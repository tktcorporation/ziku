import { existsSync } from "node:fs";
import { readFile, writeFile } from "node:fs/promises";
import { applyEdits, modify, parse } from "jsonc-parser";
import { join } from "pathe";
import { z } from "zod";
import type { TemplateModule } from "./schemas";
import { moduleSchema } from "./schemas";

const MODULES_FILE = ".ziku/modules.jsonc";

/**
 * modules.jsonc の $schema URL。
 */
export const MODULES_SCHEMA_URL =
  "https://raw.githubusercontent.com/tktcorporation/ziku/main/schema/modules.json";

/**
 * テンプレート側の modules.jsonc スキーマ（グループ形式 — init UI 用）
 */
export const templateModulesFileSchema = z.object({
  $schema: z.string().optional(),
  modules: z.array(moduleSchema),
});

export type TemplateModulesFile = z.infer<typeof templateModulesFileSchema>;

/**
 * ローカル側の modules.jsonc スキーマ（フラット形式 — ランタイム用）
 */
export const localPatternsFileSchema = z.object({
  $schema: z.string().optional(),
  include: z.array(z.string()),
  exclude: z.array(z.string()).optional(),
});

export type LocalPatternsFile = z.infer<typeof localPatternsFileSchema>;

/**
 * 両形式をカバーする統合スキーマ（JSON Schema 生成用）
 */
export const modulesFileSchema = z.union([localPatternsFileSchema, templateModulesFileSchema]);

/**
 * テンプレートの modules.jsonc を読み込み（グループ形式）
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
 * ローカルの modules.jsonc を読み込み（フラット形式）
 */
export async function loadLocalPatternsFile(
  baseDir: string,
): Promise<{ include: string[]; exclude: string[]; rawContent: string }> {
  const filePath = join(baseDir, MODULES_FILE);

  if (!existsSync(filePath)) {
    throw new Error(`${MODULES_FILE} が見つかりません: ${filePath}`);
  }

  const content = await readFile(filePath, "utf-8");
  const parsed = parse(content);
  const validated = localPatternsFileSchema.parse(parsed);

  return {
    include: validated.include,
    exclude: validated.exclude ?? [],
    rawContent: content,
  };
}

/**
 * modules.jsonc がどちらの形式かを判定して読み込み
 * テンプレート形式（modules配列）の場合はフラット化して返す
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

  // フラット形式を先に試行
  const localResult = localPatternsFileSchema.safeParse(parsed);
  if (localResult.success) {
    return {
      include: localResult.data.include,
      exclude: localResult.data.exclude ?? [],
      rawContent: content,
    };
  }

  // テンプレート形式にフォールバック（フラット化して返す）
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
 * ローカルの modules.jsonc にパターンを追加
 * @returns 更新後の JSONC 文字列
 */
export function addIncludePattern(rawContent: string, patterns: string[]): string {
  const parsed = parse(rawContent) as LocalPatternsFile;
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
 * modules.jsonc を保存
 */
export async function saveModulesFile(baseDir: string, content: string): Promise<void> {
  const filePath = join(baseDir, MODULES_FILE);
  await writeFile(filePath, content);
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
