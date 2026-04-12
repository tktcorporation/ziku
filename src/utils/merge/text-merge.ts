import { diff3Merge } from "node-diff3";
import { validateStructuredContent } from "./file-detection";
import type { MergeResult } from "./types";

// ---- テキスト 3-way マージ ----

/**
 * GNU diff3 と同等の行レベル 3-way マージ。
 *
 * 背景: 以前の実装は diff ライブラリの applyPatch を使っていたが、
 * これは「パッチが物理的に適用可能か」のみを判定し、git のような
 * 「両側の独立した変更の競合検出」をしなかった。
 * そのため、ローカルの変更がサイレントに上書きされたり、
 * 内容が二重化される問題があった (#51)。
 *
 * node-diff3 の diff3Merge は base/local/template の3者を比較し、
 * 同じ領域を両側が異なる内容に変更した場合は必ず conflict にする。
 */
export function textThreeWayMerge(
  base: string,
  local: string,
  template: string,
  filePath?: string,
): MergeResult {
  const baseLines = base.split("\n");
  const localLines = local.split("\n");
  const templateLines = template.split("\n");

  // node-diff3: diff3Merge(a, o, b) — a=local, o=base, b=template
  const regions = diff3Merge(localLines, baseLines, templateLines);

  const resultLines: string[] = [];
  let hasConflicts = false;

  for (const region of regions) {
    if ("ok" in region && region.ok) {
      resultLines.push(...region.ok);
    } else if ("conflict" in region && region.conflict) {
      hasConflicts = true;
      resultLines.push("<<<<<<< LOCAL");
      resultLines.push(...region.conflict.a);
      resultLines.push("=======");
      resultLines.push(...region.conflict.b);
      resultLines.push(">>>>>>> TEMPLATE");
    }
  }

  const content = resultLines.join("\n");

  // 構造ファイル（JSON/TOML/YAML）のクリーンマージ結果をパースで検証。
  // diff3Merge は行レベルで競合を判定するため、構造的に壊れた出力を
  // クリーンマージとして返す可能性がある。検証失敗時はファイル全体を
  // コンフリクトとしてマークし、壊れたファイルの生成を防ぐ。
  if (!hasConflicts && filePath && !validateStructuredContent(content, filePath)) {
    return {
      content: [
        "<<<<<<< LOCAL",
        local,
        "=======",
        template,
        ">>>>>>> TEMPLATE",
      ].join("\n"),
      hasConflicts: true,
      conflictDetails: [],
    };
  }

  return {
    content,
    hasConflicts,
    conflictDetails: [],
  };
}

/**
 * ファイル内容にコンフリクトマーカーが含まれるかを検出する。
 *
 * 背景: マージ後のファイルにユーザーが手動解決すべきコンフリクトが
 * 残っているかを判定するために使用する。
 */
export function hasConflictMarkers(content: string): { found: boolean; lines: number[] } {
  const lines: number[] = [];
  const contentLines = content.split("\n");

  for (let i = 0; i < contentLines.length; i++) {
    const line = contentLines[i];
    if (line.startsWith("<<<<<<<") || line.startsWith("=======") || line.startsWith(">>>>>>>")) {
      lines.push(i + 1);
    }
  }

  return { found: lines.length > 0, lines };
}
