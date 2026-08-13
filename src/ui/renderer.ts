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
import { Effect } from "effect";
import { match } from "ts-pattern";
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
export function withSpinner<T>(message: string, task: () => Promise<T>): Promise<T> {
  // 非 TTY（パイプ・ログリダイレクト・--yes での非対話実行）ではスピナーの
  // アニメーションを使わない。@clack の spinner は `process.env.CI === "true"`
  // のときだけフレーム描画を抑制するため、CI 環境変数が無いままパイプに流すと
  // フレーム（◒◐◓◑ + CR）を 80ms 間隔で書き続け、数百行分の制御文字でログを
  // 埋めてしまう（#84）。非 TTY では開始メッセージを 1 行だけ出し、失敗時のみ
  // 失敗行を足す。
  if (!process.stdout.isTTY) {
    return runWithoutSpinner(message, task);
  }

  const s = p.spinner();
  s.start(message);
  return Effect.runPromise(
    Effect.tryPromise({ try: () => task(), catch: (e) => e }).pipe(
      Effect.tap(() => Effect.sync(() => s.stop(message))),
      Effect.tapError(() => Effect.sync(() => s.stop(pc.red(`Failed: ${message}`)))),
    ),
  );
}

/**
 * 非 TTY 環境向けのスピナー代替。
 *
 * アニメーションせず、開始メッセージを 1 行だけ出力する。タスク失敗時のみ
 * 失敗行を追加し、エラーはそのまま伝播させる（TTY 版の s.stop(Failed) と同等の
 * 振る舞いを単一行で再現する）。成功時の完了表示は呼び出し側のログに委ねる。
 */
function runWithoutSpinner<T>(message: string, task: () => Promise<T>): Promise<T> {
  log.step(message);
  return Effect.runPromise(
    Effect.tryPromise({ try: () => task(), catch: (e) => e }).pipe(
      Effect.tapError(() => Effect.sync(() => log.error(`Failed: ${message}`))),
    ),
  );
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
    const label = match(r.action)
      .with("copied", "created", () => "added" as const)
      .with("overwritten", () => "updated" as const)
      .otherwise(() => "skipped" as const);

    if (label === "added") {
      lines.push(`${pc.green("+")} ${r.path}`);
      added++;
    } else if (label === "updated") {
      lines.push(`${pc.yellow("~")} ${r.path}`);
      updated++;
    } else {
      lines.push(`${pc.dim("-")} ${pc.dim(r.path)}`);
      skipped++;
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

  const lines = changed.map((f) =>
    match(f.type)
      .with("added", () => `${pc.green("+")} ${pc.green(f.path)}`)
      .with("modified", () => `${pc.yellow("~")} ${pc.yellow(f.path)}`)
      .with("deleted", () => `${pc.red("-")} ${pc.red(f.path)}`)
      .otherwise(() => `  ${pc.dim(f.path)}`),
  );

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

/** 予期された失敗を整形表示する。トップレベルエラーハンドラから呼ばれる。 */
export function logZikuError(error: { message: string; hint?: string }): void {
  p.log.error(error.message);
  if (error.hint) {
    p.log.message(pc.dim(error.hint));
  }
}

/** 原因の連鎖をたどる深さの上限。cause が循環していても止まるようにする。 */
const CAUSE_CHAIN_LIMIT = 5;

/**
 * 予期しないエラーを表示する。トップレベルエラーハンドラから呼ばれる。
 *
 * 予期された失敗と違い、ユーザーが取れる行動が分からない。原因を握り潰さず、
 * スタックトレースと cause の連鎖をそのまま見せて報告できる状態にする。
 */
export function logUnexpectedError(error: unknown): void {
  p.log.error("Unexpected error — this is a bug in ziku.");
  p.log.message(describeUnexpected(error));
  p.log.message(pc.dim("Please report it at https://github.com/tktcorporation/ziku/issues"));
}

/** エラーとその cause 連鎖を、スタックトレース付きの 1 つのテキストにまとめる。 */
function describeUnexpected(error: unknown): string {
  const lines: string[] = [];
  let current: unknown = error;

  for (let depth = 0; depth < CAUSE_CHAIN_LIMIT; depth++) {
    const prefix = depth === 0 ? "" : "Caused by: ";
    if (!(current instanceof Error)) {
      lines.push(`${prefix}${String(current)}`);
      return lines.join("\n");
    }
    lines.push(`${prefix}${current.stack ?? `${current.name}: ${current.message}`}`);
    if (current.cause === undefined) return lines.join("\n");
    current = current.cause;
  }

  lines.push("Caused by: ... (truncated)");
  return lines.join("\n");
}

export { pc };
