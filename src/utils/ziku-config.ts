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
import { dirname, join } from "pathe";
import type { ZikuConfig } from "../modules/schemas";
import { zikuConfigSchema } from "../modules/schemas";
import { FileNotFoundError, ParseError, ValidationError } from "../errors";

export const ZIKU_CONFIG_FILE = ".ziku/ziku.jsonc";

/**
 * `.ziku/ziku.jsonc` 自体を常に同期対象に含めた include パターンを返す。
 *
 * 背景: `ziku.jsonc`（include/exclude パターン定義）は、これまで pull の片方向
 * 加法マージでしか同期されず、`ziku track` でローカルに追加したパターンが
 * `ziku push` でテンプレートへ伝播しなかった（テンプレ側 ziku.jsonc が更新されず、
 * 新規ファイルが他プロジェクトの init/pull に降りてこない孤児化バグ）。
 *
 * これを解消するため、push/pull/status の差分検出（hashFiles / detectDiff /
 * analyzeSync）で `ziku.jsonc` を「他の追跡ファイルと同じ 1 ファイル」として扱い、
 * 既存の classify→3-way マージ機構に乗せる。そのための SSOT がこの関数。
 *
 * 注意: `.ziku/**` ではなく `.ziku/ziku.jsonc` のリテラルパス 1 本だけを足す。
 * `.ziku/lock.json`（テンプレート取得元 source を含むローカル専用ファイル）を
 * 同期対象に巻き込まないため。
 */
export function withConfigTracked(include: string[]): string[] {
  return include.includes(ZIKU_CONFIG_FILE) ? include : [...include, ZIKU_CONFIG_FILE];
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
  targetDir: string,
): Effect.Effect<
  { config: ZikuConfig; rawContent: string },
  FileNotFoundError | ParseError | ValidationError
> {
  const configPath = join(targetDir, ZIKU_CONFIG_FILE);

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
export async function saveZikuConfig(targetDir: string, content: string): Promise<void> {
  const configPath = join(targetDir, ZIKU_CONFIG_FILE);
  await mkdir(dirname(configPath), { recursive: true });
  await writeFile(configPath, content);
}

/**
 * .ziku/ziku.jsonc が存在するか確認
 */
export function zikuConfigExists(targetDir: string): boolean {
  return existsSync(join(targetDir, ZIKU_CONFIG_FILE));
}

/**
 * ziku.jsonc コンテンツを生成する。
 *
 * テンプレート側・ユーザー側で同一フォーマット。
 * source 情報は lock.json に分離されたため、ここにはパターンのみ。
 */
export function generateZikuJsonc(opts: { include: string[]; exclude: string[] }): string {
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
export function newIncludePatterns(existing: string[], patterns: string[]): string[] {
  return patterns.filter((p) => !existing.includes(p));
}

/**
 * ziku.jsonc の include にパターンを追加
 * @returns 更新後の JSONC 文字列
 */
export function addIncludePattern(rawContent: string, patterns: string[]): string {
  const parsed = parse(rawContent) as ZikuConfig;
  const existing = parsed.include ?? [];
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
