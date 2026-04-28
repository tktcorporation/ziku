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

// utils/template-patterns をモック (デフォルトはマージ無し = テンプレ側に追加パターン無し)
vi.mock("../../utils/template-patterns", () => ({
  mergeTemplatePatterns: vi.fn().mockResolvedValue({
    mergedInclude: [".claude/**"],
    mergedExclude: [],
    newInclude: [],
    newExclude: [],
    patternsUpdated: false,
  }),
}));

// utils/lock をモック (fast-path で読まれる)。
// デフォルトは ENOENT 相当: status が loadLock に失敗 → fast-path をスルーして
// 通常の loadCommandContext 経路に進む (= 既存テストの挙動と互換)。
vi.mock("../../utils/lock", () => ({
  loadLock: vi.fn().mockRejectedValue(new Error("ENOENT")),
  LOCK_FILE: ".ziku/lock.json",
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
    green: vi.fn((s: string) => s),
    red: vi.fn((s: string) => s),
    yellow: vi.fn((s: string) => s),
    bold: vi.fn((s: string) => s),
  },
}));

// モック後にインポート
const { statusCommand } = await import("../status");
const { loadCommandContext } = await import("../../services/command-context");
const { analyzeSync } = await import("../../utils/sync-analysis");
const { mergeTemplatePatterns } = await import("../../utils/template-patterns");
const { detectUntrackedFiles } = await import("../../utils/untracked");
const { loadLock } = await import("../../utils/lock");
const { log, outro } = await import("../../ui/renderer");

const mockLoadCommandContext = vi.mocked(loadCommandContext);
const mockAnalyzeSync = vi.mocked(analyzeSync);
const mockMergeTemplatePatterns = vi.mocked(mergeTemplatePatterns);
const mockDetectUntrackedFiles = vi.mocked(detectUntrackedFiles);
const mockLoadLock = vi.mocked(loadLock);
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
    // デフォルト: テンプレ側にパターン追加なし (P1 fix の no-op パス)
    mockMergeTemplatePatterns.mockResolvedValue({
      mergedInclude: [".claude/**"],
      mergedExclude: [],
      newInclude: [],
      newExclude: [],
      patternsUpdated: false,
    });
    // デフォルト: lock 未作成相当 (fast-path をスキップし、通常の loadCommandContext 経路に進む)
    mockLoadLock.mockRejectedValue(new Error("ENOENT"));
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
    it("pendingMerge があれば fast-path で template fetch せずに案内する (codex P2 #6)", async () => {
      // codex review #71 の最後の P2: pendingMerge 中はネットワーク不通でも
      // status が "pull --continue" を案内できるべき。lock を local だけで読んで
      // 早期 return することで、loadCommandContext (= template download) を回避する。
      mockLoadLock.mockResolvedValueOnce({
        version: "0.1.0",
        installedAt: "2024-01-01T00:00:00.000Z",
        source: { owner: "tktcorporation", repo: ".github" },
        pendingMerge: {
          conflicts: [".claude/settings.json", ".mcp.json"],
          templateHashes: {},
        },
      });
      // loadCommandContext は失敗するように設定 (template 取得不可をシミュレート)
      const { TemplateError } = await import("../../errors");
      mockLoadCommandContext.mockReturnValue(
        Effect.fail(new TemplateError({ message: "network unreachable" })),
      );

      // biome-ignore lint/suspicious/noExplicitAny: citty run signature
      await (statusCommand.run as any)({
        args: { dir: "/test" },
        rawArgs: [],
        cmd: statusCommand,
      });

      // テンプレ取得が呼ばれない (fast-path で先に return)
      expect(mockLoadCommandContext).not.toHaveBeenCalled();
      // outro で pull --continue を案内
      const outroArg = mockOutro.mock.calls.at(-1)?.[0] ?? "";
      expect(outroArg).toContain("ziku pull --continue");
      expect(outroArg).toContain("2");
      // conflict 一覧も表示される
      const messageCalls = mockLog.message.mock.calls.flat().join("\n");
      expect(messageCalls).toContain(".claude/settings.json");
      expect(messageCalls).toContain(".mcp.json");
    });

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
        pendingMerge: {
          conflicts: ["c.txt"],
          // templateHashes の中身は decideRecommendation の分岐に影響しないため空で十分。
          // pendingMerge フラグの存在自体が continueMerge を発火させる。
          templateHashes: {},
        },
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

    it("pull + push 両方 pending のとき outro に 'ziku pull' と 'ziku push' を含む (pullThenPush パイプライン)", async () => {
      const { effect } = mockContext();
      mockLoadCommandContext.mockReturnValue(effect);
      mockAnalyzeSync.mockResolvedValueOnce({
        classification: {
          ...emptyClassification(),
          autoUpdate: ["a.txt"],
          localOnly: ["b.txt"],
        },
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
      expect(outroArg).toContain("ziku push");
    });

    it("conflict あり (pendingMerge なし) のとき outro に merge 開始の案内", async () => {
      const { effect } = mockContext();
      mockLoadCommandContext.mockReturnValue(effect);
      mockAnalyzeSync.mockResolvedValueOnce({
        classification: { ...emptyClassification(), conflicts: ["c.txt"] },
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
      expect(outroArg).toContain("merge");
    });

    it("patternsUpdated + ファイル差分ゼロのとき outro は pull (push を no-op で誤推奨しない, codex P1 #2)", async () => {
      const { effect } = mockContext();
      mockLoadCommandContext.mockReturnValue(effect);
      mockMergeTemplatePatterns.mockResolvedValueOnce({
        mergedInclude: [".claude/**", ".new-pattern/**"],
        mergedExclude: [],
        newInclude: [".new-pattern/**"],
        newExclude: [],
        patternsUpdated: true,
      });
      mockAnalyzeSync.mockResolvedValueOnce({
        // 新パターンに該当するファイルが無い（テンプレも local も空）
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
      // pull を強制推奨する（in sync や push にならない）
      expect(outroArg).toContain("ziku pull");
      expect(outroArg).toContain("template patterns");
      expect(outroArg).not.toContain("In sync");
    });

    it("テンプレ側で新規 include が追加されているとマージ済みパターンで analyzeSync を呼ぶ (codex P1)", async () => {
      const { effect } = mockContext();
      mockLoadCommandContext.mockReturnValue(effect);
      mockMergeTemplatePatterns.mockResolvedValueOnce({
        mergedInclude: [".claude/**", ".new-feature/**"],
        mergedExclude: [],
        newInclude: [".new-feature/**"],
        newExclude: [],
        patternsUpdated: true,
      });
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

      // analyzeSync がマージ済み include で呼ばれることを確認 (P1 の本質)
      expect(mockAnalyzeSync).toHaveBeenCalledWith(
        expect.objectContaining({
          include: [".claude/**", ".new-feature/**"],
        }),
      );
      // ユーザー向けの新パターン通知
      const infoCalls = mockLog.info.mock.calls.flat().join(" ");
      expect(infoCalls).toContain("Template added 1 new pattern");
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
