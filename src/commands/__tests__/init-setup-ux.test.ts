/**
 * E2E テスト: テンプレートリポジトリが存在しない場合のセットアップ UX
 *
 * 背景: `ziku init` でテンプレートリポジトリ（例: my-org/.github）が見つからない場合、
 * ユーザーにリカバリ方法を提示する。以下のシナリオをカバーする:
 *   1. テンプレートが見つからない → デフォルトにフォールバック（非インタラクティブ）
 *   2. テンプレートが見つからない → ユーザーがデフォルトを選択（インタラクティブ）
 *   3. テンプレートが見つからない → ユーザーがリポジトリ作成を選択
 *   4. テンプレートが見つからない → ユーザーがカスタムソースを指定
 *   5. --from で指定されたリポジトリが見つからない → エラー
 *   6. テンプレートが正常に見つかる → 通常フロー
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
  DEFAULT_TEMPLATE_OWNER: "tktcorporation",
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
}));

vi.mock("../../ui/prompts", () => ({
  selectModules: vi.fn(),
  selectOverwriteStrategy: vi.fn(),
  selectMissingTemplateAction: vi.fn(),
  inputTemplateSource: vi.fn(),
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
const { selectModules, selectOverwriteStrategy, selectMissingTemplateAction, inputTemplateSource } =
  await import("../../ui/prompts");
const { log } = await import("../../ui/renderer");
const { hashFiles } = await import("../../utils/hash");
const { checkRepoExists, getGitHubToken, scaffoldTemplateRepo } =
  await import("../../utils/github");

const mockDownloadTemplateToTemp = vi.mocked(downloadTemplateToTemp);
const mockFetchTemplates = vi.mocked(fetchTemplates);
const mockWriteFileWithStrategy = vi.mocked(writeFileWithStrategy);
const mockCopyFile = vi.mocked(copyFile);
const mockDetectGitHubOwner = vi.mocked(detectGitHubOwner);
const mockSelectModules = vi.mocked(selectModules);
const mockSelectOverwriteStrategy = vi.mocked(selectOverwriteStrategy);
const mockSelectMissingTemplateAction = vi.mocked(selectMissingTemplateAction);
const mockInputTemplateSource = vi.mocked(inputTemplateSource);
const mockLog = vi.mocked(log);
const mockHashFiles = vi.mocked(hashFiles);
const mockCheckRepoExists = vi.mocked(checkRepoExists);
const mockGetGitHubToken = vi.mocked(getGitHubToken);
const mockScaffoldTemplateRepo = vi.mocked(scaffoldTemplateRepo);

// コマンド実行ヘルパー
async function runInit(args: Record<string, unknown>) {
  return (initCommand.run as any)({
    args: { dir: "/test", force: false, yes: false, ...args },
    rawArgs: [],
    cmd: initCommand,
  });
}

describe("init: テンプレートが見つからない場合のセットアップ UX", () => {
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
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  // ─── Scenario 1: 非インタラクティブモードでテンプレートが見つからない ───

  describe("非インタラクティブモード（--yes）でテンプレートが見つからない場合", () => {
    it("デフォルトテンプレートにフォールバックする", async () => {
      mockCheckRepoExists.mockResolvedValueOnce(false);

      await runInit({ yes: true });

      // デフォルトテンプレートが使われる
      expect(mockDownloadTemplateToTemp).toHaveBeenCalledWith(
        expect.any(String),
        "gh:tktcorporation/.github",
      );
      // 警告が表示される
      expect(mockLog.warn).toHaveBeenCalledWith(
        expect.stringContaining("not found, using default"),
      );
    });

    it("フォールバック後も正常に初期化が完了する", async () => {
      mockCheckRepoExists.mockResolvedValueOnce(false);

      await runInit({ yes: true });

      // fetchTemplates が呼ばれる（初期化が完了している）
      expect(mockFetchTemplates).toHaveBeenCalled();
      // .devenv.json が作成される
      expect(mockWriteFileWithStrategy).toHaveBeenCalledWith(
        expect.objectContaining({ relativePath: ".devenv.json" }),
      );
    });
  });

  // ─── Scenario 2: インタラクティブでデフォルトを選択 ───

  describe("インタラクティブモードでデフォルトを選択する場合", () => {
    it("ユーザーが 'use-default' を選択するとデフォルトテンプレートを使用する", async () => {
      mockCheckRepoExists.mockResolvedValueOnce(false);
      mockSelectMissingTemplateAction.mockResolvedValueOnce("use-default");
      mockSelectModules.mockResolvedValueOnce(["."]);
      mockSelectOverwriteStrategy.mockResolvedValueOnce("overwrite");

      await runInit({});

      // アクション選択プロンプトが表示される
      expect(mockSelectMissingTemplateAction).toHaveBeenCalledWith("detected-org", ".github");
      // デフォルトテンプレートが使われる
      expect(mockDownloadTemplateToTemp).toHaveBeenCalledWith(
        expect.any(String),
        "gh:tktcorporation/.github",
      );
    });
  });

  // ─── Scenario 3: インタラクティブでリポジトリ作成を選択 ───

  describe("インタラクティブモードでリポジトリ作成を選択する場合", () => {
    it("GitHub トークンがある場合はリポジトリを作成して続行する", async () => {
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

      // scaffoldTemplateRepo が正しい引数で呼ばれる
      expect(mockScaffoldTemplateRepo).toHaveBeenCalledWith(
        "ghp_test_token",
        "detected-org",
        ".github",
        "tktcorporation",
        ".github",
      );
      // 成功メッセージが表示される
      expect(mockLog.success).toHaveBeenCalledWith(
        expect.stringContaining("https://github.com/detected-org/.github"),
      );
      // 作成されたリポジトリが使われる
      expect(mockDownloadTemplateToTemp).toHaveBeenCalledWith(
        expect.any(String),
        "gh:detected-org/.github",
      );
    });

    it("GitHub トークンがない場合はエラーを投げる", async () => {
      mockCheckRepoExists.mockResolvedValueOnce(false);
      mockSelectMissingTemplateAction.mockResolvedValueOnce("create-repo");
      mockGetGitHubToken.mockReturnValue(undefined);

      await expect(runInit({})).rejects.toThrow("GitHub token required");
    });
  });

  // ─── Scenario 4: インタラクティブでカスタムソースを指定 ───

  describe("インタラクティブモードでカスタムソースを指定する場合", () => {
    it("存在するカスタムソースを指定すると正常に続行する", async () => {
      // 1回目: detected-org/.github は存在しない
      mockCheckRepoExists.mockResolvedValueOnce(false);
      mockSelectMissingTemplateAction.mockResolvedValueOnce("specify-source");
      mockInputTemplateSource.mockResolvedValueOnce("custom-org/templates");
      // 2回目: custom-org/templates は存在する
      mockCheckRepoExists.mockResolvedValueOnce(true);
      mockSelectModules.mockResolvedValueOnce(["."]);
      mockSelectOverwriteStrategy.mockResolvedValueOnce("overwrite");

      await runInit({});

      // カスタムソースが使われる
      expect(mockDownloadTemplateToTemp).toHaveBeenCalledWith(
        expect.any(String),
        "gh:custom-org/templates",
      );
    });

    it("存在しないカスタムソースを指定するとエラーを投げる", async () => {
      mockCheckRepoExists.mockResolvedValueOnce(false);
      mockSelectMissingTemplateAction.mockResolvedValueOnce("specify-source");
      mockInputTemplateSource.mockResolvedValueOnce("nonexistent-org/repo");
      mockCheckRepoExists.mockResolvedValueOnce(false);

      await expect(runInit({})).rejects.toThrow("not found");
    });
  });

  // ─── Scenario 5: --from で指定されたリポジトリが見つからない ───

  describe("--from で指定されたリポジトリが見つからない場合", () => {
    it("エラーを投げる（リカバリ選択なし）", async () => {
      mockCheckRepoExists.mockResolvedValueOnce(false);

      await expect(runInit({ from: "bad-org/bad-repo" })).rejects.toThrow("not found");

      // インタラクティブなアクション選択は表示されない
      expect(mockSelectMissingTemplateAction).not.toHaveBeenCalled();
    });
  });

  // ─── Scenario 6: テンプレートが正常に見つかる場合 ───

  describe("テンプレートが正常に見つかる場合", () => {
    it("存在チェックを通過して通常フローが実行される", async () => {
      mockCheckRepoExists.mockResolvedValueOnce(true);
      mockSelectModules.mockResolvedValueOnce(["."]);
      mockSelectOverwriteStrategy.mockResolvedValueOnce("overwrite");

      await runInit({});

      // 検出されたオーナーのリポジトリが使われる
      expect(mockDownloadTemplateToTemp).toHaveBeenCalledWith(
        expect.any(String),
        "gh:detected-org/.github",
      );
      // アクション選択プロンプトは表示されない
      expect(mockSelectMissingTemplateAction).not.toHaveBeenCalled();
    });

    it("デフォルトテンプレート（git remote 検出失敗）の場合は存在チェックをスキップする", async () => {
      mockDetectGitHubOwner.mockReturnValueOnce(null);
      mockSelectModules.mockResolvedValueOnce(["."]);
      mockSelectOverwriteStrategy.mockResolvedValueOnce("overwrite");

      await runInit({});

      // checkRepoExists は呼ばれない（デフォルトテンプレートは常に存在する前提）
      expect(mockCheckRepoExists).not.toHaveBeenCalled();
      // デフォルトテンプレートが使われる
      expect(mockDownloadTemplateToTemp).toHaveBeenCalledWith(
        expect.any(String),
        "gh:tktcorporation/.github",
      );
    });
  });

  // ─── Scenario 7: ネットワークエラー時の楽観的続行 ───

  describe("ネットワークエラー時", () => {
    it("存在チェックがネットワークエラーの場合は楽観的に続行する", async () => {
      // checkRepoExists はネットワークエラー時に true を返す（楽観的）
      mockCheckRepoExists.mockResolvedValueOnce(true);
      mockSelectModules.mockResolvedValueOnce(["."]);
      mockSelectOverwriteStrategy.mockResolvedValueOnce("overwrite");

      await runInit({});

      // 通常フローが続行される
      expect(mockDownloadTemplateToTemp).toHaveBeenCalled();
      expect(mockSelectMissingTemplateAction).not.toHaveBeenCalled();
    });
  });

  // ─── Scenario 8: E2E フロー（テンプレートなし → 作成 → 初期化完了） ───

  describe("E2E: テンプレートなし → リポジトリ作成 → 初期化完了", () => {
    it("全フローが正常に完了する", async () => {
      // テンプレートが存在しない
      mockCheckRepoExists.mockResolvedValueOnce(false);
      // ユーザーがリポジトリ作成を選択
      mockSelectMissingTemplateAction.mockResolvedValueOnce("create-repo");
      // トークンがある
      mockGetGitHubToken.mockReturnValue("ghp_test_token");
      // リポジトリ作成成功
      mockScaffoldTemplateRepo.mockResolvedValueOnce({
        url: "https://github.com/detected-org/.github",
      });
      // モジュール選択
      mockSelectModules.mockResolvedValueOnce([".", ".github"]);
      mockSelectOverwriteStrategy.mockResolvedValueOnce("overwrite");
      // テンプレートファイル
      mockFetchTemplates.mockResolvedValueOnce([
        { action: "copied", path: ".mcp.json" },
        { action: "copied", path: ".github/workflows/ci.yml" },
      ]);
      mockHashFiles.mockResolvedValueOnce({
        ".mcp.json": "hash1",
        ".github/workflows/ci.yml": "hash2",
      });

      const promise = runInit({});
      await vi.advanceTimersByTimeAsync(6000);
      await promise;

      // 1. リポジトリ存在チェック
      expect(mockCheckRepoExists).toHaveBeenCalledWith("detected-org", ".github");
      // 2. アクション選択
      expect(mockSelectMissingTemplateAction).toHaveBeenCalled();
      // 3. リポジトリ作成
      expect(mockScaffoldTemplateRepo).toHaveBeenCalled();
      // 4. テンプレートダウンロード（作成されたリポジトリから）
      expect(mockDownloadTemplateToTemp).toHaveBeenCalledWith(
        expect.any(String),
        "gh:detected-org/.github",
      );
      // 5. ファイルコピー
      expect(mockFetchTemplates).toHaveBeenCalledWith(
        expect.objectContaining({
          modules: [".", ".github"],
          overwriteStrategy: "overwrite",
        }),
      );
      // 6. .devenv.json 作成
      expect(mockWriteFileWithStrategy).toHaveBeenCalledWith(
        expect.objectContaining({
          relativePath: ".devenv.json",
        }),
      );
    });
  });

  // ─── Scenario 9: E2E フロー（テンプレートなし → デフォルト → 初期化完了） ───

  describe("E2E: テンプレートなし → デフォルト選択 → 初期化完了", () => {
    it("デフォルトテンプレートで全フローが正常に完了する", async () => {
      mockCheckRepoExists.mockResolvedValueOnce(false);
      mockSelectMissingTemplateAction.mockResolvedValueOnce("use-default");
      mockSelectModules.mockResolvedValueOnce(["."]);
      mockSelectOverwriteStrategy.mockResolvedValueOnce("skip");
      mockFetchTemplates.mockResolvedValueOnce([{ action: "copied", path: ".mcp.json" }]);

      await runInit({});

      // デフォルトテンプレートでダウンロード
      expect(mockDownloadTemplateToTemp).toHaveBeenCalledWith(
        expect.any(String),
        "gh:tktcorporation/.github",
      );
      // 初期化完了
      expect(mockFetchTemplates).toHaveBeenCalled();
      expect(mockWriteFileWithStrategy).toHaveBeenCalled();
    });
  });

  // ─── Scenario 10: E2E フロー（テンプレートなし → カスタムソース → 初期化完了） ───

  describe("E2E: テンプレートなし → カスタムソース → 初期化完了", () => {
    it("カスタムソースで全フローが正常に完了する", async () => {
      mockCheckRepoExists.mockResolvedValueOnce(false);
      mockSelectMissingTemplateAction.mockResolvedValueOnce("specify-source");
      mockInputTemplateSource.mockResolvedValueOnce("my-org/my-templates");
      mockCheckRepoExists.mockResolvedValueOnce(true);
      mockSelectModules.mockResolvedValueOnce(["."]);
      mockSelectOverwriteStrategy.mockResolvedValueOnce("overwrite");
      mockFetchTemplates.mockResolvedValueOnce([{ action: "copied", path: ".mise.toml" }]);

      await runInit({});

      // カスタムソースでダウンロード
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
