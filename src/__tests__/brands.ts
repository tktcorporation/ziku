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
import ignore from "ignore";
import type { BlobSha, CommitSha, ContentHash, HashMap, PendingConflict } from "../modules/schemas";
import { blobShaSchema, commitShaSchema, contentHashSchema } from "../modules/schemas";
import { globPatterns, repoRelPath, repoRelPaths } from "../utils/paths";
import type { SyncScope } from "../utils/sync-scope";

export {
  absPath,
  globPattern,
  globPatterns,
  pathAsPattern,
  repoRelPath,
  repoRelPaths,
} from "../utils/paths";

/**
 * 走査範囲を組み立てる。
 *
 * 本番の {@link SyncScope} は `resolveSyncScope` がテンプレートの設定と両ディレクトリの
 * `.gitignore` を読んで作る。走査範囲そのものが主題でないテストは、その入力をディスクに
 * 用意せずに範囲だけを決めたい。省略した項目は「何も無視しない・何も戻さない」になるので、
 * `include` だけを渡せば include が対象をそのまま決める範囲になる。
 *
 * `declaredInclude` を省くと宣言側も `include` と同じになる。両者の差（走査側にだけ在る
 * 制御ファイルの合成エントリ）が主題のテストだけが指定する。
 *
 * 範囲の解決規則そのものを確かめるテストは、この関数ではなく `resolveSyncScope` を使う。
 */
export function syncScope(
  params: {
    readonly include?: readonly string[];
    readonly exclude?: readonly string[];
    /** 追跡対象として宣言されたパターン。省略時は `include` と同じ。 */
    readonly declaredInclude?: readonly string[];
    /** `.gitignore` の記法で書いた無視パターン。 */
    readonly gitignore?: readonly string[];
    /** gitignore や exclude を越えて走査へ戻すパス。 */
    readonly alwaysTracked?: readonly string[];
  } = {},
): SyncScope {
  const include = globPatterns(params.include ?? []);
  const exclude = globPatterns(params.exclude ?? []);
  return {
    scan: { purpose: "scan", include, exclude },
    declared: {
      purpose: "declared",
      include:
        params.declaredInclude === undefined ? include : globPatterns(params.declaredInclude),
      exclude,
    },
    gitignore: ignore().add([...(params.gitignore ?? [])]),
    alwaysTracked: repoRelPaths(params.alwaysTracked ?? []),
  };
}

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
 * 解決待ちのコンフリクト 1 件を組み立てる。
 *
 * 経路を省いたときはマーカー入りで書き出された側にする。ziku が実際に書き込むのはこの
 * 経路だけなので、経路そのものが主題ではないテストの既定として扱いやすい。
 */
export function pendingConflict(
  path: string,
  reason: PendingConflict["reason"] = "markers",
): PendingConflict {
  return { path: repoRelPath(path), reason };
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
