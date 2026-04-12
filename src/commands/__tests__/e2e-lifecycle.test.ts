/**
 * E2E ライフサイクルテスト — 完全なシナリオ検証
 *
 * ziku の全コマンドを通したライフサイクルを 1 本のシナリオで検証する。
 * モックは最小限（GitHub API と UI のみ）にし、内部ロジックは実際のコードを通す。
 *
 * シナリオ:
 *   1. setup: テンプレートリポに .ziku/ziku.jsonc を作成
 *   2. テンプレートリポにファイルを配置
 *   3. init (プロジェクトA): テンプレートからファイルをコピー
 *   4. init (プロジェクトB): テンプレートからファイルをコピー
 *   5. プロジェクトA でファイル追加 → push → テンプレートに PR
 *   6. プロジェクトA で track → 新パターン追加 → push
 *   7. PR マージを模擬 → テンプレートリポにファイル反映
 *   8. プロジェクトB で pull → A の変更が反映される
 *   9. 新プロジェクトC で init → 追加ファイルも含めて取得
 *   10. 全プロジェクトの同期ファイルが同一内容
 *
 * ライフサイクル SSOT:
 *   各ステップで「どのファイルが」「どの場所に」「どの操作で」作成/更新されるかを
 *   宣言的に定義し、実際のコマンド実行後にアサートする。
 */

import { vol } from "memfs";
import { Effect } from "effect";
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

// ── ネットワーク系のみモック ────────────────────────────────────

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
      url: "https://github.com/test-org/.ziku/pull/1",
      number: 1,
      branch: "ziku-sync",
    }),
  ),
}));

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

// ── UI 系のみモック ─────────────────────────────────────────────

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
  threeWayMerge: vi.fn(() => ({ content: "merged", hasConflicts: false })),
  asBaseContent: vi.fn((s: string) => s),
  asLocalContent: vi.fn((s: string) => s),
  asTemplateContent: vi.fn((s: string) => s),
}));

vi.mock("../../utils/untracked", () => ({
  detectUntrackedFiles: vi.fn(() => Promise.resolve([])),
  getTotalUntrackedCount: vi.fn(() => 0),
}));

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
        if (existing) existing.push(p);
        else dirMap.set(dir, [p]);
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

vi.spyOn(console, "log").mockImplementation(() => {});

// ── imports (after mocks) ───────────────────────────────────────

const { setupCommand } = await import("../setup");
const { initCommand } = await import("../init");
const { pushCommand } = await import("../push");
const { pullCommand } = await import("../pull");
const { trackCommand } = await import("../track");
const { diffCommand } = await import("../diff");

const { fetchTemplates } = await import("../../utils/template");
const { selectPushFiles, selectDeletedFiles } = await import("../../ui/prompts");
const { createPullRequest } = await import("../../utils/github");
const { detectDiff } = await import("../../utils/diff");
const { classifyFiles } = await import("../../utils/merge");
const { loadTemplateConfig } = await import("../../utils/template-config");

const mockFetchTemplates = vi.mocked(fetchTemplates);
const mockSelectPushFiles = vi.mocked(selectPushFiles);
const mockSelectDeletedFiles = vi.mocked(selectDeletedFiles);
const mockCreatePullRequest = vi.mocked(createPullRequest);
const mockDetectDiff = vi.mocked(detectDiff);
const mockClassifyFiles = vi.mocked(classifyFiles);
const mockLoadTemplateConfig = vi.mocked(loadTemplateConfig);

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

function runInitFromDir(dir: string, fromDir: string) {
  return (initCommand.run as any)({
    args: { dir, force: false, yes: true, "from-dir": fromDir },
    rawArgs: [],
    cmd: initCommand,
  });
}

function _runDiff(dir: string) {
  return (diffCommand.run as any)({
    args: { dir, verbose: false },
    rawArgs: [],
    cmd: diffCommand,
  });
}

function runTrack(dir: string, patterns: string[]) {
  const originalArgv = process.argv;
  process.argv = ["node", "ziku", "track", ...patterns, "--dir", dir];
  const promise = (trackCommand.run as any)({
    args: { dir, list: false, patterns: patterns[0] },
    rawArgs: [],
    cmd: trackCommand,
  });
  return promise.finally(() => {
    process.argv = originalArgv;
  });
}

/**
 * テンプレートリポにファイルを配置するヘルパー。
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

describe("E2E ライフサイクル: setup → init → track → push → pull → init", () => {
  beforeEach(() => {
    vol.reset();
    vi.clearAllMocks();

    // fetchTemplates: /template から targetDir にファイルをコピーする実装
    mockFetchTemplates.mockImplementation((async (opts: any) => {
      const targetDir = opts.targetDir as string;
      const templateDir = opts.templateDir ?? "/template";
      const results: Array<{
        action: "copied" | "created" | "overwritten" | "skipped" | "skipped_ignored";
        path: string;
      }> = [];

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
    }) as any);
  });

  it("完全なライフサイクルが正しく動作する", async () => {
    // ═══════════════════════════════════════════════════════════
    // Step 1: setup — テンプレートリポに .ziku/ziku.jsonc を作成
    // ファイル操作: .ziku/ziku.jsonc [template/create]
    // ═══════════════════════════════════════════════════════════

    await runSetup("/template");

    expect(vol.existsSync("/template/.ziku/ziku.jsonc")).toBe(true);
    const zikuJsonc = JSON.parse(vol.readFileSync("/template/.ziku/ziku.jsonc", "utf8") as string);
    expect(zikuJsonc.include).toBeDefined();
    expect(zikuJsonc.include.length).toBeGreaterThan(0);
    // $schema が含まれること
    expect(zikuJsonc.$schema).toBeDefined();

    // ═══════════════════════════════════════════════════════════
    // Step 2: テンプレートリポにファイルを配置
    // ═══════════════════════════════════════════════════════════

    placeTemplateFiles({
      ".claude/rules/style.md": "# Style Guide\nUse TypeScript.",
      ".mcp.json": '{"servers":{}}',
    });

    // ═══════════════════════════════════════════════════════════
    // Step 3: init (プロジェクトA) — テンプレートからコピー
    // ファイル操作:
    //   .ziku/ziku.jsonc [template/read] — パターン取得
    //   .ziku/ziku.jsonc [local/create]  — 選択パターン保存
    //   .ziku/lock.json  [local/create]  — source + ハッシュ
    //   synced files     [local/create]  — コピー
    // ═══════════════════════════════════════════════════════════

    vol.mkdirSync("/projectA", { recursive: true });
    await runInit("/projectA");

    // ziku.jsonc が作成された（パターンのみ、source なし）
    expect(vol.existsSync("/projectA/.ziku/ziku.jsonc")).toBe(true);
    const projectAConfig = JSON.parse(
      vol.readFileSync("/projectA/.ziku/ziku.jsonc", "utf8") as string,
    );
    expect(projectAConfig.include).toBeDefined();
    expect(projectAConfig.source).toBeUndefined(); // source は lock に分離

    // lock.json が作成された（source を含む）
    expect(vol.existsSync("/projectA/.ziku/lock.json")).toBe(true);
    const lockA = JSON.parse(vol.readFileSync("/projectA/.ziku/lock.json", "utf8") as string);
    expect(lockA.source).toBeDefined();
    expect(lockA.source.owner).toBe("test-org");
    expect(lockA.version).toBeDefined();
    expect(lockA.installedAt).toBeDefined();

    // テンプレートのファイルがコピーされた
    expect(vol.existsSync("/projectA/.claude/rules/style.md")).toBe(true);
    expect(vol.existsSync("/projectA/.mcp.json")).toBe(true);
    expect(vol.readFileSync("/projectA/.claude/rules/style.md", "utf8")).toBe(
      "# Style Guide\nUse TypeScript.",
    );

    // ═══════════════════════════════════════════════════════════
    // Step 4: init (プロジェクトB) — 同じテンプレートからコピー
    // ═══════════════════════════════════════════════════════════

    vol.mkdirSync("/projectB", { recursive: true });
    await runInit("/projectB");

    expect(vol.existsSync("/projectB/.claude/rules/style.md")).toBe(true);
    expect(vol.existsSync("/projectB/.mcp.json")).toBe(true);

    // A と B の内容が一致
    expect(vol.readFileSync("/projectB/.claude/rules/style.md", "utf8")).toBe(
      vol.readFileSync("/projectA/.claude/rules/style.md", "utf8"),
    );

    // ═══════════════════════════════════════════════════════════
    // Step 5: プロジェクトA でファイル追加 → push
    // ファイル操作:
    //   .ziku/ziku.jsonc [local/read]     — patterns 取得
    //   .ziku/lock.json  [local/read]     — source, baseRef, baseHashes
    //   synced files     [local/read]     — ローカル変更検出
    //   synced files     [template/read]  — テンプレートと差分比較
    //   synced files     [template/update] — PR 作成
    // ═══════════════════════════════════════════════════════════

    vol.mkdirSync("/projectA/.claude/rules", { recursive: true });
    vol.writeFileSync("/projectA/.claude/rules/testing.md", "# Testing Guide\nWrite tests first.");

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
    const prFiles1 = mockCreatePullRequest.mock.calls[0][1].files;
    expect(prFiles1.some((f: any) => f.path === ".claude/rules/testing.md")).toBe(true);

    // ═══════════════════════════════════════════════════════════
    // Step 6: プロジェクトA で track → 新パターン追加 → push
    // ファイル操作 (track):
    //   .ziku/ziku.jsonc [local/read]   — 現在パターン取得
    //   .ziku/ziku.jsonc [local/update] — 新パターン追加
    // ═══════════════════════════════════════════════════════════

    // .eslintrc.json をプロジェクトA に作成
    vol.writeFileSync("/projectA/.eslintrc.json", '{"extends": ["next"]}');

    // track で .eslintrc.json パターンを追加
    await runTrack("/projectA", [".eslintrc.json"]);

    // ziku.jsonc に .eslintrc.json が追加された
    const updatedConfig = JSON.parse(
      vol.readFileSync("/projectA/.ziku/ziku.jsonc", "utf8") as string,
    );
    expect(updatedConfig.include).toContain(".eslintrc.json");

    // 追加したファイルを push
    mockClassifyFiles.mockReturnValueOnce({
      autoUpdate: [],
      localOnly: [".eslintrc.json"],
      conflicts: [],
      newFiles: [],
      deletedFiles: [],
      unchanged: [".claude/rules/style.md", ".claude/rules/testing.md", ".mcp.json"],
    });
    mockDetectDiff.mockResolvedValueOnce({
      files: [
        {
          path: ".eslintrc.json",
          type: "added",
          localContent: '{"extends": ["next"]}',
        },
      ],
      summary: { added: 1, modified: 0, deleted: 0, unchanged: 3 },
    } as any);
    mockSelectPushFiles.mockResolvedValueOnce([
      {
        path: ".eslintrc.json",
        type: "added",
        localContent: '{"extends": ["next"]}',
      },
    ] as any);

    await runPush("/projectA");

    expect(mockCreatePullRequest).toHaveBeenCalledTimes(2);
    const prFiles2 = mockCreatePullRequest.mock.calls[1][1].files;
    expect(prFiles2.some((f: any) => f.path === ".eslintrc.json")).toBe(true);

    // ═══════════════════════════════════════════════════════════
    // Step 7: PR マージを模擬 — テンプレートリポにファイル反映
    // テンプレートの ziku.jsonc にも .eslintrc.json パターンを追加
    // ═══════════════════════════════════════════════════════════

    placeTemplateFiles({
      ".claude/rules/testing.md": "# Testing Guide\nWrite tests first.",
      ".eslintrc.json": '{"extends": ["next"]}',
    });

    // テンプレートの ziku.jsonc を更新（新パターン追加を反映）
    const templateConfig = JSON.parse(
      vol.readFileSync("/template/.ziku/ziku.jsonc", "utf8") as string,
    );
    templateConfig.include.push(".eslintrc.json");
    vol.writeFileSync("/template/.ziku/ziku.jsonc", JSON.stringify(templateConfig, null, 2));

    // loadTemplateConfig モックを更新して新パターンを含める
    mockLoadTemplateConfig.mockReturnValue(
      Effect.succeed({
        include: [...templateConfig.include],
        exclude: [],
      }),
    );

    // ═══════════════════════════════════════════════════════════
    // Step 8: プロジェクトB で pull → A の変更が反映される
    // ファイル操作:
    //   .ziku/ziku.jsonc [local/read]   — patterns 取得
    //   .ziku/lock.json  [local/read]   — source, baseHashes, baseRef
    //   synced files     [template/read] — ダウンロードして比較
    //   synced files     [local/update]  — 自動更新
    //   .ziku/ziku.jsonc [local/update]  — テンプレート新パターンマージ
    //   .ziku/lock.json  [local/update]  — baseHashes, baseRef 更新
    // ═══════════════════════════════════════════════════════════

    mockClassifyFiles.mockReturnValueOnce({
      autoUpdate: [".claude/rules/testing.md", ".eslintrc.json"],
      localOnly: [],
      conflicts: [],
      newFiles: [],
      deletedFiles: [],
      unchanged: [".claude/rules/style.md", ".mcp.json"],
    });

    await runPull("/projectB");

    // A の変更が B に反映された
    expect(vol.existsSync("/projectB/.claude/rules/testing.md")).toBe(true);
    expect(vol.readFileSync("/projectB/.claude/rules/testing.md", "utf8")).toBe(
      "# Testing Guide\nWrite tests first.",
    );
    expect(vol.existsSync("/projectB/.eslintrc.json")).toBe(true);
    expect(vol.readFileSync("/projectB/.eslintrc.json", "utf8")).toBe('{"extends": ["next"]}');

    // B の ziku.jsonc にも .eslintrc.json パターンが追加された（テンプレートからマージ）
    const projectBConfig = JSON.parse(
      vol.readFileSync("/projectB/.ziku/ziku.jsonc", "utf8") as string,
    );
    expect(projectBConfig.include).toContain(".eslintrc.json");

    // ═══════════════════════════════════════════════════════════
    // Step 9: 新プロジェクトC で init → 追加ファイルも含めて取得
    // ═══════════════════════════════════════════════════════════

    vol.mkdirSync("/projectC", { recursive: true });
    await runInit("/projectC");

    expect(vol.existsSync("/projectC/.claude/rules/style.md")).toBe(true);
    expect(vol.existsSync("/projectC/.claude/rules/testing.md")).toBe(true);
    expect(vol.existsSync("/projectC/.mcp.json")).toBe(true);
    expect(vol.existsSync("/projectC/.eslintrc.json")).toBe(true);

    // ═══════════════════════════════════════════════════════════
    // Step 10: 全プロジェクトの同期ファイルが同一内容
    // ═══════════════════════════════════════════════════════════

    const projects = ["/projectA", "/projectB", "/projectC"];
    const syncedFiles = [
      ".claude/rules/style.md",
      ".claude/rules/testing.md",
      ".mcp.json",
      ".eslintrc.json",
    ];

    for (const file of syncedFiles) {
      const contents = projects
        .filter((p) => vol.existsSync(`${p}/${file}`))
        .map((p) => vol.readFileSync(`${p}/${file}`, "utf8"));

      // 全プロジェクトにファイルが存在
      expect(contents).toHaveLength(projects.length);

      // 全プロジェクトで同じ内容
      for (const content of contents) {
        expect(content).toBe(contents[0]);
      }
    }

    // ═══════════════════════════════════════════════════════════
    // 最終検証: 各プロジェクトの設定ファイル構造
    // ═══════════════════════════════════════════════════════════

    for (const project of projects) {
      // ziku.jsonc はパターンのみ（source なし）
      const config = JSON.parse(vol.readFileSync(`${project}/.ziku/ziku.jsonc`, "utf8") as string);
      expect(config.include).toBeDefined();
      expect(config.source).toBeUndefined();

      // lock.json は source + 同期状態
      const lock = JSON.parse(vol.readFileSync(`${project}/.ziku/lock.json`, "utf8") as string);
      expect(lock.source).toBeDefined();
      expect(lock.version).toBeDefined();
    }
  });
});

// ═══════════════════════════════════════════════════════════════
// ローカルシナリオ: --from-dir でのライフサイクル
// GitHub API を使わず、ローカルディレクトリをテンプレートとして使用
// ═══════════════════════════════════════════════════════════════

describe("E2E ライフサイクル (ローカル): setup → init --from-dir → track → push → diff → pull → init", () => {
  beforeEach(() => {
    vol.reset();
    vi.clearAllMocks();

    // fetchTemplates: テンプレートからプロジェクトにコピー
    mockFetchTemplates.mockImplementation((async (opts: any) => {
      const targetDir = opts.targetDir as string;
      const templateDir = opts.templateDir ?? "/template";
      const results: Array<{
        action: "copied" | "created" | "overwritten" | "skipped" | "skipped_ignored";
        path: string;
      }> = [];

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
    }) as any);
  });

  it("ローカルテンプレートでの完全なライフサイクルが動作する", async () => {
    // ─── Step 1: setup — テンプレートリポに .ziku/ziku.jsonc を作成 ───

    await runSetup("/template");
    expect(vol.existsSync("/template/.ziku/ziku.jsonc")).toBe(true);

    // ─── Step 2: テンプレートにファイルを配置 ───

    placeTemplateFiles({
      ".claude/rules/style.md": "# Style Guide\nUse TypeScript.",
      ".mcp.json": '{"servers":{}}',
    });

    // loadTemplateConfig: テンプレートの ziku.jsonc を直接読む
    // --from-dir の場合、loadTemplateConfig は実際のファイルシステムから読む
    // ここでは memfs 上の /template/.ziku/ziku.jsonc をモックが返す
    const templateZikuJsonc = JSON.parse(
      vol.readFileSync("/template/.ziku/ziku.jsonc", "utf8") as string,
    );
    mockLoadTemplateConfig.mockReturnValue(
      Effect.succeed({
        include: templateZikuJsonc.include,
        exclude: [],
      }),
    );

    // ─── Step 3: init --from-dir (プロジェクトA) ───

    vol.mkdirSync("/projectA", { recursive: true });
    await runInitFromDir("/projectA", "/template");

    expect(vol.existsSync("/projectA/.ziku/ziku.jsonc")).toBe(true);
    expect(vol.existsSync("/projectA/.ziku/lock.json")).toBe(true);

    // lock.json の source がローカルパス
    const lockA = JSON.parse(vol.readFileSync("/projectA/.ziku/lock.json", "utf8") as string);
    expect(lockA.source.path).toBe("/template");

    // ファイルがコピーされた
    expect(vol.existsSync("/projectA/.claude/rules/style.md")).toBe(true);
    expect(vol.existsSync("/projectA/.mcp.json")).toBe(true);

    // ─── Step 4: init --from-dir (プロジェクトB) ───

    vol.mkdirSync("/projectB", { recursive: true });
    await runInitFromDir("/projectB", "/template");

    expect(vol.readFileSync("/projectB/.claude/rules/style.md", "utf8")).toBe(
      vol.readFileSync("/projectA/.claude/rules/style.md", "utf8"),
    );

    // ─── Step 5: プロジェクトA でファイル追加 → push（ローカル直接コピー）───

    vol.mkdirSync("/projectA/.claude/rules", { recursive: true });
    vol.writeFileSync("/projectA/.claude/rules/testing.md", "# Testing Guide\nWrite tests first.");

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

    // ローカル push: PR は作成されず、テンプレートに直接コピーされる
    expect(mockCreatePullRequest).not.toHaveBeenCalled();
    expect(vol.existsSync("/template/.claude/rules/testing.md")).toBe(true);
    expect(vol.readFileSync("/template/.claude/rules/testing.md", "utf8")).toBe(
      "# Testing Guide\nWrite tests first.",
    );

    // ─── Step 6: プロジェクトA で track → 新パターン追加 → push ───

    vol.writeFileSync("/projectA/.eslintrc.json", '{"extends": ["next"]}');
    await runTrack("/projectA", [".eslintrc.json"]);

    const updatedConfig = JSON.parse(
      vol.readFileSync("/projectA/.ziku/ziku.jsonc", "utf8") as string,
    );
    expect(updatedConfig.include).toContain(".eslintrc.json");

    mockClassifyFiles.mockReturnValueOnce({
      autoUpdate: [],
      localOnly: [".eslintrc.json"],
      conflicts: [],
      newFiles: [],
      deletedFiles: [],
      unchanged: [".claude/rules/style.md", ".claude/rules/testing.md", ".mcp.json"],
    });
    mockDetectDiff.mockResolvedValueOnce({
      files: [{ path: ".eslintrc.json", type: "added", localContent: '{"extends": ["next"]}' }],
      summary: { added: 1, modified: 0, deleted: 0, unchanged: 3 },
    } as any);
    mockSelectPushFiles.mockResolvedValueOnce([
      { path: ".eslintrc.json", type: "added", localContent: '{"extends": ["next"]}' },
    ] as any);

    await runPush("/projectA");

    // テンプレートに .eslintrc.json が直接コピーされた
    expect(vol.existsSync("/template/.eslintrc.json")).toBe(true);

    // ─── Step 7: テンプレートの ziku.jsonc を更新（新パターン反映）───

    const tplConfig = JSON.parse(vol.readFileSync("/template/.ziku/ziku.jsonc", "utf8") as string);
    tplConfig.include.push(".eslintrc.json");
    vol.writeFileSync("/template/.ziku/ziku.jsonc", JSON.stringify(tplConfig, null, 2));

    mockLoadTemplateConfig.mockReturnValue(
      Effect.succeed({ include: [...tplConfig.include], exclude: [] }),
    );

    // ─── Step 8: プロジェクトB で pull → A の変更が反映される ───

    mockClassifyFiles.mockReturnValueOnce({
      autoUpdate: [".claude/rules/testing.md", ".eslintrc.json"],
      localOnly: [],
      conflicts: [],
      newFiles: [],
      deletedFiles: [],
      unchanged: [".claude/rules/style.md", ".mcp.json"],
    });

    await runPull("/projectB");

    expect(vol.existsSync("/projectB/.claude/rules/testing.md")).toBe(true);
    expect(vol.existsSync("/projectB/.eslintrc.json")).toBe(true);

    // B の ziku.jsonc にも .eslintrc.json パターンがマージされた
    const projectBConfig = JSON.parse(
      vol.readFileSync("/projectB/.ziku/ziku.jsonc", "utf8") as string,
    );
    expect(projectBConfig.include).toContain(".eslintrc.json");

    // ─── Step 9: 新プロジェクトC で init --from-dir ───

    vol.mkdirSync("/projectC", { recursive: true });
    await runInitFromDir("/projectC", "/template");

    expect(vol.existsSync("/projectC/.claude/rules/style.md")).toBe(true);
    expect(vol.existsSync("/projectC/.claude/rules/testing.md")).toBe(true);
    expect(vol.existsSync("/projectC/.eslintrc.json")).toBe(true);

    // ─── Step 10: 全プロジェクトの同期ファイルが同一 ───

    const projects = ["/projectA", "/projectB", "/projectC"];
    const syncedFiles = [
      ".claude/rules/style.md",
      ".claude/rules/testing.md",
      ".mcp.json",
      ".eslintrc.json",
    ];

    for (const file of syncedFiles) {
      const contents = projects
        .filter((p) => vol.existsSync(`${p}/${file}`))
        .map((p) => vol.readFileSync(`${p}/${file}`, "utf8"));

      expect(contents).toHaveLength(projects.length);
      for (const content of contents) {
        expect(content).toBe(contents[0]);
      }
    }

    // ─── 最終検証: ローカルソースの設定構造 ───

    for (const project of projects) {
      const config = JSON.parse(vol.readFileSync(`${project}/.ziku/ziku.jsonc`, "utf8") as string);
      expect(config.include).toBeDefined();
      expect(config.source).toBeUndefined();

      const lock = JSON.parse(vol.readFileSync(`${project}/.ziku/lock.json`, "utf8") as string);
      // ローカルソース: path フィールドを持つ
      expect(lock.source.path).toBe("/template");
    }

    // ═══════════════════════════════════════════════════════════
    // Step 11: テンプレートからファイルを削除 → pull で削除が同期
    //
    // テンプレートから .eslintrc.json を削除し、
    // プロジェクトB で pull → ローカルからも削除されることを検証。
    // ═══════════════════════════════════════════════════════════

    vol.unlinkSync("/template/.eslintrc.json");

    // classifyFiles: .eslintrc.json が deletedFiles に分類
    mockClassifyFiles.mockReturnValueOnce({
      autoUpdate: [],
      localOnly: [],
      conflicts: [],
      newFiles: [],
      deletedFiles: [".eslintrc.json"],
      unchanged: [".claude/rules/style.md", ".claude/rules/testing.md", ".mcp.json"],
    });

    // selectDeletedFiles: --force ではないが、モックで全選択を返す
    mockSelectDeletedFiles.mockResolvedValueOnce([".eslintrc.json"]);

    await runPull("/projectB");

    // .eslintrc.json がプロジェクトB から削除された
    expect(vol.existsSync("/projectB/.eslintrc.json")).toBe(false);

    // 他のファイルは残っている
    expect(vol.existsSync("/projectB/.claude/rules/style.md")).toBe(true);
    expect(vol.existsSync("/projectB/.claude/rules/testing.md")).toBe(true);
    expect(vol.existsSync("/projectB/.mcp.json")).toBe(true);

    // lock.json の baseHashes から .eslintrc.json が消えている
    const lockAfterDelete = JSON.parse(
      vol.readFileSync("/projectB/.ziku/lock.json", "utf8") as string,
    );
    expect(lockAfterDelete.baseHashes).not.toHaveProperty(".eslintrc.json");

    // ═══════════════════════════════════════════════════════════
    // Step 12: プロジェクトA でも pull → 同じ削除が反映
    // ═══════════════════════════════════════════════════════════

    mockClassifyFiles.mockReturnValueOnce({
      autoUpdate: [],
      localOnly: [],
      conflicts: [],
      newFiles: [],
      deletedFiles: [".eslintrc.json"],
      unchanged: [".claude/rules/style.md", ".claude/rules/testing.md", ".mcp.json"],
    });

    mockSelectDeletedFiles.mockResolvedValueOnce([".eslintrc.json"]);

    await runPull("/projectA");

    expect(vol.existsSync("/projectA/.eslintrc.json")).toBe(false);
    expect(vol.existsSync("/projectA/.claude/rules/style.md")).toBe(true);

    // ═══════════════════════════════════════════════════════════
    // Step 13: 新プロジェクトD で init → 削除済みファイルは含まれない
    // ═══════════════════════════════════════════════════════════

    vol.mkdirSync("/projectD", { recursive: true });
    await runInitFromDir("/projectD", "/template");

    // テンプレートに .eslintrc.json がないので、init でもコピーされない
    expect(vol.existsSync("/projectD/.eslintrc.json")).toBe(false);
    // 残りのファイルは取得される
    expect(vol.existsSync("/projectD/.claude/rules/style.md")).toBe(true);
    expect(vol.existsSync("/projectD/.claude/rules/testing.md")).toBe(true);
    expect(vol.existsSync("/projectD/.mcp.json")).toBe(true);
  });
});
