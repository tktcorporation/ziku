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
const {
  loadTemplateModulesFile,
  loadPatternsFile,
  addIncludePattern,
  isFlatFormat,
  getModulesFilePath,
  modulesFileExists,
} = await import("../loader");

describe("loadTemplateModulesFile", () => {
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

    const result = await loadTemplateModulesFile("/project");

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

    const result = await loadTemplateModulesFile("/project");

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

    const result = await loadTemplateModulesFile("/project");

    expect(result.modules).toHaveLength(1);
  });

  it("ファイルが存在しない場合はエラー", async () => {
    vol.fromJSON({});

    await expect(loadTemplateModulesFile("/project")).rejects.toThrow(
      ".ziku/modules.jsonc が見つかりません",
    );
  });

  it("不正な JSON の場合はエラー", async () => {
    vol.fromJSON({
      "/project/.ziku/modules.jsonc": "{ invalid json }",
    });

    await expect(loadTemplateModulesFile("/project")).rejects.toThrow();
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

    await expect(loadTemplateModulesFile("/project")).rejects.toThrow();
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

    const result = await loadTemplateModulesFile("/project");

    expect(result.modules[0].setupDescription).toBe("VS Code で開くとセットアップされます");
  });
});

describe("loadPatternsFile", () => {
  beforeEach(() => {
    vol.reset();
  });

  it("フラット形式を読み込める", async () => {
    const content = JSON.stringify({
      include: ["src/**"],
      exclude: ["*.local"],
    });

    vol.fromJSON({
      "/project/.ziku/modules.jsonc": content,
    });

    const result = await loadPatternsFile("/project");

    expect(result.include).toEqual(["src/**"]);
    expect(result.exclude).toEqual(["*.local"]);
  });

  it("テンプレート形式をフラット化して読み込める", async () => {
    const content = JSON.stringify({
      modules: [
        { name: "A", description: "A", include: ["a.txt"], exclude: ["a.local"] },
        { name: "B", description: "B", include: ["b.txt"] },
      ],
    });

    vol.fromJSON({
      "/project/.ziku/modules.jsonc": content,
    });

    const result = await loadPatternsFile("/project");

    expect(result.include).toEqual(["a.txt", "b.txt"]);
    expect(result.exclude).toEqual(["a.local"]);
  });

  it("ファイルが存在しない場合はエラー", async () => {
    vol.fromJSON({});

    await expect(loadPatternsFile("/project")).rejects.toThrow(
      ".ziku/modules.jsonc が見つかりません",
    );
  });

  it("どちらの形式にも合わない場合はエラー", async () => {
    vol.fromJSON({
      "/project/.ziku/modules.jsonc": JSON.stringify({ invalid: true }),
    });

    await expect(loadPatternsFile("/project")).rejects.toThrow(
      ".ziku/modules.jsonc の形式が不正です",
    );
  });
});

describe("addIncludePattern", () => {
  it("パターンを追加できる", () => {
    const rawContent = JSON.stringify(
      {
        include: [".devcontainer/devcontainer.json"],
        exclude: [],
      },
      null,
      2,
    );

    const result = addIncludePattern(rawContent, [".devcontainer/new.sh"]);

    const parsed = JSON.parse(result);
    expect(parsed.include).toContain(".devcontainer/devcontainer.json");
    expect(parsed.include).toContain(".devcontainer/new.sh");
  });

  it("重複するパターンは追加しない", () => {
    const rawContent = JSON.stringify(
      {
        include: [".devcontainer/devcontainer.json"],
        exclude: [],
      },
      null,
      2,
    );

    const result = addIncludePattern(rawContent, [".devcontainer/devcontainer.json"]);

    // 変更なしの場合は元のコンテンツを返す
    expect(result).toBe(rawContent);
  });

  it("複数のパターンを一度に追加できる", () => {
    const rawContent = JSON.stringify(
      {
        include: [".github/workflows/ci.yml"],
        exclude: [],
      },
      null,
      2,
    );

    const result = addIncludePattern(rawContent, [
      ".github/workflows/test.yml",
      ".github/labeler.yml",
    ]);

    const parsed = JSON.parse(result);
    expect(parsed.include).toHaveLength(3);
  });

  it("include が空の場合にパターンを追加できる", () => {
    const rawContent = JSON.stringify(
      {
        include: [],
        exclude: [],
      },
      null,
      2,
    );

    const result = addIncludePattern(rawContent, ["new-pattern.txt"]);

    const parsed = JSON.parse(result);
    expect(parsed.include).toEqual(["new-pattern.txt"]);
  });
});

describe("isFlatFormat", () => {
  it("フラット形式を正しく判定する", () => {
    const flat = JSON.stringify({ include: [".mcp.json"], exclude: [] });
    expect(isFlatFormat(flat)).toBe(true);
  });

  it("exclude 省略のフラット形式を正しく判定する", () => {
    const flat = JSON.stringify({ include: [".mcp.json"] });
    expect(isFlatFormat(flat)).toBe(true);
  });

  it("モジュール形式を false と判定する", () => {
    const modules = JSON.stringify({
      modules: [{ name: "A", description: "A", include: ["a.txt"] }],
    });
    expect(isFlatFormat(modules)).toBe(false);
  });

  it("不正な形式を false と判定する", () => {
    const invalid = JSON.stringify({ invalid: true });
    expect(isFlatFormat(invalid)).toBe(false);
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
