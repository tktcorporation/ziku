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
  getModuleByIdFromList,
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
          id: ".devcontainer",
          name: "DevContainer",
          description: "VS Code DevContainer 設定",
          patterns: [".devcontainer/**"],
        },
      ],
    });

    vol.fromJSON({
      "/project/.devenv/modules.jsonc": modulesContent,
    });

    const result = await loadModulesFile("/project");

    expect(result.modules).toHaveLength(1);
    expect(result.modules[0].id).toBe(".devcontainer");
    expect(result.rawContent).toBe(modulesContent);
  });

  it("JSONC コメント付きファイルを読み込める", async () => {
    const modulesContent = `{
      // これはコメント
      "modules": [
        {
          "id": ".github",
          "name": "GitHub",
          "description": "GitHub 設定",
          /* 複数行コメント */
          "patterns": [".github/**"]
        }
      ]
    }`;

    vol.fromJSON({
      "/project/.devenv/modules.jsonc": modulesContent,
    });

    const result = await loadModulesFile("/project");

    expect(result.modules).toHaveLength(1);
    expect(result.modules[0].id).toBe(".github");
  });

  it("$schema フィールドを無視して読み込める", async () => {
    const modulesContent = JSON.stringify({
      $schema: "https://example.com/schema.json",
      modules: [
        {
          id: ".",
          name: "Root",
          description: "ルート設定",
          patterns: [".mcp.json"],
        },
      ],
    });

    vol.fromJSON({
      "/project/.devenv/modules.jsonc": modulesContent,
    });

    const result = await loadModulesFile("/project");

    expect(result.modules).toHaveLength(1);
  });

  it("ファイルが存在しない場合はエラー", async () => {
    vol.fromJSON({});

    await expect(loadModulesFile("/project")).rejects.toThrow(
      ".devenv/modules.jsonc が見つかりません",
    );
  });

  it("不正な JSON の場合はエラー", async () => {
    vol.fromJSON({
      "/project/.devenv/modules.jsonc": "{ invalid json }",
    });

    await expect(loadModulesFile("/project")).rejects.toThrow();
  });

  it("スキーマに合わない場合はエラー", async () => {
    vol.fromJSON({
      "/project/.devenv/modules.jsonc": JSON.stringify({
        modules: [
          {
            id: ".devcontainer",
            // name が欠けている
            description: "Test",
            patterns: [],
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
          id: ".devcontainer",
          name: "DevContainer",
          description: "VS Code DevContainer 設定",
          setupDescription: "VS Code で開くとセットアップされます",
          patterns: [".devcontainer/**"],
        },
      ],
    });

    vol.fromJSON({
      "/project/.devenv/modules.jsonc": modulesContent,
    });

    const result = await loadModulesFile("/project");

    expect(result.modules[0].setupDescription).toBe("VS Code で開くとセットアップされます");
  });
});

describe("getModuleByIdFromList", () => {
  const modules = [
    { id: ".devcontainer", name: "DevContainer", description: "Test", patterns: [] },
    { id: ".github", name: "GitHub", description: "Test", patterns: [] },
  ];

  it("ID でモジュールを取得できる", () => {
    const result = getModuleByIdFromList(modules, ".devcontainer");

    expect(result?.id).toBe(".devcontainer");
    expect(result?.name).toBe("DevContainer");
  });

  it("存在しない ID の場合は undefined を返す", () => {
    const result = getModuleByIdFromList(modules, ".claude");

    expect(result).toBeUndefined();
  });

  it("空のリストの場合は undefined を返す", () => {
    const result = getModuleByIdFromList([], ".devcontainer");

    expect(result).toBeUndefined();
  });
});

describe("addPatternToModulesFile", () => {
  it("既存モジュールにパターンを追加できる", () => {
    const rawContent = JSON.stringify(
      {
        modules: [
          {
            id: ".devcontainer",
            name: "DevContainer",
            description: "Test",
            patterns: [".devcontainer/devcontainer.json"],
          },
        ],
      },
      null,
      2,
    );

    const result = addPatternToModulesFile(rawContent, ".devcontainer", [".devcontainer/new.sh"]);

    const parsed = JSON.parse(result);
    expect(parsed.modules[0].patterns).toContain(".devcontainer/devcontainer.json");
    expect(parsed.modules[0].patterns).toContain(".devcontainer/new.sh");
  });

  it("重複するパターンは追加しない", () => {
    const rawContent = JSON.stringify(
      {
        modules: [
          {
            id: ".devcontainer",
            name: "DevContainer",
            description: "Test",
            patterns: [".devcontainer/devcontainer.json"],
          },
        ],
      },
      null,
      2,
    );

    const result = addPatternToModulesFile(rawContent, ".devcontainer", [
      ".devcontainer/devcontainer.json",
    ]);

    // 変更なしの場合は元のコンテンツを返す
    expect(result).toBe(rawContent);
  });

  it("存在しないモジュール ID の場合はエラー", () => {
    const rawContent = JSON.stringify({
      modules: [
        {
          id: ".devcontainer",
          name: "DevContainer",
          description: "Test",
          patterns: [],
        },
      ],
    });

    expect(() => addPatternToModulesFile(rawContent, ".github", ["pattern"])).toThrow(
      "モジュール .github が見つかりません",
    );
  });

  it("複数のパターンを一度に追加できる", () => {
    const rawContent = JSON.stringify(
      {
        modules: [
          {
            id: ".github",
            name: "GitHub",
            description: "Test",
            patterns: [".github/workflows/ci.yml"],
          },
        ],
      },
      null,
      2,
    );

    const result = addPatternToModulesFile(rawContent, ".github", [
      ".github/workflows/test.yml",
      ".github/labeler.yml",
    ]);

    const parsed = JSON.parse(result);
    expect(parsed.modules[0].patterns).toHaveLength(3);
  });
});

describe("addPatternToModulesFileWithCreate", () => {
  it("既存モジュールにパターンを追加できる", () => {
    const rawContent = JSON.stringify(
      {
        modules: [
          {
            id: ".devcontainer",
            name: "DevContainer",
            description: "Test",
            patterns: [".devcontainer/devcontainer.json"],
          },
        ],
      },
      null,
      2,
    );

    const result = addPatternToModulesFileWithCreate(rawContent, ".devcontainer", [
      ".devcontainer/new.sh",
    ]);

    const parsed = JSON.parse(result);
    expect(parsed.modules).toHaveLength(1);
    expect(parsed.modules[0].patterns).toContain(".devcontainer/new.sh");
  });

  it("存在しないモジュールの場合は新規作成する", () => {
    const rawContent = JSON.stringify(
      {
        modules: [
          {
            id: ".",
            name: "Root",
            description: "Root files",
            patterns: [".mcp.json"],
          },
        ],
      },
      null,
      2,
    );

    const result = addPatternToModulesFileWithCreate(rawContent, ".cloud", [".cloud/rules/*.md"]);

    const parsed = JSON.parse(result);
    expect(parsed.modules).toHaveLength(2);
    expect(parsed.modules[1].id).toBe(".cloud");
    expect(parsed.modules[1].patterns).toContain(".cloud/rules/*.md");
  });

  it("新規モジュールにカスタム名と説明を設定できる", () => {
    const rawContent = JSON.stringify({ modules: [] }, null, 2);

    const result = addPatternToModulesFileWithCreate(rawContent, ".cloud", [".cloud/config.json"], {
      name: "Cloud Rules",
      description: "Cloud configuration files",
    });

    const parsed = JSON.parse(result);
    expect(parsed.modules[0].name).toBe("Cloud Rules");
    expect(parsed.modules[0].description).toBe("Cloud configuration files");
  });

  it("新規モジュールのデフォルト名を自動生成する", () => {
    const rawContent = JSON.stringify({ modules: [] }, null, 2);

    const result = addPatternToModulesFileWithCreate(rawContent, ".cloud", [".cloud/rules/*.md"]);

    const parsed = JSON.parse(result);
    expect(parsed.modules[0].name).toBe("Cloud");
    expect(parsed.modules[0].description).toBe("Files in .cloud directory");
  });

  it("ルートモジュールのデフォルト名は Root になる", () => {
    const rawContent = JSON.stringify({ modules: [] }, null, 2);

    const result = addPatternToModulesFileWithCreate(rawContent, ".", [".new-config"]);

    const parsed = JSON.parse(result);
    expect(parsed.modules[0].name).toBe("Root");
    expect(parsed.modules[0].description).toBe("Files in root directory");
  });
});

describe("saveModulesFile", () => {
  beforeEach(() => {
    vol.reset();
  });

  it("モジュールファイルを保存できる", async () => {
    vol.fromJSON({
      "/project/.devenv": null, // ディレクトリを作成
    });

    const content = JSON.stringify({ modules: [] });
    await saveModulesFile("/project", content);

    const saved = vol.readFileSync("/project/.devenv/modules.jsonc", "utf8");
    expect(saved).toBe(content);
  });

  it("既存ファイルを上書きできる", async () => {
    vol.fromJSON({
      "/project/.devenv/modules.jsonc": "old content",
    });

    const newContent = JSON.stringify({ modules: [{ id: "new" }] });
    await saveModulesFile("/project", newContent);

    const saved = vol.readFileSync("/project/.devenv/modules.jsonc", "utf8");
    expect(saved).toBe(newContent);
  });
});

describe("getModulesFilePath", () => {
  it("正しいパスを返す", () => {
    expect(getModulesFilePath("/project")).toBe("/project/.devenv/modules.jsonc");
  });

  it("末尾スラッシュなしでも正しく動作する", () => {
    expect(getModulesFilePath("/path/to/project")).toBe("/path/to/project/.devenv/modules.jsonc");
  });
});

describe("modulesFileExists", () => {
  beforeEach(() => {
    vol.reset();
  });

  it("ファイルが存在する場合は true を返す", () => {
    vol.fromJSON({
      "/project/.devenv/modules.jsonc": "{}",
    });

    expect(modulesFileExists("/project")).toBe(true);
  });

  it("ファイルが存在しない場合は false を返す", () => {
    vol.fromJSON({});

    expect(modulesFileExists("/project")).toBe(false);
  });

  it("ディレクトリのみ存在してファイルがない場合は false を返す", () => {
    vol.fromJSON({
      "/project/.devenv": null,
    });

    expect(modulesFileExists("/project")).toBe(false);
  });
});
