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
 * raw.githubusercontent.com 経由でリポジトリ内の schema/modules.json を参照する。
 */
export const MODULES_SCHEMA_URL =
  "https://raw.githubusercontent.com/tktcorporation/ziku/main/schema/modules.json";

/**
 * modules.jsonc のスキーマ
 */
export const modulesFileSchema = z.object({
  $schema: z.string().optional(),
  modules: z.array(moduleSchema),
});

export type ModulesFile = z.infer<typeof modulesFileSchema>;

/**
 * modules.jsonc ファイルを読み込み
 */
export async function loadModulesFile(
  baseDir: string,
): Promise<{ modules: TemplateModule[]; rawContent: string }> {
  const filePath = join(baseDir, MODULES_FILE);

  if (!existsSync(filePath)) {
    throw new Error(`${MODULES_FILE} が見つかりません: ${filePath}`);
  }

  const content = await readFile(filePath, "utf-8");
  const parsed = parse(content);
  const validated = modulesFileSchema.parse(parsed);

  return {
    modules: validated.modules,
    rawContent: content,
  };
}

/**
 * モジュール name からモジュールを取得
 */
export function getModuleByNameFromList(
  modules: TemplateModule[],
  name: string,
): TemplateModule | undefined {
  return modules.find((m) => m.name === name);
}

/**
 * modules.jsonc にパターンを追加（コメントを保持）
 * @returns 更新後の JSONC 文字列
 */
export function addPatternToModulesFile(
  rawContent: string,
  moduleName: string,
  patterns: string[],
): string {
  // 現在のモジュールリストを取得
  const parsed = parse(rawContent) as ModulesFile;
  const moduleIndex = parsed.modules.findIndex((m) => m.name === moduleName);

  if (moduleIndex === -1) {
    throw new Error(`モジュール ${moduleName} が見つかりません`);
  }

  // 既存のパターンと新規パターンをマージ
  const existingPatterns = parsed.modules[moduleIndex].include;
  const newPatterns = patterns.filter((p) => !existingPatterns.includes(p));

  if (newPatterns.length === 0) {
    return rawContent;
  }

  const updatedPatterns = [...existingPatterns, ...newPatterns];

  // JSONC を編集（コメントを保持）
  const edits = modify(rawContent, ["modules", moduleIndex, "include"], updatedPatterns, {
    formattingOptions: { tabSize: 2, insertSpaces: true },
  });

  return applyEdits(rawContent, edits);
}

/**
 * modules.jsonc にパターンを追加（モジュールが存在しない場合は作成）
 * @returns 更新後の JSONC 文字列
 */
export function addPatternToModulesFileWithCreate(
  rawContent: string,
  moduleName: string,
  patterns: string[],
  moduleOptions?: { description?: string },
): string {
  const parsed = parse(rawContent) as ModulesFile;
  const moduleIndex = parsed.modules.findIndex((m) => m.name === moduleName);

  if (moduleIndex !== -1) {
    // 既存モジュールにパターンを追加
    return addPatternToModulesFile(rawContent, moduleName, patterns);
  }

  // 新しいモジュールを作成
  const description =
    moduleOptions?.description || `Files matching ${patterns.join(", ")}`;

  const newModule: TemplateModule = {
    name: moduleName,
    description,
    include: patterns,
  };

  const newModules = [...parsed.modules, newModule];

  const edits = modify(rawContent, ["modules"], newModules, {
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
