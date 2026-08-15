/**
 * init が残した既存ファイルを、続く status / push / pull が「ローカルの変更」と読まないことを
 * 症状の側から確かめる。
 *
 * コピー・ハッシュ計算・分類は実装をそのまま通す。ここで検証したいのは「init がベースに何を
 * 記録し、その記録を後続コマンドがどう解釈するか」というコマンドをまたいだ帰結で、途中を
 * モックすると経路が途切れて症状が再現しなくなる。
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
    // 既定ブランチの控えへ倒す規則は実装を通す（コマンドの挙動そのものなのでモックしない）
    decideDefaultBranch: actual.decideDefaultBranch,
  };
});

vi.mock("../../utils/readme", () => ({
  renderTemplateReadme: vi.fn(() => Promise.resolve(null)),
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
const { statusCommand } = await import("../status");
const { pushCommand } = await import("../push");
const { pullCommand } = await import("../pull");
const { hashContent } = await import("../../utils/hash");
const { globPatterns, repoRelPath } = await import("../../__tests__/brands");
const { generateZikuJsonc } = await import("../../utils/ziku-config");
const { log, outro } = await import("../../ui/renderer");

const mockLog = vi.mocked(log);
const mockOutro = vi.mocked(outro);

const TEMPLATE_DIR = "/template";
const PROJECT_DIR = "/project";

/**
 * テンプレートの `ziku.jsonc`。init が組み立てる本文と同じ関数で作る。
 *
 * init は選択したパターンから本文を生成するので、テンプレート側が別の書式だと、その差分が
 * status の推奨に混ざる。ここで見たいのは同期ファイルの扱いなので、config は一致させて
 * 変数を 1 つに絞る。
 */
const CONFIG = generateZikuJsonc({ include: globPatterns(["*.txt"]), exclude: [] });

const TEMPLATE_FOO = "template version\n";
const LOCAL_FOO = "local version, unrelated to the template\n";
const TEMPLATE_BAR = "shared\n";

/** テンプレートと、まだ ziku を導入していないプロジェクトを置く。 */
function setupTemplate(localFiles: Record<string, string>): void {
  vol.fromJSON({
    [`${TEMPLATE_DIR}/.ziku/ziku.jsonc`]: CONFIG,
    [`${TEMPLATE_DIR}/foo.txt`]: TEMPLATE_FOO,
    [`${TEMPLATE_DIR}/bar.txt`]: TEMPLATE_BAR,
    ...Object.fromEntries(
      Object.entries(localFiles).map(([path, content]) => [`${PROJECT_DIR}/${path}`, content]),
    ),
  });
  if (Object.keys(localFiles).length === 0) vol.mkdirSync(PROJECT_DIR, { recursive: true });
}

function runInit(flags: { force?: boolean } = {}): Promise<unknown> {
  return (initCommand.run as any)({
    args: {
      dir: PROJECT_DIR,
      "from-dir": TEMPLATE_DIR,
      force: flags.force ?? false,
      yes: true,
      dryRun: false,
    },
    rawArgs: [],
    cmd: initCommand,
  });
}

function runStatus(): Promise<unknown> {
  return (statusCommand.run as any)({
    args: { dir: PROJECT_DIR },
    rawArgs: [],
    cmd: statusCommand,
  });
}

function runPushDryRun(): Promise<unknown> {
  return (pushCommand.run as any)({
    args: {
      dir: PROJECT_DIR,
      dryRun: true,
      yes: true,
      edit: false,
      includeDeletions: false,
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

function currentLock(): LockState {
  return lockSchema.parse(
    JSON.parse(vol.readFileSync(`${PROJECT_DIR}/.ziku/lock.json`, "utf8") as string),
  );
}

function baseHashOf(path: string): string | undefined {
  return baseHashesOf(currentLock())[repoRelPath(path)];
}

function readProjectFile(path: string): string {
  return vol.readFileSync(`${PROJECT_DIR}/${path}`, "utf8") as string;
}

describe("init が残した既存ファイルは、次のコマンドでローカルの変更に見えない", () => {
  beforeEach(() => {
    vol.reset();
    vi.clearAllMocks();
  });

  it("--yes で保持したファイルにはベースを記録しない", async () => {
    setupTemplate({ "foo.txt": LOCAL_FOO });

    await runInit();

    // 既存ファイルは保持される（--yes は上書きを承認しない）
    expect(readProjectFile("foo.txt")).toBe(LOCAL_FOO);
    // 保持した内容をベースにすると「ローカルは変えていない・テンプレートだけが変わった」と
    // 読まれ、次の pull が確認なくテンプレートの内容へ置き換える
    expect(baseHashOf("foo.txt")).toBeUndefined();
    // コピーされたファイルはテンプレートの内容がベース
    expect(baseHashOf("bar.txt")).toBe(hashContent(TEMPLATE_BAR));
  });

  it("--yes の直後、status はローカル発の変更を報告しない", async () => {
    setupTemplate({ "foo.txt": LOCAL_FOO });

    await runInit();
    await runStatus();

    // 保持したファイルは「ローカルがテンプレートを書き換えた」ものではないので push は勧めない。
    // 勧めた場合、そのまま push するとユーザーの無関係な既存ファイルがテンプレートを上書きする。
    expect(mockOutro).toHaveBeenCalledWith(expect.not.stringContaining("ziku push"));
    // テンプレート側の内容はまだ取り込んでいないので、取り込みの案内は出る
    expect(mockOutro).toHaveBeenCalledWith(expect.stringContaining("ziku pull"));
  });

  it("--yes の直後、push --dryRun は保持したファイルを送信候補に出さない", async () => {
    setupTemplate({ "foo.txt": LOCAL_FOO });

    await runInit();
    await runPushDryRun();

    // ベースが無いファイルは未解決の衝突として既定の送信集合から外れる。送ってしまうと、
    // ユーザーの無関係な既存ファイルがテンプレート経由で全プロジェクトへ配られる。
    expect(mockLog.info).toHaveBeenCalledWith(
      "No files match the current selection — nothing would be pushed.",
    );
    // テンプレートは init 前の内容のまま（送信候補に出ていない証拠を実体でも確かめる）
    expect(vol.readFileSync(`${TEMPLATE_DIR}/foo.txt`, "utf8")).toBe(TEMPLATE_FOO);
  });

  it("--yes の直後の pull は、保持したファイルを確認なく置き換えない", async () => {
    setupTemplate({ "foo.txt": LOCAL_FOO });

    await runInit();
    await runPull();

    // init のヘルプは既存ファイルを残すと約束している。ベースを記録するとこのファイルは
    // autoUpdate に分類され、直後の pull が約束を無効化する。
    expect(readProjectFile("foo.txt")).toBe(LOCAL_FOO);
  });

  it("--yes の直後の pull は、保持したファイルを解決待ちとして提示する", async () => {
    setupTemplate({ "foo.txt": LOCAL_FOO });

    await runInit();
    await runPull();

    // 残す側の選択はユーザーが決める。黙って据え置くのではなく、解決を促して止まる。
    expect(mockOutro).toHaveBeenCalledWith(
      expect.stringContaining("resolve conflicts then run `ziku pull --continue`"),
    );
  });

  it("--force で上書きしたファイルは、次の pull で差分として現れない", async () => {
    setupTemplate({ "foo.txt": LOCAL_FOO });

    await runInit({ force: true });
    await runPull();

    // 上書きした内容がベースに載っているので、pull から見て動かすものが無い
    expect(readProjectFile("foo.txt")).toBe(TEMPLATE_FOO);
    expect(mockOutro).toHaveBeenCalledWith(expect.stringContaining("No changes needed"));
  });

  it("テンプレートと同じ内容の既存ファイルがあるだけなら、status は同期済みと報告する", async () => {
    setupTemplate({ "foo.txt": TEMPLATE_FOO });

    await runInit();
    await runStatus();

    expect(mockOutro).toHaveBeenCalledWith(expect.stringContaining("In sync"));
  });

  it("--force で上書きしたファイルのベースは、書いた内容のハッシュになる", async () => {
    setupTemplate({ "foo.txt": LOCAL_FOO });

    await runInit({ force: true });

    expect(readProjectFile("foo.txt")).toBe(TEMPLATE_FOO);
    expect(baseHashOf("foo.txt")).toBe(hashContent(TEMPLATE_FOO));
  });

  it("--force の直後、status は同期済みと報告する", async () => {
    setupTemplate({ "foo.txt": LOCAL_FOO });

    await runInit({ force: true });
    await runStatus();

    expect(mockOutro).toHaveBeenCalledWith(expect.stringContaining("In sync"));
  });

  it("未初期化のディレクトリなら、全ファイルのベースがテンプレートの内容と一致する", async () => {
    setupTemplate({});

    await runInit();

    expect(readProjectFile("foo.txt")).toBe(TEMPLATE_FOO);
    expect(baseHashOf("foo.txt")).toBe(hashContent(TEMPLATE_FOO));
    expect(baseHashOf("bar.txt")).toBe(hashContent(TEMPLATE_BAR));
    expect(baseHashOf(".ziku/ziku.jsonc")).toBe(hashContent(CONFIG));
  });

  it("未初期化のディレクトリなら、init の直後の status は同期済みになる", async () => {
    setupTemplate({});

    await runInit();
    await runStatus();

    expect(mockOutro).toHaveBeenCalledWith(expect.stringContaining("In sync"));
  });
});
