import { existsSync } from "node:fs";
import { readFile } from "node:fs/promises";
import { createPatch } from "diff";
import { join } from "pathe";
import pc from "picocolors";
import { match } from "ts-pattern";
import type { DiffResult, DiffType, FileDiff } from "../modules/schemas";
import { filterByGitignore, loadMergedGitignore } from "./gitignore";
import type { FlatPatterns } from "./patterns";
import { resolvePatterns } from "./patterns";

export interface DiffOptions {
  targetDir: string;
  templateDir: string;
  patterns: FlatPatterns;
}

/**
 * ローカルとテンプレート間の差分を検出
 */
export async function detectDiff(options: DiffOptions): Promise<DiffResult> {
  const { targetDir, templateDir, patterns } = options;

  const files: FileDiff[] = [];
  let added = 0;
  let modified = 0;
  let deleted = 0;
  let unchanged = 0;

  // ローカルとテンプレート両方の .gitignore をマージして読み込み
  const gitignore = await loadMergedGitignore([targetDir, templateDir]);

  // フラットパターンでファイル一覧を取得し、gitignore でフィルタリング
  const templateFiles = filterByGitignore(
    resolvePatterns(templateDir, patterns.include, patterns.exclude),
    gitignore,
  );
  const localFiles = filterByGitignore(
    resolvePatterns(targetDir, patterns.include, patterns.exclude),
    gitignore,
  );

  const allFiles = new Set([...templateFiles, ...localFiles]);

  for (const filePath of allFiles) {
    const localPath = join(targetDir, filePath);
    const templatePath = join(templateDir, filePath);

    const localExists = existsSync(localPath);
    const templateExists = existsSync(templatePath);

    let type: DiffType;
    let localContent: string | undefined;
    let templateContent: string | undefined;

    if (localExists) {
      localContent = await readFile(localPath, "utf-8");
    }
    if (templateExists) {
      templateContent = await readFile(templatePath, "utf-8");
    }

    if (localExists && templateExists) {
      // 両方に存在 → 内容比較
      if (localContent === templateContent) {
        type = "unchanged";
        unchanged++;
      } else {
        type = "modified";
        modified++;
      }
    } else if (localExists && !templateExists) {
      // ローカルのみ → 追加（テンプレートにはない）
      type = "added";
      added++;
    } else {
      // テンプレートのみ → 削除（ローカルにはない）
      type = "deleted";
      deleted++;
    }

    files.push({
      path: filePath,
      type,
      localContent,
      templateContent,
    });
  }

  return {
    files: files.toSorted((a, b) => a.path.localeCompare(b.path)),
    summary: { added, modified, deleted, unchanged },
  };
}

/**
 * 差分をフォーマットして表示用文字列を生成
 */
export function formatDiff(diff: DiffResult, verbose = false): string {
  const lines: string[] = [];

  // サマリー表示
  const summaryParts: string[] = [];
  if (diff.summary.added > 0) {
    summaryParts.push(pc.green(`+${diff.summary.added} added`));
  }
  if (diff.summary.modified > 0) {
    summaryParts.push(pc.yellow(`~${diff.summary.modified} modified`));
  }
  if (diff.summary.deleted > 0) {
    summaryParts.push(pc.red(`-${diff.summary.deleted} deleted`));
  }
  if (diff.summary.unchanged > 0) {
    summaryParts.push(pc.dim(`${diff.summary.unchanged} unchanged`));
  }

  if (summaryParts.length > 0) {
    lines.push(`  ${summaryParts.join(pc.dim(" │ "))}`);
    lines.push("");
  }

  // 詳細
  const changedFiles = diff.files.filter((f) => f.type !== "unchanged");
  if (changedFiles.length > 0) {
    for (const file of changedFiles) {
      const { icon, color } = getStatusStyle(file.type);
      lines.push(`  ${icon} ${color(file.path)}`);

      if (verbose && file.type === "modified") {
        lines.push(pc.dim("    └─ Content differs from template"));
      }
    }
  } else {
    lines.push(pc.dim("  No changes detected"));
  }

  return lines.join("\n");
}

interface StatusStyle {
  icon: string;
  color: (s: string) => string;
}

function getStatusStyle(type: DiffType): StatusStyle {
  return match(type)
    .with("added", () => ({ icon: pc.green("+"), color: pc.green }))
    .with("modified", () => ({ icon: pc.yellow("~"), color: pc.yellow }))
    .with("deleted", () => ({ icon: pc.red("-"), color: pc.red }))
    .with("unchanged", () => ({ icon: pc.dim(" "), color: pc.dim }))
    .exhaustive();
}

/**
 * push 対象のファイルのみをフィルタリング
 * (ローカルで追加・変更されたファイル)
 */
export function getPushableFiles(diff: DiffResult): FileDiff[] {
  return diff.files.filter((f) => f.type === "added" || f.type === "modified");
}

/**
 * 差分があるかどうかを判定
 */
export function hasDiff(diff: DiffResult): boolean {
  return diff.summary.added > 0 || diff.summary.modified > 0 || diff.summary.deleted > 0;
}

/**
 * FileDiff から unified diff 形式の文字列を生成
 */
export function generateUnifiedDiff(fileDiff: FileDiff): string {
  const { path, type, localContent, templateContent } = fileDiff;

  return match(type)
    .with("added", () => createPatch(path, "", localContent || "", "template", "local"))
    .with("modified", () =>
      createPatch(path, templateContent || "", localContent || "", "template", "local"),
    )
    .otherwise(() => "");
}

/**
 * unified diff にカラーを適用
 * (テスト互換性のため、直接 ANSI エスケープシーケンスを使用)
 */
export function colorizeUnifiedDiff(diff: string): string {
  return diff
    .split("\n")
    .map((line) => {
      if (line.startsWith("+++") || line.startsWith("---")) {
        return `\u001B[1m${line}\u001B[0m`; // Bold
      }
      if (line.startsWith("+")) return `\u001B[32m${line}\u001B[0m`; // Green
      if (line.startsWith("-")) return `\u001B[31m${line}\u001B[0m`; // Red
      if (line.startsWith("@@")) return `\u001B[36m${line}\u001B[0m`; // Cyan
      return line;
    })
    .join("\n");
}
