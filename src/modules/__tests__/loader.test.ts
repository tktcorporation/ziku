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
  loadLocalPatternsFile,
  loadPatternsFile,
  addIncludePattern,
  saveModulesFile,
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

describe("loadLocalPatternsFile", () => {
  beforeEach(() => {
    vol.reset();
  });

  it("フラット形式の modules.jsonc を読み込める", async () => {
    const content = JSON.stringify({
      include: [".devcontainer/**", ".github/**"],
      exclude: ["*.local"],
    });

    vol.fromJSON({
      "/project/.ziku/modules.jsonc": content,
    });

    const result = await loadLocalPatternsFile("/project");

    expect(result.include).toEqual([".devcontainer/**", ".github/**"]);
    expect(result.exclude).toEqual(["*.local"]);
    expect(result.rawContent).toBe(content);
  });

  it("exclude が省略された場合は空配列を返す", async () => {
    const content = JSON.stringify({
      include: ["src/**"],
    });

    vol.fromJSON({
      "/project/.ziku/modules.jsonc": content,
    });

    const result = await loadLocalPatternsFile("/project");

    expect(result.include).toEqual(["src/**"]);
    expect(result.exclude).toEqual([]);
  });

  it("JSONC コメント付きフラット形式を読み込める", async () => {
    const content = `{
      // include patterns
      "include": ["src/**"],
      /* exclude patterns */
      "exclude": ["*.test.ts"]
    }`;

    vol.fromJSON({
      "/project/.ziku/modules.jsonc": content,
    });

    const result = await loadLocalPatternsFile("/project");

    expect(result.include).toEqual(["src/**"]);
    expect(result.exclude).toEqual(["*.test.ts"]);
  });

  it("$schema フィールドを無視して読み込める", async () => {
    const content = JSON.stringify({
      $schema: "https://example.com/schema.json",
      include: [".mcp.json"],
    });

    vol.fromJSON({
      "/project/.ziku/modules.jsonc": content,
    });

    const result = await loadLocalPatternsFile("/project");

    expect(result.include).toEqual([".mcp.json"]);
  });

  it("ファイルが存在しない場合はエラー", async () => {
    vol.fromJSON({});

    await expect(loadLocalPatternsFile("/project")).rejects.toThrow(
      ".ziku/modules.jsonc が見つかりません",
    );
  });

  it("スキーマに合わない場合はエラー", async () => {
    vol.fromJSON({
      "/project/.ziku/modules.jsonc": JSON.stringify({
        modules: [{ name: "A", description: "A", include: [] }],
      }),
    });

    await expect(loadLocalPatternsFile("/project")).rejects.toThrow();
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

describe("saveModulesFile", () => {
  beforeEach(() => {
    vol.reset();
  });

  it("モジュールファイルを保存できる", async () => {
    vol.fromJSON({
      "/project/.ziku": null, // ディレクトリを作成
    });

    const content = JSON.stringify({ include: [], exclude: [] });
    await saveModulesFile("/project", content);

    const saved = vol.readFileSync("/project/.ziku/modules.jsonc", "utf8");
    expect(saved).toBe(content);
  });

  it("既存ファイルを上書きできる", async () => {
    vol.fromJSON({
      "/project/.ziku/modules.jsonc": "old content",
    });

    const newContent = JSON.stringify({ include: ["new-pattern.txt"], exclude: [] });
    await saveModulesFile("/project", newContent);

    const saved = vol.readFileSync("/project/.ziku/modules.jsonc", "utf8");
    expect(saved).toBe(newContent);
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
