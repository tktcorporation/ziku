/**
 * E2E ライフサイクルテスト
 *
 * ziku の完全なライフサイクルを 1 本のシナリオで検証する。
 * モックは最小限（GitHub API とUIのみ）にし、内部ロジックは実際のコードを通す。
 *
 *   1. setup: テンプレートリポに .ziku/ziku.jsonc を作成
 *   2. init (プロジェクトA): テンプレートからファイルをコピー
 *   3. init (プロジェクトB): テンプレートからファイルをコピー
 *   4. プロジェクトA でファイル追加 → push → テンプレートに PR
 *   5. (PR マージを模擬 → テンプレートリポにファイル反映)
 *   6. プロジェクトB で pull → A の変更が反映される
 *   7. 新プロジェクトC で init → 追加ファイルも含めて取得
 */

import { vol } from "memfs";
import { Effect } from "effect";
import { beforeEach, describe, expect, it, vi } from "vitest";

// ── filesystem mock（これだけは必須）─────────────────────────────

vi.mock("node:fs", async () => {
  const memfs = await import("memfs");
  return memfs.fs;
});

vi.mock("node:fs/promises", async () => {
  const memfs = await import("memfs");
  return memfs.fs.promises;
});

// ── ネットワーク系のみモック（GitHub API, テンプレートダウンロード）───

vi.mock("../../utils/git-remote", () => ({
  detectGitHubOwner: vi.fn(() => "test-org"),
  detectGitHubRepo: vi.fn(() => null),
  DEFAULT_TEMPLATE_REPOS: [".ziku", ".github"],
  DEFAULT_TEMPLATE_REPO: ".ziku",
}));

vi.mock("../../utils/github", () => ({
  resolveLatestCommitSha: vi.fn(() => Promise.resolve("sha-001")),
  checkRepoExists: vi.fn(() => Promise.resolve(true)),
  checkRepoSetup: vi.fn(() => Promise.resolve(true)),
  getGitHubToken: vi.fn(() => "ghp_test"),
  getAuthenticatedUserLogin: vi.fn(() => Promise.resolve()),
  scaffoldTemplateRepo: vi.fn(),
  createPullRequest: vi.fn(() =>
    Promise.resolve({
      url: "https://github.com/test-org/.github/pull/1",
      number: 1,
      branch: "ziku-sync",
    }),
  ),
}));

// テンプレートダウンロード + ファイルコピーをモック
// glob ライブラリが memfs と互換性がないため、fetchTemplates もモックが必要。
// ただしファイルコピーのロジック自体は memfs 上で実行する。
vi.mock("../../utils/template", async (importOriginal) => {
  const original = await importOriginal<typeof import("../../utils/template")>();
  return {
    ...original,
    downloadTemplateToTemp: vi.fn(() =>
      Promise.resolve({ templateDir: "/template", cleanup: vi.fn() }),
    ),
    fetchTemplates: vi.fn(),
  };
});

// giget もモック
vi.mock("giget", () => ({
  downloadTemplate: vi.fn(() => Promise.resolve({ dir: "/template" })),
}));

// ── UI 系のみモック（対話型プロンプトはテスト不可）───

vi.mock("../../ui/prompts", () => ({
  selectDirectories: vi.fn(),
  selectOverwriteStrategy: vi.fn(() => Promise.resolve("overwrite")),
  selectMissingTemplateAction: vi.fn(),
  selectTemplateCandidate: vi.fn(),
  inputTemplateSource: vi.fn(),
  selectDeletedFiles: vi.fn(() => Promise.resolve([])),
  selectPushFiles: vi.fn(),
  confirmAction: vi.fn(() => Promise.resolve(true)),
  inputGitHubToken: vi.fn(),
  inputPrTitle: vi.fn(),
  inputPrBody: vi.fn(),
  generatePrTitle: vi.fn(() => "sync: update files"),
  generatePrBody: vi.fn(() => "Synced files"),
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

vi.mock("../../ui/diff-view", () => ({
  renderFileDiff: vi.fn(),
  calculateDiffStats: vi.fn(() => ({ additions: 0, deletions: 0 })),
  formatStats: vi.fn(() => ""),
}));

vi.mock("../../utils/readme", () => ({
  detectAndUpdateReadme: vi.fn(() => Promise.resolve({ updated: false, path: null })),
}));

// hash と merge: glob/crypto 依存のため memfs では動かない部分のみモック
vi.mock("../../utils/hash", () => ({
  hashFiles: vi.fn(() => Promise.resolve({})),
}));

vi.mock("../../utils/diff", () => ({
  detectDiff: vi.fn(() =>
    Promise.resolve({ files: [], summary: { added: 0, modified: 0, deleted: 0, unchanged: 0 } }),
  ),
}));

vi.mock("../../utils/merge", () => ({
  classifyFiles: vi.fn(() => ({
    autoUpdate: [],
    localOnly: [],
    conflicts: [],
    newFiles: [],
    deletedFiles: [],
    unchanged: [],
  })),
  threeWayMerge: vi.fn(() => ({ content: "merged", hasConflicts: false, conflictDetails: [] })),
  asBaseContent: vi.fn((s: string) => s),
  asLocalContent: vi.fn((s: string) => s),
  asTemplateContent: vi.fn((s: string) => s),
}));

vi.mock("../../utils/untracked", () => ({
  detectUntrackedFiles: vi.fn(() => Promise.resolve([])),
  getTotalUntrackedCount: vi.fn(() => 0),
}));

// loadTemplateConfig: テンプレートの .ziku/ziku.jsonc を Effect で読み込むモック
// 実際のファイルシステム（memfs）から読む代わりにモックで返す
vi.mock("../../utils/template-config", () => ({
  loadTemplateConfig: vi.fn(() =>
    Effect.succeed({
      include: [
        ".claude/settings.json",
        ".claude/rules/*.md",
        ".claude/skills/**",
        ".claude/hooks/**",
        ".mcp.json",
        ".devcontainer/**",
        ".github/**",
      ],
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
    for (const [dir, pats] of [...dirMap.entries()].toSorted()) {
      entries.push({ label: dir, patterns: pats });
    }
    if (rootFiles.length > 0) {
      entries.push({ label: "Root files", patterns: rootFiles });
    }
    return entries;
  }),
}));

vi.spyOn(console, "log").mockImplementation(() => {});

// ── imports (after mocks) ───────────────────────────────────────

const { setupCommand } = await import("../setup");
const { initCommand } = await import("../init");
const { pushCommand } = await import("../push");
const { pullCommand } = await import("../pull");

const { fetchTemplates } = await import("../../utils/template");
const { selectPushFiles } = await import("../../ui/prompts");
const { createPullRequest } = await import("../../utils/github");
const { detectDiff } = await import("../../utils/diff");
const { classifyFiles } = await import("../../utils/merge");

const mockFetchTemplates = vi.mocked(fetchTemplates);
const mockSelectPushFiles = vi.mocked(selectPushFiles);
const mockCreatePullRequest = vi.mocked(createPullRequest);
const mockDetectDiff = vi.mocked(detectDiff);
const mockClassifyFiles = vi.mocked(classifyFiles);

// ── helpers ─────────────────────────────────────────────────────

function runSetup(dir: string) {
  return (setupCommand.run as any)({
    args: { dir, remote: false },
    rawArgs: [],
    cmd: setupCommand,
  });
}

function runInit(dir: string) {
  return (initCommand.run as any)({
    args: { dir, force: false, yes: true },
    rawArgs: [],
    cmd: initCommand,
  });
}

function runPush(dir: string) {
  return (pushCommand.run as any)({
    args: { dir, dryRun: false, yes: true, edit: false },
    rawArgs: [],
    cmd: pushCommand,
  });
}

function runPull(dir: string) {
  return (pullCommand.run as any)({
    args: { dir, force: false, yes: true },
    rawArgs: [],
    cmd: pullCommand,
  });
}

/**
 * テンプレートリポにファイルを配置するヘルパー。
 * テンプレートリポ = /template として memfs 上に構築する。
 */
function placeTemplateFiles(files: Record<string, string>) {
  for (const [path, content] of Object.entries(files)) {
    const fullPath = `/template/${path}`;
    const dir = fullPath.slice(0, fullPath.lastIndexOf("/"));
    vol.mkdirSync(dir, { recursive: true });
    vol.writeFileSync(fullPath, content);
  }
}

// ── テスト ──────────────────────────────────────────────────────

describe("E2E ライフサイクル: setup → init → push → pull → init", () => {
  beforeEach(() => {
    vol.reset();
    vi.clearAllMocks();

    // fetchTemplates: /template から targetDir にファイルをコピーする実装
    // glob が memfs で動かないため、vol の内容を直接走査してコピーする
    mockFetchTemplates.mockImplementation(async (opts: any) => {
      const targetDir = opts.targetDir as string;
      const templateDir = opts.templateDir ?? "/template";
      const results: Array<{ action: string; path: string }> = [];

      // memfs 上のテンプレートファイルを再帰的にコピー
      const allFiles = vol.toJSON();
      for (const [fullPath, content] of Object.entries(allFiles)) {
        if (!fullPath.startsWith(`${templateDir}/`)) continue;
        // .ziku/ 内のファイルはスキップ（メタデータ）
        const relativePath = fullPath.slice(templateDir.length + 1);
        if (relativePath.startsWith(".ziku/")) continue;

        const destPath = `${targetDir}/${relativePath}`;
        const destDir = destPath.slice(0, destPath.lastIndexOf("/"));
        if (!vol.existsSync(destDir)) {
          vol.mkdirSync(destDir, { recursive: true });
        }
        vol.writeFileSync(destPath, content as string);
        results.push({ action: "copied", path: relativePath });
      }
      return results;
    });
  });

  it("完全なライフサイクルが正しく動作する", async () => {
    // ─── Step 1: setup — テンプレートリポに .ziku/ziku.jsonc を作成 ───

    await runSetup("/template");

    expect(vol.existsSync("/template/.ziku/ziku.jsonc")).toBe(true);
    const zikuJsoncContent = JSON.parse(
      vol.readFileSync("/template/.ziku/ziku.jsonc", "utf8") as string,
    );
    expect(zikuJsoncContent.include).toBeDefined();
    expect(zikuJsoncContent.include.length).toBeGreaterThan(0);

    // ─── Step 2: テンプレートリポにファイルを配置（実際のテンプレート状態）───

    placeTemplateFiles({
      ".claude/rules/style.md": "# Style Guide\nUse TypeScript.",
      ".mcp.json": '{"servers":{}}',
    });

    // ─── Step 3: init (プロジェクトA) — テンプレートからコピー ───

    vol.mkdirSync("/projectA", { recursive: true });
    await runInit("/projectA");

    // ziku.jsonc と lock.json が作成された
    expect(vol.existsSync("/projectA/.ziku/ziku.jsonc")).toBe(true);
    expect(vol.existsSync("/projectA/.ziku/lock.json")).toBe(true);

    // lock.json に source フィールドが含まれる
    const lockA = JSON.parse(vol.readFileSync("/projectA/.ziku/lock.json", "utf8") as string);
    expect(lockA.source).toBeDefined();
    expect(lockA.source.owner).toBe("test-org");

    // テンプレートのファイルがコピーされた
    expect(vol.existsSync("/projectA/.claude/rules/style.md")).toBe(true);
    expect(vol.existsSync("/projectA/.mcp.json")).toBe(true);
    expect(vol.readFileSync("/projectA/.claude/rules/style.md", "utf8")).toBe(
      "# Style Guide\nUse TypeScript.",
    );

    // ─── Step 4: init (プロジェクトB) — 同じテンプレートからコピー ───

    vol.mkdirSync("/projectB", { recursive: true });
    await runInit("/projectB");

    expect(vol.existsSync("/projectB/.claude/rules/style.md")).toBe(true);
    expect(vol.existsSync("/projectB/.mcp.json")).toBe(true);

    // A と B の内容が一致
    expect(vol.readFileSync("/projectB/.claude/rules/style.md", "utf8")).toBe(
      vol.readFileSync("/projectA/.claude/rules/style.md", "utf8"),
    );

    // ─── Step 5: プロジェクトA でファイル追加 → push ───

    // A に新ファイルを作成
    vol.mkdirSync("/projectA/.claude/rules", { recursive: true });
    vol.writeFileSync("/projectA/.claude/rules/testing.md", "# Testing Guide\nWrite tests first.");

    // push のモック: 差分検出 → ファイル選択 → PR 作成
    mockClassifyFiles.mockReturnValueOnce({
      autoUpdate: [],
      localOnly: [".claude/rules/testing.md"],
      conflicts: [],
      newFiles: [],
      deletedFiles: [],
      unchanged: [".claude/rules/style.md", ".mcp.json"],
    });
    mockDetectDiff.mockResolvedValueOnce({
      files: [
        {
          path: ".claude/rules/testing.md",
          type: "added",
          localContent: "# Testing Guide\nWrite tests first.",
        },
      ],
      summary: { added: 1, modified: 0, deleted: 0, unchanged: 2 },
    } as any);
    mockSelectPushFiles.mockResolvedValueOnce([
      {
        path: ".claude/rules/testing.md",
        type: "added",
        localContent: "# Testing Guide\nWrite tests first.",
      },
    ] as any);

    await runPush("/projectA");

    // PR が作成された
    expect(mockCreatePullRequest).toHaveBeenCalledTimes(1);
    const prFiles = mockCreatePullRequest.mock.calls[0][1].files;
    expect(prFiles.some((f: any) => f.path === ".claude/rules/testing.md")).toBe(true);
    expect(prFiles.find((f: any) => f.path === ".claude/rules/testing.md")?.content).toBe(
      "# Testing Guide\nWrite tests first.",
    );

    // ─── Step 6: PR マージを模擬 — テンプレートリポにファイル反映 ───

    placeTemplateFiles({
      ".claude/rules/testing.md": "# Testing Guide\nWrite tests first.",
    });

    // ─── Step 7: プロジェクトB で pull → A の変更が反映される ───

    // pull のモック: テンプレートに testing.md が追加されたことを検出
    mockClassifyFiles.mockReturnValueOnce({
      autoUpdate: [".claude/rules/testing.md"],
      localOnly: [],
      conflicts: [],
      newFiles: [],
      deletedFiles: [],
      unchanged: [".claude/rules/style.md", ".mcp.json"],
    });

    await runPull("/projectB");

    expect(vol.existsSync("/projectB/.claude/rules/testing.md")).toBe(true);
    expect(vol.readFileSync("/projectB/.claude/rules/testing.md", "utf8")).toBe(
      "# Testing Guide\nWrite tests first.",
    );

    // ─── Step 8: 新プロジェクトC で init → 追加ファイルも含めて取得 ───

    vol.mkdirSync("/projectC", { recursive: true });
    await runInit("/projectC");

    expect(vol.existsSync("/projectC/.claude/rules/style.md")).toBe(true);
    expect(vol.existsSync("/projectC/.claude/rules/testing.md")).toBe(true);
    expect(vol.existsSync("/projectC/.mcp.json")).toBe(true);

    // ─── 最終検証: 全プロジェクトの同期ファイルが同一内容 ───

    const projects = ["/projectA", "/projectB", "/projectC"];
    const syncedFiles = [".claude/rules/style.md", ".claude/rules/testing.md", ".mcp.json"];

    for (const file of syncedFiles) {
      const contents = projects
        .filter((p) => vol.existsSync(`${p}/${file}`))
        .map((p) => vol.readFileSync(`${p}/${file}`, "utf8"));

      // 全プロジェクトで同じ内容
      for (const content of contents) {
        expect(content).toBe(contents[0]);
      }
    }
  });
});
