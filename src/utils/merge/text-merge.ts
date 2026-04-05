import { applyPatch, createPatch, structuredPatch } from "diff";
import { validateStructuredContent } from "./file-detection";
import type { MergeResult } from "./types";

// ---- テキスト 3-way マージ ----

/**
 * Git と同様の行レベル 3-way マージ。
 *
 * 戦略（git merge に準拠）:
 *   1. 標準パッチ適用（fuzz=0, git apply 相当）→ 全 hunk 成功ならクリーンマージ
 *   2. 失敗時: hunk 単位で個別適用。成功した hunk はクリーンマージ、
 *      失敗した hunk にのみコンフリクトマーカーを付与
 *
 * fuzz factor は使わない。git の merge も fuzz を使わず、
 * 厳密なコンテキストマッチングでコンフリクトを検出する。
 */
export function textThreeWayMerge(
  base: string,
  local: string,
  template: string,
  filePath?: string,
): MergeResult {
  // ステップ 1: 標準パッチ適用（git apply 相当）
  const patch = createPatch("file", base, template);
  const result = applyPatch(local, patch);
  if (typeof result === "string") {
    // 構造ファイルの場合、パッチ適用結果を検証
    if (filePath && !validateStructuredContent(result, filePath)) {
      return mergeWithPerHunkMarkers(base, local, template);
    }
    return { content: result, hasConflicts: false, conflictDetails: [] };
  }

  // ステップ 2: hunk 単位でコンフリクトマーカーを付与
  return mergeWithPerHunkMarkers(base, local, template);
}

/**
 * hunk 単位でパッチを適用し、失敗した hunk のみにコンフリクトマーカーを付与する。
 *
 * 背景: ファイル全体をマーカーで囲むとファイルが完全に壊れる。
 * hunk 単位にすることで、成功した部分は正常なまま保持され、
 * コンフリクト箇所だけがマーカー付きになる。
 */
function mergeWithPerHunkMarkers(base: string, local: string, template: string): MergeResult {
  const patchObj = structuredPatch("file", "file", base, template);
  const localLines = local.split("\n");

  const resultLines: string[] = [];
  let localIdx = 0;
  let hasConflicts = false;

  for (const hunk of patchObj.hunks) {
    const hunkLocalStart = hunk.oldStart - 1;

    // hunk の前の未処理行を出力
    while (localIdx < hunkLocalStart && localIdx < localLines.length) {
      resultLines.push(localLines[localIdx]);
      localIdx++;
    }

    const hunkApplied = tryApplyHunk(localLines, hunk);

    if (hunkApplied === null) {
      // hunk 適用失敗 → この hunk 部分だけにコンフリクトマーカー
      hasConflicts = true;

      const localSection: string[] = [];
      for (let i = 0; i < hunk.oldLines && hunkLocalStart + i < localLines.length; i++) {
        localSection.push(localLines[hunkLocalStart + i]);
      }

      const templateSection: string[] = [];
      for (const line of hunk.lines) {
        if (line.startsWith("+")) {
          templateSection.push(line.slice(1));
        } else if (line.startsWith(" ")) {
          templateSection.push(line.slice(1));
        }
        // '-' 行はローカル側（localSection に含まれる）
      }

      resultLines.push("<<<<<<< LOCAL");
      resultLines.push(...localSection);
      resultLines.push("=======");
      resultLines.push(...templateSection);
      resultLines.push(">>>>>>> TEMPLATE");

      localIdx = hunkLocalStart + hunk.oldLines;
    } else {
      resultLines.push(...hunkApplied);
      localIdx = hunkLocalStart + hunk.oldLines;
    }
  }

  // 残りの行を出力
  while (localIdx < localLines.length) {
    resultLines.push(localLines[localIdx]);
    localIdx++;
  }

  return {
    content: resultLines.join("\n"),
    hasConflicts,
    conflictDetails: [],
  };
}

/**
 * 単一の hunk をローカル行に適用する（git merge ライクな行レベル判定）。
 *
 * git merge と同様に、コンフリクト判定は **変更行のみ** で行う:
 *   - コンテキスト行（` ` prefix）: ローカルの行をそのまま採用
 *   - 削除行（`-` prefix）: ローカルが同じ行を変更していたら真のコンフリクト
 *   - 追加行（`+` prefix）: テンプレートの追加行をそのまま挿入
 *
 * @returns 適用成功時は新しい行の配列。コンフリクト時は null。
 */
function tryApplyHunk(
  localLines: string[],
  hunk: { oldStart: number; oldLines: number; lines: string[] },
): string[] | null {
  const startIdx = hunk.oldStart - 1;

  let oldLineCount = 0;
  for (const line of hunk.lines) {
    if (line[0] === " " || line[0] === "-") {
      oldLineCount++;
    }
  }

  if (startIdx + oldLineCount > localLines.length) {
    return null;
  }

  const resultLines: string[] = [];
  let oldIdx = 0;

  for (const line of hunk.lines) {
    const op = line[0];
    const content = line.slice(1);

    if (op === " ") {
      // コンテキスト行: ローカルの行を採用（独立した変更を保持）
      resultLines.push(localLines[startIdx + oldIdx]);
      oldIdx++;
    } else if (op === "-") {
      // 削除行: ローカルが同じ行を変更していたら真のコンフリクト
      if (localLines[startIdx + oldIdx] !== content) {
        return null;
      }
      oldIdx++;
    } else if (op === "+") {
      resultLines.push(content);
    }
    // `\` (No newline at end of file) 等はスキップ
  }

  return resultLines;
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
