/**
 * `ziku aggregate` の表示ロジック。
 *
 * status-view.ts と同じ設計方針: 「AggregateReport を文字列に変換する」純粋関数を
 * 提供し、I/O は呼び出し側（aggregate コマンド）で行う。テストしやすさを優先する。
 */
import pc from "picocolors";
import { match } from "ts-pattern";
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
 * レポートが「網羅的ではないかもしれない」理由。ヘッダーの補足（{@link headerNotes}）と
 * 0 件時の案内（{@link zeroRepositoriesReason}）の双方が同じ判定条件を参照する
 * SSOT。どちらか一方だけを更新すると、0 件のときにヘッダーの注記と outro の文言が
 * 食い違う（ヘッダーは絞り込みを示すのに outro は「テンプレート利用リポジトリが
 * 無い」と読める）。
 *
 * 候補数上限による打ち切りは、`renderSkippedLines` / `aggregateOutroLine` と同じ設計意図
 * （0 件は「使っているリポジトリが無い」ことの証明ではない）を、候補の絞り込みそのものに
 * まで広げたもの。owner 配下に候補数上限を超えるリポジトリがあると、その分はそもそも
 * テンプレート利用の判定すら受けていない。`candidatesScanned >= candidateScanLimit` は
 * 近似であり、常に正確に打ち切りの有無を表すとは限らない（近似の理由は `modules/schemas.ts`
 * の `candidateScanLimit` を参照）。
 *
 * 直近 push フィルタは、候補数上限とは異なり「実際に除外が起きたか」を検知できない
 * （`listOwnerRepos` が早期終了した件数はレポートに残らない）ため、フィルタが適用されている
 * こと自体を常に示す。owner 配下の全リポジトリがこの下限より前にしか push されていない場合、
 * `totalRepositories: 0` だけでは「利用リポジトリが無い」のか「直近 push フィルタで最初から
 * 対象に入らなかった」のか読み手が区別できない。
 */
type IncompleteScanCause =
  | { readonly _tag: "skipped"; readonly count: number }
  | { readonly _tag: "excludedBySince"; readonly count: number }
  | { readonly _tag: "candidateScanLimitReached"; readonly limit: number }
  | { readonly _tag: "recentPushFiltered"; readonly since: string };

function detectIncompleteScanCauses(report: AggregateReport): readonly IncompleteScanCause[] {
  const causes: IncompleteScanCause[] = [];
  if (report.skipped.length > 0) {
    causes.push({ _tag: "skipped", count: report.skipped.length });
  }
  if (report.summary.excludedBySince > 0) {
    causes.push({ _tag: "excludedBySince", count: report.summary.excludedBySince });
  }
  const { candidateScanLimit, candidatesScanned, recentPushSince } = report.summary;
  if (candidateScanLimit !== undefined && candidatesScanned >= candidateScanLimit) {
    causes.push({ _tag: "candidateScanLimitReached", limit: candidateScanLimit });
  }
  if (recentPushSince !== undefined) {
    causes.push({ _tag: "recentPushFiltered", since: recentPushSince });
  }
  return causes;
}

/**
 * ヘッダー行の括弧内に添える、{@link IncompleteScanCause} 1 件分の短い注記（bold 強調あり）。
 */
function headerNoteFor(cause: IncompleteScanCause): string {
  return match(cause)
    .with({ _tag: "skipped" }, (c) => `${pc.bold(String(c.count))} skipped — see below`)
    .with({ _tag: "excludedBySince" }, (c) => `${pc.bold(String(c.count))} excluded by --since`)
    .with(
      { _tag: "candidateScanLimitReached" },
      (c) =>
        `candidate scan stopped at ${pc.bold(String(c.limit))} — the owner may have more repositories that were not checked`,
    )
    .with(
      { _tag: "recentPushFiltered" },
      (c) => `only repositories pushed on/after ${pc.bold(c.since)} were scanned`,
    )
    .exhaustive();
}

/**
 * ヘッダー行の括弧内に添える補足（skipped 件数・`--since` による除外件数・候補数上限による
 * 打ち切り・直近 push フィルタの下限）を作る。いずれも該当が無ければ空配列を返し、
 * 呼び出し側は括弧そのものを省略する。
 */
function headerNotes(report: AggregateReport): string[] {
  return detectIncompleteScanCauses(report).map((cause) => headerNoteFor(cause));
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

/** {@link zeroRepositoriesReason} が並べる、{@link IncompleteScanCause} 1 件分の説明文。 */
function zeroRepositoriesReasonFor(cause: IncompleteScanCause): string {
  return match(cause)
    .with(
      { _tag: "skipped" },
      (c) => `${c.count} repositories could not be processed (see Skipped above)`,
    )
    .with(
      { _tag: "excludedBySince" },
      (c) => `${c.count} repositories use this template but had no changes on or after --since`,
    )
    .with(
      { _tag: "candidateScanLimitReached" },
      (c) =>
        `the candidate scan stopped at ${c.limit} repositories — the owner may have more that were not checked`,
    )
    .with(
      { _tag: "recentPushFiltered" },
      (c) => `only repositories pushed on/after ${c.since} were scanned`,
    )
    .exhaustive();
}

/**
 * `totalRepositories === 0` のとき、その理由を読み手に伝える 1 文を組み立てる。
 * 該当する理由は互いに独立しているので、複数あれば全て書く。
 */
function zeroRepositoriesReason(report: AggregateReport): string | undefined {
  const causes = detectIncompleteScanCauses(report);
  if (causes.length === 0) return undefined;
  const reasons = causes.map((cause) => zeroRepositoriesReasonFor(cause));
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
