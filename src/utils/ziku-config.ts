import { existsSync } from "node:fs";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { applyEdits, modify, parse } from "jsonc-parser";
import { dirname, join } from "pathe";
import type { ZikuConfig } from "../modules/schemas";
import { zikuConfigSchema } from "../modules/schemas";

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
