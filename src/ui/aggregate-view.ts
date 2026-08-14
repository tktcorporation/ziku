/**
 * `ziku aggregate` の表示ロジック。
 *
 * status-view.ts と同じ設計方針: 「AggregateReport を文字列に変換する」純粋関数を
 * 提供し、I/O は呼び出し側（aggregate コマンド）で行う。テストしやすさを優先する。
 */
import pc from "picocolors";
import type { AggregateReport, AggregateRepositoryReport } from "../modules/schemas";

/**
 * 1 リポジトリ分の要約行を作る。
 *
 * pendingPush（未還元）と conflicts（衝突）はファイルパスを列挙する。
 * pendingPull（未配布）はテンプレート側発の変更でありユーザーの行動を要さないため、
 * 件数のみ表示しパス一覧は省略する（`status` の untracked と同様、情報の優先度を絞る）。
 */
function renderRepositoryLines(repo: AggregateRepositoryReport): string[] {
  const counts = [
    `pendingPush ${repo.pendingPush.length}`,
    `pendingPull ${repo.pendingPull.length}`,
    `conflicts ${repo.conflicts.length}`,
  ].join(", ");

  const lines = [`  ${pc.bold(`${repo.owner}/${repo.repo}`)}  ${pc.dim(`(${counts})`)}`];

  if (repo.pendingPush.length > 0) {
    lines.push(`    ${pc.green("pendingPush (not yet in template):")}`);
    for (const entry of repo.pendingPush) {
      lines.push(`      ${pc.dim("•")} ${entry.path} ${pc.dim(`(${entry.reason})`)}`);
    }
  }

  if (repo.conflicts.length > 0) {
    lines.push(`    ${pc.yellow("conflicts (both sides changed):")}`);
    for (const entry of repo.conflicts) {
      lines.push(`      ${pc.dim("•")} ${entry.path}`);
    }
  }

  return lines;
}

/**
 * skipped セクションを描画する。
 *
 * 理由まで含めて必ず表示する。黙って落とすと「対象リポジトリが無かった」と
 * 誤読される（実際は権限不足・lock.json 破損等で棚卸しできなかっただけの場合がある）。
 */
function renderSkippedLines(report: AggregateReport): string[] {
  if (report.skipped.length === 0) return [];
  const lines = [`  ${pc.yellow("⚠")} ${pc.bold("Skipped")} (${report.skipped.length})`];
  for (const s of report.skipped) {
    lines.push(`    ${pc.dim("•")} ${s.owner}/${s.repo} ${pc.dim(`— ${s.reason}`)}`);
  }
  return lines;
}

/**
 * long モード（既定・非 `--json`）の出力を生成する。
 * `clack/prompts` の log.message に渡す前提のプレーン文字列を返す。
 */
export function renderAggregateSummary(report: AggregateReport): string {
  const lines: string[] = [
    `Template: ${pc.cyan(`${report.template.owner}/${report.template.repo}`)} ${pc.dim(`@ ${report.template.ref.slice(0, 7)}`)}`,
    `Found ${pc.bold(String(report.summary.totalRepositories))} repositories using this template.`,
  ];

  if (report.repositories.length > 0) {
    lines.push("");
    for (const repo of report.repositories) {
      lines.push(...renderRepositoryLines(repo));
    }
  }

  const skippedLines = renderSkippedLines(report);
  if (skippedLines.length > 0) {
    lines.push("");
    lines.push(...skippedLines);
  }

  return lines.join("\n");
}

/**
 * outro（コマンド末尾の 1 行案内）を生成する。
 *
 * `aggregate` はレポートを作るだけで統合（push）は行わないため、次の行動として
 * 「このレポートを後段のエージェント/オペレーターに渡す」ことを明示する。
 */
export function aggregateOutroLine(report: AggregateReport): string {
  if (report.summary.totalRepositories === 0) {
    return pc.dim("No repositories found using this template.");
  }
  return `${pc.cyan("→")} Read-only report generated. Pass the JSON (--json / --out) to an agent or operator to consolidate diffs back into the template — this command does not push changes itself.`;
}
