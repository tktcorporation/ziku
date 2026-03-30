/**
 * E2E テスト: テンプレートリポジトリのセットアップ UX
 *
 * 以下のシナリオをカバーする:
 *   1. テンプレートが見つからない → ユーザーがリポジトリ作成を選択
 *   2. テンプレートが見つからない → ユーザーがカスタムソースを指定
 *   3. --from で指定されたリポジトリが見つからない → エラー
 *   4. 非インタラクティブモードでテンプレートが見つからない → エラー
 *   5. テンプレートが正常に見つかる → 通常フロー
 *   6. git remote がない → ユーザーにソース入力を促す
 *   7. テンプレートに .devenv がない → スキャフォールド PR を提案
 *   8. テンプレートに .devenv がない → ローカルデフォルトで続行
 *   9. 非インタラクティブで .devenv がない → 警告してデフォルト使用
 */
import { vol } from "memfs";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

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
  detectGitHubOwner: vi.fn(() => "detected-org"),
  DEFAULT_TEMPLATE_REPO: ".github",
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
  getGitHubToken: vi.fn(() => undefined),
  scaffoldTemplateRepo: vi.fn(() =>
    Promise.resolve({ url: "https://github.com/detected-org/.github" }),
  ),
  createDevenvScaffoldPR: vi.fn(() =>
    Promise.resolve({
      url: "https://github.com/detected-org/.github/pull/1",
      number: 1,
      branch: "devenv-scaffold",
    }),
  ),
}));

vi.mock("../../ui/prompts", () => ({
  selectModules: vi.fn(),
  selectOverwriteStrategy: vi.fn(),
  selectMissingTemplateAction: vi.fn(),
  inputTemplateSource: vi.fn(),
  selectScaffoldDevenvAction: vi.fn(() => Promise.resolve("scaffold-local")),
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
    modulesFileExists: vi.fn(() => false),
    loadModulesFile: vi.fn(),
  };
});

// モック後にインポート
const { initCommand } = await import("../init");
const { downloadTemplateToTemp, fetchTemplates, writeFileWithStrategy, copyFile } =
  await import("../../utils/template");
const { detectGitHubOwner } = await import("../../utils/git-remote");
const {
  selectModules,
  selectOverwriteStrategy,
  selectMissingTemplateAction,
  inputTemplateSource,
  selectScaffoldDevenvAction,
} = await import("../../ui/prompts");
const { log } = await import("../../ui/renderer");
const { hashFiles } = await import("../../utils/hash");
const { checkRepoExists, getGitHubToken, scaffoldTemplateRepo, createDevenvScaffoldPR } =
  await import("../../utils/github");
const { modulesFileExists } = await import("../../modules/index");

const mockDownloadTemplateToTemp = vi.mocked(downloadTemplateToTemp);
const mockFetchTemplates = vi.mocked(fetchTemplates);
const mockWriteFileWithStrategy = vi.mocked(writeFileWithStrategy);
const mockCopyFile = vi.mocked(copyFile);
const mockDetectGitHubOwner = vi.mocked(detectGitHubOwner);
const mockSelectModules = vi.mocked(selectModules);
const mockSelectOverwriteStrategy = vi.mocked(selectOverwriteStrategy);
const mockSelectMissingTemplateAction = vi.mocked(selectMissingTemplateAction);
const mockInputTemplateSource = vi.mocked(inputTemplateSource);
const mockSelectScaffoldDevenvAction = vi.mocked(selectScaffoldDevenvAction);
const mockLog = vi.mocked(log);
const mockHashFiles = vi.mocked(hashFiles);
const mockCheckRepoExists = vi.mocked(checkRepoExists);
const mockGetGitHubToken = vi.mocked(getGitHubToken);
const mockScaffoldTemplateRepo = vi.mocked(scaffoldTemplateRepo);
const mockCreateDevenvScaffoldPR = vi.mocked(createDevenvScaffoldPR);
const mockModulesFileExists = vi.mocked(modulesFileExists);

// コマンド実行ヘルパー
async function runInit(args: Record<string, unknown>) {
  return (initCommand.run as any)({
    args: { dir: "/test", force: false, yes: false, ...args },
    rawArgs: [],
    cmd: initCommand,
  });
}

describe("init: セットアップ UX", () => {
  beforeEach(() => {
    vol.reset();
    vi.clearAllMocks();
    vi.useFakeTimers({ shouldAdvanceTime: true });

    vol.fromJSON({ "/test": null });

    // デフォルトのモック設定
    mockDownloadTemplateToTemp.mockResolvedValue({
      templateDir: "/tmp/template",
      cleanup: vi.fn(),
    });
    mockFetchTemplates.mockResolvedValue([{ action: "copied", path: ".mcp.json" }]);
    mockWriteFileWithStrategy.mockResolvedValue({ action: "created", path: ".devenv.json" });
    mockCopyFile.mockResolvedValue({ action: "skipped", path: ".devenv/modules.jsonc" });
    mockHashFiles.mockResolvedValue({});
    mockDetectGitHubOwner.mockReturnValue("detected-org");
    mockCheckRepoExists.mockResolvedValue(true);
    mockGetGitHubToken.mockReturnValue(undefined);
    mockModulesFileExists.mockReturnValue(false);
    mockSelectScaffoldDevenvAction.mockResolvedValue("scaffold-local");
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  // ─── テンプレートリポジトリが見つからない場合 ───

  describe("テンプレートリポジトリが見つからない場合", () => {
    it("非インタラクティブモード（--yes）ではエラーを投げる", async () => {
      mockCheckRepoExists.mockResolvedValueOnce(false);

      await expect(runInit({ yes: true })).rejects.toThrow("not found");
    });

    it("リポジトリ作成を選択するとリポジトリを作成して続行する", async () => {
      mockCheckRepoExists.mockResolvedValueOnce(false);
      mockSelectMissingTemplateAction.mockResolvedValueOnce("create-repo");
      mockGetGitHubToken.mockReturnValue("ghp_test_token");
      mockScaffoldTemplateRepo.mockResolvedValueOnce({
        url: "https://github.com/detected-org/.github",
      });
      mockSelectModules.mockResolvedValueOnce(["."]);
      mockSelectOverwriteStrategy.mockResolvedValueOnce("overwrite");

      const promise = runInit({});
      await vi.advanceTimersByTimeAsync(6000);
      await promise;

      expect(mockScaffoldTemplateRepo).toHaveBeenCalledWith(
        "ghp_test_token",
        "detected-org",
        ".github",
      );
      expect(mockLog.success).toHaveBeenCalledWith(
        expect.stringContaining("https://github.com/detected-org/.github"),
      );
      expect(mockDownloadTemplateToTemp).toHaveBeenCalledWith(
        expect.any(String),
        "gh:detected-org/.github",
      );
    });

    it("リポジトリ作成時に GitHub トークンがなければエラー", async () => {
      mockCheckRepoExists.mockResolvedValueOnce(false);
      mockSelectMissingTemplateAction.mockResolvedValueOnce("create-repo");
      mockGetGitHubToken.mockReturnValue(undefined);

      await expect(runInit({})).rejects.toThrow("GitHub token required");
    });

    it("カスタムソースを指定すると存在チェック後に続行する", async () => {
      mockCheckRepoExists.mockResolvedValueOnce(false);
      mockSelectMissingTemplateAction.mockResolvedValueOnce("specify-source");
      mockInputTemplateSource.mockResolvedValueOnce("custom-org/templates");
      mockCheckRepoExists.mockResolvedValueOnce(true);
      mockSelectModules.mockResolvedValueOnce(["."]);
      mockSelectOverwriteStrategy.mockResolvedValueOnce("overwrite");

      await runInit({});

      expect(mockDownloadTemplateToTemp).toHaveBeenCalledWith(
        expect.any(String),
        "gh:custom-org/templates",
      );
    });

    it("カスタムソースも存在しない場合はさらにリカバリを提示する", async () => {
      // detected-org/.github が存在しない
      mockCheckRepoExists.mockResolvedValueOnce(false);
      mockSelectMissingTemplateAction.mockResolvedValueOnce("specify-source");
      // ユーザーが入力したリポジトリも存在しない
      mockInputTemplateSource.mockResolvedValueOnce("nonexistent-org/repo");
      mockCheckRepoExists.mockResolvedValueOnce(false);
      // 2回目のリカバリ: リポジトリ作成
      mockSelectMissingTemplateAction.mockResolvedValueOnce("create-repo");
      mockGetGitHubToken.mockReturnValue("ghp_test_token");
      mockScaffoldTemplateRepo.mockResolvedValueOnce({
        url: "https://github.com/nonexistent-org/repo",
      });
      mockSelectModules.mockResolvedValueOnce(["."]);
      mockSelectOverwriteStrategy.mockResolvedValueOnce("overwrite");

      const promise = runInit({});
      await vi.advanceTimersByTimeAsync(6000);
      await promise;

      // 2回リカバリが呼ばれる
      expect(mockSelectMissingTemplateAction).toHaveBeenCalledTimes(2);
    });
  });

  // ─── --from で指定されたリポジトリが見つからない場合 ───

  describe("--from で指定されたリポジトリが見つからない場合", () => {
    it("エラーを投げる（リカバリ選択なし）", async () => {
      mockCheckRepoExists.mockResolvedValueOnce(false);

      await expect(runInit({ from: "bad-org/bad-repo" })).rejects.toThrow("not found");
      expect(mockSelectMissingTemplateAction).not.toHaveBeenCalled();
    });
  });

  // ─── git remote がない場合 ───

  describe("git remote origin が検出できない場合", () => {
    it("非インタラクティブモードではエラーを投げる", async () => {
      mockDetectGitHubOwner.mockReturnValueOnce(null);

      await expect(runInit({ yes: true })).rejects.toThrow("Cannot detect template source");
    });

    it("インタラクティブモードではユーザーにソース入力を促す", async () => {
      mockDetectGitHubOwner.mockReturnValueOnce(null);
      mockInputTemplateSource.mockResolvedValueOnce("my-org/templates");
      mockCheckRepoExists.mockResolvedValueOnce(true);
      mockSelectModules.mockResolvedValueOnce(["."]);
      mockSelectOverwriteStrategy.mockResolvedValueOnce("overwrite");

      await runInit({});

      expect(mockInputTemplateSource).toHaveBeenCalled();
      expect(mockDownloadTemplateToTemp).toHaveBeenCalledWith(
        expect.any(String),
        "gh:my-org/templates",
      );
    });
  });

  // ─── テンプレートが正常に見つかる場合 ───

  describe("テンプレートが正常に見つかる場合", () => {
    it("存在チェックを通過して通常フローが実行される", async () => {
      mockCheckRepoExists.mockResolvedValueOnce(true);
      mockSelectModules.mockResolvedValueOnce(["."]);
      mockSelectOverwriteStrategy.mockResolvedValueOnce("overwrite");

      await runInit({});

      expect(mockDownloadTemplateToTemp).toHaveBeenCalledWith(
        expect.any(String),
        "gh:detected-org/.github",
      );
      expect(mockSelectMissingTemplateAction).not.toHaveBeenCalled();
    });
  });

  // ─── .devenv/modules.jsonc がテンプレートにない場合 ───

  describe("テンプレートに .devenv/modules.jsonc がない場合", () => {
    it("非インタラクティブモードでは警告してデフォルトモジュールを使用する", async () => {
      mockCheckRepoExists.mockResolvedValueOnce(true);
      mockModulesFileExists.mockReturnValue(false);

      await runInit({ yes: true });

      expect(mockLog.warn).toHaveBeenCalledWith(
        expect.stringContaining("no .devenv/modules.jsonc"),
      );
      expect(mockFetchTemplates).toHaveBeenCalled();
    });

    it("scaffold-pr を選択すると PR を作成してデフォルトで続行する", async () => {
      mockCheckRepoExists.mockResolvedValueOnce(true);
      mockModulesFileExists.mockReturnValue(false);
      mockSelectScaffoldDevenvAction.mockResolvedValueOnce("scaffold-pr");
      mockGetGitHubToken.mockReturnValue("ghp_test_token");
      mockCreateDevenvScaffoldPR.mockResolvedValueOnce({
        url: "https://github.com/detected-org/.github/pull/1",
        number: 1,
        branch: "devenv-scaffold",
      });
      mockSelectModules.mockResolvedValueOnce(["."]);
      mockSelectOverwriteStrategy.mockResolvedValueOnce("overwrite");

      await runInit({});

      expect(mockCreateDevenvScaffoldPR).toHaveBeenCalledWith(
        "ghp_test_token",
        "detected-org",
        ".github",
        expect.stringContaining("modules"),
      );
      expect(mockLog.success).toHaveBeenCalledWith(
        expect.stringContaining("https://github.com/detected-org/.github/pull/1"),
      );
      // デフォルトモジュールで初期化が続行される
      expect(mockFetchTemplates).toHaveBeenCalled();
    });

    it("scaffold-pr で GitHub トークンがなければエラー", async () => {
      mockCheckRepoExists.mockResolvedValueOnce(true);
      mockModulesFileExists.mockReturnValue(false);
      mockSelectScaffoldDevenvAction.mockResolvedValueOnce("scaffold-pr");
      mockGetGitHubToken.mockReturnValue(undefined);

      await expect(runInit({})).rejects.toThrow("GitHub token required");
    });

    it("scaffold-local を選択するとデフォルトモジュールで続行する", async () => {
      mockCheckRepoExists.mockResolvedValueOnce(true);
      mockModulesFileExists.mockReturnValue(false);
      mockSelectScaffoldDevenvAction.mockResolvedValueOnce("scaffold-local");
      mockSelectModules.mockResolvedValueOnce(["."]);
      mockSelectOverwriteStrategy.mockResolvedValueOnce("overwrite");

      await runInit({});

      expect(mockCreateDevenvScaffoldPR).not.toHaveBeenCalled();
      expect(mockFetchTemplates).toHaveBeenCalled();
    });

    it("continue-without を選択するとデフォルトモジュールで続行する", async () => {
      mockCheckRepoExists.mockResolvedValueOnce(true);
      mockModulesFileExists.mockReturnValue(false);
      mockSelectScaffoldDevenvAction.mockResolvedValueOnce("continue-without");
      mockSelectModules.mockResolvedValueOnce(["."]);
      mockSelectOverwriteStrategy.mockResolvedValueOnce("overwrite");

      await runInit({});

      expect(mockCreateDevenvScaffoldPR).not.toHaveBeenCalled();
      expect(mockFetchTemplates).toHaveBeenCalled();
    });
  });

  // ─── E2E: テンプレートなし → 作成 → .devenv スキャフォールド → 初期化完了 ───

  describe("E2E: テンプレートなし → 作成 → .devenv スキャフォールド PR → 初期化完了", () => {
    it("全フローが正常に完了する", async () => {
      // 1. テンプレートリポが存在しない
      mockCheckRepoExists.mockResolvedValueOnce(false);
      // 2. ユーザーがリポジトリ作成を選択
      mockSelectMissingTemplateAction.mockResolvedValueOnce("create-repo");
      mockGetGitHubToken.mockReturnValue("ghp_test_token");
      mockScaffoldTemplateRepo.mockResolvedValueOnce({
        url: "https://github.com/detected-org/.github",
      });
      // 3. テンプレートに .devenv がない
      mockModulesFileExists.mockReturnValue(false);
      // 4. ユーザーが PR 作成を選択
      mockSelectScaffoldDevenvAction.mockResolvedValueOnce("scaffold-pr");
      mockCreateDevenvScaffoldPR.mockResolvedValueOnce({
        url: "https://github.com/detected-org/.github/pull/1",
        number: 1,
        branch: "devenv-scaffold",
      });
      // 5. モジュール選択
      mockSelectModules.mockResolvedValueOnce([".", ".github"]);
      mockSelectOverwriteStrategy.mockResolvedValueOnce("overwrite");
      mockFetchTemplates.mockResolvedValueOnce([
        { action: "copied", path: ".mcp.json" },
        { action: "copied", path: ".github/workflows/ci.yml" },
      ]);

      const promise = runInit({});
      await vi.advanceTimersByTimeAsync(6000);
      await promise;

      // リポジトリ作成
      expect(mockScaffoldTemplateRepo).toHaveBeenCalledWith(
        "ghp_test_token",
        "detected-org",
        ".github",
      );
      // .devenv スキャフォールド PR
      expect(mockCreateDevenvScaffoldPR).toHaveBeenCalledWith(
        "ghp_test_token",
        "detected-org",
        ".github",
        expect.stringContaining("modules"),
      );
      // 初期化完了
      expect(mockFetchTemplates).toHaveBeenCalled();
      expect(mockWriteFileWithStrategy).toHaveBeenCalledWith(
        expect.objectContaining({ relativePath: ".devenv.json" }),
      );
    });
  });

  // ─── E2E: カスタムソース → .devenv なし → ローカルデフォルト → 完了 ───

  describe("E2E: カスタムソース → .devenv なし → ローカルデフォルト → 初期化完了", () => {
    it("全フローが正常に完了する", async () => {
      mockCheckRepoExists.mockResolvedValueOnce(false);
      mockSelectMissingTemplateAction.mockResolvedValueOnce("specify-source");
      mockInputTemplateSource.mockResolvedValueOnce("my-org/my-templates");
      mockCheckRepoExists.mockResolvedValueOnce(true);
      // .devenv がない
      mockModulesFileExists.mockReturnValue(false);
      mockSelectScaffoldDevenvAction.mockResolvedValueOnce("scaffold-local");
      mockSelectModules.mockResolvedValueOnce(["."]);
      mockSelectOverwriteStrategy.mockResolvedValueOnce("overwrite");
      mockFetchTemplates.mockResolvedValueOnce([{ action: "copied", path: ".mise.toml" }]);

      await runInit({});

      expect(mockDownloadTemplateToTemp).toHaveBeenCalledWith(
        expect.any(String),
        "gh:my-org/my-templates",
      );
      // .devenv.json にカスタムソースが記録される
      const configCall = mockWriteFileWithStrategy.mock.calls.find(
        (call) => call[0].relativePath === ".devenv.json",
      );
      expect(configCall).toBeDefined();
      const configContent = JSON.parse(configCall![0].content);
      expect(configContent.source).toEqual({ owner: "my-org", repo: "my-templates" });
    });
  });
});
