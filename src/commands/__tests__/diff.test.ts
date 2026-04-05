import { vol } from "memfs";
import { Effect } from "effect";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { ZikuError, FileNotFoundError } from "../../errors";

// fs モジュールをモック
vi.mock("node:fs", async () => {
  const memfs = await import("memfs");
  return memfs.fs;
});

vi.mock("node:fs/promises", async () => {
  const memfs = await import("memfs");
  return memfs.fs.promises;
});

// loadCommandContext をモック（DI の恩恵: 低レベルモック不要）
// runCommandEffect / toZikuError は実際の実装を使い、loadCommandContext だけモックする
vi.mock("../../services/command-context", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../../services/command-context")>();
  return {
    ...actual,
    loadCommandContext: vi.fn(),
  };
});

// utils/diff をモック
vi.mock("../../utils/diff", () => ({
  detectDiff: vi.fn(),
  hasDiff: vi.fn(),
}));

// utils/untracked をモック
vi.mock("../../utils/untracked", () => ({
  detectUntrackedFiles: vi.fn().mockResolvedValue([]),
  getTotalUntrackedCount: vi.fn().mockReturnValue(0),
}));

// ui/diff-view をモック
vi.mock("../../ui/diff-view", () => ({
  renderFileDiff: vi.fn(),
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
  logDiffSummary: vi.fn(),
  withSpinner: vi.fn(async (_text: string, fn: () => Promise<unknown>) => fn()),
  pc: {
    cyan: vi.fn((s: string) => s),
    dim: vi.fn((s: string) => s),
  },
}));

// モック後にインポート
const { diffCommand } = await import("../diff");
const { loadCommandContext } = await import("../../services/command-context");
const { detectDiff, hasDiff } = await import("../../utils/diff");
const { log, outro, logDiffSummary } = await import("../../ui/renderer");
const { renderFileDiff } = await import("../../ui/diff-view");

const mockLoadCommandContext = vi.mocked(loadCommandContext);
const mockDetectDiff = vi.mocked(detectDiff);
const mockHasDiff = vi.mocked(hasDiff);
const mockLog = vi.mocked(log);
const mockOutro = vi.mocked(outro);
const mockLogDiffSummary = vi.mocked(logDiffSummary);
const mockRenderFileDiff = vi.mocked(renderFileDiff);

/**
 * テスト用の CommandContext を生成するヘルパー。
 * DI のおかげでテンプレートダウンロードや設定読み込みのモックが不要。
 */
function mockContext(
  overrides?: Partial<{
    include: string[];
    source: { owner: string; repo: string };
    templateDir: string;
  }>,
) {
  const cleanup = vi.fn();
  return {
    effect: Effect.succeed({
      config: { include: overrides?.include ?? [".root/**", ".github/**"] },
      lock: {
        version: "0.1.0",
        installedAt: "2024-01-01T00:00:00.000Z",
        source: overrides?.source ?? { owner: "tktcorporation", repo: ".github" },
      },
      source: overrides?.source ?? { owner: "tktcorporation", repo: ".github" },
      templateDir: overrides?.templateDir ?? "/tmp/template",
      cleanup,
      resolveBaseRef: Effect.succeed(undefined as string | undefined),
    }),
    cleanup,
  };
}

const emptyDiff = {
  files: [],
  summary: { added: 0, modified: 0, deleted: 0, unchanged: 0 },
};

describe("diffCommand", () => {
  beforeEach(() => {
    vol.reset();
    vi.clearAllMocks();
  });

  describe("meta", () => {
    it("コマンドメタデータが正しい", () => {
      expect((diffCommand.meta as { name: string }).name).toBe("diff");
      expect((diffCommand.meta as { description: string }).description).toBe(
        "Show differences between local and template",
      );
    });
  });

  describe("args", () => {
    it("dir 引数のデフォルト値は '.'", () => {
      const args = diffCommand.args as { dir: { default: string } };
      expect(args.dir.default).toBe(".");
    });

    it("verbose 引数のデフォルト値は false", () => {
      const args = diffCommand.args as { verbose: { default: boolean } };
      expect(args.verbose.default).toBe(false);
    });
  });

  describe("run", () => {
    it(".ziku/ziku.jsonc が存在しない場合は ZikuError をスロー", async () => {
      mockLoadCommandContext.mockReturnValue(
        Effect.fail(new FileNotFoundError({ path: ".ziku/ziku.jsonc" })),
      );

      await expect(
        (diffCommand.run as any)({
          args: { dir: "/test", verbose: false },
          rawArgs: [],
          cmd: diffCommand,
        }),
      ).rejects.toThrow(ZikuError);
    });

    it("patterns が空の場合は警告", async () => {
      const { effect } = mockContext({ include: [] });
      mockLoadCommandContext.mockReturnValue(effect);

      await (diffCommand.run as any)({
        args: { dir: "/test", verbose: false },
        rawArgs: [],
        cmd: diffCommand,
      });

      expect(mockLog.warn).toHaveBeenCalledWith("No patterns configured");
    });

    it("差分がない場合は outro で完了メッセージ", async () => {
      const { effect } = mockContext();
      mockLoadCommandContext.mockReturnValue(effect);
      mockDetectDiff.mockResolvedValueOnce(emptyDiff);
      mockHasDiff.mockReturnValueOnce(false);

      await (diffCommand.run as any)({
        args: { dir: "/test", verbose: false },
        rawArgs: [],
        cmd: diffCommand,
      });

      expect(mockOutro).toHaveBeenCalledWith("No changes — in sync with template.");
    });

    it("差分がある場合は logDiffSummary を呼ぶ", async () => {
      const { effect } = mockContext();
      mockLoadCommandContext.mockReturnValue(effect);

      const diffWithChanges = {
        files: [{ path: "new-file.txt", type: "added" as const, localContent: "content" }],
        summary: { added: 1, modified: 0, deleted: 0, unchanged: 0 },
      };
      mockDetectDiff.mockResolvedValueOnce(diffWithChanges);
      mockHasDiff.mockReturnValueOnce(true);

      await (diffCommand.run as any)({
        args: { dir: "/test", verbose: false },
        rawArgs: [],
        cmd: diffCommand,
      });

      expect(mockLogDiffSummary).toHaveBeenCalledWith(diffWithChanges.files);
      expect(mockOutro).toHaveBeenCalledWith("Run 'ziku push' to push changes.");
    });

    it("cleanup が成功時にも失敗時にも呼ばれる", async () => {
      const { effect, cleanup } = mockContext();
      mockLoadCommandContext.mockReturnValue(effect);
      mockDetectDiff.mockResolvedValueOnce(emptyDiff);
      mockHasDiff.mockReturnValueOnce(false);

      await (diffCommand.run as any)({
        args: { dir: "/test", verbose: false },
        rawArgs: [],
        cmd: diffCommand,
      });

      expect(cleanup).toHaveBeenCalled();
    });

    it("lock.source からテンプレートソースを構築", async () => {
      const { effect } = mockContext({
        source: { owner: "custom-org", repo: "custom-templates" },
        templateDir: "/tmp/custom-template",
      });
      mockLoadCommandContext.mockReturnValue(effect);
      mockDetectDiff.mockResolvedValueOnce(emptyDiff);
      mockHasDiff.mockReturnValueOnce(false);

      await (diffCommand.run as any)({
        args: { dir: "/test", verbose: false },
        rawArgs: [],
        cmd: diffCommand,
      });

      // loadCommandContext が呼ばれる（テンプレート解決は内部で完了）
      expect(mockLoadCommandContext).toHaveBeenCalledWith(expect.any(String));
    });

    it("エラー時も cleanup が呼ばれる", async () => {
      const { effect, cleanup } = mockContext();
      mockLoadCommandContext.mockReturnValue(effect);
      mockDetectDiff.mockRejectedValueOnce(new Error("Diff error"));

      await expect(
        (diffCommand.run as any)({
          args: { dir: "/test", verbose: false },
          rawArgs: [],
          cmd: diffCommand,
        }),
      ).rejects.toThrow("Diff error");

      expect(cleanup).toHaveBeenCalled();
    });

    it("--verbose のとき renderFileDiff を各変更ファイルに対して呼ぶ", async () => {
      const { effect } = mockContext();
      mockLoadCommandContext.mockReturnValue(effect);

      const diffWithChanges = {
        files: [{ path: "new-file.txt", type: "added" as const, localContent: "content" }],
        summary: { added: 1, modified: 0, deleted: 0, unchanged: 0 },
      };
      mockDetectDiff.mockResolvedValueOnce(diffWithChanges);
      mockHasDiff.mockReturnValueOnce(true);

      await (diffCommand.run as any)({
        args: { dir: "/test", verbose: true },
        rawArgs: [],
        cmd: diffCommand,
      });

      expect(mockRenderFileDiff).toHaveBeenCalledWith(diffWithChanges.files[0]);
    });

    it("--verbose なしのとき renderFileDiff を呼ばない", async () => {
      const { effect } = mockContext();
      mockLoadCommandContext.mockReturnValue(effect);

      const diffWithChanges = {
        files: [{ path: "new-file.txt", type: "added" as const, localContent: "content" }],
        summary: { added: 1, modified: 0, deleted: 0, unchanged: 0 },
      };
      mockDetectDiff.mockResolvedValueOnce(diffWithChanges);
      mockHasDiff.mockReturnValueOnce(true);

      await (diffCommand.run as any)({
        args: { dir: "/test", verbose: false },
        rawArgs: [],
        cmd: diffCommand,
      });

      expect(mockRenderFileDiff).not.toHaveBeenCalled();
    });

    it("--verbose のとき変更ファイルのみ renderFileDiff を呼び、unchanged はスキップ", async () => {
      const { effect } = mockContext();
      mockLoadCommandContext.mockReturnValue(effect);

      const unchangedFile = {
        path: "unchanged.txt",
        type: "unchanged" as const,
        localContent: "same",
      };
      const addedFile = { path: "added.txt", type: "added" as const, localContent: "new" };
      const modifiedFile = {
        path: "modified.txt",
        type: "modified" as const,
        localContent: "changed",
      };

      const diffWithMixed = {
        files: [addedFile, unchangedFile, modifiedFile],
        summary: { added: 1, modified: 1, deleted: 0, unchanged: 1 },
      };
      mockDetectDiff.mockResolvedValueOnce(diffWithMixed);
      mockHasDiff.mockReturnValueOnce(true);

      await (diffCommand.run as any)({
        args: { dir: "/test", verbose: true },
        rawArgs: [],
        cmd: diffCommand,
      });

      expect(mockRenderFileDiff).toHaveBeenCalledTimes(2);
      expect(mockRenderFileDiff).toHaveBeenCalledWith(addedFile);
      expect(mockRenderFileDiff).toHaveBeenCalledWith(modifiedFile);
      expect(mockRenderFileDiff).not.toHaveBeenCalledWith(unchangedFile);
    });
  });
});
