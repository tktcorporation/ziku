import { globSync } from "tinyglobby";
import type { AbsPath, GlobPattern, RepoRelPath } from "../modules/schemas";
import { repoRelPaths } from "./paths";

/**
 * フラットな include/exclude パターン
 */
export interface FlatPatterns {
  include: GlobPattern[];
  exclude: GlobPattern[];
}

/**
 * ローカル優先でパターン列を重ね合わせた結果。
 *
 * `merged` はローカル側の並びをそのまま先頭に置き、その後ろへローカルに無いパターンだけを
 * 追記したもの。同じパターンは 1 度しか現れない。
 */
export interface PatternUnion {
  /** ローカル優先の順序に整えた和集合。 */
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
 * - ローカルが先。ユーザーが `ziku.jsonc` に書いた並びは、テンプレート側の追加によって
 *   崩れない（差分は常に末尾へ積まれるので、設定ファイルの diff も読みやすい）。
 * - 重複除去。両側に同じパターンがあっても 1 つになるので、和集合を繰り返し適用しても
 *   結果は増えない（pull と push を往復してもパターンが増殖しない）。
 *
 * 呼び出し側は `added` を見て「テンプレート側で新しく増えたパターン」を判断してよい。
 */
export function unionPatterns(
  local: readonly GlobPattern[],
  incoming: readonly GlobPattern[],
): PatternUnion {
  const seen = new Set<string>();
  const merged: GlobPattern[] = [];
  const added: GlobPattern[] = [];

  for (const pattern of local) {
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
