/**
 * テストが brand 付きの値を組み立てるための入口。
 *
 * 本番コードでは brand が付くのは境界（CLI 引数・ディレクトリ走査・設定ファイルの読み込み・
 * API レスポンス）だけで、テストはその境界を素通りしてリテラルを直接渡す。ここに変換を
 * まとめることで、各テストが独自の変換ヘルパーを持たずに済む。
 *
 * 本番の変換関数（`src/utils/paths.ts`）をそのまま再輸出し、テスト専用に足すのは
 * 「リテラルのオブジェクトをハッシュマップにする」ような、テスト側にしか現れない形の
 * 組み立てだけにする。
 */
import type { BlobSha, CommitSha, ContentHash, HashMap } from "../modules/schemas";
import { blobShaSchema, commitShaSchema, contentHashSchema } from "../modules/schemas";
import { repoRelPath } from "../utils/paths";

export {
  absPath,
  globPattern,
  globPatterns,
  pathAsPattern,
  repoRelPath,
  repoRelPaths,
} from "../utils/paths";

/** 固定値のハッシュをテストで使うための変換。 */
export function contentHash(value: string): ContentHash {
  return contentHashSchema.parse(value);
}

/** 固定値のコミット SHA をテストで使うための変換。 */
export function commitSha(value: string): CommitSha {
  return commitShaSchema.parse(value);
}

/** 固定値の blob SHA をテストで使うための変換。 */
export function blobSha(value: string): BlobSha {
  return blobShaSchema.parse(value);
}

/**
 * リテラルの `{ パス: ハッシュ }` を `HashMap` へ組み立てる。
 *
 * `HashMap` は鍵も値も brand 付きなので、リテラルのオブジェクトはそのままでは代入できない。
 */
export function hashMap(entries: Record<string, string>): HashMap {
  const result: HashMap = {};
  for (const [path, hash] of Object.entries(entries)) {
    result[repoRelPath(path)] = contentHash(hash);
  }
  return result;
}
