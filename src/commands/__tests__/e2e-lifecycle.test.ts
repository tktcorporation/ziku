/**
 * E2E ライフサイクルテスト
 *
 * ziku の完全なライフサイクルを 1 本のシナリオで検証する。
 * --from-dir を使うことで init のテンプレートダウンロードモックが不要になり、
 * 実際のファイルコピーロジックを通す。
 *
 *   1. setup: テンプレートリポに modules.jsonc を作成
 *   2. init --from-dir (プロジェクトA): テンプレートからファイルをコピー
 *   3. init --from-dir (プロジェクトB): テンプレートからファイルをコピー
 *   4. プロジェクトA でファイル追加 → push → テンプレートに PR
 *   5. (PR マージを模擬 → テンプレートリポにファイル反映)
 *   6. プロジェクトB で pull → A の変更が反映される
 *   7. 新プロジェクトC で init → 追加ファイルも含めて取得
 *
 * モック方針:
 *   - memfs: ファイルシステム（必須）
 *   - GitHub API: ネットワーク不要（createPullRequest 等）
 *   - UI: 対話不要（selectModules, selectPushFiles 等）
 *   - glob: tinyglobby が memfs と非互換のため fetchTemplates はモック
 *   - hash/diff/merge: crypto/glob 依存のため push/pull 時はモック
 *   - init --from-dir: ダウンロード不要、fetchTemplates でファイルコピー
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

// ── GitHub API モック（ネットワーク不要化）───────────────────────

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
  createDevenvScaffoldPR: vi.fn(),
  createPullRequest: vi.fn(() =>
    Promise.resolve({
      url: "https://github.com/test-org/.github/pull/1",
      number: 1,
      branch: "ziku-sync",
    }),
  ),
}));

// ── glob/hash 非互換のモック ────────────────────────────────────

// fetchTemplates: glob が memfs と非互換のため、vol を直接走査してコピー
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

vi.mock("giget", () => ({
  downloadTemplate: vi.fn(() => Promise.resolve({ dir: "/template" })),
}));

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

// ── UI モック（対話不要化）───────────────────────────────────────

vi.mock("../../ui/prompts", () => ({
  selectModules: vi.fn(),
  selectOverwriteStrategy: vi.fn(() => Promise.resolve("overwrite")),
  selectMissingTemplateAction: vi.fn(),
  selectTemplateCandidate: vi.fn(),
  inputTemplateSource: vi.fn(),
  confirmScaffoldDevenvPR: vi.fn(),
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

vi.mock("../../utils/untracked", () => ({
  detectUntrackedFiles: vi.fn(() => Promise.resolve([])),
  getTotalUntrackedCount: vi.fn(() => 0),
}));

vi.spyOn(console, "log").mockImplementation(() => {});

// ── imports ─────────────────────────────────────────────────────

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

/**
 * init を --from-dir で実行。テンプレートダウンロードをスキップし、
 * ローカルの templateDir を直接テンプレートとして使用する。
 */
function runInit(dir: string, templateDir: string) {
  return (initCommand.run as any)({
    args: { dir, force: false, yes: true, "from-dir": templateDir },
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

function placeFiles(baseDir: string, files: Record<string, string>) {
  for (const [path, content] of Object.entries(files)) {
    const fullPath = `${baseDir}/${path}`;
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

    // fetchTemplates: /template から targetDir にファイルをコピー（glob 非互換のため）
    mockFetchTemplates.mockImplementation(async (opts: any) => {
      const targetDir = opts.targetDir as string;
      const templateDir = opts.templateDir ?? "/template";
      const results: Array<{ action: string; path: string }> = [];

      const allFiles = vol.toJSON();
      for (const [fullPath, content] of Object.entries(allFiles)) {
        if (!fullPath.startsWith(`${templateDir}/`)) continue;
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
    // ─── Step 1: setup — テンプレートリポに modules.jsonc を作成 ───

    await runSetup("/template");

    expect(vol.existsSync("/template/.ziku/modules.jsonc")).toBe(true);
    const modulesContent = JSON.parse(
      vol.readFileSync("/template/.ziku/modules.jsonc", "utf8") as string,
    );
    expect(modulesContent.modules).toBeDefined();
    expect(modulesContent.modules.length).toBeGreaterThan(0);

    // ─── Step 2: テンプレートリポにファイルを配置 ───

    placeFiles("/template", {
      ".claude/rules/style.md": "# Style Guide\nUse TypeScript.",
      ".mcp.json": '{"servers":{}}',
    });

    // ─── Step 3: init --from-dir (プロジェクトA) ───
    // --from-dir でローカルテンプレートを直接指定。GitHub ダウンロード不要。

    vol.mkdirSync("/projectA", { recursive: true });
    await runInit("/projectA", "/template");

    expect(vol.existsSync("/projectA/.ziku/ziku.jsonc")).toBe(true);
    expect(vol.existsSync("/projectA/.ziku/lock.json")).toBe(true);
    expect(vol.existsSync("/projectA/.claude/rules/style.md")).toBe(true);
    expect(vol.existsSync("/projectA/.mcp.json")).toBe(true);
    expect(vol.readFileSync("/projectA/.claude/rules/style.md", "utf8")).toBe(
      "# Style Guide\nUse TypeScript.",
    );

    // ─── Step 4: init --from-dir (プロジェクトB) ───

    vol.mkdirSync("/projectB", { recursive: true });
    await runInit("/projectB", "/template");

    expect(vol.existsSync("/projectB/.claude/rules/style.md")).toBe(true);
    expect(vol.existsSync("/projectB/.mcp.json")).toBe(true);
    expect(vol.readFileSync("/projectB/.claude/rules/style.md", "utf8")).toBe(
      vol.readFileSync("/projectA/.claude/rules/style.md", "utf8"),
    );

    // ─── Step 5: プロジェクトA でファイル追加 → push ───

    placeFiles("/projectA", {
      ".claude/rules/testing.md": "# Testing Guide\nWrite tests first.",
    });

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

    expect(mockCreatePullRequest).toHaveBeenCalledTimes(1);
    const prFiles = mockCreatePullRequest.mock.calls[0][1].files;
    expect(prFiles.some((f: any) => f.path === ".claude/rules/testing.md")).toBe(true);

    // ─── Step 6: PR マージを模擬 ───

    placeFiles("/template", {
      ".claude/rules/testing.md": "# Testing Guide\nWrite tests first.",
    });

    // ─── Step 7: プロジェクトB で pull ───

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

    // ─── Step 8: 新プロジェクトC で init ───

    vol.mkdirSync("/projectC", { recursive: true });
    await runInit("/projectC", "/template");

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

      for (const content of contents) {
        expect(content).toBe(contents[0]);
      }
    }
  });
});
