/**
 * テンプレートが `ziku.jsonc` から include パターンを削除したとき、その削除が利用リポジトリへ
 * 伝播することを、pull / push を実際に走らせて確かめる。
 *
 * パターンの同期は「前回の同期時点でテンプレートが何を宣言していたか」を lock の
 * `base.patterns` から読み、テンプレートの現在の宣言とローカルの宣言の 3 者で決める。
 * この記録が無いと「テンプレートが消した」と「ローカルが独自に足した」が同じ形
 * （テンプレートに無くローカルにある）に見え、削除を伝播させるとローカル固有のパターンまで
 * 消える。記録がある lock と無い lock の両方をここで押さえる。
 *
 * 分類・走査・ハッシュ計算は実装をそのまま通す。パターンの削除はスコープの縮小を伴い、
 * 縮めた後で分類すると「テンプレートが同時に消したファイル」が候補から静かに落ちる。
 * 順序が主題なので、途中をモックすると症状が再現しない。
 */
import { vol } from "memfs";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { LockState, TemplateSource } from "../../modules/schemas";
import { createPendingLock, lockSchema, markSynced } from "../../modules/schemas";

vi.mock("node:fs", async () => {
  const memfs = await import("memfs");
  return memfs.fs;
});

vi.mock("node:fs/promises", async () => {
  const memfs = await import("memfs");
  return memfs.fs.promises;
});

// 走査範囲そのものが主題なので、パターンを解決する代役を使う（基点配下を全部返す代用品だと、
// 範囲を絞る実装と絞らない実装が同じ結果になる）。
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

// 未追跡ファイルの追跡提案は本テストの主題ではない。プロンプトの分岐を持ち込まない。
vi.mock("../../utils/untracked", () => ({
  detectUntrackedFiles: vi.fn(() => Promise.resolve([])),
  getTotalUntrackedCount: vi.fn(() => 0),
}));

vi.mock("../../utils/github", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../../utils/github")>();
  return {
    ...actual,
    resolveLatestCommitSha: vi.fn(),
    resolveSourceCommitSha: vi.fn(),
    getGitHubToken: vi.fn(() => ""),
    createPullRequest: vi.fn(),
  };
});

vi.mock("../../utils/readme", () => ({
  renderTemplateReadme: vi.fn(() => Promise.resolve(null)),
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
const { absPath, globPatterns, hashMap } = await import("../../__tests__/brands");
const { readZikuConfig } = await import("../../utils/ziku-config");
const { selectDeletedFiles } = await import("../../ui/prompts");
const mockSelectDeletedFiles = vi.mocked(selectDeletedFiles);

const TEMPLATE_DIR = "/template";
const PROJECT_DIR = "/project";
const source: TemplateSource = { kind: "local", path: absPath(TEMPLATE_DIR) };

/** `ziku.jsonc` の内容。include の並びは書き戻しの土台になるので、意図した順で持つ。 */
function config(include: readonly string[]): string {
  return `${JSON.stringify({ include }, null, 2)}\n`;
}

const GUIDE = "# Guide\n";
const BUILD_SH = "#!/bin/bash\necho build\n";
const BUILD_TS = "console.log('build');\n";

/** 移行前: シェルスクリプトを同期していた時点のテンプレートの宣言。 */
const PATTERNS_BEFORE = ["docs/*.md", "hooks/*.sh"];
/** 移行後: テンプレートが `hooks/*.sh` を捨て、`hooks/*.ts` へ移った宣言。 */
const PATTERNS_AFTER = ["docs/*.md", "hooks/*.ts"];

interface SyncedState {
  /** ローカルの `ziku.jsonc` が宣言しているパターン。 */
  readonly localPatterns: readonly string[];
  /** 前回の同期時点でテンプレートが宣言していたパターン。省略すると lock に記録しない。 */
  readonly basePatterns?: readonly string[];
  /** 前回の同期時点のファイル内容（ベースのハッシュ計算に使う）。 */
  readonly baseFiles: Readonly<Record<string, string>>;
}

/** 同期済みの lock を組み立てる。 */
function syncedLock(state: SyncedState): string {
  const hashes: Record<string, string> = {
    ".ziku/ziku.jsonc": hashContent(config(state.localPatterns)),
  };
  for (const [path, content] of Object.entries(state.baseFiles)) {
    hashes[path] = hashContent(content);
  }

  const pending = createPendingLock({
    version: "1.0.0",
    installedAt: "2024-01-01T00:00:00.000Z",
    source,
  });
  const lock = markSynced(pending, {
    hashes: hashMap(hashes),
    ...(state.basePatterns === undefined
      ? {}
      : { templatePatterns: { include: globPatterns(state.basePatterns), exclude: [] } }),
  });
  return `${JSON.stringify(lock, null, 2)}\n`;
}

/**
 * テンプレートが `hooks/*.sh` を宣言から外し、その配下のファイルも `.ts` へ置き換えた状態。
 *
 * @param basePatterns lock に記録する「前回テンプレートが宣言していたパターン」。省略すると
 *   記録の無い既存 lock（削除を伝播させる判断材料が無い状態）になる。
 */
function setupPatternRemoval(options: {
  basePatterns?: readonly string[];
  localPatterns?: readonly string[];
  localBuildSh?: string;
}): void {
  const localPatterns = options.localPatterns ?? PATTERNS_BEFORE;
  vol.fromJSON({
    [`${TEMPLATE_DIR}/.ziku/ziku.jsonc`]: config(PATTERNS_AFTER),
    [`${TEMPLATE_DIR}/docs/guide.md`]: GUIDE,
    [`${TEMPLATE_DIR}/hooks/build.ts`]: BUILD_TS,
    [`${PROJECT_DIR}/.ziku/ziku.jsonc`]: config(localPatterns),
    [`${PROJECT_DIR}/.ziku/lock.json`]: syncedLock({
      localPatterns,
      ...(options.basePatterns === undefined ? {} : { basePatterns: options.basePatterns }),
      baseFiles: { "docs/guide.md": GUIDE, "hooks/build.sh": BUILD_SH },
    }),
    [`${PROJECT_DIR}/docs/guide.md`]: GUIDE,
    [`${PROJECT_DIR}/hooks/build.sh`]: options.localBuildSh ?? BUILD_SH,
  });
}

function runPull(args: { force: boolean; yes: boolean }): Promise<unknown> {
  return (pullCommand.run as (input: unknown) => Promise<unknown>)({
    args: { dir: PROJECT_DIR, continue: false, dryRun: false, ...args },
    rawArgs: [],
    cmd: pullCommand,
  });
}

function runPush(): Promise<unknown> {
  return (pushCommand.run as (input: unknown) => Promise<unknown>)({
    args: { dir: PROJECT_DIR, dryRun: false, yes: true, edit: false, includeDeletions: false },
    rawArgs: [],
    cmd: pushCommand,
  });
}

function currentLock(): LockState {
  return lockSchema.parse(
    JSON.parse(vol.readFileSync(`${PROJECT_DIR}/.ziku/lock.json`, "utf8") as string),
  );
}

/** 指定ディレクトリの `ziku.jsonc` が宣言している include を読む。 */
async function includeOf(dir: string): Promise<readonly string[]> {
  const result = await readZikuConfig(absPath(dir));
  if (result._tag !== "Ok") throw new Error(`ziku.jsonc is not readable at ${dir}`);
  return result.config.include;
}

/** lock に記録された「テンプレートが宣言していたパターン」。 */
function basePatternsOf(lock: LockState): readonly string[] | undefined {
  return lock.sync === "pending" ? undefined : lock.base.patterns?.include;
}

describe("テンプレートが include から外したパターンは、利用リポジトリへ伝播する", () => {
  beforeEach(() => {
    vol.reset();
    vi.clearAllMocks();
    mockSelectDeletedFiles.mockResolvedValue([]);
  });

  it("テンプレートが外したパターンは、ローカルの ziku.jsonc からも消える", async () => {
    setupPatternRemoval({ basePatterns: PATTERNS_BEFORE });

    await runPull({ force: true, yes: false });

    expect(await includeOf(PROJECT_DIR)).toEqual(PATTERNS_AFTER);
  });

  it("パターンを外しても、同じ pull でそのファイルの削除が提示される", async () => {
    setupPatternRemoval({ basePatterns: PATTERNS_BEFORE });

    // スコープを縮めてから分類すると、テンプレートが同時に消したファイルは
    // 「どちらの走査にも現れない」ことになり、削除候補から静かに落ちる。
    await runPull({ force: false, yes: false });

    expect(mockSelectDeletedFiles).toHaveBeenCalledWith(["hooks/build.sh"]);
  });

  it("削除を承認すると、外れたパターンのファイルもテンプレートの新しいファイルも反映される", async () => {
    setupPatternRemoval({ basePatterns: PATTERNS_BEFORE });

    await runPull({ force: true, yes: false });

    expect(vol.existsSync(`${PROJECT_DIR}/hooks/build.sh`)).toBe(false);
    expect(vol.readFileSync(`${PROJECT_DIR}/hooks/build.ts`, "utf8")).toBe(BUILD_TS);
  });

  it("ローカル編集があるファイルを残しても、ベースから外れて push 候補にならない", async () => {
    // パターンが外れた時点でそのファイルは同期対象ではない。ベースにエントリが残ると
    // 「ベース有・テンプレート無・ローカル有」のまま毎回削除候補として報告され続ける。
    setupPatternRemoval({
      basePatterns: PATTERNS_BEFORE,
      localBuildSh: "#!/bin/bash\necho build, edited locally\n",
    });

    await runPull({ force: true, yes: false });

    expect(vol.existsSync(`${PROJECT_DIR}/hooks/build.sh`)).toBe(true);
    expect(currentLock()).not.toHaveProperty(["base", "hashes", "hooks/build.sh"]);

    await runPush();

    expect(vol.existsSync(`${TEMPLATE_DIR}/hooks/build.sh`)).toBe(false);
  });

  it("ローカルだけが持つパターンは、テンプレートに無くても消えない", async () => {
    setupPatternRemoval({
      basePatterns: PATTERNS_BEFORE,
      localPatterns: [...PATTERNS_BEFORE, "local/*.txt"],
    });

    await runPull({ force: true, yes: false });

    // 並びはローカルの宣言が基準。テンプレートの追加分だけが末尾へ積まれる。
    expect(await includeOf(PROJECT_DIR)).toEqual(["docs/*.md", "local/*.txt", "hooks/*.ts"]);
  });

  it("記録の無い既存 lock では、従来どおり削除を伝播させない", async () => {
    // 判断材料が無い状態で削除に倒すと、ローカル固有のパターンを消しうる。安全側に据え置く。
    setupPatternRemoval({});

    await runPull({ force: true, yes: false });

    expect(await includeOf(PROJECT_DIR)).toContain("hooks/*.sh");
  });

  it("pull は、そのとき取り込んだテンプレートの宣言を lock に記録する", async () => {
    setupPatternRemoval({});

    await runPull({ force: true, yes: false });

    // 1 度目の pull で記録が入るので、2 度目からは削除を伝播できる。
    expect(basePatternsOf(currentLock())).toEqual(PATTERNS_AFTER);
  });
});

describe("ローカルがテンプレートのパターンを外した状態（opt-out）は保たれる", () => {
  /** テンプレートは 2 つのパターンを宣言し続けているが、ローカルは片方を外している状態。 */
  function setupLocalOptOut(): void {
    vol.fromJSON({
      [`${TEMPLATE_DIR}/.ziku/ziku.jsonc`]: config(PATTERNS_BEFORE),
      [`${TEMPLATE_DIR}/docs/guide.md`]: GUIDE,
      [`${TEMPLATE_DIR}/hooks/build.sh`]: BUILD_SH,
      [`${PROJECT_DIR}/.ziku/ziku.jsonc`]: config(["docs/*.md"]),
      [`${PROJECT_DIR}/.ziku/lock.json`]: syncedLock({
        localPatterns: ["docs/*.md"],
        basePatterns: PATTERNS_BEFORE,
        baseFiles: { "docs/guide.md": GUIDE },
      }),
      [`${PROJECT_DIR}/docs/guide.md`]: GUIDE,
    });
  }

  beforeEach(() => {
    vol.reset();
    vi.clearAllMocks();
    mockSelectDeletedFiles.mockResolvedValue([]);
  });

  it("外したパターンは pull で復活しない", async () => {
    setupLocalOptOut();

    await runPull({ force: true, yes: false });

    expect(await includeOf(PROJECT_DIR)).toEqual(["docs/*.md"]);
  });

  it("外したパターンに一致するテンプレートのファイルは配置されない", async () => {
    setupLocalOptOut();

    await runPull({ force: true, yes: false });

    expect(vol.existsSync(`${PROJECT_DIR}/hooks/build.sh`)).toBe(false);
  });

  it("ローカルの opt-out は push でテンプレートから削除されない", async () => {
    // 1 プロジェクトの都合を全下流へ配らないため、パターンの削除はローカル → テンプレートの
    // 向きには伝播させない。
    setupLocalOptOut();

    await runPull({ force: true, yes: false });
    await runPush();

    expect(await includeOf(TEMPLATE_DIR)).toEqual(PATTERNS_BEFORE);
  });
});
