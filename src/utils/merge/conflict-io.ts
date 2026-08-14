/**
 * コンフリクト解決の I/O。
 *
 * 「ベースツリーの取得 → ファイル読み込み → 3-way マージ」までを担い、ファイル不在を
 * 握りつぶさない I/O プリミティブ・1 ファイル単位のマージ・コンフリクト集合を回すループを
 * Effect で提供する。マージ結果の扱い（ディスクへの書き込み / メモリへの保持）は
 * コマンドごとに異なるので、ループはハンドラを受け取って呼び出し側へ委ねる。
 */
import { existsSync } from "node:fs";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { Effect } from "effect";
import { dirname } from "pathe";
import { match, P } from "ts-pattern";
import type { AbsPath, LockState, PendingConflict, RepoRelPath } from "../../modules/schemas";
import { FileNotFoundError } from "../../errors";
import { buildCommitPinnedSource, downloadTemplateToTemp } from "../template";
import type { FileContent } from "../file-content";
import { readFileContent } from "../file-content";
import { joinAbs } from "../paths";
import { log, pc } from "../../ui/renderer";
import type { FileMergeOutcome } from "./types";
import { asBaseContent, asLocalContent, asTemplateContent } from "./types";
import { threeWayMerge } from "./three-way-merge";

// ─── ファイル I/O プリミティブ ───

/**
 * ファイルを読み込む。存在しない場合は FileNotFoundError を返す。
 *
 * 空文字列で握りつぶさず、呼び出し側がエラーチャネルから
 * 明示的にフォールバック戦略（catchTag）を選択する設計。
 */
export const readFileSafe = (path: AbsPath): Effect.Effect<string, FileNotFoundError> =>
  Effect.tryPromise(() => readFile(path, "utf-8")).pipe(
    Effect.catchAll(() => Effect.fail(new FileNotFoundError({ path }))),
  );

/**
 * ファイルをバイト列として読み、テキストかバイナリかを判定して返す。
 *
 * 存在しないファイルは「テキストの空内容」として扱う。マージ対象の不在は
 * `mergeOneFile` が扱う正常な入力（削除された側）であり、種別の判定は不要なため。
 */
const readFileKind = (path: AbsPath): Effect.Effect<FileContent> =>
  Effect.tryPromise(() => readFileContent(path)).pipe(
    Effect.orElseSucceed(() => ({ kind: "text", content: "" }) as const),
  );

/**
 * ファイルを書き込む。親ディレクトリがなければ自動作成する。
 * ローカルでファイルもディレクトリも削除されていた場合の復元に使う。
 *
 * バイト列も受け取る。テンプレートからのコピーは内容を解釈せずそのまま置くので、
 * utf-8 の文字列を経由させるとバイナリが U+FFFD へ潰れて壊れる。
 */
export const writeFileEnsureDir = (
  path: AbsPath,
  content: string | Uint8Array,
): Effect.Effect<void> =>
  Effect.gen(function* () {
    const dir = dirname(path);
    if (!existsSync(dir)) {
      yield* Effect.tryPromise(() => mkdir(dir, { recursive: true }));
    }
    yield* Effect.tryPromise(() => writeFile(path, content, "utf-8"));
  }).pipe(Effect.orDie);

// ─── 1ファイル単位のマージ ───

/**
 * 共通祖先（ベース）ツリーの所在。
 *
 * ベースツリーを取り直せるかどうかは、lock のソース種別とベース SHA の記録有無で決まる
 * （`downloadBaseForMerge` を参照）。取り直せなかったことを「空のベース」で代用すると、
 * 呼び出し側からは 3-way マージが成立したのか区別できなくなるため、値として区別する。
 */
export type MergeBaseSource =
  | { readonly kind: "with-base"; readonly dir: AbsPath }
  | { readonly kind: "no-base" };

export interface MergeOneFileInput {
  /** 対象ファイルの相対パス */
  readonly file: RepoRelPath;
  /** ローカルプロジェクトのルートディレクトリ */
  readonly targetDir: AbsPath;
  /** テンプレート（最新版）のディレクトリ */
  readonly templateDir: AbsPath;
  /** 共通祖先の所在。`no-base` のときはファイルを一切読まず、自動マージも試みない。 */
  readonly base: MergeBaseSource;
}

export interface MergeOneFileOutput {
  readonly file: RepoRelPath;
  readonly outcome: FileMergeOutcome;
}

/**
 * 1ファイルのマージを試みる。
 *
 * 共通祖先を用意できたときだけ 3-way マージを実行し、用意できないときは内容を読まずに
 * `NoBase` を返す。呼び出し側は結末を見るだけで「マージ済みの内容を扱ってよいか」を
 * 判断でき、ベースの有無で分岐を書き分ける必要はない。
 *
 * 3-way マージ時の各バージョンの読み込み:
 * - local: ファイルがない場合は空文字列。ローカルが削除された delete/modify conflict を
 *   「ローカル側が空」として表現する。
 * - base: ベースツリー内にファイルが無い場合は空文字列。ツリー自体は取得できているので、
 *   ファイルの不在は「前回同期時点で存在しなかった」という確定した事実であり、
 *   共通祖先が空であることを意味する（取得失敗の代用ではない）。
 * - template: `conflicts` のファイルはテンプレート側に必ず存在する（classifyFiles の
 *   不変条件。classify.ts の classifyOneFile を参照）。不在は不変条件違反なので
 *   呼び出し側で回復できず、defect として扱う。
 */
export const mergeOneFile = (input: MergeOneFileInput): Effect.Effect<MergeOneFileOutput> =>
  match(input.base)
    .with({ kind: "no-base" }, () =>
      Effect.succeed<MergeOneFileOutput>({ file: input.file, outcome: { _tag: "NoBase" } }),
    )
    .with({ kind: "with-base" }, ({ dir }) => mergeAgainstBase(input, dir))
    .exhaustive();

const mergeAgainstBase = (
  input: MergeOneFileInput,
  baseDir: AbsPath,
): Effect.Effect<MergeOneFileOutput> =>
  Effect.gen(function* () {
    const localContent = yield* readFileSafe(joinAbs(input.targetDir, input.file)).pipe(
      Effect.catchTag("FileNotFoundError", () => Effect.succeed("")),
    );

    const templateContent = yield* readFileSafe(joinAbs(input.templateDir, input.file));

    const baseContent = yield* readFileSafe(joinAbs(baseDir, input.file)).pipe(
      Effect.catchTag("FileNotFoundError", () => Effect.succeed("")),
    );

    const outcome = threeWayMerge({
      base: asBaseContent(baseContent),
      local: asLocalContent(localContent),
      template: asTemplateContent(templateContent),
      filePath: input.file,
    });

    return { file: input.file, outcome };
  }).pipe(
    // template の FileNotFoundError は classifyFiles の不変条件違反 → defect
    Effect.catchTag("FileNotFoundError", (e) => Effect.die(e)),
  );

// ─── ベーステンプレートのダウンロード ───

interface DownloadBaseResult {
  readonly templateDir: AbsPath;
  readonly cleanup: () => void;
}

/**
 * 3-way マージ用のベーステンプレートをダウンロードする。
 *
 * ベースツリーを取り直せるのは「GitHub ソース」かつ「ベースのコミット SHA を記録済み」の
 * ときだけ。それ以外（ローカルソース、ベース未確定、SHA 未記録）は null を返し、呼び出し側は
 * 共通祖先無し（`MergeBaseSource` の `no-base`）として扱う。lock を引数に取るのは、この 2 つの
 * 条件が lock の型で結び付いているため。
 *
 * ダウンロード失敗時もエラーにせず null を返す。ベースが無くても自動マージを飛ばせば済み、
 * どちらの版を残すかはユーザーが選べる（`FileMergeOutcome` の `NoBase`）。
 */
export const downloadBaseForMerge = (opts: {
  lock: LockState;
  targetDir: AbsPath;
}): Effect.Effect<DownloadBaseResult | null> =>
  match(opts.lock)
    .with({ source: { kind: "local" } }, () => Effect.succeed(null))
    .with({ source: { kind: "github" }, sync: "pending" }, () => Effect.succeed(null))
    .with(
      { source: { kind: "github" }, sync: P.union("synced", "merging"), base: { ref: P.string } },
      ({ source, base }) =>
        Effect.tryPromise(() => {
          log.info(`Downloading base version (${base.ref.slice(0, 7)}...) for merge...`);
          return downloadTemplateToTemp(
            opts.targetDir,
            buildCommitPinnedSource(source, base.ref),
            "base",
          );
        }).pipe(
          Effect.orElseSucceed(() => {
            // 文言は実際に起きることに合わせる。ベースが無いとマージ自体を試みず、ローカルの
            // ファイルには一切書かない（`mergeOneFile` の `no-base`）。マーカーを書いたと
            // 読める文言だと、入っていないマーカーを探しに行かせることになる。
            log.warn(
              "Could not download the base version. Auto-merge is skipped — conflicting files are left untouched and reported as unresolved.",
            );
            return null;
          }),
        ),
    )
    .with({ source: { kind: "github" }, sync: P.union("synced", "merging") }, () =>
      Effect.succeed(null),
    )
    .exhaustive();

// ─── コンフリクト解決ループ ───

export interface MergeConflictFilesInput {
  /** classifyFiles が `conflicts` と判定したファイルの相対パス。 */
  readonly conflicts: readonly RepoRelPath[];
  /** ローカルプロジェクトのルートディレクトリ */
  readonly targetDir: AbsPath;
  /** テンプレート（最新版）のディレクトリ */
  readonly templateDir: AbsPath;
  /** ベースツリーの取得可否を決める lock。 */
  readonly lock: LockState;
  /**
   * 1 ファイル分の結末を受け取るハンドラ。ローカルへの書き込み・メモリへの保持・ログなど、
   * コマンドごとに異なる後処理をここで行う。ハンドラの結果は未解決判定に影響しない。
   *
   * バイナリファイルではマージを試みないので呼ばれない（下の未解決の扱いを参照）。
   */
  readonly onFileResult: (result: MergeOneFileOutput) => Effect.Effect<void>;
}

/**
 * コンフリクトと判定されたファイルを 1 つずつマージし、未解決のものを経路付きで返す。
 *
 * 呼び出し側が前提にしてよいこと:
 * - ベースツリーの取得は全体で 1 回だけ行い、ループが途中で失敗しても必ず破棄される。
 * - ベースツリーを取得できなければ、どのファイルも自動マージされず全て未解決になる
 *   （`FileMergeOutcome` の `NoBase`）。「ベースが無いときの扱い」を呼び出し側ごとに
 *   決める余地は無い。
 * - 未解決の判定は「自動マージがクリーンに完了しなかった」で、`onFileResult` が何を
 *   しても変わらない。
 * - ローカルかテンプレートがバイナリのファイルはマージを試みずに未解決になる。行という
 *   単位が無く、マージ結果に相当する内容を作れないため、`onFileResult` も呼ばない。
 *   ユーザーへの案内はここで出す。
 * - 未解決の `reason` は、ローカルのファイルに何が書かれたかまで表す
 *   （`PendingConflict` を参照）。呼び出し側は再開時の確かめ方をこの値で選べる。
 *
 * 戻り値の順序は `conflicts` の順序を保つ。
 */
export const mergeConflictFiles = (
  input: MergeConflictFilesInput,
): Effect.Effect<readonly PendingConflict[]> =>
  Effect.gen(function* () {
    if (input.conflicts.length === 0) return [];

    const downloaded = yield* downloadBaseForMerge({
      lock: input.lock,
      targetDir: input.targetDir,
    });
    const base: MergeBaseSource =
      downloaded === null
        ? { kind: "no-base" }
        : { kind: "with-base", dir: downloaded.templateDir };

    return yield* Effect.gen(function* () {
      const unresolved: PendingConflict[] = [];
      for (const file of input.conflicts) {
        if (yield* isBinaryConflict(input, file)) {
          log.warn(
            `Cannot auto-merge ${pc.cyan(file)} — binary files have no lines to merge. ` +
              `Keep the local file or copy the template version over it.`,
          );
          unresolved.push({ path: file, reason: "binary" });
          continue;
        }
        const result = yield* mergeOneFile({
          file,
          targetDir: input.targetDir,
          templateDir: input.templateDir,
          base,
        });
        yield* input.onFileResult(result);
        const pending = unresolvedConflictOf(file, result.outcome);
        if (pending !== undefined) unresolved.push(pending);
      }
      return unresolved;
    }).pipe(Effect.ensuring(Effect.sync(() => downloaded?.cleanup())));
  });

/**
 * ローカルとテンプレートのどちらかがバイナリか。
 *
 * 3-way マージは行単位のテキスト処理なので、バイナリに適用しても意味のある結果にならない。
 * 行に切って比べた結果をマーカーで囲んで書き戻せば、元のバイト列が壊れるだけになる。
 * どちらか一方でもバイナリなら、内容を突き合わせずにユーザーへ判断を渡す。
 */
const isBinaryConflict = (
  input: MergeConflictFilesInput,
  file: RepoRelPath,
): Effect.Effect<boolean> =>
  Effect.gen(function* () {
    const local = yield* readFileKind(joinAbs(input.targetDir, file));
    const template = yield* readFileKind(joinAbs(input.templateDir, file));
    return local.kind === "binary" || template.kind === "binary";
  });

/**
 * 自動マージで確定しなかった 1 件。クリーンに終わったなら undefined。
 *
 * 結末をそのまま持ち回らず `PendingConflict` の語彙へ落とすのは、この値が lock に残って
 * 再開時まで生き延びるため。マージ結果の内容（`Conflicted` が抱えるマーカー入りテキスト）は
 * 再開時には既に古く、残すのは「ローカルに何が書かれたか」だけでよい。
 *
 * 書き込んだマーカーの長さは、内容と違って再開時にも古くならない。ディスク上のファイルを
 * 走査するとき、内容として正当に書かれたマーカー例と残骸を見分ける根拠になる
 * （`GeneratedMarkerSize`）ので、分かっているときだけ載せる。
 */
function unresolvedConflictOf(
  file: RepoRelPath,
  outcome: FileMergeOutcome,
): PendingConflict | undefined {
  return match(outcome)
    .with({ _tag: "Clean" }, () => undefined)
    .with({ _tag: "Conflicted" }, ({ markerSize }) =>
      match(markerSize)
        .with({ kind: "known" }, ({ size }) => ({
          path: file,
          reason: "markers" as const,
          markerSize: size,
        }))
        .with({ kind: "unknown" }, () => ({ path: file, reason: "markers" as const }))
        .exhaustive(),
    )
    .with({ _tag: "NoBase" }, () => ({ path: file, reason: "noBase" as const }))
    .exhaustive();
}
