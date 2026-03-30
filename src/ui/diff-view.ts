/**
 * Diff 表示コンポーネント
 *
 * 背景: utils/diff-viewer.ts (682行) を再構築。
 * cli-highlight を削除し picocolors のみで表示。
 * readline raw mode のインタラクティブビューアを削除し、
 * 単純な出力に変更（less にパイプ可能）。
 * 統計計算・word diff ロジックは維持。
 *
 * 削除条件: ziku が TUI フレームワーク（ink 等）に移行する場合。
 */
import * as p from "@clack/prompts";
import { diffWords } from "diff";
import pc from "picocolors";
import type { FileDiff } from "../modules/schemas";
import { generateUnifiedDiff } from "../utils/diff";

// ─── 統計計算 ──────────────────────────────────────────────────

export interface DiffStats {
  readonly additions: number;
  readonly deletions: number;
}

/**
 * テキストの実際の行数をカウントする。
 *
 * 背景: `"a\nb\n".split("\n").length` は 3 を返すが、実際の行数は 2。
 * 末尾の改行を除去してからカウントすることで正確な行数を得る。
 */
function countLines(content: string): number {
  if (!content) return 0;
  const normalized = content.endsWith("\n") ? content.slice(0, -1) : content;
  if (normalized === "") return 0;
  return normalized.split("\n").length;
}

/** ファイルの差分統計を計算 */
export function calculateDiffStats(fileDiff: FileDiff): DiffStats {
  switch (fileDiff.type) {
    case "unchanged":
      return { additions: 0, deletions: 0 };
    case "deleted":
      return {
        additions: 0,
        deletions: countLines(fileDiff.templateContent ?? ""),
      };
    case "added":
      return {
        additions: countLines(fileDiff.localContent ?? ""),
        deletions: 0,
      };
    case "modified": {
      const diff = generateUnifiedDiff(fileDiff);
      let additions = 0;
      let deletions = 0;
      for (const line of diff.split("\n")) {
        if (line.startsWith("+") && !line.startsWith("+++")) additions++;
        else if (line.startsWith("-") && !line.startsWith("---")) deletions++;
      }
      return { additions, deletions };
    }
  }
}

/** 統計フォーマット (+10 -5) */
export function formatStats(stats: DiffStats): string {
  const parts: string[] = [];
  if (stats.additions > 0) parts.push(pc.green(`+${stats.additions}`));
  if (stats.deletions > 0) parts.push(pc.red(`-${stats.deletions}`));
  return parts.length === 0 ? pc.dim("(no changes)") : parts.join(" ");
}

// ─── Diff 表示 ─────────────────────────────────────────────────

/** 単一ファイルの diff を表示 */
export function renderFileDiff(file: FileDiff): void {
  const stats = calculateDiffStats(file);
  const typeLabel =
    file.type === "added"
      ? pc.green("added")
      : file.type === "modified"
        ? pc.yellow("modified")
        : pc.red("deleted");

  p.log.step(`${pc.bold(file.path)} ${pc.dim("—")} ${typeLabel} ${formatStats(stats)}`);

  if (file.type === "unchanged") return;

  const diff = generateUnifiedDiff(file);
  if (!diff) return;

  const lines = diff
    .split("\n")
    .filter(
      (l) =>
        !l.startsWith("Index:") &&
        !l.startsWith("===") &&
        !l.startsWith("---") &&
        !l.startsWith("+++"),
    );

  const rendered = applyWordDiffAndColorize(lines);
  p.log.message(rendered.join("\n"));
}

/**
 * Diff 行に word diff + 色を適用
 *
 * 隣接する deletion/addition ペアを検出し、diffWords で
 * 変更箇所を背景色でハイライトする。それ以外の行は通常の色付け。
 */
function applyWordDiffAndColorize(lines: string[]): string[] {
  const result: string[] = [];
  let i = 0;

  while (i < lines.length) {
    const line = lines[i];

    // deletion + addition ペアを検出して word diff
    if (
      line.startsWith("-") &&
      !line.startsWith("---") &&
      i + 1 < lines.length &&
      lines[i + 1].startsWith("+") &&
      !lines[i + 1].startsWith("+++")
    ) {
      const oldText = line.slice(1);
      const newText = lines[i + 1].slice(1);
      const changes = diffWords(oldText, newText);

      let oldLine = pc.red("-");
      let newLine = pc.green("+");
      for (const change of changes) {
        if (change.added) {
          newLine += pc.bgGreen(pc.black(change.value));
        } else if (change.removed) {
          oldLine += pc.bgRed(pc.white(change.value));
        } else {
          oldLine += change.value;
          newLine += change.value;
        }
      }
      result.push(oldLine, newLine);
      i += 2;
      continue;
    }

    // 通常の行
    if (line.startsWith("@@")) {
      result.push(pc.cyan(line));
    } else if (line.startsWith("+")) {
      result.push(pc.green(line));
    } else if (line.startsWith("-")) {
      result.push(pc.red(line));
    } else {
      result.push(line);
    }
    i++;
  }

  return result;
}

/** ファイル選択用ラベル */
export function getFileLabel(file: FileDiff): string {
  const stats = calculateDiffStats(file);
  const icon =
    file.type === "added" ? pc.green("+") : file.type === "modified" ? pc.yellow("~") : pc.red("-");
  return `${icon} ${file.path} ${formatStats(stats)}`;
}
