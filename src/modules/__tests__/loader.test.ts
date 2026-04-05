import { vol } from "memfs";
import { beforeEach, describe, expect, it, vi } from "vitest";

// fs モジュールをモック
vi.mock("node:fs", async () => {
  const memfs = await import("memfs");
  return memfs.fs;
});

vi.mock("node:fs/promises", async () => {
  const memfs = await import("memfs");
  return memfs.fs.promises;
});

// モック後にインポート
const { loadModulesFile, flattenModules, getModulesFilePath, modulesFileExists } =
  await import("../loader");

describe("loadModulesFile", () => {
  beforeEach(() => {
    vol.reset();
  });

  it("正常な modules.jsonc を読み込める", async () => {
    const modulesContent = JSON.stringify({
      modules: [
        {
          name: "DevContainer",
          description: "VS Code DevContainer 設定",
          include: [".devcontainer/**"],
        },
      ],
    });

    vol.fromJSON({
      "/project/.ziku/modules.jsonc": modulesContent,
    });

    const result = await loadModulesFile("/project");

    expect(result.modules).toHaveLength(1);
    expect(result.modules[0].name).toBe("DevContainer");
    expect(result.rawContent).toBe(modulesContent);
  });

  it("JSONC コメント付きファイルを読み込める", async () => {
    const modulesContent = `{
      // これはコメント
      "modules": [
        {
          "name": "GitHub",
          "description": "GitHub 設定",
          /* 複数行コメント */
          "include": [".github/**"]
        }
      ]
    }`;

    vol.fromJSON({
      "/project/.ziku/modules.jsonc": modulesContent,
    });

    const result = await loadModulesFile("/project");

    expect(result.modules).toHaveLength(1);
    expect(result.modules[0].name).toBe("GitHub");
  });

  it("$schema フィールドを無視して読み込める", async () => {
    const modulesContent = JSON.stringify({
      $schema: "https://example.com/schema.json",
      modules: [
        {
          name: "Root",
          description: "ルート設定",
          include: [".mcp.json"],
        },
      ],
    });

    vol.fromJSON({
      "/project/.ziku/modules.jsonc": modulesContent,
    });

    const result = await loadModulesFile("/project");

    expect(result.modules).toHaveLength(1);
  });

  it("ファイルが存在しない場合はエラー", async () => {
    vol.fromJSON({});

    await expect(loadModulesFile("/project")).rejects.toThrow(
      ".ziku/modules.jsonc が見つかりません",
    );
  });

  it("不正な JSON の場合はエラー", async () => {
    vol.fromJSON({
      "/project/.ziku/modules.jsonc": "{ invalid json }",
    });

    await expect(loadModulesFile("/project")).rejects.toThrow();
  });

  it("スキーマに合わない場合はエラー", async () => {
    vol.fromJSON({
      "/project/.ziku/modules.jsonc": JSON.stringify({
        modules: [
          {
            // name が欠けている
            description: "Test",
            include: [],
          },
        ],
      }),
    });

    await expect(loadModulesFile("/project")).rejects.toThrow();
  });

  it("フラット形式（modules フィールドなし）はエラー", async () => {
    vol.fromJSON({
      "/project/.ziku/modules.jsonc": JSON.stringify({
        include: [".mcp.json"],
      }),
    });

    await expect(loadModulesFile("/project")).rejects.toThrow();
  });

  it("setupDescription を含むモジュールを読み込める", async () => {
    const modulesContent = JSON.stringify({
      modules: [
        {
          name: "DevContainer",
          description: "VS Code DevContainer 設定",
          setupDescription: "VS Code で開くとセットアップされます",
          include: [".devcontainer/**"],
        },
      ],
    });

    vol.fromJSON({
      "/project/.ziku/modules.jsonc": modulesContent,
    });

    const result = await loadModulesFile("/project");

    expect(result.modules[0].setupDescription).toBe("VS Code で開くとセットアップされます");
  });
});

describe("flattenModules", () => {
  it("複数モジュールの include/exclude をフラット化する", () => {
    const result = flattenModules([
      { name: "A", description: "A", include: ["a.txt"], exclude: ["a.local"] },
      { name: "B", description: "B", include: ["b.txt"] },
    ]);

    expect(result.include).toEqual(["a.txt", "b.txt"]);
    expect(result.exclude).toEqual(["a.local"]);
  });

  it("空のモジュール配列を処理できる", () => {
    const result = flattenModules([]);

    expect(result.include).toEqual([]);
    expect(result.exclude).toEqual([]);
  });
});

describe("getModulesFilePath", () => {
  it("正しいパスを返す", () => {
    expect(getModulesFilePath("/project")).toBe("/project/.ziku/modules.jsonc");
  });

  it("末尾スラッシュなしでも正しく動作する", () => {
    expect(getModulesFilePath("/path/to/project")).toBe("/path/to/project/.ziku/modules.jsonc");
  });
});

describe("modulesFileExists", () => {
  beforeEach(() => {
    vol.reset();
  });

  it("ファイルが存在する場合は true を返す", () => {
    vol.fromJSON({
      "/project/.ziku/modules.jsonc": "{}",
    });

    expect(modulesFileExists("/project")).toBe(true);
  });

  it("ファイルが存在しない場合は false を返す", () => {
    vol.fromJSON({});

    expect(modulesFileExists("/project")).toBe(false);
  });

  it("ディレクトリのみ存在してファイルがない場合は false を返す", () => {
    vol.fromJSON({
      "/project/.ziku": null,
    });

    expect(modulesFileExists("/project")).toBe(false);
  });
});
