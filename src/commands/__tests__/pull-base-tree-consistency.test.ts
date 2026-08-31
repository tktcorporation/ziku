/**
 * lock のベースが指すハッシュと SHA が同じツリーを指すことを、症状の側から確かめる。
 *
 * pull がベースを決める計算（`nextSyncBase`）と、その lock を共通祖先の取り寄せに使う
 * マージ（`mergeConflictFiles` → `downloadBaseForMerge`）を実物のまま繋ぎ、
 * 「一度取り込んだテンプレートの変更が、後のコンフリクトで再び差分として現れないか」を見る。
 * テンプレートの取得だけを差し替え、SHA ごとに用意したツリーを返す。
 */
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "pathe";
import { Effect } from "effect";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { AbsPath, LockState, RepoRelPath } from "../../modules/schemas";
import { createPendingLock, markSynced } from "../../modules/schemas";
import { absPath, commitSha, hashMap, repoRelPath, repoRelPaths } from "../../__tests__/brands";
import { nextSyncBase } from "../pull-plan";

vi.mock("../../utils/template", () => ({
  downloadTemplateToTemp: vi.fn(),
  buildCommitPinnedSource: vi.fn(
    (source: { owner: string; repo: string }, sha: string) =>
      `gh:${source.owner}/${source.repo}#${sha}`,
  ),
}));

vi.mock("../../ui/renderer", () => ({
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
    yellow: (s: string) => s,
    red: (s: string) => s,
  },
}));

const { mergeConflictFiles } = await import("../../utils/merge");
const { downloadTemplateToTemp } = await import("../../utils/template");
const mockDownloadTemplateToTemp = vi.mocked(downloadTemplateToTemp);

const CONFIG_FILE = repoRelPath("app.config");

/** 前回の同期時点のテンプレート。 */
const TREE_V1 = "name = app\nregion = us-east\nport = 8080\ndebug = false\n";
/** 今回の pull で取り込むテンプレート。`region` の変更がユーザーへ適用される。 */
const TREE_V2 = "name = app\nregion = eu-west\nport = 8080\ndebug = false\n";
/** 取り込みの後にテンプレートが更に進んだ状態。`region` は V2 のまま。 */
const TREE_V3 = "name = app\nregion = eu-west\nport = 8080\ndebug = false\nretries = 3\n";
/** 取り込んだ後にユーザーが `region` を自分の値へ変えたローカル。 */
const LOCAL_EDITED = "name = app\nregion = tokyo\nport = 8080\ndebug = false\n";
/** 共通祖先が V2 なら、ユーザーの `region` を保ったままテンプレートの追加だけが入る。 */
const MERGED_ON_V2 = "name = app\nregion = tokyo\nport = 8080\ndebug = false\nretries = 3\n";

const SHA_V1 = commitSha("sha-v1");
const SHA_V2 = commitSha("sha-v2");

/** SHA ごとに取り寄せられるテンプレートツリー。 */
const TREES: Record<string, string> = {
  [SHA_V1]: TREE_V1,
  [SHA_V2]: TREE_V2,
};

const tempDirs: AbsPath[] = [];

async function createTempDir(label: string): Promise<AbsPath> {
  const dir = absPath(await mkdtemp(join(tmpdir(), `ziku-base-tree-${label}-`)));
  tempDirs.push(dir);
  return dir;
}

async function writeTree(dir: AbsPath, content: string): Promise<void> {
  await mkdir(dir, { recursive: true });
  await writeFile(join(dir, CONFIG_FILE), content, "utf-8");
}

/**
 * pull が「今回のテンプレート（V2）を取り込んだ」ときに書く lock を、実物の計算で組み立てる。
 *
 * @param resolvedSha 今回解決できたテンプレートのコミット SHA。解決できなければ undefined。
 */
function lockAfterPullingV2(resolvedSha: typeof SHA_V2 | undefined): LockState {
  const previous = markSynced(
    createPendingLock({
      version: "0.1.0",
      installedAt: "2024-01-01T00:00:00.000Z",
      source: { kind: "github", owner: "owner", repo: "repo" },
    }),
    { hashes: hashMap({ [CONFIG_FILE]: "hash-v1" }), commitSha: SHA_V1 },
  );

  return markSynced(
    previous,
    nextSyncBase({
      advance: { hashes: hashMap({ [CONFIG_FILE]: "hash-v2" }), commitSha: resolvedSha },
      previousBase: hashMap({ [CONFIG_FILE]: "hash-v1" }),
      localHashes: hashMap({ [CONFIG_FILE]: "hash-v2" }),
      deletions: { candidates: [], applied: new Set<RepoRelPath>() },
      // 宣言の絞り込みは本テストの主題ではない。走査したパスがそのまま宣言の中にある形。
      declaredPaths: new Set(repoRelPaths([CONFIG_FILE])),
      templatePatterns: undefined,
    }),
  );
}

/**
 * コンフリクトを 1 件マージし、ローカルへ書かれた内容と未解決の経路を返す。
 *
 * pull と同じく、マージできた内容だけをローカルへ書き戻す。
 */
async function mergeConfigFile(params: {
  lock: LockState;
  targetDir: AbsPath;
  templateDir: AbsPath;
}): Promise<{ localContent: string; unresolvedReason: string | undefined }> {
  const unresolved = await Effect.runPromise(
    mergeConflictFiles({
      conflicts: repoRelPaths([CONFIG_FILE]),
      targetDir: params.targetDir,
      templateDir: params.templateDir,
      lock: params.lock,
      onFileResult: ({ outcome }) =>
        Effect.promise(async () => {
          if (outcome._tag === "NoBase") return;
          await writeFile(join(params.targetDir, CONFIG_FILE), outcome.content, "utf-8");
        }),
    }),
  );

  return {
    localContent: await readFile(join(params.targetDir, CONFIG_FILE), "utf-8"),
    unresolvedReason: unresolved[0]?.reason,
  };
}

describe("同期ベースのハッシュと SHA が指すツリー", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockDownloadTemplateToTemp.mockImplementation(async (_targetDir, source, _label) => {
      const sha = String(source).split("#")[1] ?? "";
      const content = TREES[sha];
      if (content === undefined) throw new Error(`no tree for ${sha}`);
      const dir = await createTempDir(`tree-${sha}`);
      await writeTree(dir, content);
      return { templateDir: dir, cleanup: () => {} };
    });
  });

  afterEach(async () => {
    for (const dir of tempDirs.splice(0)) {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it("SHA を解決できなかった pull の後にコンフリクトが起きても、取り込み済みの変更が差分として現れない", async () => {
    const targetDir = await createTempDir("local");
    const templateDir = await createTempDir("template-v3");
    await writeTree(targetDir, LOCAL_EDITED);
    await writeTree(templateDir, TREE_V3);

    const lock = lockAfterPullingV2(undefined);
    const { localContent, unresolvedReason } = await mergeConfigFile({
      lock,
      targetDir,
      templateDir,
    });

    // 前回同期時点のツリー（V1）は共通祖先として取り寄せられない。
    expect(mockDownloadTemplateToTemp).not.toHaveBeenCalled();
    // V2 で取り込み済みの `region = eu-west` が、ローカルへ再び差分として書き込まれない。
    expect(localContent).toBe(LOCAL_EDITED);
    expect(localContent).not.toContain("eu-west");
    // 共通祖先が無いので自動マージは行わず、どちらの版を残すかはユーザーが選ぶ。
    expect(unresolvedReason).toBe("noBase");
  });

  it("ハッシュと SHA が別のツリーを指す lock では、取り込み済みの変更が差分として現れる", async () => {
    const targetDir = await createTempDir("local");
    const templateDir = await createTempDir("template-v3");
    await writeTree(targetDir, LOCAL_EDITED);
    await writeTree(templateDir, TREE_V3);

    // ハッシュは V2、SHA は V1 という食い違った lock。`nextSyncBase` はこれを組み立てない。
    const mixed = markSynced(
      createPendingLock({
        version: "0.1.0",
        installedAt: "2024-01-01T00:00:00.000Z",
        source: { kind: "github", owner: "owner", repo: "repo" },
      }),
      { hashes: hashMap({ [CONFIG_FILE]: "hash-v2" }), commitSha: SHA_V1 },
    );

    const { localContent } = await mergeConfigFile({ lock: mixed, targetDir, templateDir });

    // V1 を共通祖先にすると、V2 で取り込み済みの `region = eu-west` がテンプレート側の
    // 新しい変更として扱われ、ユーザーが決着させたはずの行が再び衝突する。
    expect(localContent).toContain("eu-west");
    expect(localContent).toContain("<<<<<<<");
  });

  it("SHA を解決できた pull の後は、取り込んだツリーを共通祖先にして自動マージできる", async () => {
    const targetDir = await createTempDir("local");
    const templateDir = await createTempDir("template-v3");
    await writeTree(targetDir, LOCAL_EDITED);
    await writeTree(templateDir, TREE_V3);

    const lock = lockAfterPullingV2(SHA_V2);
    const { localContent, unresolvedReason } = await mergeConfigFile({
      lock,
      targetDir,
      templateDir,
    });

    expect(mockDownloadTemplateToTemp).toHaveBeenCalledWith(
      targetDir,
      "gh:owner/repo#sha-v2",
      "base",
    );
    // 取り込み済みの `region` はユーザーの値のまま残り、テンプレートの新しい追加だけが入る。
    expect(localContent).toBe(MERGED_ON_V2);
    expect(unresolvedReason).toBeUndefined();
  });
});
