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
  downloadTemplateToTemp: vi.fn(() =>
    Promise.resolve({ templateDir: "/tmp/base-template", cleanup: vi.fn() }),
  ),
}));

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
}));

// utils/hash をモック
vi.mock("../../utils/hash", () => ({
  hashFiles: vi.fn(() => ({})),
}));

// utils/merge をモック
vi.mock("../../utils/merge", () => ({
  classifyFiles: vi.fn(() => ({
    autoUpdate: [],
    localOnly: [],
    conflicts: [],
    newFiles: [],
    deletedFiles: [],
    unchanged: [],
  })),
  threeWayMerge: vi.fn(() => ({
    content: "merged",
    hasConflicts: false,
    conflictDetails: [],
  })),
  asBaseContent: vi.fn((s: string) => s),
  asLocalContent: vi.fn((s: string) => s),
  asTemplateContent: vi.fn((s: string) => s),
}));

// utils/patterns をモック
vi.mock("../../utils/patterns", () => ({
  getEffectivePatterns: vi.fn((_moduleId: string, patterns: string[]) => patterns),
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
}));

// modules をモック
vi.mock("../../modules", () => ({
  modulesFileExists: vi.fn(() => true),
  loadModulesFile: vi.fn(() =>
    Promise.resolve({
      modules: [
        {
          id: "root",
          name: "Root",
          description: "Root",
          patterns: [".root/**"],
        },
        {
          id: "github",
          name: "GitHub",
          description: "GitHub",
          patterns: [".github/**"],
        },
      ],
      rawContent: '{"modules":[]}',
    }),
  ),
  addPatternToModulesFile: vi.fn(),
  getModuleById: vi.fn((id: string) => ({
    id,
    name: id,
    description: `${id} module`,
    patterns: [`.${id}/**`],
  })),
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
const { downloadTemplate } = await import("giget");
const { detectDiff, getPushableFiles } = await import("../../utils/diff");
const { getGitHubToken, createPullRequest } = await import("../../utils/github");
const { confirmAction, inputGitHubToken, inputPrTitle, inputPrBody, selectPushFiles } =
  await import("../../ui/prompts");
const { log } = await import("../../ui/renderer");
const { hashFiles } = await import("../../utils/hash");
const { classifyFiles, threeWayMerge } = await import("../../utils/merge");
const mockDownloadTemplate = vi.mocked(downloadTemplate);
const mockDetectDiff = vi.mocked(detectDiff);
const mockGetPushableFiles = vi.mocked(getPushableFiles);
const mockGetGitHubToken = vi.mocked(getGitHubToken);
const mockCreatePullRequest = vi.mocked(createPullRequest);
const mockConfirmAction = vi.mocked(confirmAction);
const mockInputGitHubToken = vi.mocked(inputGitHubToken);
const mockInputPrTitle = vi.mocked(inputPrTitle);
const mockInputPrBody = vi.mocked(inputPrBody);
const mockSelectPushFiles = vi.mocked(selectPushFiles);
const mockLog = vi.mocked(log);
const mockHashFiles = vi.mocked(hashFiles);
const mockClassifyFiles = vi.mocked(classifyFiles);
const mockThreeWayMerge = vi.mocked(threeWayMerge);

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

    // デフォルトのモック設定
    mockDownloadTemplate.mockResolvedValue({
      dir: "/tmp/template",
      source: "gh:tktcorporation/.github",
    });
    mockDetectDiff.mockResolvedValue(emptyDiff);
    mockGetPushableFiles.mockReturnValue([]);
  });

  describe("meta", () => {
    it("コマンドメタデータが正しい", () => {
      expect((pushCommand.meta as { name: string }).name).toBe("push");
      expect((pushCommand.meta as { description: string }).description).toBe(
        "Push local changes to the template repository as a PR",
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
    it(".devenv.json が存在しない場合はエラー", async () => {
      vol.fromJSON({
        "/test": null,
      });

      await expect(
        (pushCommand.run as any)({
          args: { dir: "/test", dryRun: false, yes: false, edit: false },
          rawArgs: [],
          cmd: pushCommand,
        }),
      ).rejects.toThrow(".devenv.json not found.");
    });

    it("無効な .devenv.json 形式の場合はエラー", async () => {
      vol.fromJSON({
        "/test/.devenv.json": JSON.stringify({ invalid: "format" }),
      });

      await expect(
        (pushCommand.run as any)({
          args: { dir: "/test", dryRun: false, yes: false, edit: false },
          rawArgs: [],
          cmd: pushCommand,
        }),
      ).rejects.toThrow("Invalid .devenv.json format");
    });

    it("modules が空の場合は警告", async () => {
      vol.fromJSON({
        "/test/.devenv.json": JSON.stringify({
          ...validConfig,
          modules: [],
        }),
      });

      await (pushCommand.run as any)({
        args: { dir: "/test", dryRun: false, yes: false, edit: false },
        rawArgs: [],
        cmd: pushCommand,
      });

      expect(mockLog.warn).toHaveBeenCalledWith("No modules installed");
    });

    it("push 対象ファイルがない場合は情報メッセージ", async () => {
      vol.fromJSON({
        "/test/.devenv.json": JSON.stringify(validConfig),
      });

      mockGetPushableFiles.mockReturnValue([]);

      await (pushCommand.run as any)({
        args: { dir: "/test", dryRun: false, yes: false, edit: false },
        rawArgs: [],
        cmd: pushCommand,
      });

      expect(mockLog.info).toHaveBeenCalledWith("No changes to push");
    });

    it("--dry-run オプションで PR を作成しない", async () => {
      vol.fromJSON({
        "/test/.devenv.json": JSON.stringify(validConfig),
      });

      setupPushableFiles([{ path: "file.txt", type: "added", localContent: "content" }]);

      await (pushCommand.run as any)({
        args: { dir: "/test", dryRun: true, yes: false, edit: false },
        rawArgs: [],
        cmd: pushCommand,
      });

      expect(mockLog.info).toHaveBeenCalledWith("Dry run mode");
      expect(mockLog.info).toHaveBeenCalledWith("No PR was created (dry run)");
      expect(mockCreatePullRequest).not.toHaveBeenCalled();
    });

    it("ファイル選択をキャンセルすると PR を作成しない", async () => {
      vol.fromJSON({
        "/test/.devenv.json": JSON.stringify(validConfig),
      });

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
      vol.fromJSON({
        "/test/.devenv.json": JSON.stringify(validConfig),
      });

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

      expect(mockLog.info).toHaveBeenCalledWith(
        "Cancelled. Use --edit to customize title/body, or --files to specify files.",
      );
      expect(mockCreatePullRequest).not.toHaveBeenCalled();
    });

    it("PR 作成成功（タイトル・本文は自動生成）", async () => {
      vol.fromJSON({
        "/test/.devenv.json": JSON.stringify(validConfig),
      });

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
      vol.fromJSON({
        "/test/.devenv.json": JSON.stringify(validConfig),
      });

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
      vol.fromJSON({
        "/test/.devenv.json": JSON.stringify(validConfig),
      });

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
      vol.fromJSON({
        "/test/.devenv.json": JSON.stringify(validConfig),
      });

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
      vol.fromJSON({
        "/test/.devenv.json": JSON.stringify(validConfig),
      });

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

      expect(mockLog.warn).toHaveBeenCalledWith(
        "Files not found in pushable changes: nonexistent.txt",
      );
      expect(mockCreatePullRequest).toHaveBeenCalled();
    });

    it("--files に一致するファイルがない場合はキャンセル", async () => {
      vol.fromJSON({
        "/test/.devenv.json": JSON.stringify(validConfig),
      });

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

      expect(mockLog.info).toHaveBeenCalledWith("No matching files found. Cancelled.");
      expect(mockCreatePullRequest).not.toHaveBeenCalled();
    });

    it("--yes オプションで確認をスキップ", async () => {
      vol.fromJSON({
        "/test/.devenv.json": JSON.stringify(validConfig),
      });

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

    it("baseHashes が存在しコンフリクトがある場合は警告して確認を求める（baseRef なし）", async () => {
      const configWithBaseHashes = {
        ...validConfig,
        baseHashes: {
          "file.txt": "abc123",
        },
      };

      vol.fromJSON({
        "/test/.devenv.json": JSON.stringify(configWithBaseHashes),
        "/test/file.txt": "local content",
        "/tmp/template/file.txt": "template content",
      });

      // classifyFiles がコンフリクトを返す
      mockClassifyFiles.mockReturnValueOnce({
        autoUpdate: [],
        localOnly: [],
        conflicts: ["file.txt"],
        newFiles: [],
        deletedFiles: [],
        unchanged: [],
      });

      // baseRef がないので 3-way マージ不可 → unresolved として確認を求める
      // ユーザーが続行を拒否
      mockConfirmAction.mockResolvedValueOnce(false);

      await (pushCommand.run as any)({
        args: { dir: "/test", dryRun: false, yes: false, edit: false },
        rawArgs: [],
        cmd: pushCommand,
      });

      expect(mockLog.warn).toHaveBeenCalledWith(expect.stringContaining("Template updated"));
      expect(mockLog.info).toHaveBeenCalledWith(
        "Run `ziku pull` first to sync template changes, then push again.",
      );
      expect(mockCreatePullRequest).not.toHaveBeenCalled();
    });

    it("コンフリクトがあっても確認で続行を選べばPRを作成", async () => {
      const configWithBaseHashes = {
        ...validConfig,
        baseHashes: {
          "file.txt": "abc123",
        },
      };

      vol.fromJSON({
        "/test/.devenv.json": JSON.stringify(configWithBaseHashes),
        "/test/file.txt": "local content",
        "/tmp/template/file.txt": "template content",
      });

      const pushableFile = {
        path: "file.txt",
        type: "modified" as const,
        localContent: "new content",
        templateContent: "old content",
      };

      // classification: conflicts に分類 → pushableFilePaths に追加される
      mockClassifyFiles.mockReturnValueOnce({
        autoUpdate: [],
        localOnly: [],
        conflicts: ["file.txt"],
        newFiles: [],
        deletedFiles: [],
        unchanged: [],
      });

      // detectDiff: コンテンツを提供
      mockDetectDiff.mockResolvedValueOnce({
        files: [pushableFile],
        summary: { added: 0, modified: 1, deleted: 0, unchanged: 0 },
      });

      mockSelectPushFiles.mockResolvedValueOnce([pushableFile]);
      // コンフリクト確認: 続行（baseRef なし → unresolved → 確認）
      mockConfirmAction.mockResolvedValueOnce(true);
      // PR作成確認: 続行
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

      expect(mockLog.warn).toHaveBeenCalled();
      expect(mockCreatePullRequest).toHaveBeenCalled();
    });

    it("baseRef + baseHashes がある場合に 3-way マージで自動解決", async () => {
      const configWithBaseRef = {
        ...validConfig,
        baseRef: "abc123def456",
        baseHashes: {
          "file.txt": "abc123",
        },
      };

      vol.fromJSON({
        "/test/.devenv.json": JSON.stringify(configWithBaseRef),
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
        unchanged: [],
      });

      // threeWayMerge のモック（自動マージ成功）
      mockThreeWayMerge.mockReturnValueOnce({
        content: "merged content",
        hasConflicts: false,
        conflictDetails: [],
      });

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

      // 引数順序の検証: local にユーザーのローカル内容、template にテンプレート内容が渡されること
      // 背景: #148 で local/template が逆転し、ユーザーのコメント・フォーマットが失われた
      expect(mockThreeWayMerge).toHaveBeenCalledWith({
        base: "base content",
        local: "local content",
        template: "template content",
        filePath: "file.txt",
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

    it("baseHashes がない場合でもコンフリクト検出を実行（空の baseHashes で分類）", async () => {
      vol.fromJSON({
        "/test/.devenv.json": JSON.stringify(validConfig),
      });

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
      const configWithBaseHashes = {
        ...validConfig,
        baseHashes: {
          "file.txt": "abc123",
          "template-only.txt": "def456",
        },
      };

      vol.fromJSON({
        "/test/.devenv.json": JSON.stringify(configWithBaseHashes),
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
      const configWithBaseHashes = {
        ...validConfig,
        baseHashes: {
          "file.txt": "abc123",
        },
      };

      vol.fromJSON({
        "/test/.devenv.json": JSON.stringify(configWithBaseHashes),
      });

      // コンフリクトなし
      mockClassifyFiles.mockReturnValueOnce({
        autoUpdate: ["file.txt"],
        localOnly: [],
        conflicts: [],
        newFiles: [],
        deletedFiles: [],
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
