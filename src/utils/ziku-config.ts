import { existsSync } from "node:fs";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { Effect } from "effect";
import { dirname } from "pathe";
import { match } from "ts-pattern";
import type { AbsPath, GlobPattern, RepoRelPath, ZikuConfig } from "../modules/schemas";
import { describeSchemaIssues, zikuConfigSchema } from "../modules/schemas";
import { FileNotFoundError, ParseError, ValidationError } from "../errors";
import { applyEdits, modify, parseJsonc } from "./jsonc";
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
 * 走査結果から漏れても同期対象へ戻すパスのうち、`dir` に実在するものを返す。
 *
 * 走査の入口はパターン解決・ハッシュ計算・diff 検出の 3 つあり、1 つの関数にはまとめられない。
 * 落ちる理由も、戻す先の集合も違うため:
 *
 * - パターン解決（{@link withConfigTracked}）はディスクを見ない。テンプレート側にしか無い
 *   ファイルも走査させる必要があり、実在チェックを挟むと初回取得ができなくなる。
 * - ハッシュ計算は 1 ディレクトリの glob 結果へ戻す。exclude で消えた分が対象。
 * - diff 検出はローカルとテンプレートを突き合わせた集合へ戻す。gitignore で消えた分が対象。
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
 * `.ziku/ziku.jsonc` を読んだ結果。
 *
 * 「読めなかった理由」を 3 つに分ける。全部を「パース失敗」に潰すと、スキーマ違反まで
 * 構文エラーとして報告され、利用者は壊れていない JSONC の中で構文ミスを探すことになる。
 *
 * 読む入口はローカル側（{@link loadZikuConfig}）・マージ側（`src/utils/config-merge.ts`）・
 * テンプレート側（`src/utils/template-config.ts`）の 3 つあり、失敗の運び方（Effect の
 * エラーチャネル / throw）が入口ごとに違う。分類まで入口ごとに書くと、同じ内容の
 * `ziku.jsonc` が入口によって構文エラーになったりスキーマ違反になったりする。分類を
 * {@link readZikuConfig} だけが持ち、各入口はこの union を自分の失敗の形へ写すだけにする
 * ことで、ケースを足したとき全入口の `match().exhaustive()` がコンパイルエラーになる。
 *
 * `Ok` が生のテキストも持つのは、書き戻す入口が「新しく生成した内容」ではなく「元の内容の
 * include / exclude だけを差し替えたもの」を作るため（{@link withPatterns}）。パターンだけを
 * 取り出して作り直すと、注釈と ziku が読まないキーが同期のたびに消える。
 */
export type ZikuConfigRead =
  /** ファイルが無い。未初期化のプロジェクト、または ziku を使っていないテンプレート。 */
  | { readonly _tag: "NotFound" }
  /** JSONC として壊れている。`detail` は最初の破綻を行・桁で示した 1 行。 */
  | { readonly _tag: "Unparsable"; readonly detail: string }
  /** 構文は通るが ziku の設定として解釈できない。`issues` は直すべき箇所の説明。 */
  | { readonly _tag: "Invalid"; readonly issues: readonly string[] }
  /** 読めた。`raw` は部分編集の土台にできる元テキスト。 */
  | { readonly _tag: "Ok"; readonly config: ZikuConfig; readonly raw: string };

/**
 * `.ziku/ziku.jsonc` を読み、失敗を分類して返す。
 *
 * 失敗を投げず値で返すので、Effect のエラーチャネルへ載せる入口も `ZikuFailure` を throw する
 * 入口も、同じ分類から自分の形へ写せる。
 */
export async function readZikuConfig(dir: AbsPath): Promise<ZikuConfigRead> {
  const configPath = joinAbs(dir, ZIKU_CONFIG_FILE);
  if (!existsSync(configPath)) return { _tag: "NotFound" };
  return classifyZikuConfigText(await readFile(configPath, "utf-8"));
}

/** 読み出したテキストを分類する。ディスクを見ないので `NotFound` は返らない。 */
function classifyZikuConfigText(raw: string): Exclude<ZikuConfigRead, { _tag: "NotFound" }> {
  return match(parseJsonc(raw))
    .with({ kind: "unparsable" }, ({ detail }) => ({ _tag: "Unparsable", detail }) as const)
    .with({ kind: "parsed" }, ({ value }) => {
      const result = zikuConfigSchema.safeParse(value);
      return result.success
        ? ({ _tag: "Ok", config: result.data, raw } as const)
        : ({ _tag: "Invalid", issues: describeSchemaIssues(result.error) } as const);
    })
    .exhaustive();
}

/**
 * ローカルの `.ziku/ziku.jsonc` を読み込む。
 *
 * {@link readZikuConfig} の分類を、コマンド層が扱うエラーチャネルへ写す。
 *
 * - `FileNotFoundError`: ファイルが無い（未初期化）
 * - `ParseError`: JSONC として壊れている
 * - `ValidationError`: JSONC ではあるが ziku の設定として解釈できない
 */
export function loadZikuConfig(
  targetDir: AbsPath,
): Effect.Effect<
  { config: ZikuConfig; rawContent: string },
  FileNotFoundError | ParseError | ValidationError
> {
  return Effect.promise(() => readZikuConfig(targetDir)).pipe(
    Effect.flatMap(
      (
        read,
      ): Effect.Effect<
        { config: ZikuConfig; rawContent: string },
        FileNotFoundError | ParseError | ValidationError
      > =>
        match(read)
          .with({ _tag: "NotFound" }, () =>
            Effect.fail(new FileNotFoundError({ path: ZIKU_CONFIG_FILE })),
          )
          .with({ _tag: "Unparsable" }, ({ detail }) =>
            Effect.fail(new ParseError({ path: ZIKU_CONFIG_FILE, cause: new SyntaxError(detail) })),
          )
          .with({ _tag: "Invalid" }, ({ issues }) =>
            Effect.fail(new ValidationError({ path: ZIKU_CONFIG_FILE, issues })),
          )
          .with({ _tag: "Ok" }, ({ config, raw }) => Effect.succeed({ config, rawContent: raw }))
          .exhaustive(),
    ),
  );
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
 * 既存の `ziku.jsonc` の include / exclude だけを差し替えた内容を返す。
 *
 * jsonc の部分編集（`modify` / `applyEdits`）で行うので、コメントと ziku が読まないキーは
 * そのまま残る。拡張子が `.jsonc` なのは注釈を書けるようにするためで、{@link generateZikuJsonc}
 * で作り直すと利用者とテンプレートの注釈が同期のたびに消える。`ziku.jsonc` を書き換える経路
 * （track の追記・加法 union マージ）はすべてここを通す。
 *
 * パターンが元の内容と同じ並びなら編集自体を行わない。同じ値でも `modify` は配列を整形し直す
 * ので、内容が変わっていないのに利用者の書式だけが書き換わる。
 *
 * `exclude` が空なら触らない。加法 union はパターンを消さないため、空になるのはどちらの側にも
 * exclude が無い場合に限られ、書き足す意味がない。
 *
 * 元の内容が構文として壊れているか、オブジェクトとして読めないときは {@link generateZikuJsonc}
 * で作り直す。残すべき構造が読み取れず、部分編集を重ねても壊れた JSONC にしかならないため。
 *
 * 「壊れているか」は必ず {@link parseJsonc} の診断で判定する。jsonc-parser のエラー回復は
 * 閉じ括弧を失ったテキストからでも部分的なオブジェクトを返すので、戻り値の形だけで判定すると
 * 壊れたテキストが編集可能と判定され、`modify` / `applyEdits` がそれを土台に走る。この関数の
 * 判定は「作り直す」か「生のテキストを編集する」かを決めるので、誤った「読めた」がそのまま
 * 壊れたファイルの書き出しになる。
 */
export function withPatterns(
  rawContent: string,
  patterns: { readonly include: readonly GlobPattern[]; readonly exclude: readonly GlobPattern[] },
): string {
  const current = editableObjectOf(rawContent);
  if (current === undefined) {
    return generateZikuJsonc(patterns);
  }

  const withInclude = replaceArray(rawContent, "include", current.include, patterns.include);
  return patterns.exclude.length === 0
    ? withInclude
    : replaceArray(withInclude, "exclude", current.exclude, patterns.exclude);
}

/**
 * 部分編集の土台にしてよい内容だけを返す。土台にできなければ undefined。
 *
 * 配列と原始値を弾くのは、`modify` がキーを差し込む先を持たないため。
 */
function editableObjectOf(
  rawContent: string,
): { include?: unknown; exclude?: unknown } | undefined {
  return match(parseJsonc(rawContent))
    .with({ kind: "unparsable" }, () => undefined)
    .with({ kind: "parsed" }, ({ value }) =>
      typeof value === "object" && value !== null && !Array.isArray(value)
        ? (value as { include?: unknown; exclude?: unknown })
        : undefined,
    )
    .exhaustive();
}

/** 配列キー 1 つを差し替える。並びまで一致していれば元の内容をそのまま返す。 */
function replaceArray(
  rawContent: string,
  key: "include" | "exclude",
  current: unknown,
  next: readonly GlobPattern[],
): string {
  if (
    Array.isArray(current) &&
    current.length === next.length &&
    current.every((v, i) => v === next[i])
  ) {
    return rawContent;
  }
  const edits = modify(rawContent, [key], next, {
    formattingOptions: { tabSize: 2, insertSpaces: true },
  });
  return applyEdits(rawContent, edits);
}

/**
 * ziku.jsonc の include にパターンを追加
 *
 * 元の内容が壊れていれば既存パターン無しとして扱い、{@link withPatterns} の作り直しへ落ちる。
 * 呼び出し元は {@link loadZikuConfig} を通った内容を渡すので、この経路に入るのは読み込みと
 * 書き換えの間にファイルが壊れた場合だけ。そのとき部分編集を続けると壊れたまま書き戻る。
 *
 * @returns 更新後の JSONC 文字列
 */
export function addIncludePattern(rawContent: string, patterns: readonly GlobPattern[]): string {
  const existing = includePatternsOf(rawContent);
  const newPatterns = newIncludePatterns(existing, patterns);

  if (newPatterns.length === 0) {
    return rawContent;
  }

  return withPatterns(rawContent, { include: [...existing, ...newPatterns], exclude: [] });
}

/** ziku.jsonc の内容から include パターンを取り出す。土台にできない内容なら空。 */
function includePatternsOf(rawContent: string): GlobPattern[] {
  const include = editableObjectOf(rawContent)?.include;
  return Array.isArray(include)
    ? include
        .filter((pattern) => typeof pattern === "string")
        .map((pattern) => globPattern(pattern))
    : [];
}
