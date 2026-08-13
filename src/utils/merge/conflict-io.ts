/**
 * コンフリクト解決の I/O ユーティリティ。
 *
 * pull/push 共通の「ベースダウンロード→ファイル読み込み→3-way マージ」ロジックを
 * SSOT として集約する。ファイル不在を握りつぶさない I/O プリミティブと、1ファイル単位の
 * マージを Effect で提供する。post-merge 処理（ディスク書き込み or Map 保存）は
 * コマンドごとに異なるため、各コマンドに委ねる。
 */
import { existsSync } from "node:fs";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { Effect } from "effect";
import { dirname, join } from "pathe";
import { match, P } from "ts-pattern";
import type { LockState } from "../../modules/schemas";
import { FileNotFoundError } from "../../errors";
import { buildCommitPinnedSource, downloadTemplateToTemp } from "../template";
import { log } from "../../ui/renderer";
import type { MergeOutcome } from "./types";
import { asBaseContent, asLocalContent, asTemplateContent } from "./types";
import { threeWayMerge } from "./three-way-merge";

// ─── ファイル I/O プリミティブ ───

/**
 * ファイルを読み込む。存在しない場合は FileNotFoundError を返す。
 *
 * 空文字列で握りつぶさず、呼び出し側がエラーチャネルから
 * 明示的にフォールバック戦略（catchTag）を選択する設計。
 */
export const readFileSafe = (path: string): Effect.Effect<string, FileNotFoundError> =>
  Effect.tryPromise(() => readFile(path, "utf-8")).pipe(
    Effect.catchAll(() => Effect.fail(new FileNotFoundError({ path }))),
  );

/**
 * ファイルを書き込む。親ディレクトリがなければ自動作成する。
 * ローカルでファイルもディレクトリも削除されていた場合の復元に使う。
 */
export const writeFileEnsureDir = (path: string, content: string): Effect.Effect<void> =>
  Effect.gen(function* () {
    const dir = dirname(path);
    if (!existsSync(dir)) {
      yield* Effect.tryPromise(() => mkdir(dir, { recursive: true }));
    }
    yield* Effect.tryPromise(() => writeFile(path, content, "utf-8"));
  }).pipe(Effect.orDie);

// ─── 1ファイル単位のマージ ───

export interface MergeOneFileInput {
  /** 対象ファイルの相対パス */
  readonly file: string;
  /** ローカルプロジェクトのルートディレクトリ */
  readonly targetDir: string;
  /** テンプレート（最新版）のディレクトリ */
  readonly templateDir: string;
  /** ベーステンプレート（前回 pull 時点）のディレクトリ。なければ空文字列が base になる */
  readonly baseTemplateDir?: string;
}

export interface MergeOneFileOutput {
  readonly file: string;
  readonly outcome: MergeOutcome;
}

/**
 * 1ファイルの 3-way マージを実行する。
 *
 * local/template/base の3バージョンを読み込み、threeWayMerge に渡す。
 * - local, base: ファイルがない場合は FileNotFoundError → 空文字列にフォールバック
 *   （delete/modify conflict でローカルが削除されているケースに対応）
 * - template: `conflicts` のファイルはテンプレート側に必ず存在する（classifyFiles の
 *   不変条件。classify.ts の classifyOneFile を参照）。不在は不変条件違反なので
 *   呼び出し側で回復できず、defect として扱う。
 */
export const mergeOneFile = (input: MergeOneFileInput): Effect.Effect<MergeOneFileOutput> =>
  Effect.gen(function* () {
    // local: 削除されている可能性がある → FileNotFoundError を空文字列にフォールバック
    const localContent = yield* readFileSafe(join(input.targetDir, input.file)).pipe(
      Effect.catchTag("FileNotFoundError", () => Effect.succeed("")),
    );

    // template: conflicts のファイルはテンプレート側に必ず存在する（classifyFiles の不変条件）
    const templateContent = yield* readFileSafe(join(input.templateDir, input.file));

    // base: ダウンロードした時点でファイルがない可能性がある → 空文字列にフォールバック
    const baseContent = input.baseTemplateDir
      ? yield* readFileSafe(join(input.baseTemplateDir, input.file)).pipe(
          Effect.catchTag("FileNotFoundError", () => Effect.succeed("")),
        )
      : "";

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
  readonly templateDir: string;
  readonly cleanup: () => void;
}

/**
 * 3-way マージ用のベーステンプレートをダウンロードする。
 *
 * ベースツリーを取り直せるのは「GitHub ソース」かつ「ベースのコミット SHA を記録済み」の
 * ときだけ。それ以外（ローカルソース、ベース未確定、SHA 未記録）は null を返して
 * 呼び出し側を 2-way フォールバックへ倒す。lock を引数に取るのは、この 2 つの条件が
 * lock の型で結び付いているため。
 *
 * ダウンロード失敗時もエラーにせず null を返す（2-way マーカーで対処可能なため）。
 */
export const downloadBaseForMerge = (opts: {
  lock: LockState;
  targetDir: string;
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
            log.warn("Could not download base version. Falling back to 2-way conflict markers.");
            return null;
          }),
        ),
    )
    .with({ source: { kind: "github" }, sync: P.union("synced", "merging") }, () =>
      Effect.succeed(null),
    )
    .exhaustive();
