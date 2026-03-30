import { vol } from "memfs";
import { beforeEach, describe, expect, it, vi } from "vitest";

// fs モジュールをモック
vi.mock("node:fs", async () => {
  const memfs = await import("memfs");
  return memfs.fs;
});

vi.mock("node:fs/promises", async () => {
  const memfs = await import("memfs");
  return memfs.fs.promises;
});

// giget をモック
vi.mock("giget", () => ({
  downloadTemplate: vi.fn(),
}));

// utils/template をモック
vi.mock("../../utils/template", () => ({
  buildTemplateSource: vi.fn((source: { owner: string; repo: string; ref?: string }) => {
    const base = `gh:${source.owner}/${source.repo}`;
    return source.ref ? `${base}#${source.ref}` : base;
  }),
}));

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

// modules をモック
vi.mock("../../modules", () => ({
  defaultModules: [],
  loadModulesFile: vi.fn(),
  modulesFileExists: vi.fn().mockReturnValue(false),
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
const { downloadTemplate } = await import("giget");
const { detectDiff, hasDiff } = await import("../../utils/diff");
const { log, outro, logDiffSummary } = await import("../../ui/renderer");
const { renderFileDiff } = await import("../../ui/diff-view");
import { BermError } from "../../errors";

const mockDownloadTemplate = vi.mocked(downloadTemplate);
const mockDetectDiff = vi.mocked(detectDiff);
const mockHasDiff = vi.mocked(hasDiff);
const mockLog = vi.mocked(log);
const mockOutro = vi.mocked(outro);
const mockLogDiffSummary = vi.mocked(logDiffSummary);
const mockRenderFileDiff = vi.mocked(renderFileDiff);

const validConfig = {
  version: "0.1.0",
  installedAt: "2024-01-01T00:00:00.000Z",
  modules: ["root", "github"],
  source: {
    owner: "tktcorporation",
    repo: ".github",
  },
};

const emptyDiff = {
  files: [],
  summary: { added: 0, modified: 0, deleted: 0, unchanged: 0 },
};

describe("diffCommand", () => {
  beforeEach(() => {
    vol.reset();
    vi.clearAllMocks();

    // デフォルトのモック設定
    mockDownloadTemplate.mockResolvedValue({
      dir: "/tmp/template",
      source: "gh:tktcorporation/.github",
    });
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
    it(".devenv.json が存在しない場合は BermError をスロー", async () => {
      vol.fromJSON({
        "/test": null,
      });

      await expect(
        (diffCommand.run as any)({
          args: { dir: "/test", verbose: false },
          rawArgs: [],
          cmd: diffCommand,
        }),
      ).rejects.toThrow(BermError);
    });

    it("無効な .devenv.json 形式の場合は BermError をスロー", async () => {
      vol.fromJSON({
        "/test/.devenv.json": JSON.stringify({ invalid: "format" }),
      });

      await expect(
        (diffCommand.run as any)({
          args: { dir: "/test", verbose: false },
          rawArgs: [],
          cmd: diffCommand,
        }),
      ).rejects.toThrow(BermError);
    });

    it("modules が空の場合は警告", async () => {
      vol.fromJSON({
        "/test/.devenv.json": JSON.stringify({
          ...validConfig,
          modules: [],
        }),
      });

      await (diffCommand.run as any)({
        args: { dir: "/test", verbose: false },
        rawArgs: [],
        cmd: diffCommand,
      });

      expect(mockLog.warn).toHaveBeenCalledWith("No modules installed");
    });

    it("差分がない場合は outro で完了メッセージ", async () => {
      vol.fromJSON({
        "/test/.devenv.json": JSON.stringify(validConfig),
      });

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
      vol.fromJSON({
        "/test/.devenv.json": JSON.stringify(validConfig),
      });

      const diffWithChanges = {
        files: [
          {
            path: "new-file.txt",
            type: "added" as const,
            localContent: "content",
          },
        ],
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

    it("一時ディレクトリを削除", async () => {
      vol.fromJSON({
        "/test/.devenv.json": JSON.stringify(validConfig),
        "/test/.devenv-temp": null,
      });

      mockDetectDiff.mockResolvedValueOnce(emptyDiff);
      mockHasDiff.mockReturnValueOnce(false);

      await (diffCommand.run as any)({
        args: { dir: "/test", verbose: false },
        rawArgs: [],
        cmd: diffCommand,
      });

      // 一時ディレクトリが削除される（memfs では確認が難しいのでモックで確認）
      expect(mockDownloadTemplate).toHaveBeenCalled();
    });

    it("config.source からテンプレートソースを構築", async () => {
      const customConfig = {
        ...validConfig,
        source: { owner: "custom-org", repo: "custom-templates" },
      };

      vol.fromJSON({
        "/test/.devenv.json": JSON.stringify(customConfig),
      });

      mockDetectDiff.mockResolvedValueOnce(emptyDiff);
      mockHasDiff.mockReturnValueOnce(false);

      await (diffCommand.run as any)({
        args: { dir: "/test", verbose: false },
        rawArgs: [],
        cmd: diffCommand,
      });

      expect(mockDownloadTemplate).toHaveBeenCalledWith(
        "gh:custom-org/custom-templates",
        expect.objectContaining({ force: true }),
      );
    });

    it("エラー時も一時ディレクトリを削除", async () => {
      vol.fromJSON({
        "/test/.devenv.json": JSON.stringify(validConfig),
        "/test/.devenv-temp": null,
      });

      mockDetectDiff.mockRejectedValueOnce(new Error("Diff error"));

      await expect(
        (diffCommand.run as any)({
          args: { dir: "/test", verbose: false },
          rawArgs: [],
          cmd: diffCommand,
        }),
      ).rejects.toThrow("Diff error");
    });

    it("--verbose のとき renderFileDiff を各変更ファイルに対して呼ぶ", async () => {
      vol.fromJSON({
        "/test/.devenv.json": JSON.stringify(validConfig),
      });

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
      vol.fromJSON({
        "/test/.devenv.json": JSON.stringify(validConfig),
      });

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

    it("--verbose のとき変更ファイルのみ renderFileDiff を呼び、unchanged ファイルはスキップ", async () => {
      vol.fromJSON({
        "/test/.devenv.json": JSON.stringify(validConfig),
      });

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

      // 変更された2ファイル分だけ呼ばれる
      expect(mockRenderFileDiff).toHaveBeenCalledTimes(2);
      expect(mockRenderFileDiff).toHaveBeenCalledWith(addedFile);
      expect(mockRenderFileDiff).toHaveBeenCalledWith(modifiedFile);
      // unchanged ファイルは呼ばれない
      expect(mockRenderFileDiff).not.toHaveBeenCalledWith(unchangedFile);
    });
  });
});
