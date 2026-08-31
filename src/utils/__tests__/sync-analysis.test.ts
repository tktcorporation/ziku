import { vol } from "memfs";
import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("node:fs/promises", async () => {
  const memfs = await import("memfs");
  return memfs.fs.promises;
});

vi.mock("node:fs", async () => {
  const memfs = await import("memfs");
  return memfs.fs;
});

vi.mock("tinyglobby", () => ({
  glob: vi.fn(),
}));

const { absPath, repoRelPath, syncScope } = await import("../../__tests__/brands");
const { analyzeSync, restrictToDeclaredScope } = await import("../sync-analysis");
const { classifyFiles } = await import("../merge");
const { partitionSyncPlan } = await import("../merge/sync-plan");
const { hashContent } = await import("../hash");
const { glob } = await import("tinyglobby");
const mockedGlob = vi.mocked(glob);

describe("sync-analysis", () => {
  beforeEach(() => {
    vol.reset();
    vi.clearAllMocks();
  });

  it("returns a sync plan and three hash maps", async () => {
    vol.fromJSON({
      "/project/foo.txt": "local content",
      "/template/foo.txt": "template content",
    });
    // hashFiles を template / local の2回呼ぶ → 同じ glob を返す
    mockedGlob.mockResolvedValue(["foo.txt"]);

    const result = await analyzeSync({
      targetDir: absPath("/project"),
      templateDir: absPath("/template"),
      baseHashes: { [repoRelPath("foo.txt")]: hashContent("base content") },
      scope: syncScope({ include: ["**"] }),
    });

    expect(result.hashes.localHashes[repoRelPath("foo.txt")]).toBe(hashContent("local content"));
    expect(result.hashes.templateHashes[repoRelPath("foo.txt")]).toBe(
      hashContent("template content"),
    );
    expect(result.hashes.baseHashes[repoRelPath("foo.txt")]).toBe(hashContent("base content"));
    // base, local, template すべて異なる → conflict カテゴリ
    expect(result.plan.files.conflicts).toContain("foo.txt");
  });

  it("treats empty baseHashes as no base (init 直後ケース): すべて newFiles", async () => {
    vol.fromJSON({
      "/template/a.txt": "x",
      "/template/b.txt": "y",
    });
    // analyzeSync は Promise.all で先に template、次に local の順で hashFiles を呼ぶ。
    // 1回目は ["a.txt", "b.txt"] (template)、2回目は [] (local) を返すよう順序付ける。
    mockedGlob.mockResolvedValueOnce(["a.txt", "b.txt"]).mockResolvedValueOnce([]);

    const result = await analyzeSync({
      targetDir: absPath("/project"),
      templateDir: absPath("/template"),
      baseHashes: {},
      scope: syncScope({ include: ["**"] }),
    });

    expect(result.hashes.baseHashes).toEqual({});
    // ローカルにファイルがなく base もないので、すべて newFiles に分類される
    expect(result.plan.files.newFiles.toSorted()).toEqual(["a.txt", "b.txt"]);
  });

  it("分類は返す hashes だけから導かれる（同じハッシュなら呼び出し元によらず同じ分類になる）", async () => {
    vol.fromJSON({
      "/project/changed.txt": "local",
      "/project/same.txt": "same",
      "/template/changed.txt": "template",
      "/template/same.txt": "same",
    });
    mockedGlob.mockResolvedValue(["changed.txt", "same.txt"]);

    const result = await analyzeSync({
      targetDir: absPath("/project"),
      templateDir: absPath("/template"),
      baseHashes: {
        [repoRelPath("changed.txt")]: hashContent("base"),
        [repoRelPath("same.txt")]: hashContent("same"),
      },
      scope: syncScope({ include: ["**"], exclude: ["ignored/**"] }),
    });

    // pull / push / status は同じ 3 つのハッシュマップを渡す限り同じ分類を受け取る。
    expect(result.plan).toEqual(partitionSyncPlan(classifyFiles(result.hashes)));
  });

  it("classifies unchanged when local equals template equals base", async () => {
    vol.fromJSON({
      "/project/same.txt": "stable",
      "/template/same.txt": "stable",
    });
    mockedGlob.mockResolvedValue(["same.txt"]);

    const result = await analyzeSync({
      targetDir: absPath("/project"),
      templateDir: absPath("/template"),
      baseHashes: { [repoRelPath("same.txt")]: hashContent("stable") },
      scope: syncScope({ include: ["**"] }),
    });

    expect(result.plan.files.unchanged).toContain("same.txt");
  });

  it("gitignore されたファイルはどの分類カテゴリにも現れない", async () => {
    vol.fromJSON({
      "/project/.env": "TOKEN=local",
      "/template/.env": "TOKEN=template",
    });
    mockedGlob.mockResolvedValue([".env"]);

    const result = await analyzeSync({
      targetDir: absPath("/project"),
      templateDir: absPath("/template"),
      baseHashes: {},
      scope: syncScope({ include: ["**"], gitignore: [".env"] }),
    });

    // 分類に乗ると pull の書き換え対象にも push の送信候補にもなる。範囲の外にある
    // ファイルはどちらの候補にも上がらない。
    expect(Object.values(result.plan.files).flat()).toEqual([]);
    expect(result.hashes.localHashes).toEqual({});
    expect(result.hashes.templateHashes).toEqual({});
  });
});

describe("restrictToDeclaredScope", () => {
  /** 全カテゴリに同じ 1 パスを入れた分類。どのカテゴリが宣言の外を許すかだけを見る。 */
  function everyCategoryWith(path: string) {
    const paths = [repoRelPath(path)];
    return {
      autoUpdate: [...paths],
      localOnly: [...paths],
      conflicts: [...paths],
      newFiles: [...paths],
      deletedFiles: [...paths],
      deletedWithLocalEdits: [...paths],
      deletedLocally: [...paths],
      unchanged: [...paths],
    };
  }

  it("宣言の中のパスはどのカテゴリでもそのまま残る", () => {
    const result = restrictToDeclaredScope(everyCategoryWith("a.md"), () => true);

    expect(result).toEqual(everyCategoryWith("a.md"));
  });

  it("宣言の外のパスは、テンプレート側の削除を表す 2 カテゴリにだけ残る", () => {
    // 削除を最後まで見届けるための例外。残りは同期対象ではないので、テンプレートの内容を
    // 配置したりローカルの変更を送ったりする経路へ載せない。
    const result = restrictToDeclaredScope(everyCategoryWith("retired.sh"), () => false);

    expect(result).toEqual({
      autoUpdate: [],
      localOnly: [],
      conflicts: [],
      newFiles: [],
      deletedFiles: [repoRelPath("retired.sh")],
      deletedWithLocalEdits: [repoRelPath("retired.sh")],
      deletedLocally: [],
      unchanged: [],
    });
  });
});
