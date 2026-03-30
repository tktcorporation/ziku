import { existsSync } from "node:fs";
import { readFile, writeFile } from "node:fs/promises";
import { applyEdits, modify, parse } from "jsonc-parser";
import { join } from "pathe";
import { z } from "zod";
import type { TemplateModule } from "./schemas";
import { moduleSchema } from "./schemas";

const MODULES_FILE = ".devenv/modules.jsonc";

/**
 * modules.jsonc のスキーマ
 */
const modulesFileSchema = z.object({
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
 * モジュール ID からモジュールを取得
 */
export function getModuleByIdFromList(
  modules: TemplateModule[],
  id: string,
): TemplateModule | undefined {
  return modules.find((m) => m.id === id);
}

/**
 * modules.jsonc にパターンを追加（コメントを保持）
 * @returns 更新後の JSONC 文字列
 */
export function addPatternToModulesFile(
  rawContent: string,
  moduleId: string,
  patterns: string[],
): string {
  // 現在のモジュールリストを取得
  const parsed = parse(rawContent) as ModulesFile;
  const moduleIndex = parsed.modules.findIndex((m) => m.id === moduleId);

  if (moduleIndex === -1) {
    throw new Error(`モジュール ${moduleId} が見つかりません`);
  }

  // 既存のパターンと新規パターンをマージ
  const existingPatterns = parsed.modules[moduleIndex].patterns;
  const newPatterns = patterns.filter((p) => !existingPatterns.includes(p));

  if (newPatterns.length === 0) {
    return rawContent;
  }

  const updatedPatterns = [...existingPatterns, ...newPatterns];

  // JSONC を編集（コメントを保持）
  const edits = modify(rawContent, ["modules", moduleIndex, "patterns"], updatedPatterns, {
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
  moduleId: string,
  patterns: string[],
  moduleOptions?: { name?: string; description?: string },
): string {
  const parsed = parse(rawContent) as ModulesFile;
  const moduleIndex = parsed.modules.findIndex((m) => m.id === moduleId);

  if (moduleIndex !== -1) {
    // 既存モジュールにパターンを追加
    return addPatternToModulesFile(rawContent, moduleId, patterns);
  }

  // 新しいモジュールを作成
  const displayName =
    moduleOptions?.name ||
    (moduleId === "."
      ? "Root"
      : moduleId
          .replace(/^\./, "")
          .replace(/[-_]/g, " ")
          .replace(/\b\w/g, (c) => c.toUpperCase()));
  const description =
    moduleOptions?.description || `Files in ${moduleId === "." ? "root" : moduleId} directory`;

  const newModule: TemplateModule = {
    id: moduleId,
    name: displayName,
    description,
    patterns,
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
