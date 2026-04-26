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

const { analyzeSync } = await import("../sync-analysis");
const { hashContent } = await import("../hash");
const { glob } = await import("tinyglobby");
const mockedGlob = vi.mocked(glob);

describe("sync-analysis", () => {
  beforeEach(() => {
    vol.reset();
    vi.clearAllMocks();
  });

  it("returns classification and three hash maps", async () => {
    vol.fromJSON({
      "/project/foo.txt": "local content",
      "/template/foo.txt": "template content",
    });
    // hashFiles を template / local の2回呼ぶ → 同じ glob を返す
    mockedGlob.mockResolvedValue(["foo.txt"]);

    const result = await analyzeSync({
      targetDir: "/project",
      templateDir: "/template",
      baseHashes: { "foo.txt": hashContent("base content") },
      include: ["**"],
    });

    expect(result.hashes.localHashes["foo.txt"]).toBe(hashContent("local content"));
    expect(result.hashes.templateHashes["foo.txt"]).toBe(hashContent("template content"));
    expect(result.hashes.baseHashes["foo.txt"]).toBe(hashContent("base content"));
    // base, local, template すべて異なる → conflict カテゴリ
    expect(result.classification.conflicts).toContain("foo.txt");
  });

  it("treats undefined baseHashes as empty (init 直後ケース): すべて newFiles", async () => {
    vol.fromJSON({
      "/template/a.txt": "x",
      "/template/b.txt": "y",
    });
    // analyzeSync は Promise.all で先に template、次に local の順で hashFiles を呼ぶ。
    // 1回目は ["a.txt", "b.txt"] (template)、2回目は [] (local) を返すよう順序付ける。
    mockedGlob.mockResolvedValueOnce(["a.txt", "b.txt"]).mockResolvedValueOnce([]);

    const result = await analyzeSync({
      targetDir: "/project",
      templateDir: "/template",
      baseHashes: undefined,
      include: ["**"],
    });

    expect(result.hashes.baseHashes).toEqual({});
    // ローカルにファイルがなく base もないので、すべて newFiles に分類される
    expect(result.classification.newFiles.toSorted()).toEqual(["a.txt", "b.txt"]);
  });

  it("classifies unchanged when local equals template equals base", async () => {
    vol.fromJSON({
      "/project/same.txt": "stable",
      "/template/same.txt": "stable",
    });
    mockedGlob.mockResolvedValue(["same.txt"]);

    const result = await analyzeSync({
      targetDir: "/project",
      templateDir: "/template",
      baseHashes: { "same.txt": hashContent("stable") },
      include: ["**"],
    });

    expect(result.classification.unchanged).toContain("same.txt");
  });
});
