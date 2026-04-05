/**
 * E2E テスト: modules.jsonc のフラット形式が全コマンドで正しく動作することを検証
 *
 * テスト対象:
 *   - init: テンプレートからモジュール選択 → ローカルにフラット形式で出力
 *   - track: パターン追加がフラット形式に正しく反映
 *   - pull/push/diff: フラットパターンで正常動作
 */

import { vol } from "memfs";
import { beforeEach, describe, expect, it, vi } from "vitest";

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
  createPullRequest: vi.fn(() => Promise.resolve({ url: "https://github.com/test/repo/pull/2" })),
}));

vi.mock("../../ui/prompts", () => ({
  selectModules: vi.fn(),
  selectOverwriteStrategy: vi.fn(),
  selectMissingTemplateAction: vi.fn(),
  selectTemplateCandidate: vi.fn(() => Promise.resolve({ owner: "test-org", repo: ".github" })),
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
  selectDeletedFiles: vi.fn(() => Promise.resolve([])),
  selectPushFiles: vi.fn(),
  confirmAction: vi.fn(() => Promise.resolve(true)),
  inputGitHubToken: vi.fn(() => Promise.resolve("ghp_test")),
  inputPrTitle: vi.fn(() => Promise.resolve("test PR")),
  inputPrBody: vi.fn(() => Promise.resolve("test body")),
  generatePrTitle: vi.fn(() => Promise.resolve("test PR")),
  generatePrBody: vi.fn(() => Promise.resolve("test body")),
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
            name: "DevContainer",
            description: "VS Code DevContainer setup",
            include: [".devcontainer/**"],
          },
          {
            name: "GitHub",
            description: "GitHub Actions workflows",
            include: [".github/**"],
            exclude: ["*.local"],
          },
          {
            name: "Claude",
            description: "Claude settings",
            include: [".claude/**"],
          },
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
    Promise.resolve({ files: [], templateDir: "/tmp/template", targetDir: "/project" }),
  ),
  hasDiff: vi.fn(() => false),
}));

vi.mock("../../utils/untracked", () => ({
  detectUntrackedFiles: vi.fn(() => Promise.resolve([])),
  getTotalUntrackedCount: vi.fn(() => 0),
}));

vi.spyOn(console, "log").mockImplementation(() => {});

// ── imports (after mocks) ───────────────────────────────────────

const { initCommand } = await import("../init");
const { trackCommand } = await import("../track");
const { pullCommand } = await import("../pull");
const { diffCommand } = await import("../diff");

const { downloadTemplateToTemp, fetchTemplates, writeFileWithStrategy, copyFile } =
  await import("../../utils/template");
const { hashFiles } = await import("../../utils/hash");
const { loadZikuConfig: _loadZikuConfig, zikuConfigExists: _zikuConfigExists } =
  await import("../../utils/ziku-config");
const { loadLock: _loadLock, saveLock: _saveLock } = await import("../../utils/lock");
const { modulesFileExists } = await import("../../modules");
const { addIncludePattern } = await import("../../utils/ziku-config");
const { detectDiff } = await import("../../utils/diff");

const mockDownloadTemplateToTemp = vi.mocked(downloadTemplateToTemp);
const mockFetchTemplates = vi.mocked(fetchTemplates);
const mockWriteFileWithStrategy = vi.mocked(writeFileWithStrategy);
const mockCopyFile = vi.mocked(copyFile);
const mockHashFiles = vi.mocked(hashFiles);
const mockModulesFileExists = vi.mocked(modulesFileExists);

// ── helpers ─────────────────────────────────────────────────────

const DEFAULT_SOURCE = { owner: "test-org", repo: ".github" };

function createZikuJsonc(include: string[], exclude?: string[], source = DEFAULT_SOURCE): string {
  const content: Record<string, unknown> = { source, include };
  if (exclude && exclude.length > 0) {
    content.exclude = exclude;
  }
  return JSON.stringify(content, null, 2);
}

const baseLock = {
  version: "0.1.0",
  installedAt: "2024-01-01T00:00:00.000Z",
  baseHashes: {},
};

const _baseSource = { owner: "test-org", repo: ".github" };

// ═══════════════════════════════════════════════════════════════
// E2E Tests
// ═══════════════════════════════════════════════════════════════

describe("E2E: flat modules.jsonc format", () => {
  beforeEach(() => {
    vol.reset();
    vi.clearAllMocks();

    mockDownloadTemplateToTemp.mockResolvedValue({
      templateDir: "/tmp/template",
      cleanup: vi.fn(),
    });
    mockFetchTemplates.mockResolvedValue([]);
    mockWriteFileWithStrategy.mockResolvedValue({
      action: "created",
      path: ".ziku/ziku.jsonc",
    });
    mockCopyFile.mockResolvedValue({
      action: "skipped",
      path: ".ziku/lock.json",
    });
    mockHashFiles.mockResolvedValue({});
    mockModulesFileExists.mockReturnValue(true);
  });

  // ─────────────────────────────────────────────────────────────
  // 1. init → flat output
  // ─────────────────────────────────────────────────────────────

  describe("init → ローカルにフラット形式で出力", () => {
    it("--yes で全モジュール選択 → modules.jsonc がフラット形式で書き出される", async () => {
      vol.fromJSON({ "/test": null });

      await (initCommand.run as any)({
        args: { dir: "/test", force: false, yes: true },
        rawArgs: [],
        cmd: initCommand,
      });

      // writeFileWithStrategy で modules.jsonc が書き出される
      const modulesCall = mockWriteFileWithStrategy.mock.calls.find(
        (call) => call[0].relativePath === ".ziku/ziku.jsonc",
      );

      expect(modulesCall).toBeDefined();
      const content = JSON.parse(modulesCall![0].content);

      // フラット形式であること: include/exclude がトップレベル
      expect(content).toHaveProperty("include");
      expect(Array.isArray(content.include)).toBe(true);

      // modules プロパティが存在しないこと
      expect(content).not.toHaveProperty("modules");

      // 全モジュールの include パターンがフラット化されていること
      expect(content.include).toContain(".devcontainer/**");
      expect(content.include).toContain(".github/**");
      expect(content.include).toContain(".claude/**");
    });

    it("exclude のあるモジュール → exclude もフラットに含まれる", async () => {
      vol.fromJSON({ "/test": null });

      await (initCommand.run as any)({
        args: { dir: "/test", force: false, yes: true },
        rawArgs: [],
        cmd: initCommand,
      });

      const modulesCall = mockWriteFileWithStrategy.mock.calls.find(
        (call) => call[0].relativePath === ".ziku/ziku.jsonc",
      );

      expect(modulesCall).toBeDefined();
      const content = JSON.parse(modulesCall![0].content);

      // GitHub モジュールの exclude: ["*.local"] がフラット化される
      expect(content.exclude).toContain("*.local");
    });

    it("$schema URL が含まれること", async () => {
      vol.fromJSON({ "/test": null });

      await (initCommand.run as any)({
        args: { dir: "/test", force: false, yes: true },
        rawArgs: [],
        cmd: initCommand,
      });

      const modulesCall = mockWriteFileWithStrategy.mock.calls.find(
        (call) => call[0].relativePath === ".ziku/ziku.jsonc",
      );

      expect(modulesCall).toBeDefined();
      const content = JSON.parse(modulesCall![0].content);

      expect(content.$schema).toContain("schema/ziku.json");
    });

    it("fetchTemplates に FlatPatterns が渡されること", async () => {
      vol.fromJSON({ "/test": null });

      await (initCommand.run as any)({
        args: { dir: "/test", force: false, yes: true },
        rawArgs: [],
        cmd: initCommand,
      });

      // fetchTemplates の patterns 引数を確認
      expect(mockFetchTemplates).toHaveBeenCalled();
      const fetchCall = mockFetchTemplates.mock.calls[0];
      const options = fetchCall[0];

      // patterns は { include, exclude } 形式であること
      expect(options.patterns).toBeDefined();
      expect(options.patterns).toHaveProperty("include");
      expect(Array.isArray(options.patterns.include)).toBe(true);

      // modules プロパティが渡されていないこと
      expect(options).not.toHaveProperty("moduleList");
    });

    it("hashFiles に include/exclude が個別に渡されること", async () => {
      vol.fromJSON({ "/test": null });

      await (initCommand.run as any)({
        args: { dir: "/test", force: false, yes: true },
        rawArgs: [],
        cmd: initCommand,
      });

      expect(mockHashFiles).toHaveBeenCalled();
      const hashCall = mockHashFiles.mock.calls[0];

      // hashFiles(dir, include, exclude) の形式
      expect(Array.isArray(hashCall[1])).toBe(true); // include
      expect(hashCall[1]).toContain(".devcontainer/**");
    });
  });

  // ─────────────────────────────────────────────────────────────
  // 2. track → flat pattern manipulation
  // ─────────────────────────────────────────────────────────────

  describe("track → フラット形式にパターン追加", () => {
    it("addIncludePattern で新しいパターンがフラット include に追加される", () => {
      const initial = createZikuJsonc([".mcp.json", ".devcontainer/**"]);
      const updated = addIncludePattern(initial, [".cloud/rules/*.md"]);

      const parsed = JSON.parse(updated);
      expect(parsed.include).toContain(".mcp.json");
      expect(parsed.include).toContain(".devcontainer/**");
      expect(parsed.include).toContain(".cloud/rules/*.md");
      expect(parsed).not.toHaveProperty("modules");
    });

    it("複数パターンを一度に追加できる", () => {
      const initial = createZikuJsonc([".mcp.json"]);
      const updated = addIncludePattern(initial, [".cloud/rules/*.md", ".cloud/config.json"]);

      const parsed = JSON.parse(updated);
      expect(parsed.include).toHaveLength(3);
      expect(parsed.include).toContain(".cloud/rules/*.md");
      expect(parsed.include).toContain(".cloud/config.json");
    });

    it("既存パターンは重複追加されない", () => {
      const initial = createZikuJsonc([".mcp.json", ".devcontainer/**"]);
      const updated = addIncludePattern(initial, [".mcp.json"]);

      const parsed = JSON.parse(updated);
      expect(parsed.include).toHaveLength(2);
    });

    it("exclude 付きファイルへのパターン追加でも exclude は維持される", () => {
      const initial = createZikuJsonc([".mcp.json"], ["*.local"]);
      const updated = addIncludePattern(initial, [".github/**"]);

      const parsed = JSON.parse(updated);
      expect(parsed.include).toContain(".github/**");
      expect(parsed.exclude).toContain("*.local");
    });

    it("ziku.jsonc の addIncludePattern でパターンを追加できる", () => {
      const initial = createZikuJsonc([".mcp.json", ".devcontainer/**"]);

      // 追加
      const updated = addIncludePattern(initial, [".cloud/rules/*.md"]);
      const parsed = JSON.parse(updated);

      expect(parsed.include).toContain(".mcp.json");
      expect(parsed.include).toContain(".devcontainer/**");
      expect(parsed.include).toContain(".cloud/rules/*.md");
      expect(parsed.include).toHaveLength(3);
    });

    it("trackCommand --list がフラット形式の内容を表示する", async () => {
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

      // エラーなく完了すること（フラット形式を読み取れたことを意味する）
    });
  });

  // ─────────────────────────────────────────────────────────────
  // 3. pull → flat patterns
  // ─────────────────────────────────────────────────────────────

  describe("pull → フラットパターンで正常動作", () => {
    it("ziku.jsonc で読んだ include/exclude で hashFiles を呼ぶ", async () => {
      vol.fromJSON({
        "/project/.ziku/ziku.jsonc": createZikuJsonc(
          [".mcp.json", ".devcontainer/**"],
          ["*.local"],
        ),
        "/project/.ziku/lock.json": JSON.stringify(baseLock),
        "/project/.mcp.json": "{}",
      });

      mockHashFiles.mockResolvedValue({});

      await (pullCommand.run as any)({
        args: { dir: "/project", force: false, continue: false },
        rawArgs: [],
        cmd: pullCommand,
      });

      // hashFiles が include, exclude を正しく受け取っていること
      expect(mockHashFiles).toHaveBeenCalled();
      const hashCall = mockHashFiles.mock.calls[0];
      expect(hashCall[1]).toEqual([".mcp.json", ".devcontainer/**"]); // include
      expect(hashCall[2]).toEqual(["*.local"]); // exclude
    });

    it("フラットパターンのみで pull が完走する（モジュール概念なし）", async () => {
      vol.fromJSON({
        "/project/.ziku/ziku.jsonc": createZikuJsonc([".mcp.json"]),
        "/project/.ziku/lock.json": JSON.stringify(baseLock),
      });

      mockHashFiles.mockResolvedValue({});

      // エラーなく完了すること
      await (pullCommand.run as any)({
        args: { dir: "/project", force: false, continue: false },
        rawArgs: [],
        cmd: pullCommand,
      });
    });
  });

  // ─────────────────────────────────────────────────────────────
  // 4. diff → flat patterns
  // ─────────────────────────────────────────────────────────────

  describe("diff → フラットパターンで正常動作", () => {
    it("loadPatternsFile からフラットパターンを取得して detectDiff に渡す", async () => {
      vol.fromJSON({
        "/project/.ziku/ziku.jsonc": createZikuJsonc([".mcp.json", ".github/**"]),
        "/project/.ziku/lock.json": JSON.stringify(baseLock),
      });

      await (diffCommand.run as any)({
        args: { dir: "/project", verbose: false },
        rawArgs: [],
        cmd: diffCommand,
      });

      // detectDiff が patterns: { include, exclude } で呼ばれたこと
      expect(vi.mocked(detectDiff)).toHaveBeenCalledWith(
        expect.objectContaining({
          patterns: expect.objectContaining({
            include: [".mcp.json", ".github/**"],
            exclude: [],
          }),
        }),
      );
    });
  });

  // ─────────────────────────────────────────────────────────────
  // 5. format round-trip: template → init → local flat → track → pull
  // ─────────────────────────────────────────────────────────────

  describe("format round-trip", () => {
    it("テンプレートのグループ形式 → init でフラット化 → track で追加 → pull で使用", async () => {
      // Step 1: init 実行（テンプレートモジュール → フラット化）
      vol.fromJSON({ "/test": null });

      await (initCommand.run as any)({
        args: { dir: "/test", force: false, yes: true },
        rawArgs: [],
        cmd: initCommand,
      });

      // init が書き出した modules.jsonc の内容を取得
      const modulesCall = mockWriteFileWithStrategy.mock.calls.find(
        (call) => call[0].relativePath === ".ziku/ziku.jsonc",
      );
      expect(modulesCall).toBeDefined();
      const flatContent = modulesCall![0].content;
      const flatParsed = JSON.parse(flatContent);

      // フラット形式であることを確認
      expect(flatParsed).toHaveProperty("include");
      expect(flatParsed).not.toHaveProperty("modules");
      const originalLength = flatParsed.include.length;

      // Step 2: track でパターン追加
      const tracked = addIncludePattern(flatContent, [".cloud/rules/*.md"]);
      const trackedParsed = JSON.parse(tracked);
      expect(trackedParsed.include).toHaveLength(originalLength + 1);
      expect(trackedParsed.include).toContain(".cloud/rules/*.md");

      // フラット形式が維持されていること
      expect(trackedParsed).not.toHaveProperty("modules");

      // Step 3: track 後のファイルを memfs に配置して pull が読める
      vol.fromJSON({
        "/test/.ziku/ziku.jsonc": tracked,
        "/test/.ziku/lock.json": JSON.stringify(baseLock),
      });

      mockHashFiles.mockResolvedValue({});

      await (pullCommand.run as any)({
        args: { dir: "/test", force: false, continue: false },
        rawArgs: [],
        cmd: pullCommand,
      });

      // pull が正しいパターンで hashFiles を呼んだこと
      // pull で呼ばれた hashFiles コール（init の後のコールを取得）
      // mockHashFiles は init でも呼ばれるので、pull で呼ばれたコールを確認
      // pull は 2回 hashFiles を呼ぶ（template, local）ので最後の2コールを確認
      const pullCalls = mockHashFiles.mock.calls.slice(-2);
      expect(pullCalls.length).toBe(2);
      // 両方のコールが .cloud/rules/*.md を含むこと
      for (const call of pullCalls) {
        expect(call[1]).toContain(".cloud/rules/*.md");
      }
    });
  });

  // ─────────────────────────────────────────────────────────────
  // 6. format validation
  // ─────────────────────────────────────────────────────────────

  describe("format validation", () => {
    it("フラット形式ファイルがテンプレート形式と異なる構造であること", () => {
      const flat = createZikuJsonc([".mcp.json"], ["*.local"]);
      const parsed = JSON.parse(flat);

      // ziku.jsonc 形式
      expect(parsed).toHaveProperty("source");
      expect(parsed).toHaveProperty("include");
      expect(parsed).not.toHaveProperty("modules");
      expect(Array.isArray(parsed.include)).toBe(true);

      // テンプレート形式（比較用）
      const templateFormat = {
        modules: [{ name: "Root", description: "Root config", include: [".mcp.json"] }],
      };
      expect(templateFormat).toHaveProperty("modules");
      expect(templateFormat).not.toHaveProperty("include");
    });

    it("flattenModules がモジュール配列をフラット化する", async () => {
      const { flattenModules } = await import("../../modules");
      const modules = [
        { name: "Root", description: "Root config", include: [".mcp.json"] },
        { name: "GitHub", description: "GH", include: [".github/**"], exclude: ["*.local"] },
      ];

      const result = flattenModules(modules);

      expect(result.include).toContain(".mcp.json");
      expect(result.include).toContain(".github/**");
      expect(result.exclude).toContain("*.local");
    });
  });
});
