/**
 * 一部のファイルだけを選んで push しても、選ばなかったファイルの更新が失われないことを、
 * 症状の側から確かめる。
 *
 * 分類・ハッシュ・差分検出は実装をそのまま通す。検証したいのは「push がベースをどう記録し、
 * その記録を次の pull / push がどう解釈するか」というコマンドをまたいだ帰結で、どちらかを
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

// 失敗の分類（classifyGitHubApiFailure / githubApiFailure）は実装を通す。push はこれを
// 使って例外を振り分けるので、差し替えると分類そのものが消える。
vi.mock("../../utils/github", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../../utils/github")>();
  return {
    ...actual,
    resolveLatestCommitSha: vi.fn(),
    resolveDefaultBranch: vi.fn(),
    resolveSourceCommitSha: vi.fn(),
    getGitHubToken: vi.fn(() => ""),
    createPullRequest: vi.fn(),
  };
});

vi.mock("../../utils/readme", () => ({
  renderTemplateReadme: vi.fn(() => Promise.resolve(null)),
  detectReadmeUpdate: vi.fn(() => Promise.resolve(null)),
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
const { absPath, hashMap, repoRelPath } = await import("../../__tests__/brands");

const TEMPLATE_DIR = "/template";
const PROJECT_DIR = "/project";
const source: TemplateSource = { kind: "local", path: absPath(TEMPLATE_DIR) };

const CONFIG = `${JSON.stringify({ include: ["*.md"] }, null, 2)}\n`;

/** テンプレートだけが更新したファイル。push の選択から外す側。 */
const TEMPLATE_ONLY_BASE = "# Shared\n";
const TEMPLATE_ONLY_UPDATED = "# Shared, updated in the template\n";

/** ローカルだけが編集したファイル。push で選ぶ側。 */
const MINE_BASE = "# Mine\n";
const MINE_EDITED = "# Mine, edited locally\n";

/** 双方が別々に編集したファイル。ローカルテンプレートでは共通祖先を取り直せず未解決になる。 */
const BOTH_BASE = "# Both\n";
const BOTH_LOCAL = "# Both, edited locally\n";
const BOTH_TEMPLATE = "# Both, edited in the template\n";

/**
 * `shared.md` / `mine.md` / `both.md` の 3 つを同期済みとして持つ lock。
 *
 * ベースのエントリが「どちら側が変えたか」を分ける唯一の情報で、push がここをどう書き換えるかが
 * 主題になる。
 */
function syncedLock(): string {
  const lock = markSynced(
    createPendingLock({ version: "1.0.0", installedAt: "2024-01-01T00:00:00.000Z", source }),
    {
      hashes: hashMap({
        ".ziku/ziku.jsonc": hashContent(CONFIG),
        "shared.md": hashContent(TEMPLATE_ONLY_BASE),
        "mine.md": hashContent(MINE_BASE),
        "both.md": hashContent(BOTH_BASE),
      }),
    },
  );
  return JSON.stringify(lock, null, 2);
}

/**
 * 「テンプレートが `shared.md` を更新し、ローカルは `mine.md` だけを編集した」状態を作る。
 *
 * `both.md` は双方が編集した状態で、ローカルテンプレート運用では共通祖先を取り直せないため
 * 自動マージを試みられず未解決のまま push 対象から外れる。
 */
function setupDivergence(): void {
  vol.fromJSON({
    [`${TEMPLATE_DIR}/.ziku/ziku.jsonc`]: CONFIG,
    [`${TEMPLATE_DIR}/shared.md`]: TEMPLATE_ONLY_UPDATED,
    [`${TEMPLATE_DIR}/mine.md`]: MINE_BASE,
    [`${TEMPLATE_DIR}/both.md`]: BOTH_TEMPLATE,
    [`${PROJECT_DIR}/.ziku/ziku.jsonc`]: CONFIG,
    [`${PROJECT_DIR}/.ziku/lock.json`]: syncedLock(),
    [`${PROJECT_DIR}/shared.md`]: TEMPLATE_ONLY_BASE,
    [`${PROJECT_DIR}/mine.md`]: MINE_EDITED,
    [`${PROJECT_DIR}/both.md`]: BOTH_LOCAL,
  });
}

/** `--files` で送るファイルを絞った push。 */
function runPush(files?: string): Promise<unknown> {
  return (pushCommand.run as any)({
    args: {
      dir: PROJECT_DIR,
      dryRun: false,
      yes: true,
      edit: false,
      includeDeletions: false,
      ...(files === undefined ? {} : { files }),
    },
    rawArgs: [],
    cmd: pushCommand,
  });
}

function runPull(): Promise<unknown> {
  return (pullCommand.run as any)({
    args: { dir: PROJECT_DIR, continue: false, dryRun: false, force: false, yes: true },
    rawArgs: [],
    cmd: pullCommand,
  });
}

/** lock に記録されている、そのパスの同期ベース。 */
function baseHash(path: string): string | undefined {
  return baseHashesOf(currentLock())[repoRelPath(path)];
}

function currentLock(): LockState {
  return lockSchema.parse(
    JSON.parse(vol.readFileSync(`${PROJECT_DIR}/.ziku/lock.json`, "utf8") as string),
  );
}

function localFile(path: string): string {
  return vol.readFileSync(`${PROJECT_DIR}/${path}`, "utf8") as string;
}

function templateFile(path: string): string {
  return vol.readFileSync(`${TEMPLATE_DIR}/${path}`, "utf8") as string;
}

describe("選んだファイルだけを push しても、選ばなかったファイルの更新は失われない", () => {
  beforeEach(() => {
    vol.reset();
    vi.clearAllMocks();
  });

  it("送ったファイルのベースだけが前進する", async () => {
    setupDivergence();

    await runPush("mine.md");

    // 送ったファイルはテンプレートに書き込まれた内容と一致する
    expect(templateFile("mine.md")).toBe(MINE_EDITED);
    expect(baseHash("mine.md")).toBe(hashContent(MINE_EDITED));
    // 送っていないファイルは据え置く。テンプレート側の内容へ進めると、ローカルが古いまま
    // base だけが新しくなり、次の分類がこのファイルを localOnly と読む。
    expect(baseHash("shared.md")).toBe(hashContent(TEMPLATE_ONLY_BASE));
    expect(baseHash("both.md")).toBe(hashContent(BOTH_BASE));
  });

  it("push の後の pull がテンプレートの更新を取り込む", async () => {
    setupDivergence();

    await runPush("mine.md");
    await runPull();

    expect(localFile("shared.md")).toBe(TEMPLATE_ONLY_UPDATED);
  });

  it("push を繰り返してもテンプレートの更新を巻き戻さない", async () => {
    setupDivergence();

    await runPush("mine.md");
    await runPush();

    // 2 回目の push でも `shared.md` はテンプレート側だけの変更として扱われ、送信対象に
    // 入らない。ベースが前進していると localOnly になり、古いローカルの内容で上書きされる。
    expect(templateFile("shared.md")).toBe(TEMPLATE_ONLY_UPDATED);
  });

  it("自動マージできなかったファイルのベースも前進しない", async () => {
    setupDivergence();

    await runPush("mine.md");

    // 未解決の衝突は push 対象から外れる。ベースを前進させると衝突が黙って「ローカルの勝ち」
    // として確定し、テンプレート側の編集が消える。
    await runPush();

    expect(templateFile("both.md")).toBe(BOTH_TEMPLATE);
    expect(baseHash("both.md")).toBe(hashContent(BOTH_BASE));
  });

  it("ローカルとテンプレートが元から一致していたファイルはベースを揃える", async () => {
    setupDivergence();

    await runPush("mine.md");

    // `ziku.jsonc` は双方同じ内容。送っていないが、揃えても失われる情報が無い。
    expect(baseHash(".ziku/ziku.jsonc")).toBe(hashContent(CONFIG));
  });
});
