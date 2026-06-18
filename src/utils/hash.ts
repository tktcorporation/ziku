import { existsSync } from "node:fs";
import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import { join } from "pathe";
import { glob } from "tinyglobby";
import { ZIKU_CONFIG_FILE } from "./ziku-config";

/**
 * ファイル内容の SHA-256 ハッシュを計算する。
 *
 * 背景: pull 時に「ローカルが変更されたか」「テンプレートが更新されたか」を
 * ファイル全体のコピーを保持せずに判定するため、ハッシュで比較する。
 */
export function hashContent(content: string): string {
  return createHash("sha256").update(content, "utf-8").digest("hex");
}

/**
 * ディレクトリ内のファイル群を glob パターンでマッチし、
 * 各ファイルの SHA-256 ハッシュを計算してマップを返す。
 *
 * 背景: init/pull 時に適用したテンプレートファイルのハッシュを
 * .ziku/lock.json に記録し、次回 pull 時の差分検出に使用する。
 *
 * @param dir - 対象ディレクトリのルートパス
 * @param patterns - glob パターンの配列（例: [".devcontainer/**"]）
 * @returns パス（dir からの相対パス）-> SHA-256 ハッシュのマップ
 */
export async function hashFiles(
  dir: string,
  patterns: string[],
  exclude?: string[],
): Promise<Record<string, string>> {
  const files = await glob(patterns, { cwd: dir, dot: true, ignore: exclude ?? [] });
  const fileSet = new Set(files);

  // ziku.jsonc が include に明示指定されている場合、exclude（glob の ignore）で
  // 消されても必ずハッシュ対象に含める。`.ziku/**` や `**/*.jsonc` のような exclude が
  // あると、追跡対象であるはずの制御ファイルが分類経路から外れ、`ziku track` の変更が
  // 黙って同期されなくなるため（codex P2）。include の明示指定は exclude より優先する。
  if (
    patterns.includes(ZIKU_CONFIG_FILE) &&
    !fileSet.has(ZIKU_CONFIG_FILE) &&
    existsSync(join(dir, ZIKU_CONFIG_FILE))
  ) {
    fileSet.add(ZIKU_CONFIG_FILE);
  }

  const hashes: Record<string, string> = {};
  for (const file of fileSet) {
    const content = await readFile(join(dir, file), "utf-8");
    hashes[file] = hashContent(content);
  }
  return hashes;
}
