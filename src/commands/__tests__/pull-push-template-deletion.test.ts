/**
 * テンプレート側の削除が pull → push を往復しても復活しないことを、症状の側から確かめる。
 *
 * 分類・ハッシュ・差分検出は実装をそのまま通す。ここで検証したいのは「pull がベースをどう
 * 記録し、その記録を push がどう解釈するか」という 2 コマンドをまたいだ帰結で、どちらかを
 * モックすると経路が途切れて症状が再現しなくなる。
 */
import { vol } from "memfs";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { LockState, TemplateSource } from "../../modules/schemas";
import { baseHashesOf, createPendingLock, lockSchema, markSynced } from "../../modules/schemas";

vi.mock("node:fs", async () => {
  const memfs = await import("memfs");
  return memfs.fs;
});

vi.mock("node:fs/promises", async () => {
  const memfs = await import("memfs");
  return memfs.fs.promises;
});

/**
 * tinyglobby は実 fs を直接読むため memfs と噛み合わない。走査結果だけを memfs から作る。
 *
 * パターンの解決は tinyglobby の仕事なので再現しない。代わりに、テストが使うパターンは
 * 「基点配下の全ファイル」と一致するものに揃えてある。`.ziku/` を除くのは、そこを走査対象に
 * 含めるとローカル専用の `lock.json` まで同期対象に見えてしまうため。追跡対象である
 * `.ziku/ziku.jsonc` は、実装側（`alwaysTrackedPathsIn`）が走査結果とは別に足す。
 */
vi.mock("tinyglobby", async () => {
  const memfs = await import("memfs");
  const listFiles = (cwd: string): string[] => {
    const prefix = cwd.endsWith("/") ? cwd : `${cwd}/`;
    return Object.entries(memfs.vol.toJSON())
      .filter(([path, content]) => content !== null && path.startsWith(prefix))
      .map(([path]) => path.slice(prefix.length))
      .filter((path) => !path.startsWith(".ziku/"))
      .toSorted();
  };
  return {
    glob: vi.fn((_patterns: unknown, opts: { cwd: string }) =>
      Promise.resolve(listFiles(opts.cwd)),
    ),
    globSync: vi.fn((_patterns: unknown, opts: { cwd: string }) => listFiles(opts.cwd)),
  };
});

// 未追跡ファイルの追跡提案は本テストの主題ではない。プロンプトの分岐を持ち込まないよう
// 「未追跡なし」に固定する。
vi.mock("../../utils/untracked", () => ({
  detectUntrackedFiles: vi.fn(() => Promise.resolve([])),
  getTotalUntrackedCount: vi.fn(() => 0),
}));

vi.mock("../../utils/github", () => ({
  resolveLatestCommitSha: vi.fn(),
  resolveDefaultBranch: vi.fn(),
  resolveSourceCommitSha: vi.fn(),
  getGitHubToken: vi.fn(() => ""),
  createPullRequest: vi.fn(),
}));

vi.mock("../../utils/readme", () => ({
  detectAndUpdateReadme: vi.fn(() => Promise.resolve(null)),
}));

vi.mock("../../ui/prompts", () => ({
  selectDeletedFiles: vi.fn(() => Promise.resolve([])),
  selectDeletedFilesWithLocalEdits: vi.fn(() => Promise.resolve([])),
  selectUnmergedResolution: vi.fn(),
  selectPushFiles: vi.fn(),
  selectUntrackedToTrack: vi.fn(),
  logUntrackedFilesNotice: vi.fn(),
  confirmAction: vi.fn(() => Promise.resolve(true)),
  inputGitHubToken: vi.fn(),
  inputPrTitle: vi.fn(),
  inputPrBody: vi.fn(),
  generatePrTitle: vi.fn(() => "title"),
  generatePrBody: vi.fn(() => "body"),
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
    green: (s: string) => s,
    yellow: (s: string) => s,
    red: (s: string) => s,
    bold: (s: string) => s,
    dim: (s: string) => s,
  },
  withSpinner: vi.fn(async (_text: string, fn: () => Promise<unknown>) => fn()),
  logDiffSummary: vi.fn(),
  logFileResults: vi.fn(),
}));

const { pullCommand } = await import("../pull");
const { pushCommand } = await import("../push");
const { hashContent } = await import("../../utils/hash");
const { absPath, hashMap } = await import("../../__tests__/brands");
const { selectDeletedFiles } = await import("../../ui/prompts");
const mockSelectDeletedFiles = vi.mocked(selectDeletedFiles);

const TEMPLATE_DIR = "/template";
const PROJECT_DIR = "/project";
const source: TemplateSource = { kind: "local", path: absPath(TEMPLATE_DIR) };

const CONFIG = `${JSON.stringify({ include: ["*.md"] }, null, 2)}\n`;
const KEPT_CONTENT = "# Keep\n";
const REMOVED_CONTENT = "# Removed from the template\n";

/**
 * 「テンプレートがファイルを削除し、ローカルにはまだ残っている」状態を作る。
 *
 * ベースには削除前のハッシュを記録しておく。これが「テンプレートが消した」と
 * 「ローカルが足した」を分ける唯一の情報で、pull がここをどう書き換えるかが主題になる。
 */
function setupTemplateDeletion(localRemovedContent: string): void {
  const lock = markSynced(
    createPendingLock({ version: "1.0.0", installedAt: "2024-01-01T00:00:00.000Z", source }),
    {
      hashes: hashMap({
        ".ziku/ziku.jsonc": hashContent(CONFIG),
        "keep.md": hashContent(KEPT_CONTENT),
        "removed.md": hashContent(REMOVED_CONTENT),
      }),
    },
  );

  vol.fromJSON({
    [`${TEMPLATE_DIR}/.ziku/ziku.jsonc`]: CONFIG,
    [`${TEMPLATE_DIR}/keep.md`]: KEPT_CONTENT,
    [`${PROJECT_DIR}/.ziku/ziku.jsonc`]: CONFIG,
    [`${PROJECT_DIR}/.ziku/lock.json`]: JSON.stringify(lock, null, 2),
    [`${PROJECT_DIR}/keep.md`]: KEPT_CONTENT,
    [`${PROJECT_DIR}/removed.md`]: localRemovedContent,
  });
}

function runPull(args: { force: boolean; yes: boolean }): Promise<unknown> {
  return (pullCommand.run as any)({
    args: { dir: PROJECT_DIR, continue: false, dryRun: false, ...args },
    rawArgs: [],
    cmd: pullCommand,
  });
}

function runPush(): Promise<unknown> {
  return (pushCommand.run as any)({
    args: {
      dir: PROJECT_DIR,
      dryRun: false,
      yes: true,
      edit: false,
      includeDeletions: false,
    },
    rawArgs: [],
    cmd: pushCommand,
  });
}

function currentLock(): LockState {
  return lockSchema.parse(
    JSON.parse(vol.readFileSync(`${PROJECT_DIR}/.ziku/lock.json`, "utf8") as string),
  );
}

describe("テンプレートの削除は pull → push を往復しても復活しない", () => {
  beforeEach(() => {
    vol.reset();
    vi.clearAllMocks();
    mockSelectDeletedFiles.mockResolvedValue([]);
  });

  it("pull --yes で残したファイルを、続く push --yes がテンプレートへ送り返さない", async () => {
    setupTemplateDeletion(REMOVED_CONTENT);

    await runPull({ force: false, yes: true });

    // --yes は削除を承認しないので、ローカルにはファイルが残る
    expect(vol.existsSync(`${PROJECT_DIR}/removed.md`)).toBe(true);

    await runPush();

    // テンプレートの削除がそのまま保たれている（ここが復活すると、テンプレートを使う
    // 全プロジェクトへ削除の巻き戻しが配られる）
    expect(vol.existsSync(`${TEMPLATE_DIR}/removed.md`)).toBe(false);
  });

  it("ローカルに編集があるまま残したファイルも、push が既定で送り返さない", async () => {
    setupTemplateDeletion("# Removed, then edited locally\n");

    await runPull({ force: false, yes: true });
    expect(vol.existsSync(`${PROJECT_DIR}/removed.md`)).toBe(true);

    await runPush();

    expect(vol.existsSync(`${TEMPLATE_DIR}/removed.md`)).toBe(false);
  });

  it("残したファイルは次の pull でも削除候補として再び提示される", async () => {
    setupTemplateDeletion(REMOVED_CONTENT);

    await runPull({ force: false, yes: true });
    await runPull({ force: false, yes: false });

    expect(mockSelectDeletedFiles).toHaveBeenCalledWith(["removed.md"]);
  });

  it("削除を承認したファイルはベースから消え、次の pull に出てこない", async () => {
    setupTemplateDeletion(REMOVED_CONTENT);

    await runPull({ force: true, yes: false });

    expect(vol.existsSync(`${PROJECT_DIR}/removed.md`)).toBe(false);
    expect(baseHashesOf(currentLock())).not.toHaveProperty("removed.md");

    await runPull({ force: false, yes: false });

    expect(mockSelectDeletedFiles).not.toHaveBeenCalled();
  });
});
