/**
 * 今回の push に関係するパターンだけを `ziku.jsonc` に載せて送ったあと、続く push が
 * 無関係なローカル限定パターンを送らないことを、症状の側から確かめる。
 *
 * スコープを絞れているかは 1 回の push だけ見ても分からない。テンプレートへ送った内容を
 * ローカルへ書き戻さない以上、同期ベースをどこへ置くかで次回の分類が変わり、そこで
 * `localOnly` と読まれた瞬間にローカル全体の和集合が送られる。分類・ハッシュ・差分検出は
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

/**
 * tinyglobby は実 fs を直接読むため memfs と噛み合わない。走査結果だけを memfs から作る。
 *
 * パターンの解決は tinyglobby の仕事なので再現しない。代わりに、このテストの `ziku.jsonc` は
 * glob を含まないリテラルパスだけで構成し、パターンとパスの突き合わせが走査に落ちないように
 * してある。`.ziku/` を除くのは、そこを走査対象に含めるとローカル専用の `lock.json` まで
 * 同期対象に見えてしまうため。追跡対象である `.ziku/ziku.jsonc` は、実装側
 * （`alwaysTrackedPathsIn`）が走査結果とは別に足す。
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
  detectAndUpdateReadme: vi.fn(() => Promise.resolve(null)),
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

const { pushCommand } = await import("../push");
const { hashContent } = await import("../../utils/hash");
const { absPath, hashMap, repoRelPath } = await import("../../__tests__/brands");

const TEMPLATE_DIR = "/template";
const PROJECT_DIR = "/project";
const source: TemplateSource = { kind: "local", path: absPath(TEMPLATE_DIR) };

/** テンプレートが配っているパターン。 */
const TEMPLATE_CONFIG = `${JSON.stringify({ include: ["shared.md"] }, null, 2)}\n`;

/**
 * ローカルが自分で足したパターンを含む設定。
 *
 * `docs/guide.md` は今回 push するファイルのパターン、`private/secret.md` は今回の push と
 * 無関係なローカル限定パターン。後者がテンプレートへ渡らないことが主題。
 */
const LOCAL_CONFIG = `${JSON.stringify(
  { include: ["shared.md", "docs/guide.md", "private/secret.md"] },
  null,
  2,
)}\n`;

const SHARED = "# Shared\n";
const GUIDE = "# Guide\n";

/**
 * ローカルの `ziku.jsonc` を同期ベースとして持つ lock。
 *
 * 和集合を取り込む `pull` はローカルへ書いた内容をベースにするので、ローカルが自分で足した
 * パターンを持ったままベースと一致する状態は通常運用で作られる。
 */
function syncedLock(): string {
  const lock = markSynced(
    createPendingLock({ version: "1.0.0", installedAt: "2024-01-01T00:00:00.000Z", source }),
    {
      hashes: hashMap({
        ".ziku/ziku.jsonc": hashContent(LOCAL_CONFIG),
        "shared.md": hashContent(SHARED),
      }),
    },
  );
  return JSON.stringify(lock, null, 2);
}

/** テンプレートに無いファイル `docs/guide.md` がローカルにだけある状態を作る。 */
function setupLocalOnlyFile(): void {
  vol.fromJSON({
    [`${TEMPLATE_DIR}/.ziku/ziku.jsonc`]: TEMPLATE_CONFIG,
    [`${TEMPLATE_DIR}/shared.md`]: SHARED,
    [`${PROJECT_DIR}/.ziku/ziku.jsonc`]: LOCAL_CONFIG,
    [`${PROJECT_DIR}/.ziku/lock.json`]: syncedLock(),
    [`${PROJECT_DIR}/shared.md`]: SHARED,
    [`${PROJECT_DIR}/docs/guide.md`]: GUIDE,
  });
}

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

function currentLock(): LockState {
  return lockSchema.parse(
    JSON.parse(vol.readFileSync(`${PROJECT_DIR}/.ziku/lock.json`, "utf8") as string),
  );
}

/** lock に記録されている、そのパスの同期ベース。 */
function baseHash(path: string): string | undefined {
  return baseHashesOf(currentLock())[repoRelPath(path)];
}

function readFile(dir: string, path: string): string {
  return vol.readFileSync(`${dir}/${path}`, "utf8") as string;
}

/** テンプレートの `ziku.jsonc` に登録されている include パターン。 */
function templateIncludes(): string[] {
  const parsed = JSON.parse(readFile(TEMPLATE_DIR, ".ziku/ziku.jsonc")) as { include: string[] };
  return parsed.include;
}

describe("今回の push に関係するパターンだけを送る", () => {
  beforeEach(() => {
    vol.reset();
    vi.clearAllMocks();
  });

  it("送るファイルに必要なパターンだけがテンプレートへ渡る", async () => {
    setupLocalOnlyFile();

    await runPush("docs/guide.md");

    expect(templateIncludes()).toContain("docs/guide.md");
    expect(templateIncludes()).not.toContain("private/secret.md");
  });

  it("ローカルの ziku.jsonc は書き換えず、ベースも前進させない", async () => {
    setupLocalOnlyFile();

    await runPush("docs/guide.md");

    // 送ったのはローカルの内容ではないので、ローカルへ書き戻すと無関係なパターンが消える。
    expect(readFile(PROJECT_DIR, ".ziku/ziku.jsonc")).toBe(LOCAL_CONFIG);
    // ベースをテンプレート側へ進めると local != base == template になり、次の分類が
    // ローカルを localOnly と読む。
    expect(baseHash(".ziku/ziku.jsonc")).toBe(hashContent(LOCAL_CONFIG));
  });

  it("続けて push しても、無関係なローカル限定パターンは送られない", async () => {
    setupLocalOnlyFile();

    await runPush("docs/guide.md");
    await runPush();

    expect(templateIncludes()).not.toContain("private/secret.md");
    expect(readFile(PROJECT_DIR, ".ziku/ziku.jsonc")).toBe(LOCAL_CONFIG);
  });
});
