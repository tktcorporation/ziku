import { textThreeWayMerge } from "./text-merge";
import { type MergeOutcome, type ThreeWayMergeParams, classifyMergeOutcome } from "./types";

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
}: ThreeWayMergeParams): MergeOutcome {
  // ローカルとテンプレートが同一ならマージするものが無い。それでも内容の検査は通す。
  // 両側が未解決のマーカーを含んだまま一致していることがあり、素通しさせると
  // 「マーカー入りだがクリーン」な結果になる。
  if (String(local) === String(template)) {
    return classifyMergeOutcome(local);
  }

  return textThreeWayMerge(base, local, template, filePath);
}
