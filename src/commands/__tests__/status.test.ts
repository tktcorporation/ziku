import { vol } from "memfs";
import { Effect, Option } from "effect";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { ZikuError, FileNotFoundError } from "../../errors";
import type { FileClassification } from "../../utils/merge/types";

// fs モジュールをモック
vi.mock("node:fs", async () => {
  const memfs = await import("memfs");
  return memfs.fs;
});

vi.mock("node:fs/promises", async () => {
  const memfs = await import("memfs");
  return memfs.fs.promises;
});

// loadCommandContext をモック（diff.test.ts と同じ DI パターン）
vi.mock("../../services/command-context", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../../services/command-context")>();
  return {
    ...actual,
    loadCommandContext: vi.fn(),
  };
});

// utils/sync-analysis をモック (実 I/O を避ける)
vi.mock("../../utils/sync-analysis", () => ({
  analyzeSync: vi.fn(),
}));

// utils/untracked をモック
vi.mock("../../utils/untracked", () => ({
  detectUntrackedFiles: vi.fn().mockResolvedValue([]),
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
  },
}));

// モック後にインポート
const { statusCommand } = await import("../status");
const { loadCommandContext } = await import("../../services/command-context");
const { analyzeSync } = await import("../../utils/sync-analysis");
const { detectUntrackedFiles } = await import("../../utils/untracked");
const { log, outro } = await import("../../ui/renderer");

const mockLoadCommandContext = vi.mocked(loadCommandContext);
const mockAnalyzeSync = vi.mocked(analyzeSync);
const mockDetectUntrackedFiles = vi.mocked(detectUntrackedFiles);
const mockLog = vi.mocked(log);
const mockOutro = vi.mocked(outro);

/** テスト用の空 FileClassification */
function emptyClassification(): FileClassification {
  return {
    autoUpdate: [],
    localOnly: [],
    conflicts: [],
    newFiles: [],
    deletedFiles: [],
    deletedLocally: [],
    unchanged: [],
  };
}

/** テスト用 CommandContext */
function mockContext(
  overrides: Partial<{
    include: string[];
    pendingMerge: { conflicts: string[]; templateHashes: Record<string, string> };
  }> = {},
) {
  const cleanup = vi.fn();
  return {
    effect: Effect.succeed({
      config: { include: overrides.include ?? [".claude/**"] },
      lock: {
        version: "0.1.0",
        installedAt: "2024-01-01T00:00:00.000Z",
        source: { owner: "tktcorporation", repo: ".github" },
        ...(overrides.pendingMerge ? { pendingMerge: overrides.pendingMerge } : {}),
      },
      source: { owner: "tktcorporation" as const, repo: ".github" },
      templateDir: "/tmp/template",
      cleanup,
      resolveBaseRef: Effect.succeed(Option.none<string>()),
    }),
    cleanup,
  };
}

describe("statusCommand", () => {
  beforeEach(() => {
    vol.reset();
    vi.clearAllMocks();
  });

  describe("meta", () => {
    it("コマンドメタデータが正しい", () => {
      expect((statusCommand.meta as { name: string }).name).toBe("status");
      expect((statusCommand.meta as { description: string }).description).toContain("pull/push");
    });
  });

  describe("args", () => {
    it("dir 引数のデフォルト値は '.'", () => {
      const args = statusCommand.args as { dir: { default: string } };
      expect(args.dir.default).toBe(".");
    });

    it("--short / --exit-code フラグは存在しない（YAGNI で削除済み）", () => {
      const args = statusCommand.args as Record<string, unknown>;
      expect(args.short).toBeUndefined();
      expect(args["exit-code"]).toBeUndefined();
    });
  });

  describe("run", () => {
    it("loadCommandContext 失敗時は ZikuError をスロー", async () => {
      mockLoadCommandContext.mockReturnValue(
        Effect.fail(new FileNotFoundError({ path: ".ziku/ziku.jsonc" })),
      );

      await expect(
        // biome-ignore lint/suspicious/noExplicitAny: citty run signature
        (statusCommand.run as any)({
          args: { dir: "/test" },
          rawArgs: [],
          cmd: statusCommand,
        }),
      ).rejects.toThrow(ZikuError);
    });

    it("patterns が空の場合は警告 + outro 'Nothing to compare.'", async () => {
      const { effect, cleanup } = mockContext({ include: [] });
      mockLoadCommandContext.mockReturnValue(effect);

      // biome-ignore lint/suspicious/noExplicitAny: citty run signature
      await (statusCommand.run as any)({
        args: { dir: "/test" },
        rawArgs: [],
        cmd: statusCommand,
      });

      expect(mockLog.warn).toHaveBeenCalledWith("No patterns configured");
      expect(mockOutro).toHaveBeenCalledWith("Nothing to compare.");
      expect(cleanup).toHaveBeenCalled();
    });

    it("完全 in-sync のとき outro に 'In sync' のメッセージを渡す", async () => {
      const { effect, cleanup } = mockContext();
      mockLoadCommandContext.mockReturnValue(effect);
      mockAnalyzeSync.mockResolvedValueOnce({
        classification: emptyClassification(),
        hashes: { baseHashes: {}, localHashes: {}, templateHashes: {} },
      });

      // biome-ignore lint/suspicious/noExplicitAny: citty run signature
      await (statusCommand.run as any)({
        args: { dir: "/test" },
        rawArgs: [],
        cmd: statusCommand,
      });

      // log.message で renderStatusLong の出力（"in sync" 含む）
      expect(mockLog.message).toHaveBeenCalled();
      // outro で recommendationLine の "In sync" メッセージ
      const outroArg = mockOutro.mock.calls.at(-1)?.[0] ?? "";
      expect(outroArg).toContain("In sync");
      expect(cleanup).toHaveBeenCalled();
    });

    it("pull だけ pending のとき outro に 'ziku pull' を含むメッセージ", async () => {
      const { effect } = mockContext();
      mockLoadCommandContext.mockReturnValue(effect);
      mockAnalyzeSync.mockResolvedValueOnce({
        classification: { ...emptyClassification(), autoUpdate: ["a.txt"] },
        hashes: { baseHashes: {}, localHashes: {}, templateHashes: {} },
      });

      // biome-ignore lint/suspicious/noExplicitAny: citty run signature
      await (statusCommand.run as any)({
        args: { dir: "/test" },
        rawArgs: [],
        cmd: statusCommand,
      });

      const outroArg = mockOutro.mock.calls.at(-1)?.[0] ?? "";
      expect(outroArg).toContain("ziku pull");
    });

    it("push だけ pending のとき outro に 'ziku push' を含むメッセージ", async () => {
      const { effect } = mockContext();
      mockLoadCommandContext.mockReturnValue(effect);
      mockAnalyzeSync.mockResolvedValueOnce({
        classification: { ...emptyClassification(), localOnly: ["b.txt"] },
        hashes: { baseHashes: {}, localHashes: {}, templateHashes: {} },
      });

      // biome-ignore lint/suspicious/noExplicitAny: citty run signature
      await (statusCommand.run as any)({
        args: { dir: "/test" },
        rawArgs: [],
        cmd: statusCommand,
      });

      const outroArg = mockOutro.mock.calls.at(-1)?.[0] ?? "";
      expect(outroArg).toContain("ziku push");
    });

    it("pendingMerge が立っている場合は outro に 'pull --continue'", async () => {
      const { effect } = mockContext({
        pendingMerge: { conflicts: ["c.txt"], templateHashes: {} },
      });
      mockLoadCommandContext.mockReturnValue(effect);
      mockAnalyzeSync.mockResolvedValueOnce({
        classification: emptyClassification(),
        hashes: { baseHashes: {}, localHashes: {}, templateHashes: {} },
      });

      // biome-ignore lint/suspicious/noExplicitAny: citty run signature
      await (statusCommand.run as any)({
        args: { dir: "/test" },
        rawArgs: [],
        cmd: statusCommand,
      });

      const outroArg = mockOutro.mock.calls.at(-1)?.[0] ?? "";
      expect(outroArg).toContain("ziku pull --continue");
    });

    it("untracked がある場合は detectUntrackedFiles の結果が描画される", async () => {
      const { effect } = mockContext();
      mockLoadCommandContext.mockReturnValue(effect);
      mockAnalyzeSync.mockResolvedValueOnce({
        classification: emptyClassification(),
        hashes: { baseHashes: {}, localHashes: {}, templateHashes: {} },
      });
      mockDetectUntrackedFiles.mockResolvedValueOnce([
        {
          folder: "x",
          files: [{ path: ".claude/rules/draft.md", folder: "x" }],
        },
      ]);

      // biome-ignore lint/suspicious/noExplicitAny: citty run signature
      await (statusCommand.run as any)({
        args: { dir: "/test" },
        rawArgs: [],
        cmd: statusCommand,
      });

      const messageCalls = mockLog.message.mock.calls.flat().join("\n");
      expect(messageCalls).toContain(".claude/rules/draft.md");
    });

    it("analyzeSync が throw しても cleanup は呼ばれる (Effect.ensuring 経由)", async () => {
      const { effect, cleanup } = mockContext();
      mockLoadCommandContext.mockReturnValue(effect);
      mockAnalyzeSync.mockRejectedValueOnce(new Error("hash failure"));

      await expect(
        // biome-ignore lint/suspicious/noExplicitAny: citty run signature
        (statusCommand.run as any)({
          args: { dir: "/test" },
          rawArgs: [],
          cmd: statusCommand,
        }),
      ).rejects.toThrow("hash failure");

      expect(cleanup).toHaveBeenCalled();
    });
  });
});
