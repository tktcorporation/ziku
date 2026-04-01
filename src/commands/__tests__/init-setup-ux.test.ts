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
 *   7. テンプレートに .ziku がない → スキャフォールド PR を提案 → エラー（マージ後に再実行）
 *   8. テンプレートに .ziku がない + 非インタラクティブ → エラー
 *   9. テンプレートに .ziku がない + PR 拒否 → エラー
 */
import { vol } from "memfs";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
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
  detectGitHubOwner: vi.fn(() => "detected-org"),
  detectGitHubRepo: vi.fn(() => null),
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
      branch: "ziku-scaffold",
    }),
  ),
}));

vi.mock("../../ui/prompts", () => ({
  selectModules: vi.fn(),
  selectOverwriteStrategy: vi.fn(),
  selectMissingTemplateAction: vi.fn(),
  selectTemplateModules: vi.fn(() =>
    Promise.resolve([
      {
        name: "DevContainer",
        description: "VS Code DevContainer setup",
        include: [".devcontainer/**"],
      },
      {
        name: "GitHub",
        description: "GitHub Actions workflows and configuration",
        include: [".github/**"],
      },
    ]),
  ),
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
    modulesFileExists: vi.fn(() => false),
    loadTemplateModulesFile: vi.fn(),
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
  confirmScaffoldDevenvPR,
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
const mockConfirmScaffoldDevenvPR = vi.mocked(confirmScaffoldDevenvPR);
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
    mockWriteFileWithStrategy.mockResolvedValue({
      action: "created",
      path: ".ziku.json",
    });
    mockCopyFile.mockResolvedValue({
      action: "skipped",
      path: ".ziku/modules.jsonc",
    });
    mockHashFiles.mockResolvedValue({});
    mockDetectGitHubOwner.mockReturnValue("detected-org");
    mockCheckRepoExists.mockResolvedValue(true);
    mockGetGitHubToken.mockReturnValue(undefined);
    mockModulesFileExists.mockReturnValue(false);
    mockConfirmScaffoldDevenvPR.mockResolvedValue(true);
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
      mockSelectModules.mockResolvedValueOnce([
        { name: "Root", description: "Root", include: [".mcp.json"] },
      ]);
      mockSelectOverwriteStrategy.mockResolvedValueOnce("overwrite");

      // After creating repo, handleMissingDevenv will throw because modules.jsonc doesn't exist
      // But first we need modulesFileExists to return false for the template
      mockModulesFileExists.mockReturnValue(false);
      mockConfirmScaffoldDevenvPR.mockResolvedValueOnce(true);
      mockGetGitHubToken.mockReturnValue("ghp_test_token");

      const promise = runInit({}).catch((e: unknown) => e);
      await vi.advanceTimersByTimeAsync(6000);
      const error = await promise;

      // handleMissingDevenv always throws after creating PR
      expect(error).toBeInstanceOf(ZikuError);

      expect(mockScaffoldTemplateRepo).toHaveBeenCalledWith(
        "ghp_test_token",
        "detected-org",
        ".github",
      );
      expect(mockLog.success).toHaveBeenCalledWith(
        expect.stringContaining("https://github.com/detected-org/.github"),
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
      // Template has modules.jsonc
      mockModulesFileExists.mockReturnValue(true);
      const { loadTemplateModulesFile } = await import("../../modules/index");
      vi.mocked(loadTemplateModulesFile).mockResolvedValue({
        modules: [
          {
            name: "Root",
            description: "Root",
            include: [".mcp.json"],
          },
        ],
        rawContent: '{"modules":[]}',
      });
      mockSelectModules.mockResolvedValueOnce([
        { name: "Root", description: "Root", include: [".mcp.json"] },
      ]);
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
      // After creating repo, handleMissingDevenv throws
      mockModulesFileExists.mockReturnValue(false);
      mockConfirmScaffoldDevenvPR.mockResolvedValueOnce(true);

      const promise = runInit({}).catch((e: unknown) => e);
      await vi.advanceTimersByTimeAsync(6000);
      const error = await promise;

      // handleMissingDevenv always throws
      expect(error).toBeInstanceOf(ZikuError);

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
      // Template has modules.jsonc
      mockModulesFileExists.mockReturnValue(true);
      const { loadTemplateModulesFile } = await import("../../modules/index");
      vi.mocked(loadTemplateModulesFile).mockResolvedValue({
        modules: [
          {
            name: "Root",
            description: "Root",
            include: [".mcp.json"],
          },
        ],
        rawContent: '{"modules":[]}',
      });
      mockSelectModules.mockResolvedValueOnce([
        { name: "Root", description: "Root", include: [".mcp.json"] },
      ]);
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
      // Template has modules.jsonc
      mockModulesFileExists.mockReturnValue(true);
      const { loadTemplateModulesFile } = await import("../../modules/index");
      vi.mocked(loadTemplateModulesFile).mockResolvedValue({
        modules: [
          {
            name: "Root",
            description: "Root",
            include: [".mcp.json"],
          },
        ],
        rawContent: '{"modules":[]}',
      });
      mockSelectModules.mockResolvedValueOnce([
        { name: "Root", description: "Root", include: [".mcp.json"] },
      ]);
      mockSelectOverwriteStrategy.mockResolvedValueOnce("overwrite");

      await runInit({});

      expect(mockDownloadTemplateToTemp).toHaveBeenCalledWith(
        expect.any(String),
        "gh:detected-org/.github",
      );
      expect(mockSelectMissingTemplateAction).not.toHaveBeenCalled();
    });
  });

  // ─── .ziku/modules.jsonc がテンプレートにない場合 ───

  describe("テンプレートに .ziku/modules.jsonc がない場合", () => {
    it("非インタラクティブモードではエラーを投げる", async () => {
      mockCheckRepoExists.mockResolvedValueOnce(true);
      mockModulesFileExists.mockReturnValue(false);

      await expect(runInit({ yes: true })).rejects.toThrow("has no .ziku/modules.jsonc");
    });

    it("PR 作成を承認すると PR を作成してエラーを投げる（マージ後に再実行）", async () => {
      mockCheckRepoExists.mockResolvedValueOnce(true);
      mockModulesFileExists.mockReturnValue(false);
      mockConfirmScaffoldDevenvPR.mockResolvedValueOnce(true);
      mockGetGitHubToken.mockReturnValue("ghp_test_token");
      mockCreateDevenvScaffoldPR.mockResolvedValueOnce({
        url: "https://github.com/detected-org/.github/pull/1",
        number: 1,
        branch: "ziku-scaffold",
      });

      await expect(runInit({})).rejects.toThrow("Merge the PR first");

      expect(mockCreateDevenvScaffoldPR).toHaveBeenCalledWith(
        "ghp_test_token",
        "detected-org",
        ".github",
        expect.stringContaining("modules"),
      );
      expect(mockLog.success).toHaveBeenCalledWith(
        expect.stringContaining("https://github.com/detected-org/.github/pull/1"),
      );
    });

    it("PR 作成で GitHub トークンがなければエラー", async () => {
      mockCheckRepoExists.mockResolvedValueOnce(true);
      mockModulesFileExists.mockReturnValue(false);
      mockConfirmScaffoldDevenvPR.mockResolvedValueOnce(true);
      mockGetGitHubToken.mockReturnValue(undefined);

      await expect(runInit({})).rejects.toThrow("GitHub token required");
    });

    it("PR 作成を拒否するとエラーを投げる", async () => {
      mockCheckRepoExists.mockResolvedValueOnce(true);
      mockModulesFileExists.mockReturnValue(false);
      mockConfirmScaffoldDevenvPR.mockResolvedValueOnce(false);

      await expect(runInit({})).rejects.toThrow(".ziku/modules.jsonc is required");

      expect(mockCreateDevenvScaffoldPR).not.toHaveBeenCalled();
    });
  });

  // ─── E2E: テンプレートなし → 作成 → .ziku スキャフォールド PR → エラー ───

  describe("E2E: テンプレートなし → 作成 → .ziku スキャフォールド PR → マージ待ち", () => {
    it("全フローが正常に完了する（PR 作成後にマージ待ちエラー）", async () => {
      // 1. テンプレートリポが存在しない
      mockCheckRepoExists.mockResolvedValueOnce(false);
      // 2. ユーザーがリポジトリ作成を選択
      mockSelectMissingTemplateAction.mockResolvedValueOnce("create-repo");
      mockGetGitHubToken.mockReturnValue("ghp_test_token");
      mockScaffoldTemplateRepo.mockResolvedValueOnce({
        url: "https://github.com/detected-org/.github",
      });
      // 3. テンプレートに .ziku がない
      mockModulesFileExists.mockReturnValue(false);
      // 4. ユーザーが PR 作成を承認
      mockConfirmScaffoldDevenvPR.mockResolvedValueOnce(true);
      mockCreateDevenvScaffoldPR.mockResolvedValueOnce({
        url: "https://github.com/detected-org/.github/pull/1",
        number: 1,
        branch: "ziku-scaffold",
      });

      const promise = runInit({}).catch((e: unknown) => e);
      await vi.advanceTimersByTimeAsync(6000);
      const error = await promise;

      // handleMissingDevenv always throws after PR creation
      expect(error).toBeInstanceOf(ZikuError);
      expect((error as ZikuError).message).toContain("Merge the PR first");

      // リポジトリ作成
      expect(mockScaffoldTemplateRepo).toHaveBeenCalledWith(
        "ghp_test_token",
        "detected-org",
        ".github",
      );
      // .ziku スキャフォールド PR
      expect(mockCreateDevenvScaffoldPR).toHaveBeenCalledWith(
        "ghp_test_token",
        "detected-org",
        ".github",
        expect.stringContaining("modules"),
      );
    });
  });

  // ─── E2E: カスタムソース → .ziku なし → PR → マージ待ちエラー ───

  describe("E2E: カスタムソース → .ziku なし → PR → マージ待ちエラー", () => {
    it("全フローが正常に完了する", async () => {
      mockCheckRepoExists.mockResolvedValueOnce(false);
      mockSelectMissingTemplateAction.mockResolvedValueOnce("specify-source");
      mockInputTemplateSource.mockResolvedValueOnce("my-org/my-templates");
      mockCheckRepoExists.mockResolvedValueOnce(true);
      // .ziku がない
      mockModulesFileExists.mockReturnValue(false);
      mockConfirmScaffoldDevenvPR.mockResolvedValueOnce(true);
      mockGetGitHubToken.mockReturnValue("ghp_test_token");
      mockCreateDevenvScaffoldPR.mockResolvedValueOnce({
        url: "https://github.com/my-org/my-templates/pull/1",
        number: 1,
        branch: "ziku-scaffold",
      });

      await expect(runInit({})).rejects.toThrow("Merge the PR first");

      expect(mockDownloadTemplateToTemp).toHaveBeenCalledWith(
        expect.any(String),
        "gh:my-org/my-templates",
      );
      expect(mockCreateDevenvScaffoldPR).toHaveBeenCalledWith(
        "ghp_test_token",
        "my-org",
        "my-templates",
        expect.stringContaining("modules"),
      );
    });
  });
});
