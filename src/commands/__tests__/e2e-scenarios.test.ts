/**
 * E2E テスト: 様々なシナリオでのコマンド動作を検証
 *
 * 既存の e2e-flat-format.test.ts はフォーマット変換の正確性に焦点。
 * このファイルはユーザーが実際に遭遇するシナリオ全体をカバーする:
 *   - init: テンプレート、--from、--overwrite-strategy、エラーケース
 *   - diff: config 不在、verbose、untracked 検出
 *   - track: パターン追加の完全フロー、エラーケース
 *   - push/pull: config 不在エラー
 *   - cross-command: init → track → diff の一連のフロー
 */

import { vol } from "memfs";
import { Effect } from "effect";
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

// ── external dependency mocks ─────────���─────────────────────────

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

vi.mock("../../utils/github", async () => {
  const actual = await vi.importActual<typeof import("../../utils/github")>("../../utils/github");
  return {
    resolveLatestCommitSha: vi.fn(() => Promise.resolve("abc123")),
    checkRepoExists: vi.fn(() => Promise.resolve({ _tag: "Exists" as const })),
    checkRepoSetup: vi.fn(() => Promise.resolve(true)),
    getGitHubToken: vi.fn(() => "ghp_test"),
    getAuthenticatedUserLogin: vi.fn(() => Promise.resolve()),
    scaffoldTemplateRepo: vi.fn(() => Promise.resolve({ url: "https://github.com/test/repo" })),
    createPullRequest: vi.fn(() =>
      Promise.resolve({ url: "https://github.com/test/repo/pull/2", number: 2, branch: "sync" }),
    ),
    rateLimitedError: actual.rateLimitedError,
  };
});

vi.mock("../../ui/prompts", () => ({
  selectDirectories: vi.fn(),
  selectOverwriteStrategy: vi.fn(() => Promise.resolve("overwrite")),
  selectMissingTemplateAction: vi.fn(),
  selectTemplateCandidate: vi.fn(() => Promise.resolve({ owner: "test-org", repo: ".github" })),
  inputTemplateSource: vi.fn(),
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

// init 用: テンプレートの ziku.jsonc 読み込みモック
vi.mock("../../utils/template-config", () => ({
  loadTemplateConfig: vi.fn(() =>
    Effect.succeed({
      include: [".mcp.json", ".devcontainer/**"],
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

vi.mock("../../utils/merge", () => ({
  classifyFiles: vi.fn(() => ({
    autoUpdate: [],
    localOnly: [],
    conflicts: [],
    newFiles: [],
    deletedFiles: [],
    deletedLocally: [],
    unchanged: [],
  })),
  threeWayMerge: vi.fn(() => ({ content: "merged", hasConflicts: false })),
  asBaseContent: vi.fn((s: string) => s),
  asLocalContent: vi.fn((s: string) => s),
  asTemplateContent: vi.fn((s: string) => s),
  hasConflictMarkers: vi.fn(() => ({ found: false })),
}));

vi.mock("../../utils/untracked", () => ({
  detectUntrackedFiles: vi.fn(() => Promise.resolve([])),
  getTotalUntrackedCount: vi.fn(() => 0),
}));

vi.spyOn(console, "log").mockImplementation(() => {});

// ��─ imports (after mocks) ────────────��──────────────────────────

const { initCommand } = await import("../init");
const { trackCommand } = await import("../track");
const { diffCommand } = await import("../diff");
const { pullCommand } = await import("../pull");
const { pushCommand } = await import("../push");

const { downloadTemplateToTemp, fetchTemplates, writeFileWithStrategy } =
  await import("../../utils/template");
const { hashFiles } = await import("../../utils/hash");
const { zikuConfigExists: _zikuConfigExists } = await import("../../utils/ziku-config");
const { loadTemplateConfig } = await import("../../utils/template-config");
const { selectDirectories, selectDeletedFiles, selectPushFiles } = await import("../../ui/prompts");
const { log } = await import("../../ui/renderer");
const { detectDiff } = await import("../../utils/diff");
const { checkRepoExists, createPullRequest } = await import("../../utils/github");
const { classifyFiles } = await import("../../utils/merge");

const mockDownloadTemplateToTemp = vi.mocked(downloadTemplateToTemp);
const mockFetchTemplates = vi.mocked(fetchTemplates);
const mockWriteFileWithStrategy = vi.mocked(writeFileWithStrategy);
const mockHashFiles = vi.mocked(hashFiles);
const mockLoadTemplateConfig = vi.mocked(loadTemplateConfig);
const mockSelectDirectories = vi.mocked(selectDirectories);
const mockSelectDeletedFiles = vi.mocked(selectDeletedFiles);
const mockSelectPushFiles = vi.mocked(selectPushFiles);
const mockLog = vi.mocked(log);
const mockDetectDiff = vi.mocked(detectDiff);
const mockCheckRepoExists = vi.mocked(checkRepoExists);
const mockCreatePullRequest = vi.mocked(createPullRequest);
const mockClassifyFiles = vi.mocked(classifyFiles);

// ── helpers ─────��───────────────────────────────────────────────

const DEFAULT_SOURCE = { owner: "test-org", repo: ".github" };

function createZikuJsonc(include: string[], exclude?: string[]): string {
  const content: Record<string, unknown> = { include };
  if (exclude && exclude.length > 0) content.exclude = exclude;
  return JSON.stringify(content, null, 2);
}

function _createLockJson(source = DEFAULT_SOURCE): string {
  return JSON.stringify(
    {
      version: "0.1.0",
      installedAt: "2024-01-01T00:00:00.000Z",
      source,
      baseHashes: {},
    },
    null,
    2,
  );
}

const baseLock = {
  version: "0.1.0",
  installedAt: "2024-01-01T00:00:00.000Z",
  source: DEFAULT_SOURCE,
  baseHashes: {},
};

// ═══════════════════════════════════════════════════════════════
// E2E Scenarios
// ═══════════��═══════════════���══════════════════════════��════════

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
    mockCheckRepoExists.mockResolvedValue({ _tag: "Exists" });
    mockLoadTemplateConfig.mockReturnValue(
      Effect.succeed({
        include: [".mcp.json", ".devcontainer/**"],
        exclude: [],
      }),
    );
  });

  // ─────────��──────────────────────────��────────────────────────
  // Scenario 1: テンプレートでの init
  // ─────────────────���───────────────────────────────────────────

  describe("init: --yes で全ディレクトリ選択", () => {
    beforeEach(() => {
      mockLoadTemplateConfig.mockReturnValue(
        Effect.succeed({
          include: [".mcp.json", ".devcontainer/**", ".github/**"],
          exclude: ["*.local"],
        }),
      );
    });

    it("--yes で全ディレクトリのパターンがフラット化されて適用される", async () => {
      vol.fromJSON({
        "/test": null,
      });

      await (initCommand.run as any)({
        args: { dir: "/test", force: false, yes: true },
        rawArgs: [],
        cmd: initCommand,
      });

      // --yes なので selectDirectories は呼ばれない（全ディレクトリ自動選択）
      expect(mockSelectDirectories).not.toHaveBeenCalled();

      // fetchTemplates に全ディレクトリのフラット化パタ���ンが渡される
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

  // ─────────────────────────────────────��───────────────────────
  // Scenario 2: テンプレートでの init + --dirs
  // ───────────────────────��─────────────────────────────────────

  describe("init: テンプレート + --dirs フラグ", () => {
    beforeEach(() => {
      mockLoadTemplateConfig.mockReturnValue(
        Effect.succeed({
          include: [".mcp.json", ".devcontainer/**", ".github/**"],
          exclude: [],
        }),
      );
    });

    it("--dirs で特定ディレクトリだけ選択", async () => {
      vol.fromJSON({ "/test": null });

      await (initCommand.run as any)({
        args: { dir: "/test", force: false, yes: false, dirs: "Root files,.github" },
        rawArgs: [],
        cmd: initCommand,
      });

      // selectDirectories は呼ばれない（--dirs で非インタラクティブ）
      expect(mockSelectDirectories).not.toHaveBeenCalled();

      // Root files と .github のパターンだけ含まれる
      expect(mockFetchTemplates).toHaveBeenCalledWith(
        expect.objectContaining({
          patterns: expect.objectContaining({
            include: expect.arrayContaining([".mcp.json", ".github/**"]),
          }),
        }),
      );

      // .devcontainer は含まれない
      const patterns = mockFetchTemplates.mock.calls[0][0].patterns;
      expect(patterns.include).not.toContain(".devcontainer/**");
    });

    it("--dirs に存在しないディレクトリ名 → ZikuError", async () => {
      vol.fromJSON({ "/test": null });

      await expect(
        (initCommand.run as any)({
          args: { dir: "/test", force: false, yes: false, dirs: "NonExistent" },
          rawArgs: [],
          cmd: initCommand,
        }),
      ).rejects.toThrow(ZikuError);
    });
  });

  // ─────────���────────────────────��──────────────────────────────
  // Scenario 3: --from でカスタムテンプレートソース指定
  // ────���──────────���─────────────────────────────���───────────────

  describe("init: --from オプション", () => {
    beforeEach(() => {
      mockLoadTemplateConfig.mockReturnValue(
        Effect.succeed({
          include: [".editorconfig"],
          exclude: [],
        }),
      );
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
      mockCheckRepoExists.mockResolvedValueOnce({ _tag: "NotFound" });
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

  // ────���────────────────────────────────────────���───────────────
  // Scenario 4: --overwrite-strategy
  // ──────────���──────────────────────────────────────────────────

  describe("init: --overwrite-strategy", () => {
    beforeEach(() => {
      mockLoadTemplateConfig.mockReturnValue(
        Effect.succeed({
          include: [".mcp.json"],
          exclude: [],
        }),
      );
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

  // ─��───────────────────────────────────────────────────────────
  // Scenario 5: diff コマンドのエラーケース
  // ─────────────────────────────────────────────────��───────────

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

  // ─��──────────────────────────────────────────��────────────────
  // Scenario 6: track コマンドの完全フ��ー
  // ─────────────��───────────────────────────────────────────────

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

    it("パターン引数な�� → ZikuError", async () => {
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

  // ──────��─────────────────���───────────────────────────────��────
  // Scenario 7: pull コマンドのエラーケース
  // ──────────��────────────────────��─────────────────────────────

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

  // ──��───────��────────────────────────────────────���─────────────
  // Scenario 8: init → track → diff の一連のフロー
  // ────────────���──────────────────────────────────���─────────────

  describe("cross-command: init → track → diff", () => {
    it("init でセットアップ → track でパターン追加 → diff が新しいパターンで動作", async () => {
      // Step 1: init
      mockLoadTemplateConfig.mockReturnValue(
        Effect.succeed({
          include: [".mcp.json"],
          exclude: [],
        }),
      );
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
        "/project/.ziku/lock.json": JSON.stringify(baseLock),
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

  // ────────��─────────────────────���──────────────────────────���───
  // Scenario 9: init 時に変更がない場合の挙動
  // ───────────��─────────────────────────────────────────────────

  describe("init: 変更がない場合", () => {
    it("全ファイルが skipped → 'No changes were made' メッセージ", async () => {
      mockLoadTemplateConfig.mockReturnValue(
        Effect.succeed({
          include: [".mcp.json"],
          exclude: [],
        }),
      );
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

  // ─────────────���──────────────────────────────��────────────────
  // Scenario 10: パターンが空の場合
  // ─────────���───────────────────────────────────────────────────

  describe("init: テンプレートに include パターンがない場合", () => {
    it("include が空 → 'No patterns to apply' 警告", async () => {
      mockLoadTemplateConfig.mockReturnValue(
        Effect.succeed({
          include: [],
          exclude: [],
        }),
      );
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

  // ─────────────────────────────────────────────────────────────
  // Scenario 11: ファイル削除の push → pull 同期（モック版）
  //
  // classifyFiles をモックして削除フローを検証:
  //   1. push でファイルをテンプレートに追加
  //   2. テンプレートからファイルを削除
  //   3. pull で --force 削除が同期される
  //   4. pull で selectDeletedFiles による選択的削除
  //   5. baseHashes の更新を確認
  // ─────────────────────────────────────────────────────────────

  describe("ファイル削除の push → pull 同期（モック版）", () => {
    const localSource = { path: "/template" };
    const localLock = {
      version: "0.1.0",
      installedAt: "2024-01-01T00:00:00.000Z",
      source: localSource,
      baseHashes: {
        ".mcp.json": "hash-mcp",
        ".claude/rules/style.md": "hash-style",
      },
    };

    /**
     * テンプレートとプロジェクトの初期状態を構築するヘルパー。
     * init 相当の状態を memfs 上に直接構築する（init コマンドの再テストを避ける）。
     */
    function setupInitialState() {
      vol.fromJSON({
        // テンプレート側
        "/template/.ziku/ziku.jsonc": createZikuJsonc([".mcp.json", ".claude/rules/*.md"]),
        "/template/.mcp.json": '{"servers":{}}',
        "/template/.claude/rules/style.md": "# Style Guide",

        // プロジェクト側（init 済み）
        "/project/.ziku/ziku.jsonc": createZikuJsonc([".mcp.json", ".claude/rules/*.md"]),
        "/project/.ziku/lock.json": JSON.stringify(localLock, null, 2),
        "/project/.mcp.json": '{"servers":{}}',
        "/project/.claude/rules/style.md": "# Style Guide",
      });

      // downloadTemplateToTemp がローカルテンプレートを返す
      mockDownloadTemplateToTemp.mockResolvedValue({
        templateDir: "/template",
        cleanup: vi.fn(),
      });
    }

    it("push で追加したファイルがテンプレート削除後の pull で同期削除される", async () => {
      setupInitialState();

      // ── Step 1: push — 新ファイルをテンプレートに追加 ──

      vol.mkdirSync("/project/.claude/rules", { recursive: true });
      vol.writeFileSync("/project/.claude/rules/testing.md", "# Testing Guide");

      mockClassifyFiles.mockReturnValueOnce({
        autoUpdate: [],
        localOnly: [".claude/rules/testing.md"],
        conflicts: [],
        newFiles: [],
        deletedFiles: [],
        deletedLocally: [],
        unchanged: [".mcp.json", ".claude/rules/style.md"],
      });
      mockDetectDiff.mockResolvedValueOnce({
        files: [
          {
            path: ".claude/rules/testing.md",
            type: "added",
            localContent: "# Testing Guide",
          },
        ],
        summary: { added: 1, modified: 0, deleted: 0, unchanged: 2 },
      } as any);
      mockSelectPushFiles.mockResolvedValueOnce([
        {
          path: ".claude/rules/testing.md",
          type: "added",
          localContent: "# Testing Guide",
        },
      ] as any);
      // push 後の baseHashes 更新用
      mockHashFiles.mockResolvedValueOnce({
        ".mcp.json": "hash-mcp",
        ".claude/rules/style.md": "hash-style",
        ".claude/rules/testing.md": "hash-testing",
      });

      await (pushCommand.run as any)({
        args: { dir: "/project", dryRun: false, yes: true, edit: false },
        rawArgs: [],
        cmd: pushCommand,
      });

      // テンプレートにファイルがコピーされた
      expect(vol.existsSync("/template/.claude/rules/testing.md")).toBe(true);
      // PR は作成されない（ローカルソース）
      expect(mockCreatePullRequest).not.toHaveBeenCalled();

      // ── Step 2: テンプレートからファイルを削除 ──

      vol.unlinkSync("/template/.claude/rules/testing.md");

      // ── Step 3: pull — 削除が --force で同期される ──

      // テンプレート側（testing.md なし）、ローカル側（testing.md あり）
      mockHashFiles
        .mockResolvedValueOnce({
          ".mcp.json": "hash-mcp",
          ".claude/rules/style.md": "hash-style",
        })
        .mockResolvedValueOnce({
          ".mcp.json": "hash-mcp",
          ".claude/rules/style.md": "hash-style",
          ".claude/rules/testing.md": "hash-testing",
        });

      mockClassifyFiles.mockReturnValueOnce({
        autoUpdate: [],
        localOnly: [],
        conflicts: [],
        newFiles: [],
        deletedFiles: [".claude/rules/testing.md"],
        deletedLocally: [],
        unchanged: [".mcp.json", ".claude/rules/style.md"],
      });

      // push で更新された lock を反映
      const updatedLock = JSON.parse(
        vol.readFileSync("/project/.ziku/lock.json", "utf8") as string,
      );
      updatedLock.baseHashes = {
        ".mcp.json": "hash-mcp",
        ".claude/rules/style.md": "hash-style",
        ".claude/rules/testing.md": "hash-testing",
      };
      vol.writeFileSync("/project/.ziku/lock.json", JSON.stringify(updatedLock, null, 2));

      await (pullCommand.run as any)({
        args: { dir: "/project", force: true, continue: false },
        rawArgs: [],
        cmd: pullCommand,
      });

      // --force なので selectDeletedFiles は呼ばれない
      expect(mockSelectDeletedFiles).not.toHaveBeenCalled();
      // ファイルがローカルから削除された
      expect(vol.existsSync("/project/.claude/rules/testing.md")).toBe(false);
      // 他のファイルはそのまま
      expect(vol.existsSync("/project/.mcp.json")).toBe(true);
      expect(vol.existsSync("/project/.claude/rules/style.md")).toBe(true);

      // baseHashes から testing.md が消えている
      const finalLock = JSON.parse(vol.readFileSync("/project/.ziku/lock.json", "utf8") as string);
      expect(finalLock.baseHashes).not.toHaveProperty(".claude/rules/testing.md");
      expect(finalLock.baseHashes).toHaveProperty(".mcp.json");
      expect(finalLock.baseHashes).toHaveProperty(".claude/rules/style.md");
    });

    it("pull で selectDeletedFiles を通じてユーザーが選択的に削除できる", async () => {
      setupInitialState();

      // 複数ファイルが削除対象
      vol.writeFileSync("/project/.claude/rules/deprecated-a.md", "old content A");
      vol.writeFileSync("/project/.claude/rules/deprecated-b.md", "old content B");

      const lockWithExtra = {
        ...localLock,
        baseHashes: {
          ...localLock.baseHashes,
          ".claude/rules/deprecated-a.md": "hash-dep-a",
          ".claude/rules/deprecated-b.md": "hash-dep-b",
        },
      };
      vol.writeFileSync("/project/.ziku/lock.json", JSON.stringify(lockWithExtra, null, 2));

      // テンプレート側（deprecated ファイルなし）、ローカル側（deprecated ファイルあり）
      mockHashFiles
        .mockResolvedValueOnce({
          ".mcp.json": "hash-mcp",
          ".claude/rules/style.md": "hash-style",
        })
        .mockResolvedValueOnce({
          ".mcp.json": "hash-mcp",
          ".claude/rules/style.md": "hash-style",
          ".claude/rules/deprecated-a.md": "hash-dep-a",
          ".claude/rules/deprecated-b.md": "hash-dep-b",
        });

      mockClassifyFiles.mockReturnValueOnce({
        autoUpdate: [],
        localOnly: [],
        conflicts: [],
        newFiles: [],
        deletedFiles: [".claude/rules/deprecated-a.md", ".claude/rules/deprecated-b.md"],
        deletedLocally: [],
        unchanged: [".mcp.json", ".claude/rules/style.md"],
      });

      // ユーザーが deprecated-a.md のみ削除を選択
      mockSelectDeletedFiles.mockResolvedValueOnce([".claude/rules/deprecated-a.md"]);

      await (pullCommand.run as any)({
        args: { dir: "/project", force: false, continue: false },
        rawArgs: [],
        cmd: pullCommand,
      });

      expect(mockSelectDeletedFiles).toHaveBeenCalledWith([
        ".claude/rules/deprecated-a.md",
        ".claude/rules/deprecated-b.md",
      ]);

      // 選択した deprecated-a.md のみ削除された
      expect(vol.existsSync("/project/.claude/rules/deprecated-a.md")).toBe(false);
      // 選択しなかった deprecated-b.md は残っている
      expect(vol.existsSync("/project/.claude/rules/deprecated-b.md")).toBe(true);
    });

    it("GitHub テンプレートでの pull 時にファイル削除と baseHashes 更新が行われる", async () => {
      const ghLock = {
        version: "0.1.0",
        installedAt: "2024-01-01T00:00:00.000Z",
        source: DEFAULT_SOURCE,
        baseRef: "abc123",
        baseHashes: {
          ".mcp.json": "hash-mcp",
          ".claude/rules/style.md": "hash-style",
          "config/old.json": "hash-old",
        },
      };

      vol.fromJSON({
        "/project/.ziku/ziku.jsonc": createZikuJsonc([
          ".mcp.json",
          ".claude/rules/*.md",
          "config/**",
        ]),
        "/project/.ziku/lock.json": JSON.stringify(ghLock, null, 2),
        "/project/.mcp.json": '{"servers":{}}',
        "/project/.claude/rules/style.md": "# Style Guide",
        "/project/config/old.json": '{"deprecated": true}',
        // テンプレート（config/old.json が削除済み）
        "/tmp/template/.mcp.json": '{"servers":{}}',
        "/tmp/template/.claude/rules/style.md": "# Style Guide",
      });

      mockHashFiles
        .mockResolvedValueOnce({
          ".mcp.json": "hash-mcp",
          ".claude/rules/style.md": "hash-style",
        })
        .mockResolvedValueOnce({
          ".mcp.json": "hash-mcp",
          ".claude/rules/style.md": "hash-style",
          "config/old.json": "hash-old",
        });

      mockClassifyFiles.mockReturnValueOnce({
        autoUpdate: [],
        localOnly: [],
        conflicts: [],
        newFiles: [],
        deletedFiles: ["config/old.json"],
        deletedLocally: [],
        unchanged: [".mcp.json", ".claude/rules/style.md"],
      });

      await (pullCommand.run as any)({
        args: { dir: "/project", force: true, continue: false },
        rawArgs: [],
        cmd: pullCommand,
      });

      // ファイルが削除された
      expect(vol.existsSync("/project/config/old.json")).toBe(false);

      // lock.json の baseHashes が更新された
      const finalLock = JSON.parse(vol.readFileSync("/project/.ziku/lock.json", "utf8") as string);
      expect(finalLock.baseHashes).not.toHaveProperty("config/old.json");
      expect(finalLock.baseHashes).toHaveProperty(".mcp.json");
      expect(finalLock.baseRef).toBe("abc123");
    });
  });
});
