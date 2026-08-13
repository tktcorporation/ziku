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

const { hashBytes, hashContent, hashFiles } = await import("../hash");
const { glob } = await import("tinyglobby");
const mockedGlob = vi.mocked(glob);

describe("hashBytes", () => {
  it("テキストの内容は utf-8 バイト列のハッシュと一致する（既存 lock との互換）", () => {
    // "hello" の SHA-256。lock.json に記録済みのハッシュがそのまま通ることを固定値で示す。
    expect(hashContent("hello")).toBe(
      "2cf24dba5fb0a30e26e83b2ac5b9e29e1b161e5c1fa7425e73043362938b9824",
    );
    expect(hashBytes(Buffer.from("hello", "utf-8"))).toBe(hashContent("hello"));
  });

  it("マルチバイト文字の内容でもハッシュが一致する", () => {
    const content = "日本語のテキスト\n";
    expect(hashBytes(Buffer.from(content, "utf-8"))).toBe(hashContent(content));
  });

  it("内容の違うバイナリは違うハッシュになる", () => {
    // utf-8 デコードを挟むと、どちらの不正バイトも U+FFFD へ潰れて同じ文字列になる
    const a = Buffer.from([0x00, 0xff, 0x41]);
    const b = Buffer.from([0x00, 0xfe, 0x41]);
    expect(hashBytes(a)).not.toBe(hashBytes(b));
    expect(hashContent(a.toString("utf-8"))).toBe(hashContent(b.toString("utf-8")));
  });
});

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

  it("バイナリファイルは内容が違えば違うハッシュになる", async () => {
    vol.reset();
    vol.mkdirSync("/project", { recursive: true });
    vol.writeFileSync("/project/a.bin", Buffer.from([0x00, 0xff, 0x41]));
    vol.writeFileSync("/project/b.bin", Buffer.from([0x00, 0xfe, 0x41]));
    mockedGlob.mockResolvedValue(["a.bin", "b.bin"]);

    const hashes = await hashFiles("/project", ["**"]);
    expect(hashes["a.bin"]).not.toBe(hashes["b.bin"]);
  });

  it("改行コードが違うファイルは違うハッシュになる（正規化しない）", async () => {
    vol.reset();
    vol.fromJSON({ "/project/lf.txt": "a\nb\n", "/project/crlf.txt": "a\r\nb\r\n" });
    mockedGlob.mockResolvedValue(["lf.txt", "crlf.txt"]);

    const hashes = await hashFiles("/project", ["**"]);
    expect(hashes["lf.txt"]).not.toBe(hashes["crlf.txt"]);
  });
});
