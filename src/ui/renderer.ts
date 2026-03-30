/**
 * 統一出力インターフェース — @clack/prompts のラッパー
 *
 * 背景: showHeader(), box(), showNextSteps(), log, withSpinner() 等の
 * 散在した UI 関数を @clack/prompts ベースで統一するために導入。
 * 全コマンドはこのモジュール経由で出力する。
 *
 * 削除条件: ziku が別の UI フレームワーク（ink 等）に移行する場合。
 */
import * as p from "@clack/prompts";
import pc from "picocolors";

declare const __VERSION__: string;
const version = typeof __VERSION__ !== "undefined" ? __VERSION__ : "dev";

/** 各コマンドの非インタラクティブ用法ヒント */
const nonInteractiveHints: Record<string, string> = {
  init: "Non-interactive: ziku init --yes  or  ziku init --modules <ids> -s skip",
  push: "Non-interactive: ziku push --yes --files <paths> -m <title>",
  pull: "Non-interactive: ziku pull --force",
  diff: "Non-interactive: ziku diff --verbose",
};

/** CLI の開始表示 */
export function intro(command?: string): void {
  const title = command ? `ziku ${command}` : "ziku";
  p.intro(`${pc.bgCyan(pc.black(` ${title} `))} ${pc.dim(`v${version}`)}`);
  if (command && nonInteractiveHints[command]) {
    p.log.message(pc.dim(nonInteractiveHints[command]));
  }
}

/** CLI の終了表示 */
export function outro(message: string): void {
  p.outro(message);
}

/** 構造化ログ — @clack/prompts の log を re-export */
export const log = {
  info: (message: string) => p.log.info(message),
  success: (message: string) => p.log.success(message),
  warn: (message: string) => p.log.warn(message),
  error: (message: string) => p.log.error(message),
  step: (message: string) => p.log.step(message),
  message: (message: string) => p.log.message(message),
};

/** スピナー付きで非同期タスクを実行 */
export async function withSpinner<T>(message: string, task: () => Promise<T>): Promise<T> {
  const s = p.spinner();
  s.start(message);
  try {
    const result = await task();
    s.stop(message);
    return result;
  } catch (error) {
    s.stop(pc.red(`Failed: ${message}`));
    throw error;
  }
}

/** ファイル操作結果を表示（init コマンド用） */
export function logFileResults(results: { action: string; path: string }[]): {
  added: number;
  updated: number;
  skipped: number;
} {
  let added = 0;
  let updated = 0;
  let skipped = 0;

  const lines: string[] = [];
  for (const r of results) {
    switch (r.action) {
      case "copied":
      case "created":
        lines.push(`${pc.green("+")} ${r.path}`);
        added++;
        break;
      case "overwritten":
        lines.push(`${pc.yellow("~")} ${r.path}`);
        updated++;
        break;
      default:
        lines.push(`${pc.dim("-")} ${pc.dim(r.path)}`);
        skipped++;
        break;
    }
  }

  const summary = [
    added > 0 ? pc.green(`${added} added`) : null,
    updated > 0 ? pc.yellow(`${updated} updated`) : null,
    skipped > 0 ? pc.dim(`${skipped} skipped`) : null,
  ]
    .filter(Boolean)
    .join(", ");

  p.log.message([...lines, "", summary].join("\n"));

  return { added, updated, skipped };
}

/** diff サマリーを表示（push/diff コマンド用） */
export function logDiffSummary(files: { path: string; type: string }[]): void {
  const changed = files.filter((f) => f.type !== "unchanged");
  if (changed.length === 0) {
    p.log.info("No changes detected");
    return;
  }

  const lines = changed.map((f) => {
    switch (f.type) {
      case "added":
        return `${pc.green("+")} ${pc.green(f.path)}`;
      case "modified":
        return `${pc.yellow("~")} ${pc.yellow(f.path)}`;
      case "deleted":
        return `${pc.red("-")} ${pc.red(f.path)}`;
      default:
        return `  ${pc.dim(f.path)}`;
    }
  });

  const summary = files.reduce(
    (acc, f) => {
      if (f.type === "added") acc.added++;
      else if (f.type === "modified") acc.modified++;
      else if (f.type === "deleted") acc.deleted++;
      return acc;
    },
    { added: 0, modified: 0, deleted: 0 },
  );

  const summaryParts = [
    summary.added > 0 ? pc.green(`+${summary.added} added`) : null,
    summary.modified > 0 ? pc.yellow(`~${summary.modified} modified`) : null,
    summary.deleted > 0 ? pc.red(`-${summary.deleted} deleted`) : null,
  ]
    .filter(Boolean)
    .join(pc.dim(" | "));

  p.log.message([...lines, "", summaryParts].join("\n"));
}

/** BermError を整形表示 */
export function logBermError(error: { message: string; hint?: string }): void {
  p.log.error(error.message);
  if (error.hint) {
    p.log.message(pc.dim(error.hint));
  }
}

export { pc };
