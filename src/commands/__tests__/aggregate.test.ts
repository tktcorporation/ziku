import { vol } from "memfs";
import { Effect } from "effect";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { ZikuError, GitHubApiError } from "../../errors";
import type { AggregateReport } from "../../modules/schemas";

// fs モジュールをモック（--out のファイル書き出しテスト用）
vi.mock("node:fs", async () => {
  const memfs = await import("memfs");
  return memfs.fs;
});

vi.mock("node:fs/promises", async () => {
  const memfs = await import("memfs");
  return memfs.fs.promises;
});

// utils/aggregate をモック（集約ロジック本体はテスト対象外。src/utils/__tests__/aggregate.test.ts が別途カバー）
vi.mock("../../utils/aggregate", () => ({
  aggregateTemplateUsage: vi.fn(),
}));

// utils/git-remote をモック
vi.mock("../../utils/git-remote", () => ({
  detectGitHubRepo: vi.fn(),
}));

// ui/renderer をモック
vi.mock("../../ui/renderer", () => ({
  intro: vi.fn(),
  outro: vi.fn(),
  log: {
    info: vi.fn(),
    success: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    step: vi.fn(),
    message: vi.fn(),
  },
  withSpinner: vi.fn(async (_text: string, fn: () => Promise<unknown>) => fn()),
  pc: {
    cyan: vi.fn((s: string) => s),
    dim: vi.fn((s: string) => s),
    green: vi.fn((s: string) => s),
    red: vi.fn((s: string) => s),
    yellow: vi.fn((s: string) => s),
    bold: vi.fn((s: string) => s),
  },
}));

const { aggregateCommand, normalizeSince, parseConcurrency } = await import("../aggregate");
const { aggregateTemplateUsage } = await import("../../utils/aggregate");
const { detectGitHubRepo } = await import("../../utils/git-remote");
const { log, outro } = await import("../../ui/renderer");

const mockAggregateTemplateUsage = vi.mocked(aggregateTemplateUsage);
const mockDetectGitHubRepo = vi.mocked(detectGitHubRepo);
const mockLog = vi.mocked(log);
const mockOutro = vi.mocked(outro);

/** テスト用の最小 AggregateReport フィクスチャ */
function makeReport(overrides: Partial<AggregateReport> = {}): AggregateReport {
  return {
    template: { owner: "acme", repo: "template", ref: "abc1234567890" },
    generatedAt: "2026-01-01T00:00:00.000Z",
    repositories: [],
    skipped: [],
    summary: {
      totalRepositories: 0,
      repositoriesWithPendingPush: 0,
      pendingPushFiles: 0,
      conflictFiles: 0,
    },
    ...overrides,
  };
}

// biome-ignore lint/suspicious/noExplicitAny: citty run signature
async function runAggregate(args: Record<string, unknown>): Promise<void> {
  await (aggregateCommand.run as any)({
    args: { dir: ".", json: false, "include-archived": false, ...args },
    rawArgs: [],
    cmd: aggregateCommand,
  });
}

describe("normalizeSince", () => {
  it("YYYY-MM-DD を UTC 0 時の ISO 8601 に正規化する", () => {
    const result = normalizeSince("2026-01-01");
    expect(result).toEqual({ ok: true, value: "2026-01-01T00:00:00.000Z" });
  });

  it("オフセット付き ISO 8601 を UTC の ISO 8601 に正規化する", () => {
    const result = normalizeSince("2026-01-01T09:00:00+09:00");
    expect(result).toEqual({ ok: true, value: "2026-01-01T00:00:00.000Z" });
  });

  it("既に UTC の ISO 8601 はそのまま UTC 表現に正規化される", () => {
    const result = normalizeSince("2026-06-15T12:34:56.000Z");
    expect(result).toEqual({ ok: true, value: "2026-06-15T12:34:56.000Z" });
  });

  it("オフセット無しの日時は実行環境のタイムゾーンに関わらず UTC として解釈する", () => {
    // オフセット無しの日時文字列を new Date() に渡すとローカルタイムとして解釈される
    // 仕様があるため、CI (UTC) とローカル (JST 等) で --since の結果がずれないことを保証する。
    const result = normalizeSince("2026-01-01T00:00:00");
    expect(result).toEqual({ ok: true, value: "2026-01-01T00:00:00.000Z" });
  });

  it("パースできない入力はエラーになる", () => {
    const result = normalizeSince("not-a-date");
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.message).toContain("Invalid --since value");
    }
  });

  // new Date() は "2026-02-30" を 3 月 2 日へ繰り上げ、"01/02/2026" のような
  // 非 ISO 形式も処理系依存で受理する。どちらも例外にならないため、検証を
  // new Date() に委ねると絞り込みの境界が黙ってずれる。
  it.each([
    ["暦上ありえない日付", "2026-02-30"],
    ["存在しない月", "2026-13-01"],
    ["0 日", "2026-01-00"],
    ["非 ISO のスラッシュ区切り", "01/02/2026"],
    ["範囲外の時刻", "2026-01-01T24:00:00"],
    ["範囲外の分", "2026-01-01T00:60:00"],
  ])("%s (%s) は繰り上げずにエラーにする", (_label, input) => {
    const result = normalizeSince(input);
    expect(result.ok).toBe(false);
  });

  it("うるう年の 2 月 29 日は受理する", () => {
    expect(normalizeSince("2028-02-29")).toEqual({ ok: true, value: "2028-02-29T00:00:00.000Z" });
  });

  it("平年の 2 月 29 日はエラーにする", () => {
    expect(normalizeSince("2026-02-29").ok).toBe(false);
  });

  it("秒を省略した日時を受理する", () => {
    expect(normalizeSince("2026-01-01T09:30")).toEqual({
      ok: true,
      value: "2026-01-01T09:30:00.000Z",
    });
  });
});

describe("parseConcurrency", () => {
  it("未指定は undefined として成功扱い", () => {
    expect(parseConcurrency(undefined)).toEqual({ ok: true, value: undefined });
  });

  it("正の整数はそのまま受理する", () => {
    expect(parseConcurrency("4")).toEqual({ ok: true, value: 4 });
  });

  it("0 はエラーになる", () => {
    const result = parseConcurrency("0");
    expect(result.ok).toBe(false);
  });

  it("負値はエラーになる", () => {
    const result = parseConcurrency("-1");
    expect(result.ok).toBe(false);
  });

  it("数値でない入力はエラーになる", () => {
    const result = parseConcurrency("abc");
    expect(result.ok).toBe(false);
  });

  it("小数はエラーになる", () => {
    const result = parseConcurrency("2.5");
    expect(result.ok).toBe(false);
  });
});

describe("aggregateCommand", () => {
  beforeEach(() => {
    vol.reset();
    vi.clearAllMocks();
    mockDetectGitHubRepo.mockReturnValue({ owner: "acme", repo: "template" });
    mockAggregateTemplateUsage.mockReturnValue(Effect.succeed(makeReport()));
  });

  describe("run", () => {
    it("git remote から owner/repo を検出できない場合は ZikuError", async () => {
      mockDetectGitHubRepo.mockReturnValue(null);

      await expect(runAggregate({})).rejects.toThrow(ZikuError);
      expect(mockAggregateTemplateUsage).not.toHaveBeenCalled();
    });

    it("パースできない --since は ZikuError（aggregateTemplateUsage は呼ばれない）", async () => {
      await expect(runAggregate({ since: "not-a-date" })).rejects.toThrow(ZikuError);
      expect(mockAggregateTemplateUsage).not.toHaveBeenCalled();
    });

    it("--since は正規化されて aggregateTemplateUsage に渡る", async () => {
      await runAggregate({ since: "2026-01-01T09:00:00+09:00" });

      expect(mockAggregateTemplateUsage).toHaveBeenCalledWith(
        expect.objectContaining({ since: "2026-01-01T00:00:00.000Z" }),
      );
    });

    it("--concurrency=0 は ZikuError（aggregateTemplateUsage は呼ばれない）", async () => {
      await expect(runAggregate({ concurrency: "0" })).rejects.toThrow(ZikuError);
      expect(mockAggregateTemplateUsage).not.toHaveBeenCalled();
    });

    it("--concurrency=abc は ZikuError", async () => {
      await expect(runAggregate({ concurrency: "abc" })).rejects.toThrow(ZikuError);
      expect(mockAggregateTemplateUsage).not.toHaveBeenCalled();
    });

    it("--concurrency=8 は数値として aggregateTemplateUsage に渡る", async () => {
      await runAggregate({ concurrency: "8" });

      expect(mockAggregateTemplateUsage).toHaveBeenCalledWith(
        expect.objectContaining({ concurrency: 8 }),
      );
    });

    it("--owner 未指定時は検出した template owner を searchOwner に使う", async () => {
      await runAggregate({});

      expect(mockAggregateTemplateUsage).toHaveBeenCalledWith(
        expect.objectContaining({
          template: { owner: "acme", repo: "template" },
          searchOwner: "acme",
        }),
      );
    });

    it("--owner 指定時はそちらを searchOwner に使う", async () => {
      await runAggregate({ owner: "other-org" });

      expect(mockAggregateTemplateUsage).toHaveBeenCalledWith(
        expect.objectContaining({ searchOwner: "other-org" }),
      );
    });

    it("aggregateTemplateUsage の GitHubApiError は ZikuError に変換される", async () => {
      mockAggregateTemplateUsage.mockReturnValue(
        Effect.fail(new GitHubApiError({ message: "rate limited" })),
      );

      await expect(runAggregate({})).rejects.toThrow(ZikuError);
    });

    it("--json 指定時は stdout に JSON としてパース可能な出力のみを書く（装飾なし）", async () => {
      const report = makeReport({
        summary: {
          totalRepositories: 1,
          repositoriesWithPendingPush: 0,
          pendingPushFiles: 0,
          conflictFiles: 0,
        },
      });
      mockAggregateTemplateUsage.mockReturnValue(Effect.succeed(report));

      const writeSpy = vi.spyOn(process.stdout, "write").mockImplementation(() => true);
      await runAggregate({ json: true });

      // mockRestore() は呼び出し履歴もクリアするため、アサーションを済ませてから復元する。
      expect(writeSpy).toHaveBeenCalledTimes(1);
      const written = writeSpy.mock.calls[0][0] as string;
      writeSpy.mockRestore();

      expect(() => JSON.parse(written)).not.toThrow();
      expect(JSON.parse(written)).toEqual(report);

      // 装飾（intro/outro/log）は --json 時は一切呼ばれない
      expect(mockLog.info).not.toHaveBeenCalled();
      expect(mockLog.message).not.toHaveBeenCalled();
      expect(mockOutro).not.toHaveBeenCalled();
    });

    it("既定出力は skipped の理由を表示する", async () => {
      const report = makeReport({
        skipped: [{ owner: "acme", repo: "broken-lock", reason: "lock.json のパースに失敗" }],
      });
      mockAggregateTemplateUsage.mockReturnValue(Effect.succeed(report));

      await runAggregate({});

      const messageCalls = mockLog.message.mock.calls.flat().join("\n");
      expect(messageCalls).toContain("broken-lock");
      expect(messageCalls).toContain("lock.json のパースに失敗");
    });

    it("既定出力は pendingPush ありのリポジトリのファイルパスを表示する", async () => {
      const report = makeReport({
        repositories: [
          {
            owner: "acme",
            repo: "consumer-a",
            defaultBranch: "main",
            ref: "deadbeef",
            pendingPush: [{ path: ".claude/rules/foo.md", reason: "localOnly" }],
            pendingPull: [],
            conflicts: [],
          },
        ],
        summary: {
          totalRepositories: 1,
          repositoriesWithPendingPush: 1,
          pendingPushFiles: 1,
          conflictFiles: 0,
        },
      });
      mockAggregateTemplateUsage.mockReturnValue(Effect.succeed(report));

      await runAggregate({});

      const messageCalls = mockLog.message.mock.calls.flat().join("\n");
      expect(messageCalls).toContain("consumer-a");
      expect(messageCalls).toContain(".claude/rules/foo.md");
    });

    it("--out 指定時は JSON レポートをファイルへ書き出す", async () => {
      const report = makeReport();
      mockAggregateTemplateUsage.mockReturnValue(Effect.succeed(report));

      await runAggregate({ out: "/work/report.json" });

      const { readFile } = await import("node:fs/promises");
      const written = await readFile("/work/report.json", "utf-8");
      expect(JSON.parse(written)).toEqual(report);
    });

    it("--json --out 併用時、--out のログはファイルに書かれるが stdout には JSON のみ", async () => {
      const report = makeReport();
      mockAggregateTemplateUsage.mockReturnValue(Effect.succeed(report));

      const writeSpy = vi.spyOn(process.stdout, "write").mockImplementation(() => true);
      await runAggregate({ json: true, out: "/work/report.json" });

      expect(writeSpy).toHaveBeenCalledTimes(1);
      const stdoutWritten = writeSpy.mock.calls[0][0] as string;
      writeSpy.mockRestore();

      expect(() => JSON.parse(stdoutWritten)).not.toThrow();
      expect(mockLog.success).not.toHaveBeenCalled();

      const { readFile } = await import("node:fs/promises");
      const written = await readFile("/work/report.json", "utf-8");
      expect(JSON.parse(written)).toEqual(report);
    });
  });
});
