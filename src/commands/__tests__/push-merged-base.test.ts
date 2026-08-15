/**
 * 自動マージした内容をテンプレートへ送ったあと、続く push がテンプレート側の変更を
 * 巻き戻さないことを、症状の側から確かめる。
 *
 * 巻き戻りは 1 回の push だけ見ても現れない。マージ結果はテンプレートへしか届かないので、
 * 同期ベースをどこへ置くかで次回の分類が変わり、そこで `localOnly` と読まれた瞬間に
 * 古いローカル内容がテンプレートへ書き戻る。分類・ハッシュ・差分検出・3-way マージは
 * 実装をそのまま通し、push を 2 回続けた結果のテンプレートを見る。
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

const BASE_DIR = "/base";
const TEMPLATE_DIR = "/template";
const PROJECT_DIR = "/project";

/**
 * 共通祖先のツリーが手に入る状態を作る。
 *
 * ローカルテンプレートはコミットを持たないので、実装はベースツリーを取り直せず自動マージを
 * 試みない（`downloadBaseForMerge`）。ここで差し替えるのはベースツリーの入手だけで、
 * マージ本体（`mergeOneFile`）も未解決の判定も実装をそのまま通す。
 */
vi.mock("../../utils/merge", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../../utils/merge")>();
  const { Effect } = await import("effect");

  return {
    ...actual,
    mergeConflictFiles: (input: import("../../utils/merge").MergeConflictFilesInput) =>
      Effect.gen(function* () {
        const unresolved: { path: string; reason: "markers" }[] = [];
        for (const file of input.conflicts) {
          const result = yield* actual.mergeOneFile({
            file,
            targetDir: input.targetDir,
            templateDir: input.templateDir,
            base: { kind: "with-base", dir: BASE_DIR as never },
          });
          yield* input.onFileResult(result);
          if (result.outcome._tag !== "Clean") unresolved.push({ path: file, reason: "markers" });
        }
        return unresolved;
      }),
  };
});

/**
 * tinyglobby は実 fs を直接読むため memfs と噛み合わない。走査結果だけを memfs から作る。
 *
 * このテストの `ziku.jsonc` は glob を含まないリテラルパスだけで構成し、パターンとパスの
 * 突き合わせが走査に落ちないようにしてある。`.ziku/` を除くのは、そこを走査対象に含めると
 * ローカル専用の `lock.json` まで同期対象に見えてしまうため。追跡対象である
 * `.ziku/ziku.jsonc` は実装側が走査結果とは別に足す。
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
    isDynamicPattern: vi.fn((pattern: string) => /[*?[\]{}]/.test(pattern)),
  };
});

// 未追跡ファイルの追跡提案は本テストの主題ではない。プロンプトの分岐を持ち込まないよう
// 「未追跡なし」に固定する。
vi.mock("../../utils/untracked", () => ({
  detectUntrackedFiles: vi.fn(() => Promise.resolve([])),
  getTotalUntrackedCount: vi.fn(() => 0),
}));

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

const { pushCommand } = await import("../push");
const { hashContent } = await import("../../utils/hash");
const { absPath, hashMap, repoRelPath } = await import("../../__tests__/brands");

const source: TemplateSource = { kind: "local", path: absPath(TEMPLATE_DIR) };

const CONFIG = `${JSON.stringify({ include: ["shared.md"] }, null, 2)}\n`;

/** 前回同期した時点の内容。 */
const BASE = "alpha\nbeta\ngamma\ndelta\nepsilon\n";
/** ローカルが 1 行目を書き換えた。 */
const LOCAL = "LOCAL\nbeta\ngamma\ndelta\nepsilon\n";
/** テンプレートが最終行を書き換えた。 */
const TEMPLATE = "alpha\nbeta\ngamma\ndelta\nTEMPLATE\n";
/** 双方の変更を取り込んだ自動マージの結果。 */
const MERGED = "LOCAL\nbeta\ngamma\ndelta\nTEMPLATE\n";

function syncedLock(): string {
  const lock = markSynced(
    createPendingLock({ version: "1.0.0", installedAt: "2024-01-01T00:00:00.000Z", source }),
    {
      hashes: hashMap({
        ".ziku/ziku.jsonc": hashContent(CONFIG),
        "shared.md": hashContent(BASE),
      }),
    },
  );
  return JSON.stringify(lock, null, 2);
}

/** ローカルとテンプレートが同じファイルを別の場所で書き換えた状態を作る。 */
function setupConflict(): void {
  vol.fromJSON({
    [`${BASE_DIR}/shared.md`]: BASE,
    [`${TEMPLATE_DIR}/.ziku/ziku.jsonc`]: CONFIG,
    [`${TEMPLATE_DIR}/shared.md`]: TEMPLATE,
    [`${PROJECT_DIR}/.ziku/ziku.jsonc`]: CONFIG,
    [`${PROJECT_DIR}/.ziku/lock.json`]: syncedLock(),
    [`${PROJECT_DIR}/shared.md`]: LOCAL,
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

function readFile(dir: string, path: string): string {
  return vol.readFileSync(`${dir}/${path}`, "utf8") as string;
}

function currentLock(): LockState {
  return lockSchema.parse(
    JSON.parse(vol.readFileSync(`${PROJECT_DIR}/.ziku/lock.json`, "utf8") as string),
  );
}

describe("自動マージ結果を送ったあとの push", () => {
  beforeEach(() => {
    vol.reset();
    vi.clearAllMocks();
  });

  it("マージ結果をテンプレートへ送る", async () => {
    setupConflict();

    await runPush();

    expect(readFile(TEMPLATE_DIR, "shared.md")).toBe(MERGED);
  });

  it("マージ結果をローカルへは書かない（取り込むのは pull の役目）", async () => {
    setupConflict();

    await runPush();

    expect(readFile(PROJECT_DIR, "shared.md")).toBe(LOCAL);
  });

  it("続けて push しても、テンプレート側の変更を巻き戻さない", async () => {
    setupConflict();

    await runPush();
    await runPush();

    expect(readFile(TEMPLATE_DIR, "shared.md")).toContain("TEMPLATE");
    expect(readFile(TEMPLATE_DIR, "shared.md")).toBe(MERGED);
  });

  it("ローカルに残らなかった内容のベースは前進させない", async () => {
    setupConflict();

    await runPush();

    // 前進させると local != base == template になり、次の分類が localOnly と読む。
    expect(baseHashesOf(currentLock())[repoRelPath("shared.md")]).toBe(hashContent(BASE));
  });
});
