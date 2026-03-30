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

/**
 * tinyglobby は実際の fs を直接使うため memfs と互換性がない。
 * glob をモックして memfs の vol から相対パスを返すようにする。
 */
vi.mock("tinyglobby", () => ({
  glob: vi.fn(),
}));

const { hashContent, hashFiles } = await import("../hash");
const { glob } = await import("tinyglobby");
const mockedGlob = vi.mocked(glob);

describe("hashContent", () => {
  it("should return consistent SHA-256 hash for same input", () => {
    const hash1 = hashContent("hello");
    const hash2 = hashContent("hello");
    expect(hash1).toBe(hash2);
  });

  it("should return different hashes for different input", () => {
    expect(hashContent("hello")).not.toBe(hashContent("world"));
  });

  it("should return 64-char hex string", () => {
    const hash = hashContent("test");
    expect(hash).toMatch(/^[0-9a-f]{64}$/);
  });
});

describe("hashFiles", () => {
  beforeEach(() => {
    vol.reset();
    vi.clearAllMocks();
  });

  it("should hash all matching files", async () => {
    vol.fromJSON({
      "/project/.github/ci.yml": "name: CI",
      "/project/.github/label.yml": "labels: []",
      "/project/README.md": "# Hello",
    });

    mockedGlob.mockResolvedValue([".github/ci.yml", ".github/label.yml"]);

    const hashes = await hashFiles("/project", [".github/**"]);
    expect(Object.keys(hashes)).toHaveLength(2);
    expect(hashes[".github/ci.yml"]).toBeDefined();
    expect(hashes[".github/label.yml"]).toBeDefined();
    expect(hashes["README.md"]).toBeUndefined();
  });

  it("should return empty map for no matches", async () => {
    vol.fromJSON({ "/project/README.md": "# Hello" });
    mockedGlob.mockResolvedValue([]);

    const hashes = await hashFiles("/project", [".nonexistent/**"]);
    expect(hashes).toEqual({});
  });

  it("should produce consistent hashes", async () => {
    vol.fromJSON({ "/project/file.txt": "content" });
    mockedGlob.mockResolvedValue(["file.txt"]);

    const hashes = await hashFiles("/project", ["**"]);
    expect(hashes["file.txt"]).toBe(hashContent("content"));
  });
});
