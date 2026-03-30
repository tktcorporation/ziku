import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import { join } from "pathe";
import { glob } from "tinyglobby";

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
 * .ziku.json に記録し、次回 pull 時の差分検出に使用する。
 *
 * @param dir - 対象ディレクトリのルートパス
 * @param patterns - glob パターンの配列（例: [".devcontainer/**"]）
 * @returns パス（dir からの相対パス）-> SHA-256 ハッシュのマップ
 */
export async function hashFiles(dir: string, patterns: string[]): Promise<Record<string, string>> {
  const files = await glob(patterns, { cwd: dir, dot: true });
  const hashes: Record<string, string> = {};
  for (const file of files) {
    const content = await readFile(join(dir, file), "utf-8");
    hashes[file] = hashContent(content);
  }
  return hashes;
}
