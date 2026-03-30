import { vol } from "memfs";
import { beforeEach, describe, expect, it, vi } from "vitest";

// fs モジュールをモック
vi.mock("node:fs/promises", async () => {
  const memfs = await import("memfs");
  return memfs.fs.promises;
});

vi.mock("node:fs", async () => {
  const memfs = await import("memfs");
  return memfs.fs;
});

// モック後にインポート
const {
  deleteManifest,
  generateManifest,
  serializeManifest,
  saveManifest,
  loadManifest,
  manifestExists,
  getSelectedFilePaths,
  getSelectedUntrackedFiles,
  MANIFEST_FILENAME,
} = await import("../manifest");

describe("generateManifest", () => {
  it("基本的なマニフェストを生成できる", () => {
    const result = generateManifest({
      targetDir: "/project",
      diff: {
        files: [],
        summary: { added: 1, modified: 2, deleted: 0, unchanged: 3 },
      },
      pushableFiles: [
        { path: ".devcontainer/devcontainer.json", type: "modified" },
        { path: ".github/workflows/ci.yml", type: "added" },
      ],
    });

    expect(result.version).toBe(1);
    expect(result.files).toHaveLength(2);
    expect(result.files[0]).toEqual({
      path: ".devcontainer/devcontainer.json",
      type: "modified",
      selected: true,
    });
    expect(result.summary).toEqual({ added: 1, modified: 2, deleted: 0 });
  });

  it("未追跡ファイルを含むマニフェストを生成できる", () => {
    const result = generateManifest({
      targetDir: "/project",
      diff: {
        files: [],
        summary: { added: 0, modified: 1, deleted: 0, unchanged: 0 },
      },
      pushableFiles: [{ path: ".devcontainer/devcontainer.json", type: "modified" }],
      untrackedByFolder: [
        {
          folder: ".devcontainer",
          files: [
            {
              path: ".devcontainer/custom.sh",
              folder: ".devcontainer",
              moduleId: ".devcontainer",
            },
          ],
        },
      ],
    });

    expect(result.untracked_files).toHaveLength(1);
    expect(result.untracked_files?.[0]).toEqual({
      path: ".devcontainer/custom.sh",
      module_id: ".devcontainer",
      selected: false, // デフォルトは非選択
    });
  });

  it("カスタムタイトルを設定できる", () => {
    const result = generateManifest({
      targetDir: "/project",
      diff: {
        files: [],
        summary: { added: 0, modified: 0, deleted: 0, unchanged: 0 },
      },
      pushableFiles: [],
      defaultTitle: "feat: custom title",
    });

    expect(result.pr.title).toBe("feat: custom title");
  });
});

describe("serializeManifest", () => {
  it("マニフェストをYAML形式でシリアライズできる", () => {
    const manifest = generateManifest({
      targetDir: "/project",
      diff: {
        files: [],
        summary: { added: 1, modified: 0, deleted: 0, unchanged: 0 },
      },
      pushableFiles: [{ path: "test.txt", type: "added" }],
    });

    const yaml = serializeManifest(manifest);

    expect(yaml).toContain("# ziku push manifest");
    expect(yaml).toContain("version: 1");
    expect(yaml).toContain("path: test.txt");
    expect(yaml).toContain("selected: true");
  });

  it("ヘッダーコメントに使用方法が含まれる", () => {
    const manifest = generateManifest({
      targetDir: "/project",
      diff: {
        files: [],
        summary: { added: 0, modified: 0, deleted: 0, unchanged: 0 },
      },
      pushableFiles: [],
    });

    const yaml = serializeManifest(manifest);

    expect(yaml).toContain("USAGE (for AI agents and humans):");
    expect(yaml).toContain("ziku push --execute");
  });
});

describe("saveManifest / loadManifest", () => {
  beforeEach(() => {
    vol.reset();
  });

  it("マニフェストを保存して読み込める", async () => {
    vol.fromJSON({
      "/project": null,
    });

    const manifest = generateManifest({
      targetDir: "/project",
      diff: {
        files: [],
        summary: { added: 1, modified: 2, deleted: 0, unchanged: 0 },
      },
      pushableFiles: [{ path: ".devcontainer/devcontainer.json", type: "modified" }],
    });

    await saveManifest("/project", manifest);
    const loaded = await loadManifest("/project");

    expect(loaded.version).toBe(1);
    expect(loaded.files).toEqual(manifest.files);
    expect(loaded.summary).toEqual(manifest.summary);
  });

  it("マニフェストファイルが存在しない場合はエラー", async () => {
    vol.fromJSON({});

    await expect(loadManifest("/project")).rejects.toThrow("Manifest file not found");
  });

  it("不正なマニフェストファイルの場合はエラー", async () => {
    vol.fromJSON({
      [`/project/${MANIFEST_FILENAME}`]: "invalid: yaml: content:",
    });

    await expect(loadManifest("/project")).rejects.toThrow();
  });
});

describe("manifestExists", () => {
  beforeEach(() => {
    vol.reset();
  });

  it("マニフェストファイルが存在する場合は true", () => {
    vol.fromJSON({
      [`/project/${MANIFEST_FILENAME}`]: "version: 1",
    });

    expect(manifestExists("/project")).toBe(true);
  });

  it("マニフェストファイルが存在しない場合は false", () => {
    vol.fromJSON({});

    expect(manifestExists("/project")).toBe(false);
  });
});

describe("deleteManifest", () => {
  beforeEach(() => {
    vol.reset();
  });

  it("マニフェストファイルを削除できる", async () => {
    vol.fromJSON({
      [`/project/${MANIFEST_FILENAME}`]: "version: 1",
    });

    expect(manifestExists("/project")).toBe(true);
    await deleteManifest("/project");
    expect(manifestExists("/project")).toBe(false);
  });

  it("マニフェストファイルが存在しない場合でもエラーにならない", async () => {
    vol.fromJSON({});

    await expect(deleteManifest("/project")).resolves.not.toThrow();
  });
});

describe("getSelectedFilePaths", () => {
  it("選択されたファイルのパスのみを返す", () => {
    const manifest = {
      version: 1 as const,
      generated_at: new Date().toISOString(),
      github: {},
      pr: { title: "test" },
      files: [
        { path: "file1.txt", type: "added" as const, selected: true },
        { path: "file2.txt", type: "modified" as const, selected: false },
        { path: "file3.txt", type: "added" as const, selected: true },
      ],
      summary: { added: 2, modified: 1, deleted: 0 },
    };

    const result = getSelectedFilePaths(manifest);

    expect(result).toEqual(["file1.txt", "file3.txt"]);
  });

  it("選択されたファイルがない場合は空配列", () => {
    const manifest = {
      version: 1 as const,
      generated_at: new Date().toISOString(),
      github: {},
      pr: { title: "test" },
      files: [{ path: "file1.txt", type: "added" as const, selected: false }],
      summary: { added: 1, modified: 0, deleted: 0 },
    };

    const result = getSelectedFilePaths(manifest);

    expect(result).toEqual([]);
  });
});

describe("getSelectedUntrackedFiles", () => {
  it("選択された未追跡ファイルをモジュールID別に返す", () => {
    const manifest = {
      version: 1 as const,
      generated_at: new Date().toISOString(),
      github: {},
      pr: { title: "test" },
      files: [],
      untracked_files: [
        { path: ".devcontainer/a.sh", module_id: ".devcontainer", selected: true },
        { path: ".devcontainer/b.sh", module_id: ".devcontainer", selected: false },
        { path: ".github/c.yml", module_id: ".github", selected: true },
      ],
      summary: { added: 0, modified: 0, deleted: 0 },
    };

    const result = getSelectedUntrackedFiles(manifest);

    expect(result.get(".devcontainer")).toEqual([".devcontainer/a.sh"]);
    expect(result.get(".github")).toEqual([".github/c.yml"]);
  });

  it("未追跡ファイルがない場合は空のMap", () => {
    const manifest = {
      version: 1 as const,
      generated_at: new Date().toISOString(),
      github: {},
      pr: { title: "test" },
      files: [],
      summary: { added: 0, modified: 0, deleted: 0 },
    };

    const result = getSelectedUntrackedFiles(manifest);

    expect(result.size).toBe(0);
  });
});
