/**
 * `init --dirs` で選ばなかったディレクトリのファイルが、続く pull で失われないことを症状の
 * 側から確かめる。
 *
 * コピー・ハッシュ計算・分類は実装をそのまま通す。検証したいのは「init が何をベースに記録し、
 * その記録を pull がどう解釈するか」というコマンドをまたいだ帰結で、途中をモックすると経路が
 * 途切れて症状が再現しなくなる。
 */
import { vol } from "memfs";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { LockState } from "../../modules/schemas";
import { baseHashesOf, lockSchema } from "../../modules/schemas";

vi.mock("node:fs", async () => {
  const memfs = await import("memfs");
  return memfs.fs;
});

vi.mock("node:fs/promises", async () => {
  const memfs = await import("memfs");
  return memfs.fs.promises;
});

// 選んだディレクトリだけを走査していることが主題なので、パターンの解決まで再現する走査へ
// 差し替える（理由は glob-memfs の JSDoc）。
vi.mock("tinyglobby", async () => {
  const { globMemfs } = await import("../../__tests__/glob-memfs");
  return {
    glob: vi.fn((patterns: string[], opts: { cwd: string; ignore?: string[] }) =>
      Promise.resolve(globMemfs(patterns, opts)),
    ),
    globSync: vi.fn((patterns: string[], opts: { cwd: string; ignore?: string[] }) =>
      globMemfs(patterns, opts),
    ),
  };
});

// 未追跡ファイルの追跡提案は本テストの主題ではない。プロンプトの分岐を持ち込まないよう
// 「未追跡なし」に固定する。
vi.mock("../../utils/untracked", () => ({
  detectUntrackedFiles: vi.fn(() => Promise.resolve([])),
  getTotalUntrackedCount: vi.fn(() => 0),
}));

vi.mock("../../utils/git-remote", () => ({
  detectGitHubOwner: vi.fn(() => "test-org"),
  detectGitHubRepo: vi.fn(() => null),
  DEFAULT_TEMPLATE_REPOS: [".ziku", ".github"],
  DEFAULT_TEMPLATE_REPO: ".ziku",
}));

vi.mock("../../utils/github", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../../utils/github")>();
  return {
    resolveLatestCommitSha: vi.fn(),
    fetchDefaultBranch: vi.fn(),
    resolveSourceCommitSha: vi.fn(),
    resolveSourceCommit: vi.fn(),
    checkRepoExists: vi.fn(),
    checkRepoSetup: vi.fn(),
    getAuthenticatedUserLogin: vi.fn(),
    scaffoldTemplateRepo: vi.fn(),
    getGitHubToken: vi.fn(() => ""),
    createPullRequest: vi.fn(),
    rateLimitedError: vi.fn(),
    unauthorizedError: vi.fn(),
    decideDefaultBranch: actual.decideDefaultBranch,
  };
});

vi.mock("../../utils/readme", () => ({
  renderTemplateReadme: vi.fn(() => Promise.resolve(null)),
  detectReadmeUpdate: vi.fn(() => Promise.resolve(null)),
}));

vi.mock("../../ui/prompts", () => ({
  selectDirectories: vi.fn(),
  selectOverwriteStrategy: vi.fn(),
  selectMissingTemplateAction: vi.fn(),
  selectTemplateCandidate: vi.fn(),
  inputTemplateSource: vi.fn(),
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
  logFileResults: vi.fn(() => ({ added: 0, updated: 0, skipped: 0 })),
}));

const { initCommand } = await import("../init");
const { pullCommand } = await import("../pull");
const { globPatterns, repoRelPath } = await import("../../__tests__/brands");
const { generateZikuJsonc } = await import("../../utils/ziku-config");

const TEMPLATE_DIR = "/template";
const PROJECT_DIR = "/project";

/** テンプレートの `ziku.jsonc`。選択の単位はトップレベルディレクトリなので 2 つ用意する。 */
const TEMPLATE_CONFIG = generateZikuJsonc({
  include: globPatterns([".claude/**", ".github/**"]),
  exclude: [],
});

const TEMPLATE_RULES = "template rules\n";
const TEMPLATE_CI = "template ci\n";
const LOCAL_CI = "local ci, unrelated to the template\n";

function setupTemplate(): void {
  vol.fromJSON({
    [`${TEMPLATE_DIR}/.ziku/ziku.jsonc`]: TEMPLATE_CONFIG,
    [`${TEMPLATE_DIR}/.claude/rules.md`]: TEMPLATE_RULES,
    [`${TEMPLATE_DIR}/.github/workflows/ci.yml`]: TEMPLATE_CI,
    // ユーザーは `.github/` を自分で持っていて、init では選ばない
    [`${PROJECT_DIR}/.github/workflows/ci.yml`]: LOCAL_CI,
  });
}

function runInit(): Promise<unknown> {
  // biome-ignore lint/suspicious/noExplicitAny: citty run signature
  return (initCommand.run as any)({
    args: {
      dir: PROJECT_DIR,
      "from-dir": TEMPLATE_DIR,
      dirs: ".claude",
      force: false,
      yes: true,
      dryRun: false,
    },
    rawArgs: [],
    cmd: initCommand,
  });
}

function runPull(): Promise<unknown> {
  // biome-ignore lint/suspicious/noExplicitAny: citty run signature
  return (pullCommand.run as any)({
    args: { dir: PROJECT_DIR, continue: false, dryRun: false, force: false, yes: true },
    rawArgs: [],
    cmd: pullCommand,
  });
}

function currentLock(): LockState {
  return lockSchema.parse(
    JSON.parse(vol.readFileSync(`${PROJECT_DIR}/.ziku/lock.json`, "utf8") as string),
  );
}

function readProjectFile(path: string): string {
  return vol.readFileSync(`${PROJECT_DIR}/${path}`, "utf8") as string;
}

describe("init --dirs で選ばなかったディレクトリは、続く pull に巻き込まれない", () => {
  beforeEach(() => {
    vol.reset();
    vi.clearAllMocks();
  });

  it("選んだディレクトリだけを配置し、選ばなかった側のベースは記録しない", async () => {
    setupTemplate();

    await runInit();

    expect(readProjectFile(".claude/rules.md")).toBe(TEMPLATE_RULES);
    expect(readProjectFile(".github/workflows/ci.yml")).toBe(LOCAL_CI);
    // 配置していないファイルのベースを記録すると、そのハッシュはユーザーの既存ファイルの
    // ものになり、「ローカルは変えていない」と読まれる
    expect(baseHashesOf(currentLock())).not.toHaveProperty([
      repoRelPath(".github/workflows/ci.yml"),
    ]);
  });

  it("選ばなかったディレクトリの既存ファイルは、次の pull でも残る", async () => {
    setupTemplate();

    await runInit();
    await runPull();

    // ベースが無いので「ローカルとテンプレートの両方にある未同期のファイル」として扱われ、
    // 取り込むかどうかはユーザーが決める
    expect(readProjectFile(".github/workflows/ci.yml")).toBe(LOCAL_CI);
  });
});
