import { vol } from "memfs";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { CopyResult } from "../template";
import { buildTemplateSource } from "../template";

// fs モジュールをモック
vi.mock("node:fs", async () => {
  const memfs = await import("memfs");
  return memfs.fs;
});

// @clack/prompts をモック
vi.mock("@clack/prompts", () => ({
  confirm: vi.fn(),
  isCancel: vi.fn(() => false),
}));

// ui/renderer をモック
vi.mock("../../ui/renderer", () => ({
  log: {
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    success: vi.fn(),
    step: vi.fn(),
    message: vi.fn(),
  },
}));

// モック後にインポート
const { copyFile, writeFileWithStrategy } = await import("../template");
const clack = await import("@clack/prompts");
const mockConfirm = vi.mocked(clack.confirm);

describe("buildTemplateSource", () => {
  it("owner/repo から giget 形式の文字列を構築", () => {
    expect(buildTemplateSource({ owner: "my-org", repo: "my-templates" })).toBe(
      "gh:my-org/my-templates",
    );
  });

  it("ref が指定されている場合は #ref を付与", () => {
    expect(buildTemplateSource({ owner: "my-org", repo: "repo", ref: "develop" })).toBe(
      "gh:my-org/repo#develop",
    );
  });

  it("ref が undefined の場合は付与しない", () => {
    expect(buildTemplateSource({ owner: "x", repo: "y", ref: undefined })).toBe("gh:x/y");
  });
});

// 型をインポート
import type { FileOperationResult } from "../../modules/schemas";

describe("copyFile", () => {
  beforeEach(() => {
    vol.reset();
    vi.clearAllMocks();
  });

  describe("新規ファイル", () => {
    it("常にコピーする", async () => {
      vol.fromJSON({
        "/src/file.txt": "source content",
      });

      const result = await copyFile("/src/file.txt", "/dest/file.txt", "skip", "file.txt");

      expect(result).toEqual<CopyResult>({
        action: "copied",
        path: "file.txt",
      });
      expect(vol.readFileSync("/dest/file.txt", "utf8")).toBe("source content");
    });

    it("親ディレクトリが存在しない場合は作成する", async () => {
      vol.fromJSON({
        "/src/file.txt": "source content",
      });

      await copyFile("/src/file.txt", "/dest/nested/dir/file.txt", "skip", "nested/dir/file.txt");

      expect(vol.existsSync("/dest/nested/dir")).toBe(true);
      expect(vol.readFileSync("/dest/nested/dir/file.txt", "utf8")).toBe("source content");
    });
  });

  describe("既存ファイル - overwrite 戦略", () => {
    it("上書きする", async () => {
      vol.fromJSON({
        "/src/file.txt": "new content",
        "/dest/file.txt": "old content",
      });

      const result = await copyFile("/src/file.txt", "/dest/file.txt", "overwrite", "file.txt");

      expect(result).toEqual<CopyResult>({
        action: "overwritten",
        path: "file.txt",
      });
      expect(vol.readFileSync("/dest/file.txt", "utf8")).toBe("new content");
    });
  });

  describe("既存ファイル - skip 戦略", () => {
    it("スキップする（コピーしない）", async () => {
      vol.fromJSON({
        "/src/file.txt": "new content",
        "/dest/file.txt": "old content",
      });

      const result = await copyFile("/src/file.txt", "/dest/file.txt", "skip", "file.txt");

      expect(result).toEqual<CopyResult>({
        action: "skipped",
        path: "file.txt",
      });
      expect(vol.readFileSync("/dest/file.txt", "utf8")).toBe("old content");
    });
  });

  describe("既存ファイル - prompt 戦略", () => {
    it("ユーザーが Yes の場合は上書きする", async () => {
      vol.fromJSON({
        "/src/file.txt": "new content",
        "/dest/file.txt": "old content",
      });

      mockConfirm.mockResolvedValueOnce(true);

      const result = await copyFile("/src/file.txt", "/dest/file.txt", "prompt", "file.txt");

      expect(result).toEqual<CopyResult>({
        action: "overwritten",
        path: "file.txt",
      });
      expect(vol.readFileSync("/dest/file.txt", "utf8")).toBe("new content");
      expect(mockConfirm).toHaveBeenCalledWith({
        message: "file.txt already exists. Overwrite?",
        initialValue: false,
      });
    });

    it("ユーザーが No の場合はスキップする", async () => {
      vol.fromJSON({
        "/src/file.txt": "new content",
        "/dest/file.txt": "old content",
      });

      mockConfirm.mockResolvedValueOnce(false);

      const result = await copyFile("/src/file.txt", "/dest/file.txt", "prompt", "file.txt");

      expect(result).toEqual<CopyResult>({
        action: "skipped",
        path: "file.txt",
      });
      expect(vol.readFileSync("/dest/file.txt", "utf8")).toBe("old content");
    });
  });
});

describe("writeFileWithStrategy", () => {
  beforeEach(() => {
    vol.reset();
    vi.clearAllMocks();
  });

  describe("新規ファイル", () => {
    it("常に作成する（skip戦略でも）", async () => {
      vol.fromJSON({});

      const result = await writeFileWithStrategy({
        destPath: "/dest/file.txt",
        content: "new content",
        strategy: "skip",
        relativePath: "file.txt",
      });

      expect(result).toEqual<FileOperationResult>({
        action: "created",
        path: "file.txt",
      });
      expect(vol.readFileSync("/dest/file.txt", "utf8")).toBe("new content");
    });

    it("親ディレクトリが存在しない場合は作成する", async () => {
      vol.fromJSON({});

      await writeFileWithStrategy({
        destPath: "/dest/nested/dir/file.txt",
        content: "new content",
        strategy: "skip",
        relativePath: "nested/dir/file.txt",
      });

      expect(vol.existsSync("/dest/nested/dir")).toBe(true);
      expect(vol.readFileSync("/dest/nested/dir/file.txt", "utf8")).toBe("new content");
    });
  });

  describe("既存ファイル - overwrite 戦略", () => {
    it("上書きする", async () => {
      vol.fromJSON({
        "/dest/file.txt": "old content",
      });

      const result = await writeFileWithStrategy({
        destPath: "/dest/file.txt",
        content: "new content",
        strategy: "overwrite",
        relativePath: "file.txt",
      });

      expect(result).toEqual<FileOperationResult>({
        action: "overwritten",
        path: "file.txt",
      });
      expect(vol.readFileSync("/dest/file.txt", "utf8")).toBe("new content");
    });
  });

  describe("既存ファイル - skip 戦略", () => {
    it("スキップする（書き込まない）", async () => {
      vol.fromJSON({
        "/dest/file.txt": "old content",
      });

      const result = await writeFileWithStrategy({
        destPath: "/dest/file.txt",
        content: "new content",
        strategy: "skip",
        relativePath: "file.txt",
      });

      expect(result).toEqual<FileOperationResult>({
        action: "skipped",
        path: "file.txt",
      });
      expect(vol.readFileSync("/dest/file.txt", "utf8")).toBe("old content");
    });
  });

  describe("既存ファイル - prompt 戦略", () => {
    it("ユーザーが Yes の場合は上書きする", async () => {
      vol.fromJSON({
        "/dest/file.txt": "old content",
      });

      mockConfirm.mockResolvedValueOnce(true);

      const result = await writeFileWithStrategy({
        destPath: "/dest/file.txt",
        content: "new content",
        strategy: "prompt",
        relativePath: "file.txt",
      });

      expect(result).toEqual<FileOperationResult>({
        action: "overwritten",
        path: "file.txt",
      });
      expect(vol.readFileSync("/dest/file.txt", "utf8")).toBe("new content");
      expect(mockConfirm).toHaveBeenCalledWith({
        message: "file.txt already exists. Overwrite?",
        initialValue: false,
      });
    });

    it("ユーザーが No の場合はスキップする", async () => {
      vol.fromJSON({
        "/dest/file.txt": "old content",
      });

      mockConfirm.mockResolvedValueOnce(false);

      const result = await writeFileWithStrategy({
        destPath: "/dest/file.txt",
        content: "new content",
        strategy: "prompt",
        relativePath: "file.txt",
      });

      expect(result).toEqual<FileOperationResult>({
        action: "skipped",
        path: "file.txt",
      });
      expect(vol.readFileSync("/dest/file.txt", "utf8")).toBe("old content");
    });
  });
});
