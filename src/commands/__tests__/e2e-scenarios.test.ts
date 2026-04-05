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

vi.mock("../../utils/github", () => ({
  resolveLatestCommitSha: vi.fn(() => Promise.resolve("abc123")),
  checkRepoExists: vi.fn(() => Promise.resolve(true)),
  checkRepoSetup: vi.fn(() => Promise.resolve(true)),
  getGitHubToken: vi.fn(() => "ghp_test"),
  getAuthenticatedUserLogin: vi.fn(() => Promise.resolve()),
  scaffoldTemplateRepo: vi.fn(() => Promise.resolve({ url: "https://github.com/test/repo" })),
  createPullRequest: vi.fn(() =>
    Promise.resolve({ url: "https://github.com/test/repo/pull/2", number: 2, branch: "sync" }),
  ),
}));

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

const { downloadTemplateToTemp, fetchTemplates, writeFileWithStrategy } =
  await import("../../utils/template");
const { hashFiles } = await import("../../utils/hash");
const { zikuConfigExists: _zikuConfigExists } = await import("../../utils/ziku-config");
const { loadTemplateConfig } = await import("../../utils/template-config");
const { selectDirectories } = await import("../../ui/prompts");
const { log } = await import("../../ui/renderer");
const { detectDiff } = await import("../../utils/diff");
const { checkRepoExists } = await import("../../utils/github");

const mockDownloadTemplateToTemp = vi.mocked(downloadTemplateToTemp);
const mockFetchTemplates = vi.mocked(fetchTemplates);
const mockWriteFileWithStrategy = vi.mocked(writeFileWithStrategy);
const mockHashFiles = vi.mocked(hashFiles);
const mockLoadTemplateConfig = vi.mocked(loadTemplateConfig);
const mockSelectDirectories = vi.mocked(selectDirectories);
const mockLog = vi.mocked(log);
const mockDetectDiff = vi.mocked(detectDiff);
const mockCheckRepoExists = vi.mocked(checkRepoExists);

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
    mockCheckRepoExists.mockResolvedValue(true);
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
});
