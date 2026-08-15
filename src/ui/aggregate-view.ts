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
 * ヘッダー行の括弧内に添える補足（skipped 件数・`--since` による除外件数）を作る。
 * どちらも 0 件なら空配列を返し、呼び出し側は括弧そのものを省略する。
 */
function headerNotes(report: AggregateReport): string[] {
  const notes: string[] = [];
  if (report.skipped.length > 0) {
    notes.push(`${pc.bold(String(report.skipped.length))} skipped — see below`);
  }
  if (report.summary.excludedBySince > 0) {
    notes.push(`${pc.bold(String(report.summary.excludedBySince))} excluded by --since`);
  }
  return notes;
}

/**
 * ヘッダー行（テンプレートと集計件数のサマリ）を作る。
 *
 * `summary.totalRepositories` は `--since` フィルタと `skipped` 適用後の件数であり
 * 「テンプレートを使っているリポジトリ数」ではない。「使っている数」と誤読されないよう、
 * レポートに載った件数であることを明示し、skipped / `--since` による除外があれば
 * 同じ行で件数を示す（読み手が両者を区別できるようにする）。
 */
function renderHeaderLine(report: AggregateReport): string {
  const total = report.summary.totalRepositories;
  const notes = headerNotes(report);
  if (notes.length === 0) {
    return `Report includes ${pc.bold(String(total))} repositories.`;
  }
  return `Report includes ${pc.bold(String(total))} repositories (${notes.join(", ")}).`;
}

/**
 * long モード（既定・非 `--json`）の出力を生成する。
 * `clack/prompts` の log.message に渡す前提のプレーン文字列を返す。
 */
export function renderAggregateSummary(report: AggregateReport): string {
  const lines: string[] = [
    `Template: ${pc.cyan(`${report.template.owner}/${report.template.repo}`)} ${pc.dim(`@ ${report.template.ref.slice(0, 7)}`)}`,
    renderHeaderLine(report),
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
 * `totalRepositories === 0` のとき、その理由を読み手に伝える 1 文を組み立てる。
 * skipped と `--since` による除外は互いに独立した理由なので両方あれば両方書く。
 */
function zeroRepositoriesReason(report: AggregateReport): string | undefined {
  const reasons: string[] = [];
  if (report.skipped.length > 0) {
    reasons.push(
      `${report.skipped.length} repositories could not be processed (see Skipped above)`,
    );
  }
  if (report.summary.excludedBySince > 0) {
    reasons.push(
      `${report.summary.excludedBySince} repositories use this template but had no changes on or after --since`,
    );
  }
  if (reasons.length === 0) return undefined;
  return `No repositories included in the report — ${reasons.join("; ")}. This does not mean no repositories use this template.`;
}

/**
 * outro（コマンド末尾の 1 行案内）を生成する。
 *
 * `aggregate` はレポートを作るだけで統合（push）は行わないため、次の行動として
 * 「このレポートを後段のエージェント/オペレーターに渡す」ことを明示する。
 *
 * `totalRepositories === 0` は「レポートに載った件数が 0」であって「テンプレートを
 * 使っているリポジトリが無い」ことの証明ではない。skipped または `--since` による
 * 除外が 1 件以上あるなら、実際には利用リポジトリが見つかったが処理できなかった／
 * 変更が `--since` より古かっただけの可能性があるため、「無かった」と読めるメッセージを
 * 出さずその件数を案内する（{@link zeroRepositoriesReason}）。
 */
export function aggregateOutroLine(report: AggregateReport): string {
  if (report.summary.totalRepositories === 0) {
    const reason = zeroRepositoriesReason(report);
    if (reason !== undefined) return pc.yellow(reason);
    return pc.dim("No repositories found using this template.");
  }
  return `${pc.cyan("→")} Read-only report generated. Pass the JSON (--json / --out) to an agent or operator to consolidate diffs back into the template — this command does not push changes itself.`;
}
