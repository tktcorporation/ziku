import { describe, expect, it } from "vitest";
import type { AggregateReport, CommitSha } from "../../modules/schemas";
import { commitShaSchema } from "../../modules/schemas";
import { aggregateOutroLine, renderAggregateSummary } from "../aggregate-view";

/** テスト用の commit SHA を brand する。 */
function sha(value: string): CommitSha {
  return commitShaSchema.parse(value);
}

/**
 * ANSI SGR エスケープシーケンス（ESC + `[` + 数値 + `m`）を取り除き、素のテキストで比較する。
 * RegExp コンストラクタに ESC を動的に流し込むことで、正規表現リテラル内に制御文字を
 * 直書きするのを避けている（lint の no-control-regex 回避 + ソース可読性向上）。
 */
const ESC = String.fromCodePoint(0x1b);
const ANSI_SGR_PATTERN = new RegExp(`${ESC}\\[[0-9;]*m`, "g");
function strip(s: string): string {
  return s.replaceAll(ANSI_SGR_PATTERN, "");
}

function makeReport(overrides: Partial<AggregateReport> = {}): AggregateReport {
  return {
    template: { owner: "acme", repo: "template", ref: sha("abc1234567890") },
    generatedAt: "2026-01-01T00:00:00.000Z",
    repositories: [],
    skipped: [],
    summary: {
      totalRepositories: 0,
      repositoriesWithPendingPush: 0,
      pendingPushFiles: 0,
      conflictFiles: 0,
      excludedBySince: 0,
    },
    ...overrides,
  };
}

describe("renderAggregateSummary", () => {
  it("skipped が無ければ件数のみを表示する", () => {
    const report = makeReport({
      repositories: [
        {
          owner: "acme",
          repo: "consumer-a",
          defaultBranch: "main",
          ref: sha("deadbeef"),
          pendingPush: [],
          pendingPull: [],
          conflicts: [],
        },
      ],
      summary: {
        totalRepositories: 1,
        repositoriesWithPendingPush: 0,
        pendingPushFiles: 0,
        conflictFiles: 0,
        excludedBySince: 0,
      },
    });

    const line = strip(renderAggregateSummary(report));
    expect(line).toContain("Report includes 1 repositories.");
  });

  it("skipped があれば、レポート件数と skipped 件数を区別して表示する", () => {
    const report = makeReport({
      repositories: [
        {
          owner: "acme",
          repo: "consumer-a",
          defaultBranch: "main",
          ref: sha("deadbeef"),
          pendingPush: [],
          pendingPull: [],
          conflicts: [],
        },
      ],
      skipped: [{ owner: "acme", repo: "broken", reason: "Failed to fetch lock.json" }],
      summary: {
        totalRepositories: 1,
        repositoriesWithPendingPush: 0,
        pendingPushFiles: 0,
        conflictFiles: 0,
        excludedBySince: 0,
      },
    });

    const line = strip(renderAggregateSummary(report));
    // レポートに載った件数 (1) と skipped の件数 (1) が読み手に区別できること。
    expect(line).toContain("Report includes 1 repositories (1 skipped — see below).");
  });

  it("--since で除外された件数があれば、レポート件数と区別して表示する", () => {
    const report = makeReport({
      summary: {
        totalRepositories: 0,
        repositoriesWithPendingPush: 0,
        pendingPushFiles: 0,
        conflictFiles: 0,
        excludedBySince: 2,
      },
    });

    const line = strip(renderAggregateSummary(report));
    expect(line).toContain("Report includes 0 repositories (2 excluded by --since).");
  });
});

describe("aggregateOutroLine", () => {
  it("repositories が 0 件かつ skipped も 0 件なら「見つからなかった」と案内する", () => {
    const report = makeReport();
    expect(strip(aggregateOutroLine(report))).toContain(
      "No repositories found using this template.",
    );
  });

  it("repositories が 0 件でも skipped が 1 件以上あれば「見つからなかった」と読めるメッセージを出さない", () => {
    const report = makeReport({
      skipped: [{ owner: "acme", repo: "rate-limited", reason: "Rate limited" }],
    });

    const line = strip(aggregateOutroLine(report));
    expect(line).not.toContain("No repositories found using this template.");
    // skipped の件数と、"0 件 = 使っているリポジトリが無い" ではないことを案内する。
    expect(line).toContain("1 repositories could not be processed");
  });

  it("--since で全件除外された場合（repositories=0, skipped=0, excludedBySince>0）は「見つからなかった」と読めるメッセージを出さない", () => {
    const report = makeReport({
      summary: {
        totalRepositories: 0,
        repositoriesWithPendingPush: 0,
        pendingPushFiles: 0,
        conflictFiles: 0,
        excludedBySince: 3,
      },
    });

    const line = strip(aggregateOutroLine(report));
    expect(line).not.toContain("No repositories found using this template.");
    expect(line).toContain(
      "3 repositories use this template but had no changes on or after --since",
    );
  });

  it("repositories が 1 件以上あれば通常の案内を返す", () => {
    const report = makeReport({
      repositories: [
        {
          owner: "acme",
          repo: "consumer-a",
          defaultBranch: "main",
          ref: sha("deadbeef"),
          pendingPush: [],
          pendingPull: [],
          conflicts: [],
        },
      ],
      summary: {
        totalRepositories: 1,
        repositoriesWithPendingPush: 0,
        pendingPushFiles: 0,
        conflictFiles: 0,
        excludedBySince: 0,
      },
    });

    const line = strip(aggregateOutroLine(report));
    expect(line).toContain("Read-only report generated.");
  });
});
