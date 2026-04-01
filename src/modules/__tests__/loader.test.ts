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
  loadModulesFile,
  getModuleByNameFromList,
  addPatternToModulesFile,
  addPatternToModulesFileWithCreate,
  saveModulesFile,
  getModulesFilePath,
  modulesFileExists,
} = await import("../loader");

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

describe("getModuleByNameFromList", () => {
  const modules = [
    { name: "DevContainer", description: "Test", include: [] as string[] },
    { name: "GitHub", description: "Test", include: [] as string[] },
  ];

  it("name でモジュールを取得できる", () => {
    const result = getModuleByNameFromList(modules, "DevContainer");

    expect(result?.name).toBe("DevContainer");
  });

  it("存在しない name の場合は undefined を返す", () => {
    const result = getModuleByNameFromList(modules, "Claude");

    expect(result).toBeUndefined();
  });

  it("空のリストの場合は undefined を返す", () => {
    const result = getModuleByNameFromList([], "DevContainer");

    expect(result).toBeUndefined();
  });
});

describe("addPatternToModulesFile", () => {
  it("既存モジュールにパターンを追加できる", () => {
    const rawContent = JSON.stringify(
      {
        modules: [
          {
            name: "DevContainer",
            description: "Test",
            include: [".devcontainer/devcontainer.json"],
          },
        ],
      },
      null,
      2,
    );

    const result = addPatternToModulesFile(rawContent, "DevContainer", [".devcontainer/new.sh"]);

    const parsed = JSON.parse(result);
    expect(parsed.modules[0].include).toContain(".devcontainer/devcontainer.json");
    expect(parsed.modules[0].include).toContain(".devcontainer/new.sh");
  });

  it("重複するパターンは追加しない", () => {
    const rawContent = JSON.stringify(
      {
        modules: [
          {
            name: "DevContainer",
            description: "Test",
            include: [".devcontainer/devcontainer.json"],
          },
        ],
      },
      null,
      2,
    );

    const result = addPatternToModulesFile(rawContent, "DevContainer", [
      ".devcontainer/devcontainer.json",
    ]);

    // 変更なしの場合は元のコンテンツを返す
    expect(result).toBe(rawContent);
  });

  it("存在しないモジュール名の場合はエラー", () => {
    const rawContent = JSON.stringify({
      modules: [
        {
          name: "DevContainer",
          description: "Test",
          include: [],
        },
      ],
    });

    expect(() => addPatternToModulesFile(rawContent, "GitHub", ["pattern"])).toThrow(
      "モジュール GitHub が見つかりません",
    );
  });

  it("複数のパターンを一度に追加できる", () => {
    const rawContent = JSON.stringify(
      {
        modules: [
          {
            name: "GitHub",
            description: "Test",
            include: [".github/workflows/ci.yml"],
          },
        ],
      },
      null,
      2,
    );

    const result = addPatternToModulesFile(rawContent, "GitHub", [
      ".github/workflows/test.yml",
      ".github/labeler.yml",
    ]);

    const parsed = JSON.parse(result);
    expect(parsed.modules[0].include).toHaveLength(3);
  });
});

describe("addPatternToModulesFileWithCreate", () => {
  it("既存モジュールにパターンを追加できる", () => {
    const rawContent = JSON.stringify(
      {
        modules: [
          {
            name: "DevContainer",
            description: "Test",
            include: [".devcontainer/devcontainer.json"],
          },
        ],
      },
      null,
      2,
    );

    const result = addPatternToModulesFileWithCreate(rawContent, "DevContainer", [
      ".devcontainer/new.sh",
    ]);

    const parsed = JSON.parse(result);
    expect(parsed.modules).toHaveLength(1);
    expect(parsed.modules[0].include).toContain(".devcontainer/new.sh");
  });

  it("存在しないモジュールの場合は新規作成する", () => {
    const rawContent = JSON.stringify(
      {
        modules: [
          {
            name: "Root",
            description: "Root files",
            include: [".mcp.json"],
          },
        ],
      },
      null,
      2,
    );

    const result = addPatternToModulesFileWithCreate(rawContent, "Cloud", [".cloud/rules/*.md"]);

    const parsed = JSON.parse(result);
    expect(parsed.modules).toHaveLength(2);
    expect(parsed.modules[1].name).toBe("Cloud");
    expect(parsed.modules[1].include).toContain(".cloud/rules/*.md");
  });

  it("新規モジュールにカスタム説明を設定できる", () => {
    const rawContent = JSON.stringify({ modules: [] }, null, 2);

    const result = addPatternToModulesFileWithCreate(rawContent, "Cloud Rules", [".cloud/config.json"], {
      description: "Cloud configuration files",
    });

    const parsed = JSON.parse(result);
    expect(parsed.modules[0].name).toBe("Cloud Rules");
    expect(parsed.modules[0].description).toBe("Cloud configuration files");
  });

  it("新規モジュールのデフォルト説明を自動生成する", () => {
    const rawContent = JSON.stringify({ modules: [] }, null, 2);

    const result = addPatternToModulesFileWithCreate(rawContent, "Cloud", [".cloud/rules/*.md"]);

    const parsed = JSON.parse(result);
    expect(parsed.modules[0].name).toBe("Cloud");
    expect(parsed.modules[0].description).toBe("Files matching .cloud/rules/*.md");
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

    const content = JSON.stringify({ modules: [] });
    await saveModulesFile("/project", content);

    const saved = vol.readFileSync("/project/.ziku/modules.jsonc", "utf8");
    expect(saved).toBe(content);
  });

  it("既存ファイルを上書きできる", async () => {
    vol.fromJSON({
      "/project/.ziku/modules.jsonc": "old content",
    });

    const newContent = JSON.stringify({ modules: [{ name: "New", description: "New module", include: [] }] });
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
