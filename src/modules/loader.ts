import { existsSync } from "node:fs";
import { readFile } from "node:fs/promises";
import { applyEdits, modify, parse } from "jsonc-parser";
import { join } from "pathe";
import { z } from "zod";
import type { TemplateModule } from "./schemas";
import { moduleSchema } from "./schemas";

/**
 * テンプレートリポジトリ側のモジュール定義ファイルパス。
 * ユーザープロジェクトには存在しない（ユーザー側は ziku.jsonc を使う）。
 */
export const MODULES_FILE = ".ziku/modules.jsonc";

/**
 * modules.jsonc の $schema URL。
 */
export const MODULES_SCHEMA_URL =
  "https://raw.githubusercontent.com/tktcorporation/ziku/main/schema/modules.json";

/**
 * テンプレート側の modules.jsonc スキーマ（モジュール形式 — init 時の選択 UI 用）
 */
export const templateModulesFileSchema = z.object({
  $schema: z.string().optional(),
  modules: z.array(moduleSchema),
});

/**
 * フラット形式の modules.jsonc スキーマ。
 *
 * 背景: handleTemplateRepoInit や scaffold PR で生成される簡易形式。
 * モジュール選択 UI を使わず、include/exclude だけで同期対象を定義する。
 * loadPatternsFile 内でフォールバックとして使用する。
 */
const flatPatternsFileSchema = z.object({
  $schema: z.string().optional(),
  include: z.array(z.string()),
  exclude: z.array(z.string()).optional(),
});

/**
 * 両形式をカバーする統合スキーマ（JSON Schema 生成用）。
 *
 * テンプレートリポジトリの modules.jsonc はモジュール形式が標準だが、
 * scaffold 時に生成されるフラット形式も有効な形式として許容する。
 */
export const modulesFileSchema = z.union([flatPatternsFileSchema, templateModulesFileSchema]);

/**
 * テンプレートの modules.jsonc を読み込み（モジュール形式）。
 * init 時にモジュール選択 UI を表示するために使用する。
 */
export async function loadTemplateModulesFile(
  baseDir: string,
): Promise<{ modules: TemplateModule[]; rawContent: string }> {
  const filePath = join(baseDir, MODULES_FILE);

  if (!existsSync(filePath)) {
    throw new Error(`${MODULES_FILE} が見つかりません: ${filePath}`);
  }

  const content = await readFile(filePath, "utf-8");
  const parsed = parse(content);
  const validated = templateModulesFileSchema.parse(parsed);

  return {
    modules: validated.modules,
    rawContent: content,
  };
}

/**
 * テンプレートの modules.jsonc を読み込み、include/exclude パターンに展開して返す。
 *
 * モジュール形式 → 全モジュールの include/exclude をフラット化。
 * フラット形式（scaffold 生成） → そのまま返す。
 *
 * 呼び出し元: init（フォールバック）、push（テンプレートのパターン取得）
 */
export async function loadPatternsFile(
  baseDir: string,
): Promise<{ include: string[]; exclude: string[]; rawContent: string }> {
  const filePath = join(baseDir, MODULES_FILE);

  if (!existsSync(filePath)) {
    throw new Error(`${MODULES_FILE} が見つかりません: ${filePath}`);
  }

  const content = await readFile(filePath, "utf-8");
  const parsed = parse(content);

  // フラット形式を先に試行（scaffold で生成された場合）
  const flatResult = flatPatternsFileSchema.safeParse(parsed);
  if (flatResult.success) {
    return {
      include: flatResult.data.include,
      exclude: flatResult.data.exclude ?? [],
      rawContent: content,
    };
  }

  // モジュール形式にフォールバック（標準のテンプレート形式）
  const templateResult = templateModulesFileSchema.safeParse(parsed);
  if (templateResult.success) {
    return {
      include: templateResult.data.modules.flatMap((m) => m.include),
      exclude: templateResult.data.modules.flatMap((m) => m.exclude ?? []),
      rawContent: content,
    };
  }

  throw new Error(`${MODULES_FILE} の形式が不正です`);
}

/**
 * フラット形式の modules.jsonc に include パターンを追加する。
 *
 * 背景: push 時にローカルで追加されたパターンをテンプレートの modules.jsonc に
 * 書き戻すために使用。フラット形式（scaffold 生成）のファイルのみ対応。
 * 呼び出し前に isFlatFormat() でフラット形式であることを確認すること。
 *
 * @returns 更新後の JSONC 文字列
 */
export function addIncludePattern(rawContent: string, patterns: string[]): string {
  const parsed = parse(rawContent) as { include?: string[] };
  const existing = parsed.include ?? [];
  const newPatterns = patterns.filter((p) => !existing.includes(p));

  if (newPatterns.length === 0) {
    return rawContent;
  }

  const updatedInclude = [...existing, ...newPatterns];
  const edits = modify(rawContent, ["include"], updatedInclude, {
    formattingOptions: { tabSize: 2, insertSpaces: true },
  });

  return applyEdits(rawContent, edits);
}

/**
 * modules.jsonc がフラット形式かどうかを判定する。
 *
 * 背景: addIncludePattern はフラット形式のみ対応。
 * モジュール形式に対して呼ぶとファイルが壊れるため、
 * 呼び出し元で事前にこの関数でチェックする。
 */
export function isFlatFormat(rawContent: string): boolean {
  const parsed = parse(rawContent);
  return flatPatternsFileSchema.safeParse(parsed).success;
}

/**
 * モジュールファイルのパスを取得
 */
export function getModulesFilePath(baseDir: string): string {
  return join(baseDir, MODULES_FILE);
}

/**
 * modules.jsonc が存在するか確認
 */
export function modulesFileExists(baseDir: string): boolean {
  return existsSync(join(baseDir, MODULES_FILE));
}
