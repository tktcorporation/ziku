import { existsSync } from "node:fs";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { Effect } from "effect";
import {
  type ParseError as JsoncParseError,
  applyEdits,
  modify,
  parse,
  printParseErrorCode,
} from "jsonc-parser";
import { dirname } from "pathe";
import { match } from "ts-pattern";
import type { AbsPath, GlobPattern, RepoRelPath, ZikuConfig } from "../modules/schemas";
import { zikuConfigSchema } from "../modules/schemas";
import { FileNotFoundError, ParseError, ValidationError } from "../errors";
import { globPattern, joinAbs, pathAsPattern, repoRelPath } from "./paths";

export const ZIKU_CONFIG_FILE: RepoRelPath = repoRelPath(".ziku/ziku.jsonc");

// ─── 同期対象パスの種別 ───

/**
 * 同期対象パスの種別。
 *
 * `.ziku/ziku.jsonc` は同期対象パターンそのものを定義するファイルで、他の追跡ファイルとは
 * 違う規則で扱う。
 *
 * - 走査条件（include / exclude / gitignore）にかかわらず同期対象に残す
 * - 内容はテキストの 3-way マージではなく、パターン要素の加法 union でマージする
 * - テンプレートが削除してもローカルからは消さない（削除は伝播しない）
 *
 * 型で区別しないと、この規則が消費側それぞれのパス比較として散らばり、「このファイルだけ
 * 規則が違う」ことを知るのに全消費箇所を読む必要が出る。種別ごとの扱いは
 * `src/utils/merge/sync-plan.ts` に集約する。
 */
export type SyncPath =
  | { readonly kind: "syncedFile"; readonly path: RepoRelPath }
  | { readonly kind: "zikuConfig"; readonly path: RepoRelPath };

/** 通常の同期ファイルと違う規則で扱う種別。 */
export type SpecialSyncKind = Exclude<SyncPath["kind"], "syncedFile">;

/**
 * 特別扱いする種別と、その分類結果。
 *
 * 値は「そのパスを分類した結果」そのもので、{@link classifySyncPath} はこの表をパスで
 * 逆引きして返すだけ。表と分類の分岐を別々に書くと、表へ登録しても分類が返さない種別が
 * 生まれ、その種別を前提にした消費側の分岐が到達不能なまま通ってしまう（新種別が通常の
 * 同期ファイルとして扱われる）。
 *
 * 鍵ごとに `Extract<SyncPath, { kind: K }>` を要求するので、`SyncPath` に種別を足すと
 * この表への登録が必須になり、鍵と値の種別が食い違うこともコンパイルエラーになる。
 */
export const SPECIAL_SYNC_PATHS: {
  readonly [K in SpecialSyncKind]: Extract<SyncPath, { readonly kind: K }>;
} = {
  zikuConfig: { kind: "zikuConfig", path: ZIKU_CONFIG_FILE },
};

const SPECIAL_SYNC_PATH_LIST: readonly SyncPath[] = Object.values(SPECIAL_SYNC_PATHS);

/**
 * 走査条件にかかわらず同期対象へ戻すパス。
 *
 * 特別扱いのファイルは、ユーザーが除外していても ziku 自身が同期の前提として必要とする。
 * `SPECIAL_SYNC_PATHS` から導くので、種別を足せば下の入口すべてが自動的に追随する。
 */
const ALWAYS_TRACKED_PATHS: readonly RepoRelPath[] = SPECIAL_SYNC_PATH_LIST.map(
  (special) => special.path,
);

/** パス → 特別扱いの分類結果。{@link classifySyncPath} の逆引き表。 */
const SPECIAL_SYNC_PATH_BY_PATH: ReadonlyMap<RepoRelPath, SyncPath> = new Map(
  SPECIAL_SYNC_PATH_LIST.map((special) => [special.path, special]),
);

/**
 * パスの種別を判定する。
 *
 * 「このパスは ziku 自身の設定ファイルか」を決めるのはこの関数だけで、他の判定
 * （{@link isZikuConfigPath}、分類結果の仕分け）はすべてここを経由する。
 */
export function classifySyncPath(path: RepoRelPath): SyncPath {
  return SPECIAL_SYNC_PATH_BY_PATH.get(path) ?? { kind: "syncedFile", path };
}

/**
 * そのパスが ziku 自身の設定ファイルか。
 *
 * 分類結果ではなく個々のパス（push 候補の一覧など）から設定ファイルを見つける入口。
 * 網羅的な分岐で書くことで、種別が増えたときに判定漏れがコンパイルエラーになる。
 */
export function isZikuConfigPath(path: RepoRelPath): boolean {
  return match(classifySyncPath(path))
    .with({ kind: "zikuConfig" }, () => true)
    .with({ kind: "syncedFile" }, () => false)
    .exhaustive();
}

/**
 * 特別扱いのファイル自体を常に同期対象に含めた include パターンを返す。
 *
 * 背景: `ziku.jsonc`（include/exclude パターン定義）を追跡対象から外すと、`ziku track` で
 * ローカルに追加したパターンが `ziku push` でテンプレートへ伝播せず、新規ファイルが他
 * プロジェクトの init/pull に降りてこない。パターン定義自体を「他の追跡ファイルと同じ
 * 1 ファイル」として扱い、既存の classify→マージ機構に乗せるための入口がこの関数。
 *
 * 注意: `.ziku/**` ではなくリテラルパス 1 本だけを足す。`.ziku/lock.json`（テンプレート
 * 取得元 source を含むローカル専用ファイル）を同期対象に巻き込まないため。
 */
export function withConfigTracked(include: readonly GlobPattern[]): GlobPattern[] {
  const present = new Set<string>(include);
  const missing = ALWAYS_TRACKED_PATHS.filter((path) => !present.has(path)).map((path) =>
    pathAsPattern(path),
  );
  return [...include, ...missing];
}

/**
 * {@link withConfigTracked} が足した合成エントリを取り除いた include パターンを返す。
 *
 * 未追跡ファイルの探索のように「ユーザーが明示的に追跡すると決めたパターン」だけを見たい
 * 入口で使う。合成エントリを混ぜると `.ziku` が探索のスコープ基点とみなされ、同期対象外の
 * `.ziku/lock.json`（テンプレート取得元 source を含むローカル専用ファイル）まで追跡候補に
 * 出てしまう。特別扱いのファイルは常に追跡されるので、探索対象から外しても追跡漏れは起きない。
 */
export function withoutConfigTracked(include: readonly GlobPattern[]): GlobPattern[] {
  const alwaysTracked = new Set<string>(ALWAYS_TRACKED_PATHS);
  return include.filter((pattern) => !alwaysTracked.has(pattern));
}

/**
 * 走査結果から漏れても同期対象へ戻すパスのうち、`dir` に実在するものを返す。
 *
 * 走査の入口はパターン解決・ハッシュ計算・diff 検出の 3 つあり、1 つの関数にはまとめられない。
 * 落ちる理由も、戻す先の集合も違うため:
 *
 * - パターン解決（{@link withConfigTracked}）はディスクを見ない。テンプレート側にしか無い
 *   ファイルも走査させる必要があり、実在チェックを挟むと初回取得ができなくなる。
 * - ハッシュ計算は 1 ディレクトリの glob 結果へ戻す。exclude で消えた分が対象で、include に
 *   明示されているときだけ戻す（設定ファイルを追跡しないパターンで呼ぶ利用者に押し付けない）。
 * - diff 検出はローカルとテンプレートを突き合わせた集合へ戻す。gitignore で消えた分が対象で、
 *   include の明示は問わない（`ziku diff` は合成エントリを足さない生の include で走るため）。
 *
 * 3 者が共有できるのは「どのパスが対象か」だけなので、その一覧をこの関数と
 * {@link withConfigTracked} が同じ定数から引く。
 */
export function alwaysTrackedPathsIn(dir: AbsPath): RepoRelPath[] {
  return ALWAYS_TRACKED_PATHS.filter((path) => existsSync(joinAbs(dir, path)));
}

export const ZIKU_CONFIG_SCHEMA_URL =
  "https://raw.githubusercontent.com/tktcorporation/ziku/main/schema/ziku.json";

/**
 * jsonc-parser の診断を、エディタで開ける位置つきの 1 行に落とす。
 *
 * 診断が持つのはエラーコードと文字オフセットだけなので、行・桁へ直して示す。
 * オフセットのままだと、ユーザーは壊れた箇所へ辿り着けない。
 */
function describeJsoncError(error: JsoncParseError, content: string): string {
  const linesBefore = content.slice(0, error.offset).split("\n");
  const line = linesBefore.length;
  const column = (linesBefore.at(-1)?.length ?? 0) + 1;
  return `${printParseErrorCode(error.error)} at line ${line}, column ${column}`;
}

/**
 * `.ziku/ziku.jsonc` を読み込む。
 *
 * 失敗理由を 3 つに分けて返す。全部を「パース失敗」に潰すと、スキーマ違反まで
 * 構文エラーとして報告され、ユーザーは壊れていない JSONC の中で構文ミスを探すことになる。
 *
 * - `FileNotFoundError`: ファイルが読めない（未初期化）
 * - `ParseError`: JSONC として壊れている
 * - `ValidationError`: JSONC ではあるが ziku の設定として解釈できない
 */
export function loadZikuConfig(
  targetDir: AbsPath,
): Effect.Effect<
  { config: ZikuConfig; rawContent: string },
  FileNotFoundError | ParseError | ValidationError
> {
  const configPath = joinAbs(targetDir, ZIKU_CONFIG_FILE);

  return Effect.gen(function* () {
    const content = yield* Effect.tryPromise({
      try: () => readFile(configPath, "utf-8"),
      catch: () => new FileNotFoundError({ path: ZIKU_CONFIG_FILE }),
    });

    // jsonc-parser の parse は不正入力でも例外を投げず、渡した配列へ診断を積む設計。
    // 例外の有無で判定すると、どんな入力でも構文が通ったことになる。
    //
    // 末尾カンマを許容するのは、この設定ファイルが JSONC 方言で書かれるため。
    const syntaxErrors: JsoncParseError[] = [];
    const parsed: unknown = parse(content, syntaxErrors, { allowTrailingComma: true });
    // 後続の診断は最初の破綻から派生した連鎖なので、直すべき箇所である先頭だけを報告する。
    const firstSyntaxError = syntaxErrors[0];
    if (firstSyntaxError !== undefined) {
      return yield* new ParseError({
        path: ZIKU_CONFIG_FILE,
        cause: new SyntaxError(describeJsoncError(firstSyntaxError, content)),
      });
    }

    const result = zikuConfigSchema.safeParse(parsed);
    if (!result.success) {
      return yield* new ValidationError({
        path: ZIKU_CONFIG_FILE,
        issues: result.error.issues.map((issue) =>
          issue.path.length > 0 ? `${issue.path.join(".")}: ${issue.message}` : issue.message,
        ),
      });
    }

    return { config: result.data, rawContent: content };
  });
}

/**
 * .ziku/ziku.jsonc を保存
 */
export async function saveZikuConfig(targetDir: AbsPath, content: string): Promise<void> {
  const configPath = joinAbs(targetDir, ZIKU_CONFIG_FILE);
  await mkdir(dirname(configPath), { recursive: true });
  await writeFile(configPath, content);
}

/**
 * .ziku/ziku.jsonc が存在するか確認
 */
export function zikuConfigExists(targetDir: AbsPath): boolean {
  return existsSync(joinAbs(targetDir, ZIKU_CONFIG_FILE));
}

/**
 * ziku.jsonc コンテンツを生成する。
 *
 * テンプレート側・ユーザー側で同一フォーマット。
 * source 情報は lock.json に分離されたため、ここにはパターンのみ。
 */
export function generateZikuJsonc(opts: {
  include: readonly GlobPattern[];
  exclude: readonly GlobPattern[];
}): string {
  const content: Record<string, unknown> = {
    $schema: ZIKU_CONFIG_SCHEMA_URL,
    include: opts.include,
  };
  if (opts.exclude.length > 0) {
    content.exclude = opts.exclude;
  }
  return `${JSON.stringify(content, null, 2)}\n`;
}

/**
 * patterns のうち、まだ existing に含まれていない新規パターンだけを返す。
 * addIncludePattern の判定基準と呼び出し元（track コマンドのプレビュー等）の表示を
 * 同じ差分に揃えるための共有ヘルパー。ここを分けないと「実際に追加される集合」と
 * 「表示される集合」が別々の判定になり、既存パターンを混ぜて指定したときにズレる。
 */
export function newIncludePatterns(
  existing: readonly GlobPattern[],
  patterns: readonly GlobPattern[],
): GlobPattern[] {
  const known = new Set<string>(existing);
  return patterns.filter((p) => !known.has(p));
}

/**
 * ziku.jsonc の include にパターンを追加
 * @returns 更新後の JSONC 文字列
 */
export function addIncludePattern(rawContent: string, patterns: readonly GlobPattern[]): string {
  const parsed = parse(rawContent) as { include?: string[] } | undefined;
  const existing = (parsed?.include ?? []).map((pattern) => globPattern(pattern));
  const newPatterns = newIncludePatterns(existing, patterns);

  if (newPatterns.length === 0) {
    return rawContent;
  }

  const updatedInclude = [...existing, ...newPatterns];
  const edits = modify(rawContent, ["include"], updatedInclude, {
    formattingOptions: { tabSize: 2, insertSpaces: true },
  });

  return applyEdits(rawContent, edits);
}
