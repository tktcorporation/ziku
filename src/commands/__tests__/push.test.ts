import { vol } from "memfs";
import { Effect, Option } from "effect";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { FileNotFoundError } from "../../errors";

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
  getPushableFiles: vi.fn(() => []),
  generateUnifiedDiff: vi.fn(() => ""),
  colorizeUnifiedDiff: vi.fn((s: string) => s),
}));

// utils/github をモック
vi.mock("../../utils/github", () => ({
  getGitHubToken: vi.fn(),
  createPullRequest: vi.fn(),
}));

// utils/readme をモック
vi.mock("../../utils/readme", () => ({
  detectAndUpdateReadme: vi.fn(() => null),
}));

// utils/untracked をモック
vi.mock("../../utils/untracked", () => ({
  detectUntrackedFiles: vi.fn(() => []),
  getTotalUntrackedCount: vi.fn((groups: Array<{ files: unknown[] }>) =>
    groups.reduce((sum, g) => sum + g.files.length, 0),
  ),
}));

// utils/hash をモック
vi.mock("../../utils/hash", () => ({
  hashFiles: vi.fn(() => ({})),
}));

// utils/merge をモック
vi.mock("../../utils/merge", async () => {
  const effectMod = await import("effect");
  return {
    classifyFiles: vi.fn(() => ({
      autoUpdate: [],
      localOnly: [],
      conflicts: [],
      newFiles: [],
      deletedFiles: [],
      deletedLocally: [],
      unchanged: [],
    })),
    // conflict-io の共通ユーティリティ
    mergeOneFile: vi.fn(),
    downloadBaseForMerge: vi.fn(() => effectMod.Effect.succeed(null)),
  };
});

// utils/template をモック（push 内部で base ダウンロード時に直接 import される）
vi.mock("../../utils/template", () => ({
  downloadTemplateToTemp: vi.fn(() =>
    Promise.resolve({ templateDir: "/tmp/base-template", cleanup: vi.fn() }),
  ),
  buildTemplateSource: vi.fn((source: { owner: string; repo: string; ref?: string }) => {
    const base = `gh:${source.owner}/${source.repo}`;
    return source.ref ? `${base}#${source.ref}` : base;
  }),
}));

// ui/prompts をモック
vi.mock("../../ui/prompts", () => ({
  confirmAction: vi.fn(),
  generatePrTitle: vi.fn(() => "feat: add file.txt config"),
  generatePrBody: vi.fn(() => "## Changes\n\n**Added:**\n- `file.txt`"),
  inputGitHubToken: vi.fn(),
  inputPrTitle: vi.fn(),
  inputPrBody: vi.fn(),
  selectPushFiles: vi.fn(),
  selectUntrackedToTrack: vi.fn(() => []),
  logUntrackedFilesNotice: vi.fn(),
}));

// ui/renderer をモック
vi.mock("../../ui/renderer", () => ({
  intro: vi.fn(),
  outro: vi.fn(),
  log: {
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    success: vi.fn(),
    step: vi.fn(),
    message: vi.fn(),
  },
  logDiffSummary: vi.fn(),
  pc: {
    cyan: (s: string) => s,
    bold: (s: string) => s,
    dim: (s: string) => s,
    green: (s: string) => s,
    yellow: (s: string) => s,
    red: (s: string) => s,
  },
  withSpinner: vi.fn(async (_text: string, fn: () => Promise<unknown>) => fn()),
}));

// モック後にインポート
const { pushCommand } = await import("../push");
const { loadCommandContext } = await import("../../services/command-context");
const { detectDiff, getPushableFiles } = await import("../../utils/diff");
const { getGitHubToken, createPullRequest } = await import("../../utils/github");
const {
  confirmAction,
  inputGitHubToken,
  inputPrTitle,
  inputPrBody,
  selectPushFiles,
  selectUntrackedToTrack,
  logUntrackedFilesNotice,
} = await import("../../ui/prompts");
const { detectUntrackedFiles } = await import("../../utils/untracked");
const { log } = await import("../../ui/renderer");
const { hashFiles } = await import("../../utils/hash");
const { classifyFiles, mergeOneFile, downloadBaseForMerge } = await import("../../utils/merge");
const mockLoadCommandContext = vi.mocked(loadCommandContext);
const mockDetectDiff = vi.mocked(detectDiff);
const mockGetPushableFiles = vi.mocked(getPushableFiles);
const mockGetGitHubToken = vi.mocked(getGitHubToken);
const mockCreatePullRequest = vi.mocked(createPullRequest);
const mockConfirmAction = vi.mocked(confirmAction);
const mockInputGitHubToken = vi.mocked(inputGitHubToken);
const mockInputPrTitle = vi.mocked(inputPrTitle);
const mockInputPrBody = vi.mocked(inputPrBody);
const mockSelectPushFiles = vi.mocked(selectPushFiles);
const mockSelectUntrackedToTrack = vi.mocked(selectUntrackedToTrack);
const mockLogUntrackedFilesNotice = vi.mocked(logUntrackedFilesNotice);
const mockDetectUntrackedFiles = vi.mocked(detectUntrackedFiles);
const mockLog = vi.mocked(log);
const mockHashFiles = vi.mocked(hashFiles);
const mockClassifyFiles = vi.mocked(classifyFiles);
const mockMergeOneFile = vi.mocked(mergeOneFile);
const mockDownloadBaseForMerge = vi.mocked(downloadBaseForMerge);

const validZikuConfig = {
  include: [".github/**"],
  exclude: [],
};

const validLock = {
  version: "0.1.0",
  installedAt: "2024-01-01T00:00:00.000Z",
  source: {
    owner: "tktcorporation",
    repo: ".github",
  },
};

const emptyDiff = {
  files: [],
  summary: { added: 0, modified: 0, deleted: 0, unchanged: 0 },
};

/**
 * テスト用の CommandContext を生成するヘルパー。
 * DI のおかげでテンプレートダウンロードや設定読み込みのモックが不要。
 */
function mockContext(overrides?: {
  config?: typeof validZikuConfig;
  lock?: typeof validLock & Record<string, unknown>;
  source?: { owner: string; repo: string } | { path: string };
  templateDir?: string;
}) {
  const cleanup = vi.fn();
  const source = overrides?.source ?? { owner: "tktcorporation", repo: ".github" };
  return {
    effect: Effect.succeed({
      config: overrides?.config ?? validZikuConfig,
      lock: overrides?.lock ?? validLock,
      source,
      templateDir: overrides?.templateDir ?? "/tmp/template",
      cleanup,
      resolveBaseRef: Effect.succeed(Option.none<string>()),
    }),
    cleanup,
  };
}

/**
 * classification と detectDiff を同時にセットアップするヘルパー。
 * メインの push フローでは classifyFiles が pushable files の決定権を持ち、
 * detectDiff はコンテンツ提供のみを担うため、両方の整合性を取る必要がある。
 */
function setupPushableFiles(
  files: {
    path: string;
    type: "added" | "modified";
    localContent: string;
    templateContent?: string;
  }[],
) {
  // classification: 全ファイルを localOnly に分類（push 対象）
  mockClassifyFiles.mockReturnValueOnce({
    autoUpdate: [],
    localOnly: files.map((f) => f.path),
    conflicts: [],
    newFiles: [],
    deletedFiles: [],
    deletedLocally: [],
    unchanged: [],
  });

  // detectDiff: ファイル内容を提供
  mockDetectDiff.mockResolvedValueOnce({
    files: files.map((f) => ({
      path: f.path,
      type: f.type,
      localContent: f.localContent,
      templateContent: f.templateContent,
    })),
    summary: {
      added: files.filter((f) => f.type === "added").length,
      modified: files.filter((f) => f.type === "modified").length,
      deleted: 0,
      unchanged: 0,
    },
  });
}

describe("pushCommand", () => {
  beforeEach(() => {
    vol.reset();
    vi.clearAllMocks();

    // デフォルトのモック設定: 正常な CommandContext を返す
    const { effect } = mockContext();
    mockLoadCommandContext.mockReturnValue(effect);

    mockDetectDiff.mockResolvedValue(emptyDiff);
    mockGetPushableFiles.mockReturnValue([]);
  });

  describe("meta", () => {
    it("コマンドメタデータが正しい", () => {
      expect((pushCommand.meta as { name: string }).name).toBe("push");
      expect((pushCommand.meta as { description: string }).description).toBe(
        "Push local changes to the template (PR for GitHub, direct copy for local)",
      );
    });
  });

  describe("args", () => {
    it("dir 引数のデフォルト値は '.'", () => {
      const args = pushCommand.args as { dir: { default: string } };
      expect(args.dir.default).toBe(".");
    });

    it("dryRun 引数のデフォルト値は false", () => {
      const args = pushCommand.args as { dryRun: { default: boolean } };
      expect(args.dryRun.default).toBe(false);
    });

    it("yes 引数のデフォルト値は false", () => {
      const args = pushCommand.args as { yes: { default: boolean } };
      expect(args.yes.default).toBe(false);
    });

    it("edit 引数のデフォルト値は false", () => {
      const args = pushCommand.args as { edit: { default: boolean } };
      expect(args.edit.default).toBe(false);
    });
  });

  describe("run", () => {
    it(".ziku/ziku.jsonc が存在しない場合はエラー", async () => {
      mockLoadCommandContext.mockReturnValue(
        Effect.fail(new FileNotFoundError({ path: ".ziku/ziku.jsonc" })),
      );

      await expect(
        (pushCommand.run as any)({
          args: { dir: "/test", dryRun: false, yes: false, edit: false },
          rawArgs: [],
          cmd: pushCommand,
        }),
      ).rejects.toThrow(".ziku/ziku.jsonc not found.");
    });

    it(".ziku/lock.json が存在しない場合はエラー", async () => {
      mockLoadCommandContext.mockReturnValue(
        Effect.fail(new FileNotFoundError({ path: ".ziku/lock.json" })),
      );

      await expect(
        (pushCommand.run as any)({
          args: { dir: "/test", dryRun: false, yes: false, edit: false },
          rawArgs: [],
          cmd: pushCommand,
        }),
      ).rejects.toThrow(".ziku/lock.json not found.");
    });

    it("無効な .ziku/lock.json 形式の場合はエラー", async () => {
      // ParseError は toZikuError で "Failed to parse configuration" に変換される
      const { ParseError } = await import("../../errors");
      mockLoadCommandContext.mockReturnValue(
        Effect.fail(new ParseError({ path: ".ziku/lock.json", cause: "invalid format" })),
      );

      await expect(
        (pushCommand.run as any)({
          args: { dir: "/test", dryRun: false, yes: false, edit: false },
          rawArgs: [],
          cmd: pushCommand,
        }),
      ).rejects.toThrow("Failed to parse configuration");
    });

    it("patterns が空の場合は警告", async () => {
      const { effect } = mockContext({
        config: { include: [], exclude: [] },
      });
      mockLoadCommandContext.mockReturnValue(effect);

      await (pushCommand.run as any)({
        args: { dir: "/test", dryRun: false, yes: false, edit: false },
        rawArgs: [],
        cmd: pushCommand,
      });

      expect(mockLog.warn).toHaveBeenCalledWith("No patterns configured");
    });

    it("push 対象ファイルがない場合は情報メッセージ", async () => {
      mockGetPushableFiles.mockReturnValue([]);

      await (pushCommand.run as any)({
        args: { dir: "/test", dryRun: false, yes: false, edit: false },
        rawArgs: [],
        cmd: pushCommand,
      });

      expect(mockLog.info).toHaveBeenCalledWith("No changes to push");
    });

    it("--dry-run オプションで PR を作成しない", async () => {
      setupPushableFiles([{ path: "file.txt", type: "added", localContent: "content" }]);

      await (pushCommand.run as any)({
        args: { dir: "/test", dryRun: true, yes: false, edit: false },
        rawArgs: [],
        cmd: pushCommand,
      });

      expect(mockLog.info).toHaveBeenCalledWith("Dry run mode");
      // dry-run ではファイルリストを表示して終了
      expect(mockCreatePullRequest).not.toHaveBeenCalled();
    });

    it("ファイル選択をキャンセルすると PR を作成しない", async () => {
      setupPushableFiles([{ path: "file.txt", type: "added", localContent: "content" }]);

      mockSelectPushFiles.mockResolvedValueOnce([]);

      await (pushCommand.run as any)({
        args: { dir: "/test", dryRun: false, yes: false, edit: false },
        rawArgs: [],
        cmd: pushCommand,
      });

      expect(mockLog.info).toHaveBeenCalledWith("No files selected. Cancelled.");
      expect(mockCreatePullRequest).not.toHaveBeenCalled();
    });

    it("PR 作成前の確認でキャンセル", async () => {
      const pushableFile = {
        path: "file.txt",
        type: "added" as const,
        localContent: "content",
      };

      setupPushableFiles([pushableFile]);
      mockSelectPushFiles.mockResolvedValueOnce([pushableFile]);
      mockGetGitHubToken.mockReturnValue("ghp_token");
      mockConfirmAction.mockResolvedValueOnce(false);

      await (pushCommand.run as any)({
        args: { dir: "/test", dryRun: false, yes: false, edit: false },
        rawArgs: [],
        cmd: pushCommand,
      });

      expect(mockLog.info).toHaveBeenCalledWith("Cancelled.");
      expect(mockCreatePullRequest).not.toHaveBeenCalled();
    });

    it("PR 作成成功（タイトル・本文は自動生成）", async () => {
      const pushableFile = {
        path: "file.txt",
        type: "added" as const,
        localContent: "content",
      };

      setupPushableFiles([pushableFile]);
      mockSelectPushFiles.mockResolvedValueOnce([pushableFile]);
      mockGetGitHubToken.mockReturnValue("ghp_token");
      mockConfirmAction.mockResolvedValueOnce(true);
      mockCreatePullRequest.mockResolvedValueOnce({
        url: "https://github.com/owner/repo/pull/1",
        branch: "update-template-123",
        number: 1,
      });

      await (pushCommand.run as any)({
        args: { dir: "/test", dryRun: false, yes: false, edit: false },
        rawArgs: [],
        cmd: pushCommand,
      });

      expect(mockLog.success).toHaveBeenCalledWith("Pull request created!");
      // ファイル選択は常に呼ばれる（--files 未指定時）
      expect(mockSelectPushFiles).toHaveBeenCalled();
      // タイトル入力・本文入力のプロンプトは呼ばれない
      expect(mockInputPrTitle).not.toHaveBeenCalled();
      expect(mockInputPrBody).not.toHaveBeenCalled();
      expect(mockCreatePullRequest).toHaveBeenCalledWith(
        "ghp_token",
        expect.objectContaining({
          owner: "tktcorporation",
          repo: ".github",
          title: "feat: add file.txt config",
          body: "## Changes\n\n**Added:**\n- `file.txt`",
        }),
      );
    });

    it("GitHub トークンがない場合はプロンプト", async () => {
      const pushableFile = {
        path: "file.txt",
        type: "added" as const,
        localContent: "content",
      };

      setupPushableFiles([pushableFile]);
      mockSelectPushFiles.mockResolvedValueOnce([pushableFile]);
      mockGetGitHubToken.mockReturnValue(undefined);
      mockInputGitHubToken.mockResolvedValueOnce("ghp_prompted_token");
      mockConfirmAction.mockResolvedValueOnce(true);
      mockCreatePullRequest.mockResolvedValueOnce({
        url: "https://github.com/owner/repo/pull/1",
        branch: "update-template-123",
        number: 1,
      });

      await (pushCommand.run as any)({
        args: { dir: "/test", dryRun: false, yes: false, edit: false },
        rawArgs: [],
        cmd: pushCommand,
      });

      expect(mockInputGitHubToken).toHaveBeenCalled();
      expect(mockCreatePullRequest).toHaveBeenCalledWith("ghp_prompted_token", expect.anything());
    });

    it("--message オプションで PR タイトルを指定", async () => {
      const pushableFile = {
        path: "file.txt",
        type: "added" as const,
        localContent: "content",
      };

      setupPushableFiles([pushableFile]);
      mockSelectPushFiles.mockResolvedValueOnce([pushableFile]);
      mockGetGitHubToken.mockReturnValue("ghp_token");
      mockConfirmAction.mockResolvedValueOnce(true);
      mockCreatePullRequest.mockResolvedValueOnce({
        url: "https://github.com/owner/repo/pull/1",
        branch: "update-template-123",
        number: 1,
      });

      await (pushCommand.run as any)({
        args: {
          dir: "/test",
          dryRun: false,
          yes: false,
          edit: false,
          message: "Custom PR title",
        },
        rawArgs: [],
        cmd: pushCommand,
      });

      // inputPrTitle は呼ばれない
      expect(mockInputPrTitle).not.toHaveBeenCalled();
      expect(mockCreatePullRequest).toHaveBeenCalledWith(
        "ghp_token",
        expect.objectContaining({
          title: "Custom PR title",
        }),
      );
    });

    it("--files オプションで指定ファイルのみ PR に含める", async () => {
      const file1 = {
        path: ".claude/statusline.sh",
        type: "added" as const,
        localContent: "#!/bin/bash\necho hello",
      };
      const file2 = {
        path: ".claude/settings.json",
        type: "modified" as const,
        localContent: '{"statusLine": "script"}',
        templateContent: '{"statusLine": "default"}',
      };
      const file3 = {
        path: ".devcontainer/devcontainer.json",
        type: "modified" as const,
        localContent: '{"name": "new"}',
        templateContent: '{"name": "old"}',
      };

      setupPushableFiles([file1, file2, file3]);
      mockGetGitHubToken.mockReturnValue("ghp_token");
      mockConfirmAction.mockResolvedValueOnce(true);
      mockCreatePullRequest.mockResolvedValueOnce({
        url: "https://github.com/owner/repo/pull/1",
        branch: "update-template-123",
        number: 1,
      });

      await (pushCommand.run as any)({
        args: {
          dir: "/test",
          dryRun: false,
          yes: false,
          edit: false,
          files: ".claude/statusline.sh,.claude/settings.json",
        },
        rawArgs: [],
        cmd: pushCommand,
      });

      // --files が指定された場合はインタラクティブ選択をスキップ
      expect(mockSelectPushFiles).not.toHaveBeenCalled();
      expect(mockCreatePullRequest).toHaveBeenCalledWith(
        "ghp_token",
        expect.objectContaining({
          files: expect.arrayContaining([
            expect.objectContaining({ path: ".claude/statusline.sh" }),
            expect.objectContaining({ path: ".claude/settings.json" }),
          ]),
        }),
      );
      // file3 は含まれない
      const callArgs = mockCreatePullRequest.mock.calls[0][1];
      expect(callArgs.files.some((f: any) => f.path === ".devcontainer/devcontainer.json")).toBe(
        false,
      );
    });

    it("--files に存在しないファイルを指定すると警告", async () => {
      const file1 = {
        path: "file.txt",
        type: "added" as const,
        localContent: "content",
      };

      setupPushableFiles([file1]);
      mockGetGitHubToken.mockReturnValue("ghp_token");
      mockConfirmAction.mockResolvedValueOnce(true);
      mockCreatePullRequest.mockResolvedValueOnce({
        url: "https://github.com/owner/repo/pull/1",
        branch: "update-template-123",
        number: 1,
      });

      await (pushCommand.run as any)({
        args: {
          dir: "/test",
          dryRun: false,
          yes: false,
          edit: false,
          files: "file.txt,nonexistent.txt",
        },
        rawArgs: [],
        cmd: pushCommand,
      });

      expect(mockLog.warn).toHaveBeenCalledWith("Files not found: nonexistent.txt");
      expect(mockCreatePullRequest).toHaveBeenCalled();
    });

    it("--files に一致するファイルがない場合はキャンセル", async () => {
      setupPushableFiles([{ path: "file.txt", type: "added", localContent: "content" }]);

      await (pushCommand.run as any)({
        args: {
          dir: "/test",
          dryRun: false,
          yes: false,
          edit: false,
          files: "nonexistent.txt",
        },
        rawArgs: [],
        cmd: pushCommand,
      });

      expect(mockLog.info).toHaveBeenCalledWith("No matching files. Cancelled.");
      expect(mockCreatePullRequest).not.toHaveBeenCalled();
    });

    it("--yes オプションで確認をスキップ", async () => {
      const pushableFile = {
        path: "file.txt",
        type: "added" as const,
        localContent: "content",
      };

      setupPushableFiles([pushableFile]);
      mockSelectPushFiles.mockResolvedValueOnce([pushableFile]);
      mockGetGitHubToken.mockReturnValue("ghp_token");
      mockCreatePullRequest.mockResolvedValueOnce({
        url: "https://github.com/owner/repo/pull/1",
        branch: "update-template-123",
        number: 1,
      });

      await (pushCommand.run as any)({
        args: { dir: "/test", dryRun: false, yes: true, edit: false },
        rawArgs: [],
        cmd: pushCommand,
      });

      // --yes: タイトル入力・確認プロンプトをスキップ（ファイル選択は常に表示）
      expect(mockSelectPushFiles).toHaveBeenCalled();
      expect(mockInputPrTitle).not.toHaveBeenCalled();
      expect(mockInputPrBody).not.toHaveBeenCalled();
      expect(mockConfirmAction).not.toHaveBeenCalled();
      expect(mockCreatePullRequest).toHaveBeenCalled();
    });

    it("pendingMerge がある場合はエラー", async () => {
      const { effect } = mockContext({
        lock: {
          ...validLock,
          pendingMerge: {
            conflicts: [".mcp.json"],
            templateHashes: {},
          },
        },
      });
      mockLoadCommandContext.mockReturnValue(effect);

      await expect(
        (pushCommand.run as any)({
          args: { dir: "/test", dryRun: false, yes: false, edit: false },
          rawArgs: [],
          cmd: pushCommand,
        }),
      ).rejects.toThrow("Unresolved merge conflicts");
    });

    it("ローカルソースの場合はファイルを直接テンプレートにコピー", async () => {
      const { effect } = mockContext({
        source: { path: "/local/template" },
        lock: {
          ...validLock,
          source: { path: "/local/template" } as any,
        },
      });
      mockLoadCommandContext.mockReturnValue(effect);

      // ローカル push はエラーにならず正常終了する
      await (pushCommand.run as any)({
        args: { dir: "/test", dryRun: false, yes: true, edit: false },
        rawArgs: [],
        cmd: pushCommand,
      });

      // PR は作成されない
      expect(mockCreatePullRequest).not.toHaveBeenCalled();
    });

    it("未解決の衝突は既定では push されず警告のみ（巻き添えで中断しない）", async () => {
      const { effect } = mockContext({
        lock: {
          ...validLock,
          baseHashes: {
            "file.txt": "abc123",
          },
        },
      });
      mockLoadCommandContext.mockReturnValue(effect);

      vol.fromJSON({
        "/test/file.txt": "local content",
        "/tmp/template/file.txt": "template content",
      });

      // classifyFiles がコンフリクトを返す（baseRef なし → 3-way マージ不可 → unresolved）
      mockClassifyFiles.mockReturnValueOnce({
        autoUpdate: [],
        localOnly: [],
        conflicts: ["file.txt"],
        newFiles: [],
        deletedFiles: [],
        deletedLocally: [],
        unchanged: [],
      });
      // 衝突ファイルは候補として現れる
      mockDetectDiff.mockResolvedValueOnce({
        files: [
          {
            path: "file.txt",
            type: "modified",
            localContent: "local content",
            templateContent: "template content",
          },
        ],
        summary: { added: 0, modified: 1, deleted: 0, unchanged: 0 },
      });
      // 衝突ファイルは既定で未選択 → ユーザーは何も選ばない
      mockSelectPushFiles.mockResolvedValueOnce([]);

      // 中断せず正常終了する（衝突ファイルは除外されるだけ）
      await (pushCommand.run as any)({
        args: { dir: "/test", dryRun: false, yes: false, edit: false },
        rawArgs: [],
        cmd: pushCommand,
      });

      // 未解決の衝突を警告で知らせる
      expect(mockLog.warn).toHaveBeenCalledWith(expect.stringContaining("unresolved conflicts"));
      // 選択しなければ push されない
      expect(mockCreatePullRequest).not.toHaveBeenCalled();
    });

    it("コンフリクトしていないファイルは、未解決の衝突があっても push できる", async () => {
      const { effect } = mockContext({
        lock: {
          ...validLock,
          baseHashes: { "bad.txt": "abc123" },
        },
      });
      mockLoadCommandContext.mockReturnValue(effect);

      vol.fromJSON({
        "/test/bad.txt": "local",
        "/tmp/template/bad.txt": "template",
      });

      // safe.txt は localOnly（push 可）、bad.txt は conflict（baseRef なし → unresolved）
      mockClassifyFiles.mockReturnValueOnce({
        autoUpdate: [],
        localOnly: ["safe.txt"],
        conflicts: ["bad.txt"],
        newFiles: [],
        deletedFiles: [],
        deletedLocally: [],
        unchanged: [],
      });
      mockDetectDiff.mockResolvedValueOnce({
        files: [
          { path: "safe.txt", type: "added", localContent: "safe" },
          { path: "bad.txt", type: "modified", localContent: "local", templateContent: "template" },
        ],
        summary: { added: 1, modified: 1, deleted: 0, unchanged: 0 },
      });
      // ユーザーは衝突しない safe.txt のみ選択（bad.txt は既定で未選択）
      mockSelectPushFiles.mockResolvedValueOnce([
        { path: "safe.txt", type: "added", localContent: "safe" },
      ]);
      mockGetGitHubToken.mockReturnValue("ghp_token");
      mockConfirmAction.mockResolvedValueOnce(true);
      mockCreatePullRequest.mockResolvedValueOnce({
        url: "https://github.com/owner/repo/pull/1",
        branch: "update-template-123",
        number: 1,
      });

      await (pushCommand.run as any)({
        args: { dir: "/test", dryRun: false, yes: false, edit: false },
        rawArgs: [],
        cmd: pushCommand,
      });

      // safe.txt は push される
      expect(mockCreatePullRequest).toHaveBeenCalledWith(
        "ghp_token",
        expect.objectContaining({
          files: expect.arrayContaining([expect.objectContaining({ path: "safe.txt" })]),
        }),
      );
      // 未解決の bad.txt は push に含まれない
      const callArgs = mockCreatePullRequest.mock.calls[0][1];
      expect(callArgs.files.some((f: any) => f.path === "bad.txt")).toBe(false);
    });

    it("未解決の衝突を --files で明示指定すると中断し、ファイル名と ziku pull を案内する", async () => {
      const { effect } = mockContext({
        lock: {
          ...validLock,
          baseHashes: {
            "file.txt": "abc123",
          },
        },
      });
      mockLoadCommandContext.mockReturnValue(effect);

      vol.fromJSON({
        "/test/file.txt": "local content",
        "/tmp/template/file.txt": "template content",
      });

      mockClassifyFiles.mockReturnValueOnce({
        autoUpdate: [],
        localOnly: [],
        conflicts: ["file.txt"],
        newFiles: [],
        deletedFiles: [],
        deletedLocally: [],
        unchanged: [],
      });
      mockDetectDiff.mockResolvedValueOnce({
        files: [
          {
            path: "file.txt",
            type: "modified",
            localContent: "local content",
            templateContent: "template content",
          },
        ],
        summary: { added: 0, modified: 1, deleted: 0, unchanged: 0 },
      });

      // --files で衝突ファイルを明示指定 → 解決を促して確定的に中断する。
      // hint には対象ファイル名と解決手順（ziku pull）が両方含まれること。
      await expect(
        (pushCommand.run as any)({
          args: { dir: "/test", dryRun: false, yes: false, edit: false, files: "file.txt" },
          rawArgs: [],
          cmd: pushCommand,
        }),
      ).rejects.toMatchObject({
        name: "ZikuError",
        message: expect.stringContaining("couldn't be auto-merged"),
        hint: expect.stringMatching(/file\.txt[\s\S]*ziku pull/),
      });

      expect(mockCreatePullRequest).not.toHaveBeenCalled();
    });

    it("対話で未解決の衝突を選択すると中断する（--files 以外の経路）", async () => {
      const { effect } = mockContext({
        lock: {
          ...validLock,
          baseHashes: { "file.txt": "abc123" },
        },
      });
      mockLoadCommandContext.mockReturnValue(effect);

      vol.fromJSON({
        "/test/file.txt": "local content",
        "/tmp/template/file.txt": "template content",
      });

      mockClassifyFiles.mockReturnValueOnce({
        autoUpdate: [],
        localOnly: [],
        conflicts: ["file.txt"],
        newFiles: [],
        deletedFiles: [],
        deletedLocally: [],
        unchanged: [],
      });
      const conflictFile = {
        path: "file.txt",
        type: "modified" as const,
        localContent: "local content",
        templateContent: "template content",
      };
      mockDetectDiff.mockResolvedValueOnce({
        files: [conflictFile],
        summary: { added: 0, modified: 1, deleted: 0, unchanged: 0 },
      });
      // 既定では未選択だが、ユーザーが対話で衝突ファイルを明示選択したケース
      mockSelectPushFiles.mockResolvedValueOnce([conflictFile]);

      await expect(
        (pushCommand.run as any)({
          args: { dir: "/test", dryRun: false, yes: false, edit: false },
          rawArgs: [],
          cmd: pushCommand,
        }),
      ).rejects.toMatchObject({
        name: "ZikuError",
        message: expect.stringContaining("couldn't be auto-merged"),
        hint: expect.stringMatching(/file\.txt[\s\S]*ziku pull/),
      });

      expect(mockCreatePullRequest).not.toHaveBeenCalled();
    });

    it("baseRef + baseHashes がある場合に 3-way マージで自動解決", async () => {
      const { effect } = mockContext({
        lock: {
          ...validLock,
          baseRef: "abc123def456",
          baseHashes: {
            "file.txt": "abc123",
          },
        },
      });
      mockLoadCommandContext.mockReturnValue(effect);

      vol.fromJSON({
        "/test/file.txt": "local content",
        "/tmp/template/file.txt": "template content",
        // base テンプレートのファイル（downloadTemplateToTemp が /tmp/base-template を返す）
        "/tmp/base-template/file.txt": "base content",
      });

      mockClassifyFiles.mockReturnValueOnce({
        autoUpdate: [],
        localOnly: [],
        conflicts: ["file.txt"],
        newFiles: [],
        deletedFiles: [],
        deletedLocally: [],
        unchanged: [],
      });

      // downloadBaseForMerge がベースを返す
      mockDownloadBaseForMerge.mockReturnValueOnce(
        Effect.succeed({ templateDir: "/tmp/base-template", cleanup: vi.fn() }),
      );

      // mergeOneFile のモック（自動マージ成功）
      mockMergeOneFile.mockReturnValueOnce(
        Effect.succeed({ file: "file.txt", content: "merged content", hasConflicts: false }),
      );

      const pushableFile = {
        path: "file.txt",
        type: "modified" as const,
        localContent: "local content",
        templateContent: "template content",
      };

      // detectDiff: コンテンツを提供
      mockDetectDiff.mockResolvedValueOnce({
        files: [pushableFile],
        summary: { added: 0, modified: 1, deleted: 0, unchanged: 0 },
      });

      mockSelectPushFiles.mockResolvedValueOnce([pushableFile]);
      // 3-way マージ成功 → unresolved なし → 確認は PR 作成確認のみ
      mockConfirmAction.mockResolvedValueOnce(true);
      mockGetGitHubToken.mockReturnValue("ghp_token");
      mockCreatePullRequest.mockResolvedValueOnce({
        url: "https://github.com/owner/repo/pull/1",
        branch: "update-template-123",
        number: 1,
      });

      await (pushCommand.run as any)({
        args: { dir: "/test", dryRun: false, yes: false, edit: false },
        rawArgs: [],
        cmd: pushCommand,
      });

      expect(mockLog.success).toHaveBeenCalledWith("Auto-merged 1 file(s):");

      // mergeOneFile に正しい引数が渡されること
      expect(mockMergeOneFile).toHaveBeenCalledWith({
        file: "file.txt",
        targetDir: "/test",
        templateDir: "/tmp/template",
        baseTemplateDir: "/tmp/base-template",
      });

      expect(mockCreatePullRequest).toHaveBeenCalledWith(
        "ghp_token",
        expect.objectContaining({
          files: expect.arrayContaining([
            expect.objectContaining({
              path: "file.txt",
              content: "merged content",
            }),
          ]),
        }),
      );
    });

    it("delete/modify conflict: 未解決でも ENOENT で落ちず、除外して継続する", async () => {
      const { effect } = mockContext({
        lock: {
          ...validLock,
          baseRef: "abc123def456",
          baseHashes: {
            "deleted-file.txt": "abc123",
          },
        },
      });
      mockLoadCommandContext.mockReturnValue(effect);

      // ローカルにファイルが存在しない（削除済み）
      // テンプレートと base テンプレートにはファイルが存在する
      vol.fromJSON({
        "/tmp/template/deleted-file.txt": "template content updated",
        "/tmp/base-template/deleted-file.txt": "base content",
      });

      mockClassifyFiles.mockReturnValueOnce({
        autoUpdate: [],
        localOnly: [],
        conflicts: ["deleted-file.txt"], // delete/modify conflict
        newFiles: [],
        deletedFiles: [],
        deletedLocally: [],
        unchanged: [],
      });

      // downloadBaseForMerge がベースを返す
      mockDownloadBaseForMerge.mockReturnValueOnce(
        Effect.succeed({ templateDir: "/tmp/base-template", cleanup: vi.fn() }),
      );

      // mergeOneFile: コンフリクト（delete/modify conflict は mergeOneFile 内で
      // readFileSafe により安全にローカル=空文字列で処理される）
      mockMergeOneFile.mockReturnValueOnce(
        Effect.succeed({
          file: "deleted-file.txt",
          content: "<<<<<<< LOCAL\n=======\ntemplate content updated\n>>>>>>> TEMPLATE",
          hasConflicts: true,
        }),
      );

      // ENOENT で落ちず、未解決の衝突は push 対象から除外して正常終了する。
      await (pushCommand.run as any)({
        args: { dir: "/test", dryRun: false, yes: false, edit: false },
        rawArgs: [],
        cmd: pushCommand,
      });

      // delete/modify conflict も安全に処理（mergeOneFile が呼ばれている）
      expect(mockMergeOneFile).toHaveBeenCalled();
      // 未解決なので push されない
      expect(mockCreatePullRequest).not.toHaveBeenCalled();
    });

    it("--yes でも未解決の衝突は push されない（暗黙の上書きをしない）", async () => {
      const { effect } = mockContext({
        lock: {
          ...validLock,
          baseHashes: {
            "file.txt": "abc123",
          },
        },
      });
      mockLoadCommandContext.mockReturnValue(effect);

      vol.fromJSON({
        "/test/file.txt": "local content",
        "/tmp/template/file.txt": "template content",
      });

      // baseRef なし → 3-way マージ不可 → unresolved
      mockClassifyFiles.mockReturnValueOnce({
        autoUpdate: [],
        localOnly: [],
        conflicts: ["file.txt"],
        newFiles: [],
        deletedFiles: [],
        deletedLocally: [],
        unchanged: [],
      });
      mockDetectDiff.mockResolvedValueOnce({
        files: [
          {
            path: "file.txt",
            type: "modified",
            localContent: "local content",
            templateContent: "template content",
          },
        ],
        summary: { added: 0, modified: 1, deleted: 0, unchanged: 0 },
      });
      // 衝突ファイルは既定で未選択（フォールバック selector が除外する）
      mockSelectPushFiles.mockResolvedValueOnce([]);

      // --yes でも暗黙の上書き push はしない。衝突ファイルは選択 selector に
      // conflictedPaths として渡され、既定で未選択になる。
      await (pushCommand.run as any)({
        args: { dir: "/test", dryRun: false, yes: true, edit: false },
        rawArgs: [],
        cmd: pushCommand,
      });

      // selector に衝突ファイルが「コンフリクト」として渡される
      const selectOpts = mockSelectPushFiles.mock.calls[0]?.[1] as
        | { conflictedPaths?: Set<string> }
        | undefined;
      expect(selectOpts?.conflictedPaths?.has("file.txt")).toBe(true);
      // 衝突は push されない
      expect(mockCreatePullRequest).not.toHaveBeenCalled();
    });

    it("baseHashes がない場合でもコンフリクト検出を実行（空の baseHashes で分類）", async () => {
      mockGetPushableFiles.mockReturnValue([]);

      await (pushCommand.run as any)({
        args: { dir: "/test", dryRun: false, yes: false, edit: false },
        rawArgs: [],
        cmd: pushCommand,
      });

      // baseHashes がなくても hashFiles と classifyFiles は実行される
      expect(mockHashFiles).toHaveBeenCalled();
      expect(mockClassifyFiles).toHaveBeenCalledWith(
        expect.objectContaining({
          baseHashes: {},
        }),
      );
    });

    it("autoUpdate ファイル（テンプレートのみ変更）は classification により push 対象外", async () => {
      const { effect } = mockContext({
        lock: {
          ...validLock,
          baseHashes: {
            "file.txt": "abc123",
            "template-only.txt": "def456",
          },
        },
      });
      mockLoadCommandContext.mockReturnValue(effect);

      vol.fromJSON({
        "/test/file.txt": "local content",
        "/test/template-only.txt": "old template content",
        "/tmp/template/file.txt": "local content",
        "/tmp/template/template-only.txt": "new template content",
      });

      // classification が autoUpdate に分類 → pushableFilePaths に含まれない
      mockClassifyFiles.mockReturnValueOnce({
        autoUpdate: ["template-only.txt"],
        localOnly: [],
        conflicts: [],
        newFiles: [],
        deletedFiles: [],
        deletedLocally: [],
        unchanged: ["file.txt"],
      });

      // detectDiff は template-only.txt を "modified" として返すが、
      // classification の pushableFilePaths に含まれないため除外される
      mockDetectDiff.mockResolvedValueOnce({
        files: [
          {
            path: "template-only.txt",
            type: "modified" as const,
            localContent: "old template content",
            templateContent: "new template content",
          },
        ],
        summary: { added: 0, modified: 1, deleted: 0, unchanged: 0 },
      });

      await (pushCommand.run as any)({
        args: { dir: "/test", dryRun: false, yes: false, edit: false },
        rawArgs: [],
        cmd: pushCommand,
      });

      // autoUpdate ファイルは classification により除外 → "No changes to push"
      expect(mockLog.info).toHaveBeenCalledWith(
        expect.stringContaining("Skipping 1 file(s) only changed in template"),
      );
      expect(mockLog.info).toHaveBeenCalledWith("No changes to push");
      expect(mockCreatePullRequest).not.toHaveBeenCalled();
    });

    it("baseHashes が存在しコンフリクトがない場合は正常に続行", async () => {
      const { effect } = mockContext({
        lock: {
          ...validLock,
          baseHashes: {
            "file.txt": "abc123",
          },
        },
      });
      mockLoadCommandContext.mockReturnValue(effect);

      // コンフリクトなし
      mockClassifyFiles.mockReturnValueOnce({
        autoUpdate: ["file.txt"],
        localOnly: [],
        conflicts: [],
        newFiles: [],
        deletedFiles: [],
        deletedLocally: [],
        unchanged: [],
      });

      mockGetPushableFiles.mockReturnValue([]);

      await (pushCommand.run as any)({
        args: { dir: "/test", dryRun: false, yes: false, edit: false },
        rawArgs: [],
        cmd: pushCommand,
      });

      // コンフリクト検出は実行されたが、エラーにはならない
      expect(mockHashFiles).toHaveBeenCalled();
      expect(mockClassifyFiles).toHaveBeenCalled();
      // "No changes to push" に到達
      expect(mockLog.info).toHaveBeenCalledWith("No changes to push");
    });
  });
});

describe("未追跡ファイルの追跡フロー", () => {
  beforeEach(() => {
    vol.reset();
    vi.clearAllMocks();
    const { effect } = mockContext();
    mockLoadCommandContext.mockReturnValue(effect);
    mockDetectDiff.mockResolvedValue(emptyDiff);
    mockGetPushableFiles.mockReturnValue([]);
  });

  /** /test/.ziku/ziku.jsonc を初期 include 付きで memfs に用意する */
  function seedZikuConfig(include: string[] = [".github/**"]): void {
    vol.fromJSON({
      "/test/.ziku/ziku.jsonc": `${JSON.stringify(
        { $schema: "https://example.com/schema.json", include },
        null,
        2,
      )}\n`,
    });
  }

  /** memfs 上の /test/.ziku/ziku.jsonc の include 配列を読み出す */
  function readTrackedInclude(): string[] {
    const raw = vol.toJSON()["/test/.ziku/ziku.jsonc"] as string;
    return JSON.parse(raw).include as string[];
  }

  const untrackedDocsFile = [{ folder: "docs", files: [{ path: "docs/new.md", folder: "docs" }] }];

  it("対話モードで選択した未追跡ファイルが include に追記され push 対象に乗る", async () => {
    seedZikuConfig();
    mockDetectUntrackedFiles.mockReturnValueOnce(untrackedDocsFile as never);
    mockSelectUntrackedToTrack.mockResolvedValueOnce(["docs/new.md"]);

    // 追跡したファイルが localOnly として分類され、diff にも現れる
    setupPushableFiles([{ path: "docs/new.md", type: "added", localContent: "# New doc" }]);
    mockSelectPushFiles.mockResolvedValueOnce([
      { path: "docs/new.md", type: "added", localContent: "# New doc" },
    ]);
    mockGetGitHubToken.mockReturnValue("ghp_token");
    mockConfirmAction.mockResolvedValueOnce(true);
    mockCreatePullRequest.mockResolvedValueOnce({
      url: "https://github.com/owner/repo/pull/1",
      branch: "update-template-123",
      number: 1,
    });

    await (pushCommand.run as any)({
      args: { dir: "/test", dryRun: false, yes: false, edit: false },
      rawArgs: [],
      cmd: pushCommand,
    });

    // 追跡ファイルが PR に含まれる
    expect(mockCreatePullRequest).toHaveBeenCalledWith(
      "ghp_token",
      expect.objectContaining({
        files: expect.arrayContaining([expect.objectContaining({ path: "docs/new.md" })]),
      }),
    );
    // include に永続化される（push 成功後）
    expect(readTrackedInclude()).toContain("docs/new.md");
    expect(mockLog.success).toHaveBeenCalledWith(expect.stringContaining("Tracked 1 new file(s)"));
  });

  it("未追跡を1件も選択しなければ include は変化しない", async () => {
    seedZikuConfig();
    mockDetectUntrackedFiles.mockReturnValueOnce(untrackedDocsFile as never);
    mockSelectUntrackedToTrack.mockResolvedValueOnce([]);

    // 別の追跡済みファイルの変更だけを push する
    setupPushableFiles([{ path: "file.txt", type: "added", localContent: "content" }]);
    mockSelectPushFiles.mockResolvedValueOnce([
      { path: "file.txt", type: "added", localContent: "content" },
    ]);
    mockGetGitHubToken.mockReturnValue("ghp_token");
    mockConfirmAction.mockResolvedValueOnce(true);
    mockCreatePullRequest.mockResolvedValueOnce({
      url: "https://github.com/owner/repo/pull/1",
      branch: "update-template-123",
      number: 1,
    });

    await (pushCommand.run as any)({
      args: { dir: "/test", dryRun: false, yes: false, edit: false },
      rawArgs: [],
      cmd: pushCommand,
    });

    expect(readTrackedInclude()).toEqual([".github/**"]);
    expect(mockLog.success).not.toHaveBeenCalledWith(expect.stringContaining("Tracked"));
  });

  it("push 失敗時は include を書き換えない（部分適用しない）", async () => {
    seedZikuConfig();
    mockDetectUntrackedFiles.mockReturnValueOnce(untrackedDocsFile as never);
    mockSelectUntrackedToTrack.mockResolvedValueOnce(["docs/new.md"]);

    setupPushableFiles([{ path: "docs/new.md", type: "added", localContent: "# New doc" }]);
    mockSelectPushFiles.mockResolvedValueOnce([
      { path: "docs/new.md", type: "added", localContent: "# New doc" },
    ]);
    mockGetGitHubToken.mockReturnValue("ghp_token");
    mockConfirmAction.mockResolvedValueOnce(true);
    // PR 作成が失敗する
    mockCreatePullRequest.mockRejectedValueOnce(new Error("network error"));

    await expect(
      (pushCommand.run as any)({
        args: { dir: "/test", dryRun: false, yes: false, edit: false },
        rawArgs: [],
        cmd: pushCommand,
      }),
    ).rejects.toThrow();

    // push が失敗したので include は元のまま
    expect(readTrackedInclude()).toEqual([".github/**"]);
  });

  it("--yes では未追跡を追加せず、除外を明示通知する", async () => {
    seedZikuConfig();
    mockDetectUntrackedFiles.mockReturnValueOnce(untrackedDocsFile as never);
    // --yes では追跡対象なし → push 対象もなしで終了
    mockGetPushableFiles.mockReturnValue([]);

    await (pushCommand.run as any)({
      args: { dir: "/test", dryRun: false, yes: true, edit: false },
      rawArgs: [],
      cmd: pushCommand,
    });

    // 選択プロンプトは出さない
    expect(mockSelectUntrackedToTrack).not.toHaveBeenCalled();
    // 除外を通知する
    expect(mockLogUntrackedFilesNotice).toHaveBeenCalledWith(
      untrackedDocsFile,
      1,
      expect.objectContaining({ headline: expect.stringContaining("excluded from push") }),
    );
    // include は変化しない
    expect(readTrackedInclude()).toEqual([".github/**"]);
  });

  it("--dry-run では未追跡を追加せず、dry-run 用の通知文言を出す", async () => {
    seedZikuConfig();
    mockDetectUntrackedFiles.mockReturnValueOnce(untrackedDocsFile as never);

    await (pushCommand.run as any)({
      args: { dir: "/test", dryRun: true, yes: false, edit: false },
      rawArgs: [],
      cmd: pushCommand,
    });

    // dry-run は「除外」ではなく「追跡判断のスキップ」と伝える
    expect(mockSelectUntrackedToTrack).not.toHaveBeenCalled();
    expect(mockLogUntrackedFilesNotice).toHaveBeenCalledWith(
      untrackedDocsFile,
      1,
      expect.objectContaining({ headline: expect.stringContaining("dry-run: tracking skipped") }),
    );
    expect(readTrackedInclude()).toEqual([".github/**"]);
  });

  it("ローカルソースへの push でも、追跡したファイルが include に永続化される", async () => {
    const { effect } = mockContext({
      source: { path: "/local/template" },
      lock: { ...validLock, source: { path: "/local/template" } as any },
    });
    mockLoadCommandContext.mockReturnValue(effect);
    seedZikuConfig();
    mockDetectUntrackedFiles.mockReturnValueOnce(untrackedDocsFile as never);
    mockSelectUntrackedToTrack.mockResolvedValueOnce(["docs/new.md"]);

    setupPushableFiles([{ path: "docs/new.md", type: "added", localContent: "# New doc" }]);
    mockSelectPushFiles.mockResolvedValueOnce([
      { path: "docs/new.md", type: "added", localContent: "# New doc" },
    ]);
    // ローカル push の確認プロンプト
    mockConfirmAction.mockResolvedValueOnce(true);

    await (pushCommand.run as any)({
      args: { dir: "/test", dryRun: false, yes: false, edit: false },
      rawArgs: [],
      cmd: pushCommand,
    });

    // ローカル push 経路（PR は作らない）でも include に追記される
    expect(mockCreatePullRequest).not.toHaveBeenCalled();
    expect(readTrackedInclude()).toContain("docs/new.md");
  });

  it("追跡を選んでもファイル選択で外したファイルは永続化されない", async () => {
    seedZikuConfig();
    mockDetectUntrackedFiles.mockReturnValueOnce(untrackedDocsFile as never);
    mockSelectUntrackedToTrack.mockResolvedValueOnce(["docs/new.md"]);

    // docs/new.md（追跡候補）と safe.txt の両方が push 可能
    setupPushableFiles([
      { path: "docs/new.md", type: "added", localContent: "# New doc" },
      { path: "safe.txt", type: "added", localContent: "safe" },
    ]);
    // ユーザーはファイル選択で safe.txt のみ選び、docs/new.md は外す
    mockSelectPushFiles.mockResolvedValueOnce([
      { path: "safe.txt", type: "added", localContent: "safe" },
    ]);
    mockGetGitHubToken.mockReturnValue("ghp_token");
    mockConfirmAction.mockResolvedValueOnce(true);
    mockCreatePullRequest.mockResolvedValueOnce({
      url: "https://github.com/owner/repo/pull/1",
      branch: "update-template-123",
      number: 1,
    });

    await (pushCommand.run as any)({
      args: { dir: "/test", dryRun: false, yes: false, edit: false },
      rawArgs: [],
      cmd: pushCommand,
    });

    // 実際に push したのは safe.txt のみ。push していない docs/new.md は追跡されない。
    const callArgs = mockCreatePullRequest.mock.calls[0][1];
    expect(callArgs.files.some((f: any) => f.path === "safe.txt")).toBe(true);
    expect(readTrackedInclude()).toEqual([".github/**"]);
  });
});

describe("pushCommand args", () => {
  it("args に yes フラグが定義されている", () => {
    const args = pushCommand.args as Record<string, { type: string; default?: unknown }>;
    expect(args.yes).toBeDefined();
    expect(args.yes.default).toBe(false);
  });

  it("args に force という名前のトップレベルフラグが存在しない", () => {
    const args = pushCommand.args as Record<string, unknown>;
    expect(args.force).toBeUndefined();
  });
});
