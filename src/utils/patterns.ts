import { globSync } from "tinyglobby";
import type { AbsPath, GlobPattern, RepoRelPath } from "../modules/schemas";
import { repoRelPaths } from "./paths";

/**
 * フラットな include/exclude パターン
 */
export interface FlatPatterns {
  include: readonly GlobPattern[];
  exclude: readonly GlobPattern[];
}

/**
 * パターン列を重ね合わせた結果。
 *
 * `merged` は `base` 側の並びをそのまま先頭に置き、その後ろへ `base` に無いパターンだけを
 * 追記したもの。同じパターンは 1 度しか現れない。
 */
export interface PatternUnion {
  /** `base` の並びを保ったまま整えた和集合。 */
  readonly merged: GlobPattern[];
  /** `incoming` 側にだけあったパターン。取り込んだ差分をユーザーへ提示するために返す。 */
  readonly added: GlobPattern[];
}

/**
 * 2 つのパターン列を和集合にする。
 *
 * ziku のパターン同期（テンプレート ⇄ ローカルの include / exclude）は、どちら側の
 * パターンも失わないことを前提に組み立てられている。この関数はその前提を 2 点で満たす。
 *
 * - `base` が先。`base` には「この和集合を書き戻す先の `ziku.jsonc` が今持っている並び」を
 *   渡す。書き戻し先と並びの基準を揃えると、その文書の差分は末尾への追記だけになる。
 *   逆にすると既存の要素が並べ替わり、1 行の追加でも配列ごと入れ替わった差分になる
 *   （`src/utils/config-merge.ts` の `renderUnionInto` が両者を 1 つの引数から導く）。
 * - 重複除去。両側に同じパターンがあっても 1 つになるので、和集合を繰り返し適用しても
 *   結果は増えない（pull と push を往復してもパターンが増殖しない）。
 *
 * 呼び出し側は `added` を見て「取り込む側にだけあったパターン」を判断してよい。
 */
export function unionPatterns(
  base: readonly GlobPattern[],
  incoming: readonly GlobPattern[],
): PatternUnion {
  const seen = new Set<string>();
  const merged: GlobPattern[] = [];
  const added: GlobPattern[] = [];

  for (const pattern of base) {
    if (seen.has(pattern)) continue;
    seen.add(pattern);
    merged.push(pattern);
  }
  for (const pattern of incoming) {
    if (seen.has(pattern)) continue;
    seen.add(pattern);
    merged.push(pattern);
    added.push(pattern);
  }

  return { merged, added };
}

/**
 * パターンにマッチするファイル一覧を、基点からの相対パスとして取得する。
 *
 * パターンからパスへの変換点。`baseDir` の中身を実際に走査した結果だけが
 * `RepoRelPath` になるので、パターン文字列がパスとして紛れ込む経路をここで塞ぐ。
 */
export function resolvePatterns(
  baseDir: AbsPath,
  patterns: readonly GlobPattern[],
  ignore?: readonly GlobPattern[],
): RepoRelPath[] {
  const files = globSync(patterns, {
    cwd: baseDir,
    dot: true,
    onlyFiles: true,
    ignore: ignore ?? [],
  });
  return repoRelPaths(files.toSorted());
}
