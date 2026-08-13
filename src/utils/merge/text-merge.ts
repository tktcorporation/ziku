import { diff3Merge } from "node-diff3";
import { match } from "ts-pattern";
import { type ConflictMarkers, conflictMarkerSize, conflictMarkers } from "./conflict-markers";
import { validateStructuredContent } from "./file-detection";
import { type MergeOutcome, classifyMergeOutcome } from "./types";

// ---- テキスト 3-way マージ ----

/**
 * GNU diff3 と同等の行レベル 3-way マージ。
 *
 * base/local/template の3者を比較し、同じ領域を両側が異なる内容へ変更した場合は
 * 必ずコンフリクトにする。「パッチが物理的に適用可能か」だけを見る patch 適用系の
 * 手法と違い、片側の変更がサイレントに消えたり内容が二重化したりしない。
 *
 * @param filePath 構造ファイル（JSON/TOML/YAML）の検証に使う。省略すると検証しない。
 */
export function textThreeWayMerge(
  base: string,
  local: string,
  template: string,
  filePath?: string,
): MergeOutcome {
  const markers = conflictMarkers(conflictMarkerSize([base, local, template]));

  // node-diff3: diff3Merge(a, o, b) — a=local, o=base, b=template
  const regions = diff3Merge(local.split("\n"), base.split("\n"), template.split("\n"));

  const resultLines: string[] = [];

  for (const region of regions) {
    if ("ok" in region && region.ok) {
      resultLines.push(...region.ok);
    } else if ("conflict" in region && region.conflict) {
      resultLines.push(
        markers.local,
        ...region.conflict.a,
        markers.base,
        ...region.conflict.o,
        markers.separator,
        ...region.conflict.b,
        markers.template,
      );
    }
  }

  // 構造ファイル（JSON/TOML/YAML）のクリーンな結果はパースで検証する。
  // diff3Merge は行レベルで競合を判定するため、構造的に壊れた出力を
  // クリーンマージとして返す可能性がある。検証に失敗した場合はファイル全体を
  // 1 つのコンフリクトブロックにして、壊れたファイルの生成を防ぐ。
  return match(classifyMergeOutcome(resultLines.join("\n")))
    .with({ _tag: "Conflicted" }, (outcome) => outcome)
    .with({ _tag: "Clean" }, (outcome) =>
      filePath === undefined || validateStructuredContent(outcome.content, filePath)
        ? outcome
        : classifyMergeOutcome(wholeFileConflict({ base, local, template, markers })),
    )
    .exhaustive();
}

/**
 * ファイル全体を 1 つのコンフリクトブロックにする。
 *
 * 各セクションは行へ分解してから結合する。末尾改行付きの内容をそのまま連結すると
 * 次のマーカーの直前に空行が入り、ファイル末尾の改行も失われる。
 */
function wholeFileConflict(params: {
  base: string;
  local: string;
  template: string;
  markers: ConflictMarkers;
}): string {
  const { base, local, template, markers } = params;
  const lines = [
    markers.local,
    ...toLines(local),
    markers.base,
    ...toLines(base),
    markers.separator,
    ...toLines(template),
    markers.template,
  ];
  // 最終行はマーカーなので必ず改行で終端する（git のマーカー出力と同じ）。
  return `${lines.join("\n")}\n`;
}

/** 内容を行へ分解する。末尾改行は行の区切りとして扱い、空行を作らない。 */
function toLines(content: string): string[] {
  const lines = content.split("\n");
  return lines.at(-1) === "" ? lines.slice(0, -1) : lines;
}
