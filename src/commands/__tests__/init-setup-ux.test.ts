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
 *   7. テンプレートに .ziku/ziku.jsonc がない → エラー（setup への誘導）
 *   8. テンプレートに .ziku/ziku.jsonc がない + 非インタラクティブ → エラー
 */
import { vol } from "memfs";
import { Effect } from "effect";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { TemplateNotConfiguredError } from "../../errors";

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

vi.mock("../../utils/github", async () => {
  const actual = await vi.importActual<typeof import("../../utils/github")>("../../utils/github");
  return {
    resolveLatestCommitSha: vi.fn(() => Promise.resolve("abc123def456")),
    checkRepoExists: vi.fn(() => Promise.resolve({ _tag: "Exists" as const })),
    checkRepoSetup: vi.fn(() => Promise.resolve(true)),
    getGitHubToken: vi.fn(() => {}),
    getAuthenticatedUserLogin: vi.fn(() => Promise.resolve()),
    scaffoldTemplateRepo: vi.fn(() =>
      Promise.resolve({ url: "https://github.com/detected-org/.github" }),
    ),
    rateLimitedError: actual.rateLimitedError,
  };
});

vi.mock("../../ui/prompts", () => ({
  selectDirectories: vi.fn(),
  selectOverwriteStrategy: vi.fn(),
  selectMissingTemplateAction: vi.fn(),
  selectTemplateCandidate: vi.fn(),
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

vi.mock("../../utils/template-config", () => ({
  loadTemplateConfig: vi.fn(() =>
    Effect.succeed({
      include: [".mcp.json", ".devcontainer/**", ".github/**"],
      exclude: [],
    }),
  ),
  templateConfigExists: vi.fn(() => true),
  extractDirectoryEntries: vi.fn((patterns: string[]) => {
    const dirMap = new Map<string, string[]>();
    const rootFiles: string[] = [];
    for (const p of patterns) {
      const slashIndex = p.indexOf("/");
      if (slashIndex === -1) {
        rootFiles.push(p);
      } else {
        const dir = p.slice(0, slashIndex);
        const existing = dirMap.get(dir);
        if (existing) {
          existing.push(p);
        } else {
          dirMap.set(dir, [p]);
        }
      }
    }
    const entries: Array<{ label: string; patterns: string[] }> = [];
    for (const [dir, pats] of [...dirMap.entries()].toSorted((a, b) => a[0].localeCompare(b[0]))) {
      entries.push({ label: dir, patterns: pats });
    }
    if (rootFiles.length > 0) {
      entries.push({ label: "Root files", patterns: rootFiles });
    }
    return entries;
  }),
}));

// モック後にインポート
const { initCommand } = await import("../init");
const { downloadTemplateToTemp, fetchTemplates, writeFileWithStrategy, copyFile } =
  await import("../../utils/template");
const { detectGitHubOwner } = await import("../../utils/git-remote");
const {
  selectDirectories,
  selectOverwriteStrategy,
  selectMissingTemplateAction,
  selectTemplateCandidate,
  inputTemplateSource,
} = await import("../../ui/prompts");
const { log } = await import("../../ui/renderer");
const { hashFiles } = await import("../../utils/hash");
const {
  checkRepoExists,
  checkRepoSetup,
  getAuthenticatedUserLogin,
  getGitHubToken,
  scaffoldTemplateRepo,
} = await import("../../utils/github");
const { loadTemplateConfig } = await import("../../utils/template-config");

const mockDownloadTemplateToTemp = vi.mocked(downloadTemplateToTemp);
const mockFetchTemplates = vi.mocked(fetchTemplates);
const mockWriteFileWithStrategy = vi.mocked(writeFileWithStrategy);
const mockCopyFile = vi.mocked(copyFile);
const mockDetectGitHubOwner = vi.mocked(detectGitHubOwner);
const mockSelectDirectories = vi.mocked(selectDirectories);
const mockSelectOverwriteStrategy = vi.mocked(selectOverwriteStrategy);
const mockSelectMissingTemplateAction = vi.mocked(selectMissingTemplateAction);
const mockSelectTemplateCandidate = vi.mocked(selectTemplateCandidate);
const mockInputTemplateSource = vi.mocked(inputTemplateSource);
const _mockLog = vi.mocked(log);
const mockHashFiles = vi.mocked(hashFiles);
const mockCheckRepoExists = vi.mocked(checkRepoExists);
const mockCheckRepoSetup = vi.mocked(checkRepoSetup);
const mockGetAuthenticatedUserLogin = vi.mocked(getAuthenticatedUserLogin);
const mockGetGitHubToken = vi.mocked(getGitHubToken);
const mockScaffoldTemplateRepo = vi.mocked(scaffoldTemplateRepo);
const mockLoadTemplateConfig = vi.mocked(loadTemplateConfig);

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
    vi.resetAllMocks();
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
      path: ".ziku/lock.json",
    });
    mockCopyFile.mockResolvedValue({
      action: "skipped",
      path: ".ziku/ziku.jsonc",
    });
    mockHashFiles.mockResolvedValue({});
    mockDetectGitHubOwner.mockReturnValue("detected-org");
    mockGetAuthenticatedUserLogin.mockResolvedValue(undefined);
    mockCheckRepoExists.mockResolvedValue({ _tag: "Exists" });
    mockCheckRepoSetup.mockResolvedValue(true);
    mockGetGitHubToken.mockReturnValue(undefined);
    mockSelectTemplateCandidate.mockResolvedValue({ owner: "detected-org", repo: ".github" });
    mockLoadTemplateConfig.mockReturnValue(
      Effect.succeed({
        include: [".mcp.json", ".devcontainer/**", ".github/**"],
        exclude: [],
      }),
    );
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  // ─── テンプレートリポジトリが見つからない場合 ───

  describe("テンプレートリポジトリが見つからない場合", () => {
    it("非インタラクティブモード（--yes）で候補が存在しない場合はエラー", async () => {
      mockCheckRepoExists.mockResolvedValue({ _tag: "NotFound" });

      await expect(runInit({ yes: true })).rejects.toThrow("not found");
    });

    it("リポジトリ作成を選択するとリポジトリを作成して続行する", async () => {
      // 2候補（.ziku, .github）とも存在しない
      mockCheckRepoExists
        .mockResolvedValueOnce({ _tag: "NotFound" })
        .mockResolvedValueOnce({ _tag: "NotFound" });
      mockSelectMissingTemplateAction.mockResolvedValueOnce("create-repo");
      mockGetGitHubToken.mockReturnValue("ghp_test_token");
      mockScaffoldTemplateRepo.mockResolvedValueOnce({
        url: "https://github.com/detected-org/.ziku",
      });
      mockSelectDirectories.mockResolvedValueOnce([".mcp.json"]);
      mockSelectOverwriteStrategy.mockResolvedValueOnce("overwrite");

      // リポ作成後、ziku.jsonc がないのでエラーになる（ziku setup への誘導）
      mockLoadTemplateConfig.mockReturnValue(
        Effect.fail(new TemplateNotConfiguredError({ templateDir: "/tmp/template" })),
      );

      const promise = runInit({}).catch((e: unknown) => e);
      await vi.advanceTimersByTimeAsync(6000);
      const error = await promise;

      // Effect.runPromise wraps errors in FiberFailure, so check message content
      expect(error).toBeDefined();
      expect(String(error)).toContain("has no .ziku/ziku.jsonc");

      expect(mockScaffoldTemplateRepo).toHaveBeenCalledWith(
        "ghp_test_token",
        "detected-org",
        ".ziku",
      );
    });

    it("リポジトリ作成時に GitHub トークンがなければエラー", async () => {
      mockCheckRepoExists
        .mockResolvedValueOnce({ _tag: "NotFound" })
        .mockResolvedValueOnce({ _tag: "NotFound" });
      mockSelectMissingTemplateAction.mockResolvedValueOnce("create-repo");
      mockGetGitHubToken.mockReturnValue(undefined);

      await expect(runInit({})).rejects.toThrow("GitHub token required");
    });

    it("カスタムソースを指定すると存在チェック後に続行する", async () => {
      mockCheckRepoExists
        .mockResolvedValueOnce({ _tag: "NotFound" })
        .mockResolvedValueOnce({ _tag: "NotFound" });
      mockSelectMissingTemplateAction.mockResolvedValueOnce("specify-source");
      mockInputTemplateSource.mockResolvedValueOnce("custom-org/templates");
      mockCheckRepoExists.mockResolvedValueOnce({ _tag: "Exists" });
      // Template has ziku.jsonc
      mockLoadTemplateConfig.mockReturnValue(
        Effect.succeed({
          include: [".mcp.json"],
          exclude: [],
        }),
      );
      mockSelectDirectories.mockResolvedValueOnce([".mcp.json"]);
      mockSelectOverwriteStrategy.mockResolvedValueOnce("overwrite");

      await runInit({});

      expect(mockDownloadTemplateToTemp).toHaveBeenCalledWith(
        expect.any(String),
        "gh:custom-org/templates",
      );
    });

    it("カスタムソースも存在しない場合はさらにリカバリを提示する", async () => {
      // detected-org/.ziku, detected-org/.github が存在しない
      mockCheckRepoExists
        .mockResolvedValueOnce({ _tag: "NotFound" })
        .mockResolvedValueOnce({ _tag: "NotFound" });
      mockSelectMissingTemplateAction.mockResolvedValueOnce("specify-source");
      // ユーザーが入力したリポジトリも存在しない
      mockInputTemplateSource.mockResolvedValueOnce("nonexistent-org/repo");
      mockCheckRepoExists.mockResolvedValueOnce({ _tag: "NotFound" });
      // 2回目のリカバリ: リポジトリ作成
      mockSelectMissingTemplateAction.mockResolvedValueOnce("create-repo");
      mockGetGitHubToken.mockReturnValue("ghp_test_token");
      mockScaffoldTemplateRepo.mockResolvedValueOnce({
        url: "https://github.com/nonexistent-org/repo",
      });
      // After creating repo, template has no ziku.jsonc
      mockLoadTemplateConfig.mockReturnValue(
        Effect.fail(new TemplateNotConfiguredError({ templateDir: "/tmp/template" })),
      );

      const promise = runInit({}).catch((e: unknown) => e);
      await vi.advanceTimersByTimeAsync(6000);
      const error = await promise;

      // Effect.runPromise wraps errors in FiberFailure
      expect(error).toBeDefined();
      expect(String(error)).toContain("has no .ziku/ziku.jsonc");

      // 2回リカバリが呼ばれる
      expect(mockSelectMissingTemplateAction).toHaveBeenCalledTimes(2);
    });
  });

  // ─── --from で指定されたリポジトリが見つからない場合 ───

  describe("--from で指定されたリポジトリが見つからない場合", () => {
    it("エラーを投げる（リカバリ選択なし）", async () => {
      mockCheckRepoExists.mockResolvedValueOnce({ _tag: "NotFound" });

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
      mockCheckRepoExists.mockResolvedValueOnce({ _tag: "Exists" });
      // Template has ziku.jsonc
      mockLoadTemplateConfig.mockReturnValue(
        Effect.succeed({
          include: [".mcp.json"],
          exclude: [],
        }),
      );
      mockSelectDirectories.mockResolvedValueOnce([".mcp.json"]);
      mockSelectOverwriteStrategy.mockResolvedValueOnce("overwrite");

      await runInit({});

      expect(mockInputTemplateSource).toHaveBeenCalled();
      expect(mockDownloadTemplateToTemp).toHaveBeenCalledWith(
        expect.any(String),
        "gh:my-org/templates",
      );
    });
  });

  // ─── セットアップ状態チェック ───

  describe("セットアップ状態（.ziku/ziku.jsonc 存在）チェック", () => {
    it("非インタラクティブで .github のみセットアップ済みなら .github を選択", async () => {
      // .ziku と .github 両方存在
      mockCheckRepoExists.mockResolvedValue({ _tag: "Exists" });
      // .ziku はセットアップ未完了、.github はセットアップ済み
      mockCheckRepoSetup
        .mockResolvedValueOnce(false) // detected-org/.ziku
        .mockResolvedValueOnce(true); // detected-org/.github

      mockLoadTemplateConfig.mockReturnValue(
        Effect.succeed({
          include: [".mcp.json"],
          exclude: [],
        }),
      );

      await runInit({ yes: true });

      // セットアップ済みの .github が優先される
      expect(mockDownloadTemplateToTemp).toHaveBeenCalledWith(
        expect.any(String),
        "gh:detected-org/.github",
      );
    });

    it("非インタラクティブで .ziku のみセットアップ済みなら .ziku を選択", async () => {
      mockCheckRepoExists.mockResolvedValue({ _tag: "Exists" });
      // .ziku はセットアップ済み、.github はセットアップ未完了
      mockCheckRepoSetup
        .mockResolvedValueOnce(true) // detected-org/.ziku
        .mockResolvedValueOnce(false); // detected-org/.github

      mockLoadTemplateConfig.mockReturnValue(
        Effect.succeed({
          include: [".mcp.json"],
          exclude: [],
        }),
      );

      await runInit({ yes: true });

      expect(mockDownloadTemplateToTemp).toHaveBeenCalledWith(
        expect.any(String),
        "gh:detected-org/.ziku",
      );
    });

    it("両方セットアップ済みならリスト順（.ziku）を優先", async () => {
      mockCheckRepoExists.mockResolvedValue({ _tag: "Exists" });
      // 両方セットアップ済み
      mockCheckRepoSetup.mockResolvedValue(true);

      mockLoadTemplateConfig.mockReturnValue(
        Effect.succeed({
          include: [".mcp.json"],
          exclude: [],
        }),
      );

      await runInit({ yes: true });

      // デフォルト順で .ziku が先
      expect(mockDownloadTemplateToTemp).toHaveBeenCalledWith(
        expect.any(String),
        "gh:detected-org/.ziku",
      );
    });

    it("どちらもセットアップ未完了ならリスト順（.ziku）を選択", async () => {
      mockCheckRepoExists.mockResolvedValue({ _tag: "Exists" });
      mockCheckRepoSetup.mockResolvedValue(false);

      // Template has no ziku.jsonc → error
      mockLoadTemplateConfig.mockReturnValue(
        Effect.fail(new TemplateNotConfiguredError({ templateDir: "/tmp/template" })),
      );

      await expect(runInit({ yes: true })).rejects.toThrow("has no .ziku/ziku.jsonc");
    });

    it("インタラクティブモードで候補に ready 状態が表示される", async () => {
      mockCheckRepoExists.mockResolvedValue({ _tag: "Exists" });
      mockCheckRepoSetup
        .mockResolvedValueOnce(true) // detected-org/.ziku: ready
        .mockResolvedValueOnce(false); // detected-org/.github: not ready

      mockSelectTemplateCandidate.mockResolvedValueOnce({
        owner: "detected-org",
        repo: ".ziku",
      });
      mockLoadTemplateConfig.mockReturnValue(
        Effect.succeed({
          include: [".mcp.json"],
          exclude: [],
        }),
      );
      mockSelectDirectories.mockResolvedValueOnce([".mcp.json"]);
      mockSelectOverwriteStrategy.mockResolvedValueOnce("overwrite");

      await runInit({});

      // selectTemplateCandidate に ready 付きの候補が渡される
      expect(mockSelectTemplateCandidate).toHaveBeenCalledWith(
        expect.arrayContaining([
          expect.objectContaining({ owner: "detected-org", repo: ".ziku", ready: true }),
          expect.objectContaining({ owner: "detected-org", repo: ".github", ready: false }),
        ]),
      );
    });
  });

  // ─── テンプレートが正常に見つかる場合 ───

  describe("テンプレートが正常に見つかる場合", () => {
    it("存在チェックを通過して通常フローが実行される", async () => {
      mockCheckRepoExists.mockResolvedValueOnce({ _tag: "Exists" });
      // Template has ziku.jsonc
      mockLoadTemplateConfig.mockReturnValue(
        Effect.succeed({
          include: [".mcp.json"],
          exclude: [],
        }),
      );
      mockSelectDirectories.mockResolvedValueOnce([".mcp.json"]);
      mockSelectOverwriteStrategy.mockResolvedValueOnce("overwrite");

      await runInit({});

      expect(mockDownloadTemplateToTemp).toHaveBeenCalledWith(
        expect.any(String),
        "gh:detected-org/.github",
      );
      expect(mockSelectMissingTemplateAction).not.toHaveBeenCalled();
    });
  });

  // ─── .ziku/ziku.jsonc がテンプレートにない場合 ───

  describe("テンプレートに .ziku/ziku.jsonc がない場合", () => {
    it("ziku setup への誘導エラーを投げる", async () => {
      mockCheckRepoExists.mockResolvedValueOnce({ _tag: "Exists" });
      mockLoadTemplateConfig.mockReturnValue(
        Effect.fail(new TemplateNotConfiguredError({ templateDir: "/tmp/template" })),
      );

      await expect(runInit({})).rejects.toThrow("has no .ziku/ziku.jsonc");
    });
  });

  // ─── E2E: テンプレートなし → 作成 → ziku.jsonc なし → setup 誘導 ───

  describe("E2E: テンプレートなし → 作成 → ziku.jsonc なし → setup 誘導", () => {
    it("リポ作成後に ziku.jsonc がなければ setup への誘導エラー", async () => {
      // 1. テンプレートリポが存在しない（.ziku, .github 両方）
      mockCheckRepoExists
        .mockResolvedValueOnce({ _tag: "NotFound" })
        .mockResolvedValueOnce({ _tag: "NotFound" });
      // 2. ユーザーがリポジトリ作成を選択
      mockSelectMissingTemplateAction.mockResolvedValueOnce("create-repo");
      mockGetGitHubToken.mockReturnValue("ghp_test_token");
      mockScaffoldTemplateRepo.mockResolvedValueOnce({
        url: "https://github.com/detected-org/.ziku",
      });
      // 3. テンプレートに .ziku/ziku.jsonc がない → setup 誘導エラー
      mockLoadTemplateConfig.mockReturnValue(
        Effect.fail(new TemplateNotConfiguredError({ templateDir: "/tmp/template" })),
      );

      const promise = runInit({}).catch((e: unknown) => e);
      await vi.advanceTimersByTimeAsync(6000);
      const error = await promise;

      // Effect.runPromise wraps errors in FiberFailure
      expect(error).toBeDefined();
      expect(String(error)).toContain("has no .ziku/ziku.jsonc");

      expect(mockScaffoldTemplateRepo).toHaveBeenCalledWith(
        "ghp_test_token",
        "detected-org",
        ".ziku",
      );
    });
  });

  // ─── E2E: カスタムソース → .ziku なし → setup 誘導 ───

  describe("E2E: カスタムソース → .ziku なし → setup 誘導", () => {
    it("ziku.jsonc がなければ setup への誘導エラー", async () => {
      // 2候補とも存在しない
      mockCheckRepoExists
        .mockResolvedValueOnce({ _tag: "NotFound" })
        .mockResolvedValueOnce({ _tag: "NotFound" });
      mockSelectMissingTemplateAction.mockResolvedValueOnce("specify-source");
      mockInputTemplateSource.mockResolvedValueOnce("my-org/my-templates");
      mockCheckRepoExists.mockResolvedValueOnce({ _tag: "Exists" });
      // .ziku がない → setup 誘導エラー
      mockLoadTemplateConfig.mockReturnValue(
        Effect.fail(new TemplateNotConfiguredError({ templateDir: "/tmp/template" })),
      );

      await expect(runInit({})).rejects.toThrow("has no .ziku/ziku.jsonc");

      expect(mockDownloadTemplateToTemp).toHaveBeenCalledWith(
        expect.any(String),
        "gh:my-org/my-templates",
      );
    });
  });
});
