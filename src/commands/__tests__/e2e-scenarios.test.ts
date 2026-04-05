/**
 * E2E テスト: 様々なシナリオでのコマンド動作を検証
 *
 * 既存の e2e-flat-format.test.ts はフォーマット変換の正確性に焦点。
 * このファイルはユーザーが実際に遭遇するシナリオ全体をカバーする:
 *   - init: フラットテンプレート、--from、--overwrite-strategy、エラーケース
 *   - diff: config 不在、verbose、untracked 検出
 *   - track: パターン追加の完全フロー、エラーケース
 *   - push/pull: config 不在エラー
 *   - cross-command: init → track → diff の一連のフロー
 */

import { vol } from "memfs";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { ZikuError } from "../../errors";

// ── filesystem mock ─────────────────────────────────────────────

vi.mock("node:fs", async () => {
  const memfs = await import("memfs");
  return memfs.fs;
});

vi.mock("node:fs/promises", async () => {
  const memfs = await import("memfs");
  return memfs.fs.promises;
});

// ── external dependency mocks ───────────────────────────────────

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
  resolveLatestCommitSha: vi.fn(() => Promise.resolve("abc123")),
  checkRepoExists: vi.fn(() => Promise.resolve(true)),
  checkRepoSetup: vi.fn(() => Promise.resolve(true)),
  getGitHubToken: vi.fn(() => "ghp_test"),
  getAuthenticatedUserLogin: vi.fn(() => Promise.resolve()),
  scaffoldTemplateRepo: vi.fn(() => Promise.resolve({ url: "https://github.com/test/repo" })),
  createDevenvScaffoldPR: vi.fn(() =>
    Promise.resolve({ url: "https://github.com/test/repo/pull/1", number: 1, branch: "ziku" }),
  ),
  createPullRequest: vi.fn(() =>
    Promise.resolve({ url: "https://github.com/test/repo/pull/2", number: 2, branch: "sync" }),
  ),
}));

vi.mock("../../ui/prompts", () => ({
  selectModules: vi.fn(),
  selectOverwriteStrategy: vi.fn(() => Promise.resolve("overwrite")),
  selectMissingTemplateAction: vi.fn(),
  selectTemplateCandidate: vi.fn(() => Promise.resolve({ owner: "test-org", repo: ".github" })),
  inputTemplateSource: vi.fn(),
  confirmScaffoldDevenvPR: vi.fn(() => Promise.resolve(true)),
  selectDeletedFiles: vi.fn(() => Promise.resolve([])),
  selectPushFiles: vi.fn(),
  confirmAction: vi.fn(() => Promise.resolve(true)),
  inputGitHubToken: vi.fn(() => Promise.resolve("ghp_test")),
  inputPrTitle: vi.fn(() => Promise.resolve("test PR")),
  inputPrBody: vi.fn(() => Promise.resolve("test body")),
  generatePrTitle: vi.fn(() => "test PR"),
  generatePrBody: vi.fn(() => "test body"),
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
    green: (s: string) => s,
    red: (s: string) => s,
    yellow: (s: string) => s,
  },
  withSpinner: vi.fn(async (_text: string, fn: () => Promise<unknown>) => fn()),
  logFileResults: vi.fn(() => ({ added: 1, updated: 0, skipped: 0 })),
  logDiffSummary: vi.fn(),
  logZikuError: vi.fn(),
}));

// init 用: テンプレートの modules.jsonc 読み込みモック
vi.mock("../../modules/index", async (importOriginal) => {
  const original = await importOriginal<typeof import("../../modules/index")>();
  return {
    ...original,
    modulesFileExists: vi.fn(() => true),
    loadModulesFile: vi.fn(() =>
      Promise.resolve({
        modules: [
          { name: "Default", description: "Default", include: [".mcp.json", ".devcontainer/**"] },
        ],
        rawContent: '{"modules":[]}',
      }),
    ),
  };
});

vi.mock("../../utils/ziku-config", async (importOriginal) => {
  const actual = (await importOriginal()) as Record<string, unknown>;
  return { ...actual };
});
vi.mock("../../utils/lock", async (importOriginal) => {
  const actual = (await importOriginal()) as Record<string, unknown>;
  return { ...actual };
});

vi.mock("../../ui/diff-view", () => ({
  renderFileDiff: vi.fn(),
  calculateDiffStats: vi.fn(() => ({ additions: 0, deletions: 0 })),
  formatStats: vi.fn(() => ""),
}));

vi.mock("../../utils/readme", () => ({
  detectAndUpdateReadme: vi.fn(() => Promise.resolve({ updated: false, path: null })),
}));

vi.mock("giget", () => ({
  downloadTemplate: vi.fn(() => Promise.resolve({ dir: "/tmp/template" })),
}));

vi.mock("../../utils/diff", () => ({
  detectDiff: vi.fn(() =>
    Promise.resolve({
      files: [],
      summary: { added: 0, modified: 0, deleted: 0, unchanged: 0 },
      templateDir: "/tmp/template",
      targetDir: "/project",
    }),
  ),
  hasDiff: vi.fn(() => false),
  getPushableFiles: vi.fn(() => []),
}));

vi.mock("../../utils/untracked", () => ({
  detectUntrackedFiles: vi.fn(() => Promise.resolve([])),
  getTotalUntrackedCount: vi.fn(() => 0),
}));

vi.spyOn(console, "log").mockImplementation(() => {});

// ── imports (after mocks) ───────────────────────────────────────

const { initCommand } = await import("../init");
const { trackCommand } = await import("../track");
const { diffCommand } = await import("../diff");
const { pullCommand } = await import("../pull");

const { downloadTemplateToTemp, fetchTemplates, writeFileWithStrategy } =
  await import("../../utils/template");
const { hashFiles } = await import("../../utils/hash");
const { zikuConfigExists: _zikuConfigExists } = await import("../../utils/ziku-config");
const { modulesFileExists, loadModulesFile } = await import("../../modules");
const { selectModules } = await import("../../ui/prompts");
const { log } = await import("../../ui/renderer");
const { detectDiff } = await import("../../utils/diff");
const { checkRepoExists } = await import("../../utils/github");

const mockDownloadTemplateToTemp = vi.mocked(downloadTemplateToTemp);
const mockFetchTemplates = vi.mocked(fetchTemplates);
const mockWriteFileWithStrategy = vi.mocked(writeFileWithStrategy);
const mockHashFiles = vi.mocked(hashFiles);
const mockModulesFileExists = vi.mocked(modulesFileExists);
const mockLoadModulesFile = vi.mocked(loadModulesFile);
const mockSelectModules = vi.mocked(selectModules);
const mockLog = vi.mocked(log);
const mockDetectDiff = vi.mocked(detectDiff);
const mockCheckRepoExists = vi.mocked(checkRepoExists);

// ── helpers ─────────────────────────────────────────────────────

const DEFAULT_SOURCE = { owner: "test-org", repo: ".github" };

function createZikuJsonc(include: string[], exclude?: string[], source = DEFAULT_SOURCE): string {
  const content: Record<string, unknown> = { source, include };
  if (exclude && exclude.length > 0) content.exclude = exclude;
  return JSON.stringify(content, null, 2);
}

/**
 * テスト用: モジュール形式の modules.jsonc を生成するヘルパー。
 * 1つの Default モジュールにまとめる。
 */
function modulesJsonc(include: string[], exclude?: string[]): string {
  const mod: Record<string, unknown> = { name: "Default", description: "Default", include };
  if (exclude && exclude.length > 0) mod.exclude = exclude;
  return JSON.stringify({ modules: [mod] }, null, 2);
}

/**
 * テスト用: mockLoadModulesFile に渡すモジュール形式のレスポンスを生成するヘルパー。
 */
function mockModulesResponse(include: string[], exclude?: string[]) {
  const mod: Record<string, unknown> = { name: "Default", description: "Default", include };
  if (exclude && exclude.length > 0) mod.exclude = exclude;
  return {
    modules: [mod],
    rawContent: modulesJsonc(include, exclude),
  };
}

const baseLock = {
  version: "0.1.0",
  installedAt: "2024-01-01T00:00:00.000Z",
  baseHashes: {},
};

const _baseSource = { owner: "test-org", repo: ".github" };

// ═══════════════════════════════════════════════════════════════
// E2E Scenarios
// ═══════════════════════════════════════════════════════════════

describe("E2E: multi-scenario tests", () => {
  beforeEach(() => {
    vol.reset();
    vi.clearAllMocks();

    mockDownloadTemplateToTemp.mockResolvedValue({
      templateDir: "/tmp/template",
      cleanup: vi.fn(),
    });
    mockFetchTemplates.mockResolvedValue([]);
    mockWriteFileWithStrategy.mockResolvedValue({ action: "created", path: ".ziku/ziku.jsonc" });
    mockHashFiles.mockResolvedValue({});
    mockModulesFileExists.mockReturnValue(true);
    mockCheckRepoExists.mockResolvedValue(true);
  });

  // ─────────────────────────────────────────────────────────────
  // Scenario 1: フラットテンプレートでの init
  // テンプレート側が modules 形式でなくフラット形式の場合、
  // モジュール選択をスキップして全パターンを使用する
  // ─────────────────────────────────────────────────────────────

  describe("init: --yes で全モジュール選択", () => {
    beforeEach(() => {
      mockLoadModulesFile.mockResolvedValue({
        modules: [
          { name: "Root", description: "Root", include: [".mcp.json"], exclude: ["*.local"] },
          { name: "DevContainer", description: "DC", include: [".devcontainer/**"] },
          { name: "GitHub", description: "GH", include: [".github/**"] },
        ],
        rawContent: '{"modules":[]}',
      });
    });

    it("--yes で全モジュールのパターンがフラット化されて適用される", async () => {
      vol.fromJSON({
        "/test": null,
      });

      await (initCommand.run as any)({
        args: { dir: "/test", force: false, yes: true },
        rawArgs: [],
        cmd: initCommand,
      });

      // --yes なので selectModules は呼ばれない（全モジュール自動選択）
      expect(mockSelectModules).not.toHaveBeenCalled();

      // fetchTemplates に全モジュールのフラット化パターンが渡される
      expect(mockFetchTemplates).toHaveBeenCalledWith(
        expect.objectContaining({
          patterns: expect.objectContaining({
            include: expect.arrayContaining([".mcp.json", ".devcontainer/**", ".github/**"]),
            exclude: expect.arrayContaining(["*.local"]),
          }),
        }),
      );
    });
  });

  // ─────────────────────────────────────────────────────────────
  // Scenario 2: モジュール形式テンプレートでの init + --modules
  // ─────────────────────────────────────────────────────────────

  describe("init: モジュール形式テンプレート + --modules フラグ", () => {
    beforeEach(() => {
      mockLoadModulesFile.mockResolvedValue({
        modules: [
          { name: "Root", description: "Root config", include: [".mcp.json"] },
          { name: "DevContainer", description: "DC", include: [".devcontainer/**"] },
          { name: "GitHub", description: "GH", include: [".github/**"] },
        ],
        rawContent: "{}",
      });
    });

    it("--modules で特定モジュールだけ選択", async () => {
      vol.fromJSON({ "/test": null });

      await (initCommand.run as any)({
        args: { dir: "/test", force: false, yes: false, modules: "Root,GitHub" },
        rawArgs: [],
        cmd: initCommand,
      });

      // selectModules は呼ばれない（--modules で非インタラクティブ）
      expect(mockSelectModules).not.toHaveBeenCalled();

      // Root と GitHub のパターンだけ含まれる
      expect(mockFetchTemplates).toHaveBeenCalledWith(
        expect.objectContaining({
          patterns: expect.objectContaining({
            include: expect.arrayContaining([".mcp.json", ".github/**"]),
          }),
        }),
      );

      // DevContainer は含まれない
      const patterns = mockFetchTemplates.mock.calls[0][0].patterns;
      expect(patterns.include).not.toContain(".devcontainer/**");
    });

    it("--modules に存在しないモジュール名 → ZikuError", async () => {
      vol.fromJSON({ "/test": null });

      await expect(
        (initCommand.run as any)({
          args: { dir: "/test", force: false, yes: false, modules: "NonExistent" },
          rawArgs: [],
          cmd: initCommand,
        }),
      ).rejects.toThrow(ZikuError);
    });
  });

  // ─────────────────────────────────────────────────────────────
  // Scenario 3: --from でカスタムテンプレートソース指定
  // ─────────────────────────────────────────────────────────────

  describe("init: --from オプション", () => {
    beforeEach(() => {
      mockLoadModulesFile.mockResolvedValue(mockModulesResponse([".editorconfig"]));
    });

    it("--from で指定したリポジトリがテンプレートソースになる", async () => {
      vol.fromJSON({
        ...vol.toJSON(),
        "/test": null,
      });

      await (initCommand.run as any)({
        args: { dir: "/test", force: false, yes: true, from: "custom-org/templates" },
        rawArgs: [],
        cmd: initCommand,
      });

      // downloadTemplateToTemp にカスタムソースが渡される
      expect(mockDownloadTemplateToTemp).toHaveBeenCalledWith(
        expect.any(String),
        "gh:custom-org/templates",
      );
    });

    it("--from のリポジトリが存在しない → ZikuError", async () => {
      mockCheckRepoExists.mockResolvedValueOnce(false);
      vol.fromJSON({ "/test": null });

      await expect(
        (initCommand.run as any)({
          args: { dir: "/test", force: false, yes: true, from: "no-org/no-repo" },
          rawArgs: [],
          cmd: initCommand,
        }),
      ).rejects.toThrow(ZikuError);
    });
  });

  // ─────────────────────────────────────────────────────────────
  // Scenario 4: --overwrite-strategy
  // ─────────────────────────────────────────────────────────────

  describe("init: --overwrite-strategy", () => {
    beforeEach(() => {
      mockLoadModulesFile.mockResolvedValue(mockModulesResponse([".mcp.json"]));
    });

    it("--overwrite-strategy skip で skip 戦略が使われる", async () => {
      vol.fromJSON({
        ...vol.toJSON(),
        "/test": null,
      });

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
        expect.objectContaining({ overwriteStrategy: "skip" }),
      );
    });

    it("無効な --overwrite-strategy → ZikuError", async () => {
      vol.fromJSON({
        ...vol.toJSON(),
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
    });
  });

  // ─────────────────────────────────────────────────────────────
  // Scenario 5: diff コマンドのエラーケース
  // ─────────────────────────────────────────────────────────────

  describe("diff: エラーケース", () => {
    it(".ziku/ziku.jsonc が存在しない → ZikuError", async () => {
      vol.fromJSON({
        "/project/.ziku/lock.json": JSON.stringify(baseLock),
        // .ziku/ziku.jsonc なし
      });

      await expect(
        (diffCommand.run as any)({
          args: { dir: "/project", verbose: false },
          rawArgs: [],
          cmd: diffCommand,
        }),
      ).rejects.toThrow();
    });

    it("ziku.jsonc が存在しない → ZikuError", async () => {
      vol.fromJSON({
        "/project/.ziku/lock.json": JSON.stringify(baseLock),
        // .ziku/ziku.jsonc なし
      });

      await expect(
        (diffCommand.run as any)({
          args: { dir: "/project", verbose: false },
          rawArgs: [],
          cmd: diffCommand,
        }),
      ).rejects.toThrow();
    });
  });

  // ─────────────────────────────────────────────────────────────
  // Scenario 6: track コマンドの完全フロー
  // ─────────────────────────────────────────────────────────────

  describe("track: パターン追加の完全フロー", () => {
    it("新規パターンを追加して ziku.jsonc に反映される", async () => {
      const initial = createZikuJsonc([".mcp.json"]);
      vol.fromJSON({
        "/project/.ziku/ziku.jsonc": initial,
      });

      const originalArgv = process.argv;
      process.argv = ["node", "ziku", "track", ".github/workflows/*.yml", "--dir", "/project"];

      await (trackCommand.run as any)({
        args: { dir: "/project", list: false, patterns: ".github/workflows/*.yml" },
        rawArgs: [],
        cmd: trackCommand,
      });

      process.argv = originalArgv;

      // ファイルが更新されていること
      const content = vol.readFileSync("/project/.ziku/ziku.jsonc", "utf-8") as string;
      const parsed = JSON.parse(content);
      expect(parsed.include).toContain(".mcp.json");
      expect(parsed.include).toContain(".github/workflows/*.yml");
    });

    it("既に追跡済みのパターン → 変更なし警告", async () => {
      vol.fromJSON({
        "/project/.ziku/ziku.jsonc": createZikuJsonc([".mcp.json"]),
      });

      const originalArgv = process.argv;
      process.argv = ["node", "ziku", "track", ".mcp.json", "--dir", "/project"];

      await (trackCommand.run as any)({
        args: { dir: "/project", list: false, patterns: ".mcp.json" },
        rawArgs: [],
        cmd: trackCommand,
      });

      process.argv = originalArgv;

      // info が呼ばれること（既に追跡済み）
      expect(mockLog.info).toHaveBeenCalledWith(expect.stringContaining("already tracked"));
    });

    it("--list でパターン一覧を表示", async () => {
      vol.fromJSON({
        "/project/.ziku/ziku.jsonc": createZikuJsonc(
          [".mcp.json", ".devcontainer/**"],
          ["*.local"],
        ),
      });

      await (trackCommand.run as any)({
        args: { dir: "/project", list: true, patterns: "" },
        rawArgs: [],
        cmd: trackCommand,
      });

      // エラーなく完了すること
    });

    it("ziku.jsonc がない場合 → ZikuError", async () => {
      vol.fromJSON({ "/project": null });

      await expect(
        (trackCommand.run as any)({
          args: { dir: "/project", list: false, patterns: ".new-pattern" },
          rawArgs: [],
          cmd: trackCommand,
        }),
      ).rejects.toThrow(ZikuError);
    });

    it("パターン引数なし → ZikuError", async () => {
      vol.fromJSON({
        "/project/.ziku/ziku.jsonc": createZikuJsonc([".mcp.json"]),
      });

      const originalArgv = process.argv;
      process.argv = ["node", "ziku", "track", "--dir", "/project"];

      await expect(
        (trackCommand.run as any)({
          args: { dir: "/project", list: false, patterns: "" },
          rawArgs: [],
          cmd: trackCommand,
        }),
      ).rejects.toThrow(ZikuError);

      process.argv = originalArgv;
    });
  });

  // ─────────────────────────────────────────────────────────────
  // Scenario 7: pull コマンドのエラーケース
  // ─────────────────────────────────────────────────────────────

  describe("pull: エラーケース", () => {
    it(".ziku/ziku.jsonc がない → ZikuError", async () => {
      vol.fromJSON({
        "/project/.ziku/lock.json": JSON.stringify(baseLock),
      });

      await expect(
        (pullCommand.run as any)({
          args: { dir: "/project", force: false, continue: false },
          rawArgs: [],
          cmd: pullCommand,
        }),
      ).rejects.toThrow();
    });
  });

  // ─────────────────────────────────────────────────────────────
  // Scenario 8: init → track → diff の一連のフロー
  // ─────────────────────────────────────────────────────────────

  describe("cross-command: init → track → diff", () => {
    it("init でセットアップ → track でパターン追加 → diff が新しいパターンで動作", async () => {
      // Step 1: init
      mockLoadModulesFile.mockResolvedValue(mockModulesResponse([".mcp.json"]));
      vol.fromJSON({
        "/project": null,
      });

      mockFetchTemplates.mockResolvedValue([{ action: "copied", path: ".mcp.json" }]);

      await (initCommand.run as any)({
        args: { dir: "/project", force: false, yes: true },
        rawArgs: [],
        cmd: initCommand,
      });

      // init が書き出した ziku.jsonc を取得
      const initZikuCall = mockWriteFileWithStrategy.mock.calls.find(
        (call) => call[0].relativePath === ".ziku/ziku.jsonc",
      );
      expect(initZikuCall).toBeDefined();
      const initContent = initZikuCall![0].content;

      // Step 2: track でパターン追加
      vol.fromJSON({
        "/project/.ziku/ziku.jsonc": initContent,
      });

      const originalArgv = process.argv;
      process.argv = ["node", "ziku", "track", ".github/workflows/ci.yml", "--dir", "/project"];

      await (trackCommand.run as any)({
        args: { dir: "/project", list: false, patterns: ".github/workflows/ci.yml" },
        rawArgs: [],
        cmd: trackCommand,
      });

      process.argv = originalArgv;

      // ziku.jsonc が更新されたことを確認
      const updatedContent = vol.readFileSync("/project/.ziku/ziku.jsonc", "utf-8") as string;
      const updatedParsed = JSON.parse(updatedContent);
      expect(updatedParsed.include).toContain(".mcp.json");
      expect(updatedParsed.include).toContain(".github/workflows/ci.yml");

      await (diffCommand.run as any)({
        args: { dir: "/project", verbose: false },
        rawArgs: [],
        cmd: diffCommand,
      });

      // detectDiff が更新後のパターンで呼ばれること
      expect(mockDetectDiff).toHaveBeenCalledWith(
        expect.objectContaining({
          patterns: expect.objectContaining({
            include: expect.arrayContaining([".mcp.json", ".github/workflows/ci.yml"]),
          }),
        }),
      );
    });
  });

  // ─────────────────────────────────────────────────────────────
  // Scenario 9: init 時に変更がない場合の挙動
  // ─────────────────────────────────────────────────────────────

  describe("init: 変更がない場合", () => {
    it("全ファイルが skipped → 'No changes were made' メッセージ", async () => {
      mockLoadModulesFile.mockResolvedValue(mockModulesResponse([".mcp.json"]));
      vol.fromJSON({
        "/test": null,
      });

      // logFileResults が added=0, updated=0 を返す
      const { logFileResults } = await import("../../ui/renderer");
      vi.mocked(logFileResults).mockReturnValue({ added: 0, updated: 0, skipped: 3 });

      await (initCommand.run as any)({
        args: { dir: "/test", force: false, yes: true },
        rawArgs: [],
        cmd: initCommand,
      });

      expect(mockLog.info).toHaveBeenCalledWith("No changes were made");
    });
  });

  // ─────────────────────────────────────────────────────────────
  // Scenario 10: パターンが空の場合
  // ─────────────────────────────────────────────────────────────

  describe("init: テンプレートに include パターンがない場合", () => {
    it("include が空 → 'No patterns to apply' 警告", async () => {
      mockLoadModulesFile.mockResolvedValue(mockModulesResponse([]));
      vol.fromJSON({
        "/test": null,
      });

      await (initCommand.run as any)({
        args: { dir: "/test", force: false, yes: true },
        rawArgs: [],
        cmd: initCommand,
      });

      expect(mockLog.warn).toHaveBeenCalledWith("No patterns to apply");
      // fetchTemplates は呼ばれない
      expect(mockFetchTemplates).not.toHaveBeenCalled();
    });
  });
});
