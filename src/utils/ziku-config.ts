import { existsSync } from "node:fs";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { applyEdits, modify, parse } from "jsonc-parser";
import { dirname, join } from "pathe";
import type { ZikuConfig } from "../modules/schemas";
import { zikuConfigSchema } from "../modules/schemas";

export const ZIKU_CONFIG_FILE = ".ziku/ziku.jsonc";

export const ZIKU_CONFIG_SCHEMA_URL =
  "https://raw.githubusercontent.com/tktcorporation/ziku/main/schema/ziku.json";

/**
 * .ziku/ziku.jsonc を読み込み
 */
export async function loadZikuConfig(
  targetDir: string,
): Promise<{ config: ZikuConfig; rawContent: string }> {
  const configPath = join(targetDir, ZIKU_CONFIG_FILE);
  const content = await readFile(configPath, "utf-8");
  const parsed = parse(content);
  const config = zikuConfigSchema.parse(parsed);
  return { config, rawContent: content };
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
 * ziku.jsonc コンテンツを生成する
 */
export function generateZikuJsonc(opts: {
  source: { owner: string; repo: string } | { dir: string };
  include: string[];
  exclude: string[];
}): string {
  const content: Record<string, unknown> = {
    $schema: ZIKU_CONFIG_SCHEMA_URL,
    source: opts.source,
    include: opts.include,
  };
  if (opts.exclude.length > 0) {
    content.exclude = opts.exclude;
  }
  return `${JSON.stringify(content, null, 2)}\n`;
}

/**
 * ziku.jsonc の include にパターンを追加
 * @returns 更新後の JSONC 文字列
 */
export function addIncludePattern(rawContent: string, patterns: string[]): string {
  const parsed = parse(rawContent) as ZikuConfig;
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
