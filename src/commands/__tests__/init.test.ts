import { vol } from "memfs";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { ZikuError } from "../../errors";

// fs モジュールをモック
vi.mock("node:fs", async () => {
  const memfs = await import("memfs");
  return memfs.fs;
});

vi.mock("node:fs/promises", async () => {
  const memfs = await import("memfs");
  return memfs.fs.promises;
});

// 外部依存をモック
vi.mock("../../utils/git-remote", () => ({
  detectGitHubOwner: vi.fn(() => "test-org"),
  detectGitHubRepo: vi.fn(() => null),
  DEFAULT_TEMPLATE_REPOS: [".ziku", ".github"],
  DEFAULT_TEMPLATE_REPO: ".ziku",
}));

vi.mock("../../utils/template", () => ({
  buildTemplateSource: vi.fn(
    (source: { owner: string; repo: string }) => `gh:${source.owner}/${source.repo}`,
  ),
  downloadTemplateToTemp: vi.fn(),
  fetchTemplates: vi.fn(),
  writeFileWithStrategy: vi.fn(),
  copyFile: vi.fn(),
}));

vi.mock("../../utils/hash", () => ({
  hashFiles: vi.fn(),
}));

vi.mock("../../utils/github", () => ({
  resolveLatestCommitSha: vi.fn(() => Promise.resolve("abc123def456")),
  checkRepoExists: vi.fn(() => Promise.resolve(true)),
  checkRepoSetup: vi.fn(() => Promise.resolve(true)),
  getGitHubToken: vi.fn(() => {}),
  getAuthenticatedUserLogin: vi.fn(() => Promise.resolve()),
  scaffoldTemplateRepo: vi.fn(() => Promise.resolve({ url: "https://github.com/test/repo" })),
  createDevenvScaffoldPR: vi.fn(() =>
    Promise.resolve({
      url: "https://github.com/test/repo/pull/1",
      number: 1,
      branch: "ziku",
    }),
  ),
}));

vi.mock("../../ui/prompts", () => ({
  selectModules: vi.fn(),
  selectOverwriteStrategy: vi.fn(),
  selectMissingTemplateAction: vi.fn(),
  selectTemplateCandidate: vi.fn(() => Promise.resolve({ owner: "test-org", repo: ".github" })),
  inputTemplateSource: vi.fn(),
  confirmScaffoldDevenvPR: vi.fn(() => Promise.resolve(true)),
}));

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
  pc: {
    cyan: (s: string) => s,
    bold: (s: string) => s,
    dim: (s: string) => s,
  },
  withSpinner: vi.fn(async (_text: string, fn: () => Promise<unknown>) => fn()),
  logFileResults: vi.fn(() => ({ added: 1, updated: 0, skipped: 0 })),
}));

vi.mock("../../modules/index", async (importOriginal) => {
  const original = await importOriginal<typeof import("../../modules/index")>();
  return {
    ...original,
    modulesFileExists: vi.fn(() => true),
    loadModulesFile: vi.fn(() =>
      Promise.resolve({
        modules: [
          {
            name: "Root Config",
            description: "Root config",
            include: [".mcp.json", ".mise.toml"],
          },
          {
            name: "DevContainer",
            description: "DevContainer",
            include: [".devcontainer/**"],
          },
          {
            name: "GitHub",
            description: "GitHub",
            include: [".github/**"],
          },
          {
            name: "Claude",
            description: "Claude",
            include: [".claude/**"],
          },
        ],
        rawContent: '{"modules":[]}',
      }),
    ),
  };
});

// モック後にインポート
const { initCommand, isCurrentRepoTemplate, generateDefaultModulesJsonc } = await import("../init");
const { downloadTemplateToTemp, fetchTemplates, writeFileWithStrategy, copyFile } =
  await import("../../utils/template");
const { detectGitHubOwner, detectGitHubRepo } = await import("../../utils/git-remote");
const { selectModules, selectOverwriteStrategy, selectTemplateCandidate } =
  await import("../../ui/prompts");
const { log } = await import("../../ui/renderer");
const { hashFiles } = await import("../../utils/hash");
const { modulesFileExists } = await import("../../modules/index");
const { checkRepoExists, checkRepoSetup } = await import("../../utils/github");

const mockDownloadTemplateToTemp = vi.mocked(downloadTemplateToTemp);
const mockFetchTemplates = vi.mocked(fetchTemplates);
const mockWriteFileWithStrategy = vi.mocked(writeFileWithStrategy);
const mockCopyFile = vi.mocked(copyFile);
const mockDetectGitHubOwner = vi.mocked(detectGitHubOwner);
const mockDetectGitHubRepo = vi.mocked(detectGitHubRepo);
const mockSelectModules = vi.mocked(selectModules);
const mockSelectOverwriteStrategy = vi.mocked(selectOverwriteStrategy);
const mockLog = vi.mocked(log);
const mockHashFiles = vi.mocked(hashFiles);
const mockModulesFileExists = vi.mocked(modulesFileExists);
const mockCheckRepoExists = vi.mocked(checkRepoExists);
const mockCheckRepoSetup = vi.mocked(checkRepoSetup);

describe("initCommand", () => {
  beforeEach(() => {
    vol.reset();
    vi.clearAllMocks();

    // デフォルトのモック設定
    mockDownloadTemplateToTemp.mockResolvedValue({
      templateDir: "/tmp/template",
      cleanup: vi.fn(),
    });
    mockFetchTemplates.mockResolvedValue([]);
    mockWriteFileWithStrategy.mockResolvedValue({
      action: "created",
      path: ".ziku/lock.json",
    });
    mockCopyFile.mockResolvedValue({
      action: "skipped",
      path: ".ziku/ziku.jsonc",
    });
    mockHashFiles.mockResolvedValue({});
  });

  describe("meta", () => {
    it("コマンドメタデータが正しい", () => {
      expect((initCommand.meta as { name: string }).name).toBe("ziku");
      expect((initCommand.meta as { description: string }).description).toBe(
        "Apply dev environment template to your project",
      );
    });
  });

  describe("args", () => {
    it("dir 引数のデフォルト値は '.'", () => {
      const args = initCommand.args as { dir: { default: string } };
      expect(args.dir.default).toBe(".");
    });

    it("force 引数のデフォルト値は false", () => {
      const args = initCommand.args as { force: { default: boolean } };
      expect(args.force.default).toBe(false);
    });

    it("yes 引数のデフォルト値は false", () => {
      const args = initCommand.args as { yes: { default: boolean } };
      expect(args.yes.default).toBe(false);
    });
  });

  describe("run", () => {
    it("モジュールが選択されない場合は警告を表示", async () => {
      vol.fromJSON({
        "/test": null,
      });

      // selectModules が空配列 → include が空 → "No patterns to apply"
      mockSelectModules.mockResolvedValueOnce([]);

      await (initCommand.run as any)({
        args: { dir: "/test", force: false, yes: false },
        rawArgs: [],
        cmd: initCommand,
      });

      expect(mockLog.warn).toHaveBeenCalledWith("No patterns to apply");
    });

    it("--yes オプションで全モジュールを自動選択", async () => {
      vol.fromJSON({
        "/test": null,
      });

      mockFetchTemplates.mockResolvedValue([{ action: "copied", path: ".mcp.json" }]);

      await (initCommand.run as any)({
        args: { dir: "/test", force: false, yes: true },
        rawArgs: [],
        cmd: initCommand,
      });

      // selectModules は呼ばれない
      expect(mockSelectModules).not.toHaveBeenCalled();
      // fetchTemplates は呼ばれる
      expect(mockFetchTemplates).toHaveBeenCalled();
    });

    it("ターゲットディレクトリが存在しない場合は作成", async () => {
      vol.fromJSON({});

      mockSelectModules.mockResolvedValueOnce([
        { name: "Root Config", description: "Root config", include: [".mcp.json", ".mise.toml"] },
      ]);
      mockSelectOverwriteStrategy.mockResolvedValueOnce("prompt");

      mockFetchTemplates.mockResolvedValue([{ action: "copied", path: ".mcp.json" }]);

      await (initCommand.run as any)({
        args: { dir: "/new-dir", force: false, yes: false },
        rawArgs: [],
        cmd: initCommand,
      });

      expect(vol.existsSync("/new-dir")).toBe(true);
    });

    it("devcontainer モジュール選択時に env.example を作成", async () => {
      vol.fromJSON({
        "/test": null,
      });

      mockSelectModules.mockResolvedValueOnce([
        { name: "DevContainer", description: "DevContainer", include: [".devcontainer/**"] },
      ]);
      mockSelectOverwriteStrategy.mockResolvedValueOnce("prompt");

      mockFetchTemplates.mockResolvedValue([]);

      await (initCommand.run as any)({
        args: { dir: "/test", force: false, yes: false },
        rawArgs: [],
        cmd: initCommand,
      });

      // writeFileWithStrategy が devcontainer.env.example に対して呼ばれる
      expect(mockWriteFileWithStrategy).toHaveBeenCalledWith(
        expect.objectContaining({
          relativePath: ".devcontainer/devcontainer.env.example",
        }),
      );
    });

    it("--force オプションで overwrite 戦略を使用", async () => {
      vol.fromJSON({
        "/test": null,
      });

      mockSelectModules.mockResolvedValueOnce([
        { name: "Root Config", description: "Root config", include: [".mcp.json", ".mise.toml"] },
      ]);
      mockSelectOverwriteStrategy.mockResolvedValueOnce("prompt");

      mockFetchTemplates.mockResolvedValue([]);

      await (initCommand.run as any)({
        args: { dir: "/test", force: true, yes: false }, // --force
        rawArgs: [],
        cmd: initCommand,
      });

      // fetchTemplates は overwrite 戦略で呼ばれる
      expect(mockFetchTemplates).toHaveBeenCalledWith(
        expect.objectContaining({
          overwriteStrategy: "overwrite",
        }),
      );
    });

    it("cleanup が必ず呼ばれる", async () => {
      vol.fromJSON({
        "/test": null,
      });

      const mockCleanup = vi.fn();
      mockDownloadTemplateToTemp.mockResolvedValue({
        templateDir: "/tmp/template",
        cleanup: mockCleanup,
      });

      mockSelectModules.mockResolvedValueOnce([
        { name: "Root Config", description: "Root config", include: [".mcp.json", ".mise.toml"] },
      ]);
      mockSelectOverwriteStrategy.mockResolvedValueOnce("prompt");

      mockFetchTemplates.mockResolvedValue([]);

      await (initCommand.run as any)({
        args: { dir: "/test", force: false, yes: false },
        rawArgs: [],
        cmd: initCommand,
      });

      expect(mockCleanup).toHaveBeenCalled();
    });

    it("選択されたモジュールで ziku.jsonc を生成する", async () => {
      vol.fromJSON({
        "/test": null,
      });

      mockSelectModules.mockResolvedValueOnce([
        { name: "Root Config", description: "Root config", include: [".mcp.json", ".mise.toml"] },
      ]);
      mockSelectOverwriteStrategy.mockResolvedValueOnce("prompt");

      mockFetchTemplates.mockResolvedValue([]);

      await (initCommand.run as any)({
        args: { dir: "/test", force: false, yes: false },
        rawArgs: [],
        cmd: initCommand,
      });

      // writeFileWithStrategy が ziku.jsonc に対して呼ばれる
      expect(mockWriteFileWithStrategy).toHaveBeenCalledWith(
        expect.objectContaining({
          relativePath: ".ziku/ziku.jsonc",
        }),
      );
    });

    it("エラー時も cleanup が呼ばれる", async () => {
      vol.fromJSON({
        "/test": null,
      });

      const mockCleanup = vi.fn();
      mockDownloadTemplateToTemp.mockResolvedValue({
        templateDir: "/tmp/template",
        cleanup: mockCleanup,
      });

      mockSelectModules.mockRejectedValueOnce(new Error("User cancelled"));

      await expect(
        (initCommand.run as any)({
          args: { dir: "/test", force: false, yes: false },
          rawArgs: [],
          cmd: initCommand,
        }),
      ).rejects.toThrow("User cancelled");

      expect(mockCleanup).toHaveBeenCalled();
    });

    it("--modules オプションで指定モジュールのみ選択", async () => {
      vol.fromJSON({
        "/test": null,
      });

      mockFetchTemplates.mockResolvedValue([{ action: "copied", path: ".mcp.json" }]);

      await (initCommand.run as any)({
        args: {
          dir: "/test",
          force: false,
          yes: false,
          modules: "Root Config",
        },
        rawArgs: [],
        cmd: initCommand,
      });

      // selectModules は呼ばれない（非インタラクティブ）
      expect(mockSelectModules).not.toHaveBeenCalled();
      // fetchTemplates は指定モジュールで呼ばれる
      expect(mockFetchTemplates).toHaveBeenCalledWith(
        expect.objectContaining({
          patterns: expect.objectContaining({
            include: expect.arrayContaining([".mcp.json", ".mise.toml"]),
          }),
        }),
      );
    });

    it("--modules で複数モジュールをカンマ区切りで指定", async () => {
      vol.fromJSON({
        "/test": null,
      });

      mockFetchTemplates.mockResolvedValue([]);

      await (initCommand.run as any)({
        args: {
          dir: "/test",
          force: false,
          yes: false,
          modules: "Root Config,GitHub",
        },
        rawArgs: [],
        cmd: initCommand,
      });

      expect(mockSelectModules).not.toHaveBeenCalled();
      expect(mockFetchTemplates).toHaveBeenCalledWith(
        expect.objectContaining({
          patterns: expect.objectContaining({
            include: expect.arrayContaining([".mcp.json", ".mise.toml", ".github/**"]),
          }),
        }),
      );
    });

    it("--modules で無効なモジュール名を指定するとエラー", async () => {
      vol.fromJSON({
        "/test": null,
      });

      await expect(
        (initCommand.run as any)({
          args: {
            dir: "/test",
            force: false,
            yes: false,
            modules: "invalid-module",
          },
          rawArgs: [],
          cmd: initCommand,
        }),
      ).rejects.toThrow(ZikuError);

      expect(mockFetchTemplates).not.toHaveBeenCalled();
    });

    it("--overwrite-strategy で skip 戦略を指定", async () => {
      vol.fromJSON({
        "/test": null,
      });

      mockFetchTemplates.mockResolvedValue([]);

      await (initCommand.run as any)({
        args: {
          dir: "/test",
          force: false,
          yes: true,
          "overwrite-strategy": "skip",
        },
        rawArgs: [],
        cmd: initCommand,
      });

      expect(mockFetchTemplates).toHaveBeenCalledWith(
        expect.objectContaining({
          overwriteStrategy: "skip",
        }),
      );
    });

    it("--modules と --overwrite-strategy の組み合わせ", async () => {
      vol.fromJSON({
        "/test": null,
      });

      mockFetchTemplates.mockResolvedValue([]);

      await (initCommand.run as any)({
        args: {
          dir: "/test",
          force: false,
          yes: false,
          modules: "Root Config",
          "overwrite-strategy": "skip",
        },
        rawArgs: [],
        cmd: initCommand,
      });

      expect(mockSelectModules).not.toHaveBeenCalled();
      expect(mockFetchTemplates).toHaveBeenCalledWith(
        expect.objectContaining({
          patterns: expect.objectContaining({
            include: expect.arrayContaining([".mcp.json", ".mise.toml"]),
          }),
          overwriteStrategy: "skip",
        }),
      );
    });

    it("--overwrite-strategy に無効な値を指定するとエラー", async () => {
      vol.fromJSON({
        "/test": null,
      });

      await expect(
        (initCommand.run as any)({
          args: {
            dir: "/test",
            force: false,
            yes: true,
            "overwrite-strategy": "invalid",
          },
          rawArgs: [],
          cmd: initCommand,
        }),
      ).rejects.toThrow(ZikuError);

      expect(mockFetchTemplates).not.toHaveBeenCalled();
    });

    it("--overwrite-strategy のみ指定時はモジュール選択はインタラクティブ", async () => {
      vol.fromJSON({
        "/test": null,
      });

      mockSelectModules.mockResolvedValueOnce([
        { name: "Root Config", description: "Root config", include: [".mcp.json", ".mise.toml"] },
      ]);

      mockFetchTemplates.mockResolvedValue([]);

      await (initCommand.run as any)({
        args: {
          dir: "/test",
          force: false,
          yes: false,
          "overwrite-strategy": "skip",
        },
        rawArgs: [],
        cmd: initCommand,
      });

      // モジュール選択はインタラクティブ
      expect(mockSelectModules).toHaveBeenCalled();
      // 戦略は --overwrite-strategy で上書き
      expect(mockFetchTemplates).toHaveBeenCalledWith(
        expect.objectContaining({
          overwriteStrategy: "skip",
        }),
      );
    });

    it("'init' 引数は無視して現在のディレクトリを使用", async () => {
      vol.fromJSON({
        ".": null,
      });

      mockSelectModules.mockResolvedValueOnce([]);

      await (initCommand.run as any)({
        args: { dir: "init", force: false, yes: false },
        rawArgs: [],
        cmd: initCommand,
      });

      // "init" は "." として扱われる
      expect(mockLog.info).toHaveBeenCalledWith(expect.stringContaining(process.cwd()));
    });

    it("--from でカスタムソースを指定", async () => {
      vol.fromJSON({
        "/test": null,
      });

      mockSelectModules.mockResolvedValueOnce([
        { name: "Root Config", description: "Root config", include: [".mcp.json", ".mise.toml"] },
      ]);
      mockSelectOverwriteStrategy.mockResolvedValueOnce("prompt");

      mockFetchTemplates.mockResolvedValue([]);

      await (initCommand.run as any)({
        args: {
          dir: "/test",
          force: false,
          yes: false,
          from: "my-org/my-templates",
        },
        rawArgs: [],
        cmd: initCommand,
      });

      // downloadTemplateToTemp にカスタムソースが渡される
      expect(mockDownloadTemplateToTemp).toHaveBeenCalledWith(
        expect.any(String),
        "gh:my-org/my-templates",
      );
    });

    it("--from でオーナー名のみ指定すると .ziku / .github を探索し最初に見つかったものを使う", async () => {
      vol.fromJSON({
        "/test": null,
      });

      mockSelectModules.mockResolvedValueOnce([
        { name: "Root Config", description: "Root config", include: [".mcp.json", ".mise.toml"] },
      ]);
      mockSelectOverwriteStrategy.mockResolvedValueOnce("prompt");

      mockFetchTemplates.mockResolvedValue([]);

      await (initCommand.run as any)({
        args: {
          dir: "/test",
          force: false,
          yes: false,
          from: "my-org",
        },
        rawArgs: [],
        cmd: initCommand,
      });

      // checkRepoExists がデフォルトで true を返すため、先頭の .ziku が使われる
      expect(mockDownloadTemplateToTemp).toHaveBeenCalledWith(
        expect.any(String),
        "gh:my-org/.ziku",
      );
    });

    it("--from オーナーのみで .github だけセットアップ済みなら .github を選択", async () => {
      vol.fromJSON({
        "/test": null,
      });

      // 両方存在するが .ziku はセットアップ未完了
      mockCheckRepoExists.mockResolvedValue(true);
      mockCheckRepoSetup
        .mockResolvedValueOnce(false) // .ziku
        .mockResolvedValueOnce(true); // .github

      mockSelectModules.mockResolvedValueOnce([
        { name: "Root Config", description: "Root config", include: [".mcp.json", ".mise.toml"] },
      ]);
      mockSelectOverwriteStrategy.mockResolvedValueOnce("prompt");
      mockFetchTemplates.mockResolvedValue([]);

      await (initCommand.run as any)({
        args: { dir: "/test", force: false, yes: false, from: "my-org" },
        rawArgs: [],
        cmd: initCommand,
      });

      // セットアップ済みの .github が選ばれる
      expect(mockDownloadTemplateToTemp).toHaveBeenCalledWith(
        expect.any(String),
        "gh:my-org/.github",
      );
    });

    it("--from オーナーのみで .ziku のみ存在する場合は .ziku を選択", async () => {
      vol.fromJSON({
        "/test": null,
      });

      // .ziku のみ存在
      mockCheckRepoExists
        .mockResolvedValueOnce(true) // .ziku
        .mockResolvedValueOnce(false); // .github
      mockCheckRepoSetup.mockResolvedValueOnce(false); // .ziku はセットアップ未完了

      mockSelectModules.mockResolvedValueOnce([
        { name: "Root Config", description: "Root config", include: [".mcp.json", ".mise.toml"] },
      ]);
      mockSelectOverwriteStrategy.mockResolvedValueOnce("prompt");
      mockFetchTemplates.mockResolvedValue([]);

      await (initCommand.run as any)({
        args: { dir: "/test", force: false, yes: false, from: "my-org" },
        rawArgs: [],
        cmd: initCommand,
      });

      expect(mockDownloadTemplateToTemp).toHaveBeenCalledWith(
        expect.any(String),
        "gh:my-org/.ziku",
      );
    });

    it("--from 未指定時は git remote から owner を検出", async () => {
      vol.fromJSON({
        "/test": null,
      });

      mockDetectGitHubOwner.mockReturnValueOnce("detected-org");
      vi.mocked(selectTemplateCandidate).mockResolvedValueOnce({
        owner: "detected-org",
        repo: ".github",
      });

      mockSelectModules.mockResolvedValueOnce([
        { name: "Root Config", description: "Root config", include: [".mcp.json", ".mise.toml"] },
      ]);
      mockSelectOverwriteStrategy.mockResolvedValueOnce("prompt");

      mockFetchTemplates.mockResolvedValue([]);

      await (initCommand.run as any)({
        args: { dir: "/test", force: false, yes: false },
        rawArgs: [],
        cmd: initCommand,
      });

      // detected-org/.github が使われる
      expect(mockDownloadTemplateToTemp).toHaveBeenCalledWith(
        expect.any(String),
        "gh:detected-org/.github",
      );
    });

    it("git remote 検出失敗時はユーザーにソース入力を促す", async () => {
      vol.fromJSON({
        "/test": null,
      });

      mockDetectGitHubOwner.mockReturnValueOnce(null);

      const { inputTemplateSource } = await import("../../ui/prompts");
      const mockInputTemplateSource = vi.mocked(inputTemplateSource);
      // ユーザーが custom-org/templates を入力
      mockInputTemplateSource.mockResolvedValueOnce("custom-org/templates");
      mockCheckRepoExists.mockResolvedValueOnce(true);
      mockSelectModules.mockResolvedValueOnce([
        { name: "Root Config", description: "Root config", include: [".mcp.json", ".mise.toml"] },
      ]);
      mockSelectOverwriteStrategy.mockResolvedValueOnce("prompt");

      mockFetchTemplates.mockResolvedValue([]);

      await (initCommand.run as any)({
        args: { dir: "/test", force: false, yes: false },
        rawArgs: [],
        cmd: initCommand,
      });

      expect(mockInputTemplateSource).toHaveBeenCalled();
      expect(mockDownloadTemplateToTemp).toHaveBeenCalledWith(
        expect.any(String),
        "gh:custom-org/templates",
      );
    });

    it(".ziku/lock.json に baseHashes が含まれる", async () => {
      vol.fromJSON({
        "/test": null,
      });

      const expectedHashes = {
        ".mcp.json": "abc123hash",
        ".mise.toml": "def456hash",
      };
      mockHashFiles.mockResolvedValueOnce(expectedHashes);

      mockFetchTemplates.mockResolvedValue([{ action: "copied", path: ".mcp.json" }]);

      await (initCommand.run as any)({
        args: { dir: "/test", force: false, yes: true },
        rawArgs: [],
        cmd: initCommand,
      });

      // hashFiles がテンプレートディレクトリとモジュールパターンで呼ばれる
      expect(mockHashFiles).toHaveBeenCalledWith(
        "/tmp/template",
        expect.any(Array),
        expect.any(Array),
      );

      // saveLock により .ziku/lock.json がファイルシステムに書き出される
      expect(vol.existsSync("/test/.ziku/lock.json")).toBe(true);
      const lockContent = JSON.parse(vol.readFileSync("/test/.ziku/lock.json", "utf-8") as string);
      expect(lockContent.baseHashes).toEqual(expectedHashes);
    });

    it("テンプレートにマッチするファイルがない場合は baseHashes が省略される", async () => {
      vol.fromJSON({
        "/test": null,
      });

      // 空のハッシュマップを返す（パターンにマッチするファイルがない場合）
      mockHashFiles.mockResolvedValueOnce({});

      mockFetchTemplates.mockResolvedValue([{ action: "copied", path: ".mcp.json" }]);

      await (initCommand.run as any)({
        args: { dir: "/test", force: false, yes: true },
        rawArgs: [],
        cmd: initCommand,
      });

      // saveLock により .ziku/lock.json がファイルシステムに書き出される
      expect(vol.existsSync("/test/.ziku/lock.json")).toBe(true);
      const lockContent = JSON.parse(vol.readFileSync("/test/.ziku/lock.json", "utf-8") as string);
      // 空のハッシュマップの場合は baseHashes キーが省略される
      expect(lockContent.baseHashes).toBeUndefined();
    });

    it("テンプレートリポジトリ自体で実行した場合、モジュール形式の modules.jsonc を生成する", async () => {
      vol.fromJSON({
        "/test": null,
      });

      // 現在のリポジトリがテンプレートリポジトリと一致するようモック
      mockDetectGitHubRepo.mockReturnValueOnce({ owner: "test-org", repo: ".github" });
      // handleTemplateRepoInit 内で modulesFileExists(targetDir) が false を返す
      mockModulesFileExists.mockReturnValueOnce(false);

      await (initCommand.run as any)({
        args: { dir: "/test", force: false, yes: false },
        rawArgs: [],
        cmd: initCommand,
      });

      // テンプレートをダウンロードしない
      expect(mockDownloadTemplateToTemp).not.toHaveBeenCalled();
      // modules.jsonc がモジュール形式で生成される
      expect(vol.existsSync("/test/.ziku/modules.jsonc")).toBe(true);
      const content = vol.readFileSync("/test/.ziku/modules.jsonc", "utf-8") as string;
      const parsed = JSON.parse(content);
      expect(parsed.modules).toBeDefined();
      expect(Array.isArray(parsed.modules)).toBe(true);
      expect(parsed.modules.length).toBeGreaterThan(0);
      expect(parsed.modules[0].name).toBeDefined();
      expect(parsed.modules[0].include).toBeDefined();
    });

    it("テンプレートリポジトリで modules.jsonc が既にある場合はスキップ", async () => {
      vol.fromJSON({
        "/test": null,
        "/test/.ziku/modules.jsonc": '{"modules":[]}',
      });

      mockDetectGitHubRepo.mockReturnValueOnce({ owner: "test-org", repo: ".github" });
      // modulesFileExists が true を返すように（テンプレートリポジトリの場合は targetDir でチェック）
      // デフォルトモックは templateDir に対して true なので、targetDir 用に呼び出し順を調整
      mockModulesFileExists.mockReturnValueOnce(true);

      await (initCommand.run as any)({
        args: { dir: "/test", force: false, yes: false },
        rawArgs: [],
        cmd: initCommand,
      });

      expect(mockDownloadTemplateToTemp).not.toHaveBeenCalled();
      expect(mockLog.success).toHaveBeenCalledWith(".ziku/modules.jsonc already exists");
    });

    it("別リポジトリからの実行ではテンプレートリポジトリ検出が働かない", async () => {
      vol.fromJSON({
        "/test": null,
      });

      // 現在のリポジトリがテンプレートリポジトリと異なる
      mockDetectGitHubRepo.mockReturnValueOnce({ owner: "test-org", repo: "my-app" });

      mockSelectModules.mockResolvedValueOnce([
        { name: "Root Config", description: "Root config", include: [".mcp.json", ".mise.toml"] },
      ]);
      mockSelectOverwriteStrategy.mockResolvedValueOnce("prompt");
      mockFetchTemplates.mockResolvedValue([]);

      await (initCommand.run as any)({
        args: { dir: "/test", force: false, yes: false },
        rawArgs: [],
        cmd: initCommand,
      });

      // 通常のダウンロードフローが実行される
      expect(mockDownloadTemplateToTemp).toHaveBeenCalled();
    });
  });
});

describe("isCurrentRepoTemplate", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("現在のリポジトリがテンプレートと一致する場合 true", () => {
    mockDetectGitHubRepo.mockReturnValueOnce({ owner: "my-org", repo: ".github" });
    expect(isCurrentRepoTemplate("/test", "my-org", ".github")).toBe(true);
  });

  it("大文字小文字を無視して比較する", () => {
    mockDetectGitHubRepo.mockReturnValueOnce({ owner: "My-Org", repo: ".GitHub" });
    expect(isCurrentRepoTemplate("/test", "my-org", ".github")).toBe(true);
  });

  it("リポジトリが異なる場合 false", () => {
    mockDetectGitHubRepo.mockReturnValueOnce({ owner: "my-org", repo: "my-app" });
    expect(isCurrentRepoTemplate("/test", "my-org", ".github")).toBe(false);
  });

  it("git remote がない場合 false", () => {
    mockDetectGitHubRepo.mockReturnValueOnce(null);
    expect(isCurrentRepoTemplate("/test", "my-org", ".github")).toBe(false);
  });

  it("オーナーが異なる場合 false", () => {
    mockDetectGitHubRepo.mockReturnValueOnce({ owner: "other-org", repo: ".github" });
    expect(isCurrentRepoTemplate("/test", "my-org", ".github")).toBe(false);
  });
});

describe("generateDefaultModulesJsonc", () => {
  it("modules 形式と $schema を含む JSON を生成する", () => {
    const content = generateDefaultModulesJsonc();
    const parsed = JSON.parse(content);
    expect(parsed.$schema).toBeDefined();
    expect(parsed.modules).toBeDefined();
    expect(Array.isArray(parsed.modules)).toBe(true);
    expect(parsed.modules.length).toBeGreaterThan(0);
  });

  it("デフォルトモジュールに name と description と include がある", () => {
    const content = generateDefaultModulesJsonc();
    const parsed = JSON.parse(content);
    const mod = parsed.modules[0];
    expect(mod.name).toBeDefined();
    expect(mod.description).toBeDefined();
    expect(Array.isArray(mod.include)).toBe(true);
    expect(mod.include.length).toBeGreaterThan(0);
  });
});
