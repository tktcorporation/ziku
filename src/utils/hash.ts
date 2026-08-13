import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import { glob } from "tinyglobby";
import type { AbsPath, ContentHash, GlobPattern, HashMap, RepoRelPath } from "../modules/schemas";
import { contentHashSchema } from "../modules/schemas";
import { joinAbs, repoRelPath } from "./paths";
import { alwaysTrackedPathsIn } from "./ziku-config";

/**
 * テキスト内容の SHA-256 ハッシュを計算する。
 *
 * 背景: pull 時に「ローカルが変更されたか」「テンプレートが更新されたか」を
 * ファイル全体のコピーを保持せずに判定するため、ハッシュで比較する。
 *
 * 文字列は utf-8 のバイト列として食わせるので、同じ内容のファイルを
 * {@link hashBytes} で計算した値と一致する。
 */
export function hashContent(content: string): ContentHash {
  return contentHashSchema.parse(createHash("sha256").update(content, "utf-8").digest("hex"));
}

/**
 * バイト列の SHA-256 ハッシュを計算する。
 *
 * ファイルのハッシュはバイト列から計算する。utf-8 としてデコードしてから計算すると、
 * テキストとして解釈できないバイトが U+FFFD へ置換され、内容の異なるバイナリが同じ
 * ハッシュになる。同じ理由で、改行コードや BOM の正規化もここでは行わない。それらが違う
 * ファイルはバイト列として実際に違うので、差分として検出されるのが正しい挙動になる
 * （正規化するのはマージ処理の内部だけ。`src/utils/text-shape.ts` を参照）。
 */
export function hashBytes(bytes: Uint8Array): ContentHash {
  return contentHashSchema.parse(createHash("sha256").update(bytes).digest("hex"));
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
  dir: AbsPath,
  patterns: readonly GlobPattern[],
  exclude?: readonly GlobPattern[],
): Promise<HashMap> {
  const files = await glob(patterns, { cwd: dir, dot: true, ignore: exclude ?? [] });
  // 走査結果はここで初めて brand を得る。ディレクトリを歩いて出てきた文字列が
  // 「基点からの相対パス」だと言えるのは、この呼び出しの直後だけ。
  const fileSet = new Set<RepoRelPath>(files.map((file) => repoRelPath(file)));

  // 常に追跡するファイルが include に明示指定されている場合、exclude（glob の ignore）で
  // 消されても必ずハッシュ対象に含める。`.ziku/**` や `**/*.jsonc` のような exclude が
  // あると、追跡対象であるはずの制御ファイルが分類経路から外れ、`ziku track` の変更が
  // 黙って同期されなくなる。include の明示指定は exclude より優先する。
  const literalPatterns = new Set<string>(patterns);
  for (const path of alwaysTrackedPathsIn(dir)) {
    if (literalPatterns.has(path)) fileSet.add(path);
  }

  const hashes: HashMap = {};
  for (const file of fileSet) {
    hashes[file] = hashBytes(await readFile(joinAbs(dir, file)));
  }
  return hashes;
}
