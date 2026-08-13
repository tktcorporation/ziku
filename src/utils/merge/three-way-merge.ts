import { textThreeWayMerge } from "./text-merge";
import type { MergeResult, ThreeWayMergeParams } from "./types";

/**
 * 3-way マージを実行する。
 *
 * ファイル形式によらず行レベルの 3-way マージ（git merge-file 相当）で処理する。
 * 形式ごとの構造マージへ分岐させると、コンフリクトの表現が形式ごとに食い違い、
 * 呼び出し側が結果を一様に扱えなくなる。
 *
 * 結果の内容は local をベースに template 側の変更を適用したもの。
 * コンフリクト時はコンフリクトマーカーが挿入される。
 */
export function threeWayMerge({
  base,
  local,
  template,
  filePath,
}: ThreeWayMergeParams): MergeResult {
  // ローカルとテンプレートが同一なら即座に返す
  if (String(local) === String(template)) {
    return { content: local, hasConflicts: false };
  }

  return textThreeWayMerge(base, local, template, filePath);
}
