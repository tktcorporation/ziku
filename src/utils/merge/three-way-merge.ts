import { type TextShape, applyTextShape, detectTextShape, normalizeText } from "../text-shape";
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
 *
 * 改行コードと BOM はここで揃える。マージの内部は BOM 無し・LF で処理し、結果はローカル側の
 * 形へ戻す（`src/utils/text-shape.ts`）。ローカルを基準にするのは、ユーザーのワークツリーに
 * あるファイルの形を pull が勝手に書き換えないため。生成するコンフリクトマーカーの行も
 * 同じ経路を通るので、ファイル全体で改行コードが揃う。
 */
export function threeWayMerge({
  base,
  local,
  template,
  filePath,
}: ThreeWayMergeParams): MergeOutcome {
  const shape = detectTextShape(local);
  const normalizedLocal = normalizeText(local);
  const normalizedTemplate = normalizeText(template);

  // ローカルとテンプレートが同一ならマージするものが無い。それでも内容の検査は通す。
  // 両側が未解決のマーカーを含んだまま一致していることがあり、素通しさせると
  // 「マーカー入りだがクリーン」な結果になる。
  if (normalizedLocal === normalizedTemplate) {
    return restore(classifyMergeOutcome(normalizedLocal), shape);
  }

  return restore(
    textThreeWayMerge(normalizeText(base), normalizedLocal, normalizedTemplate, filePath),
    shape,
  );
}

/**
 * マージ結果をローカル側の形へ戻す。
 *
 * 戻した内容をもう一度分類し直すのは、`MergedContent`（マーカー非混入が検証済み）を
 * 作れる経路を `classifyMergeOutcome` の 1 本に保つため。復元は改行コードと BOM しか
 * 足さないので、分類結果は復元前と変わらない。
 */
function restore(outcome: MergeOutcome, shape: TextShape): MergeOutcome {
  return classifyMergeOutcome(applyTextShape(outcome.content, shape));
}
