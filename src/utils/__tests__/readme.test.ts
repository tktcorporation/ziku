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
const { generateReadme, updateReadmeFile, detectAndUpdateReadme } = await import("../readme");

describe("generateReadme", () => {
  beforeEach(() => {
    vol.reset();
  });

  it("README が存在しない場合は updated: false を返す", async () => {
    vol.fromJSON({});

    const result = await generateReadme({
      readmePath: "/project/README.md",
      modulesPath: "/project/.devenv/modules.jsonc",
    });

    expect(result.updated).toBe(false);
    expect(result.content).toBe("");
  });

  it("マーカーがない README は更新しない", async () => {
    const originalReadme = "# My Project\n\nSome content";
    vol.fromJSON({
      "/project/README.md": originalReadme,
      "/project/.devenv/modules.jsonc": JSON.stringify({ modules: [] }),
    });

    const result = await generateReadme({
      readmePath: "/project/README.md",
      modulesPath: "/project/.devenv/modules.jsonc",
    });

    expect(result.updated).toBe(false);
    expect(result.content).toBe(originalReadme);
  });

  it("FEATURES マーカー間のコンテンツを更新する", async () => {
    const readme = `# My Project

<!-- FEATURES:START -->
Old content
<!-- FEATURES:END -->

Other content`;

    const modulesJson = JSON.stringify({
      modules: [
        { id: ".devcontainer", name: "DevContainer", description: "Docker 開発環境", patterns: [] },
      ],
    });

    vol.fromJSON({
      "/project/README.md": readme,
      "/project/.devenv/modules.jsonc": modulesJson,
    });

    const result = await generateReadme({
      readmePath: "/project/README.md",
      modulesPath: "/project/.devenv/modules.jsonc",
    });

    expect(result.updated).toBe(true);
    expect(result.content).toContain("**DevContainer**");
    expect(result.content).toContain("Docker 開発環境");
    expect(result.content).not.toContain("Old content");
  });

  it("FILES マーカー間のコンテンツを更新する", async () => {
    const readme = `# My Project

<!-- FILES:START -->
Old files
<!-- FILES:END -->`;

    const modulesJson = JSON.stringify({
      modules: [
        {
          id: ".devcontainer",
          name: "DevContainer",
          description: "Docker 開発環境",
          patterns: [".devcontainer/devcontainer.json"],
        },
      ],
    });

    vol.fromJSON({
      "/project/README.md": readme,
      "/project/.devenv/modules.jsonc": modulesJson,
    });

    const result = await generateReadme({
      readmePath: "/project/README.md",
      modulesPath: "/project/.devenv/modules.jsonc",
    });

    expect(result.updated).toBe(true);
    expect(result.content).toContain(".devcontainer/devcontainer.json");
    expect(result.content).not.toContain("Old files");
  });

  it("modules.jsonc が存在しない場合は空のモジュールリストとして扱う", async () => {
    const readme = `# My Project

<!-- FEATURES:START -->
Old content
<!-- FEATURES:END -->`;

    vol.fromJSON({
      "/project/README.md": readme,
    });

    const result = await generateReadme({
      readmePath: "/project/README.md",
      modulesPath: "/project/.devenv/modules.jsonc",
    });

    // モジュールがないので更新されない
    expect(result.updated).toBe(false);
  });

  it("COMMANDS マーカーをカスタム関数で更新する", async () => {
    const readme = `# My Project

<!-- COMMANDS:START -->
Old commands
<!-- COMMANDS:END -->`;

    vol.fromJSON({
      "/project/README.md": readme,
      "/project/.devenv/modules.jsonc": JSON.stringify({ modules: [] }),
    });

    const result = await generateReadme({
      readmePath: "/project/README.md",
      modulesPath: "/project/.devenv/modules.jsonc",
      generateCommandsSection: async () => "## Commands\n\n- `pnpm dev`\n",
    });

    expect(result.updated).toBe(true);
    expect(result.content).toContain("pnpm dev");
    expect(result.content).not.toContain("Old commands");
  });

  it("複数のマーカーを同時に更新できる", async () => {
    const readme = `# My Project

<!-- FEATURES:START -->
Old features
<!-- FEATURES:END -->

Some text

<!-- FILES:START -->
Old files
<!-- FILES:END -->`;

    const modulesJson = JSON.stringify({
      modules: [
        {
          id: ".",
          name: "ルート設定",
          description: "ルート設定ファイル",
          patterns: [".mcp.json"],
        },
      ],
    });

    vol.fromJSON({
      "/project/README.md": readme,
      "/project/.devenv/modules.jsonc": modulesJson,
    });

    const result = await generateReadme({
      readmePath: "/project/README.md",
      modulesPath: "/project/.devenv/modules.jsonc",
    });

    expect(result.updated).toBe(true);
    expect(result.content).toContain("**ルート設定**");
    expect(result.content).toContain(".mcp.json");
  });

  it("glob パターンを持つファイルに (パターン) ラベルを付ける", async () => {
    const readme = `# My Project

<!-- FILES:START -->
<!-- FILES:END -->`;

    const modulesJson = JSON.stringify({
      modules: [
        {
          id: ".devcontainer",
          name: "DevContainer",
          description: "Docker 開発環境",
          patterns: [".devcontainer/*.sh"],
        },
      ],
    });

    vol.fromJSON({
      "/project/README.md": readme,
      "/project/.devenv/modules.jsonc": modulesJson,
    });

    const result = await generateReadme({
      readmePath: "/project/README.md",
      modulesPath: "/project/.devenv/modules.jsonc",
    });

    expect(result.content).toContain("(パターン)");
  });
});

describe("updateReadmeFile", () => {
  beforeEach(() => {
    vol.reset();
  });

  it("更新があればファイルに書き込む", async () => {
    const readme = `# My Project

<!-- FEATURES:START -->
<!-- FEATURES:END -->`;

    const modulesJson = JSON.stringify({
      modules: [{ id: ".", name: "Root", description: "ルート設定", patterns: [] }],
    });

    vol.fromJSON({
      "/project/README.md": readme,
      "/project/.devenv/modules.jsonc": modulesJson,
    });

    const result = await updateReadmeFile({
      readmePath: "/project/README.md",
      modulesPath: "/project/.devenv/modules.jsonc",
    });

    expect(result.updated).toBe(true);

    const savedContent = vol.readFileSync("/project/README.md", "utf8");
    expect(savedContent).toContain("**Root**");
  });

  it("更新がなければファイルに書き込まない", async () => {
    const readme = "# My Project\n\nNo markers here";

    vol.fromJSON({
      "/project/README.md": readme,
      "/project/.devenv/modules.jsonc": JSON.stringify({ modules: [] }),
    });

    await updateReadmeFile({
      readmePath: "/project/README.md",
      modulesPath: "/project/.devenv/modules.jsonc",
    });

    const savedContent = vol.readFileSync("/project/README.md", "utf8");
    expect(savedContent).toBe(readme);
  });
});

describe("detectAndUpdateReadme", () => {
  beforeEach(() => {
    vol.reset();
  });

  it("README が存在しない場合は null を返す", async () => {
    vol.fromJSON({});

    const result = await detectAndUpdateReadme("/project", "/template");

    expect(result).toBeNull();
  });

  it("マーカーがない README の場合は null を返す", async () => {
    vol.fromJSON({
      "/project/README.md": "# My Project\n\nNo markers",
    });

    const result = await detectAndUpdateReadme("/project", "/template");

    expect(result).toBeNull();
  });

  it("FEATURES マーカーがあれば更新する", async () => {
    vol.fromJSON({
      "/project/README.md": "# My Project\n\n<!-- FEATURES:START -->\n<!-- FEATURES:END -->",
      "/template/.devenv/modules.jsonc": JSON.stringify({
        modules: [{ id: ".", name: "Root", description: "Test", patterns: [] }],
      }),
    });

    const result = await detectAndUpdateReadme("/project", "/template");

    expect(result).not.toBeNull();
    expect(result?.updated).toBe(true);
  });

  it("FILES マーカーがあれば更新する", async () => {
    vol.fromJSON({
      "/project/README.md": "# My Project\n\n<!-- FILES:START -->\n<!-- FILES:END -->",
      "/template/.devenv/modules.jsonc": JSON.stringify({
        modules: [{ id: ".", name: "Root", description: "Test", patterns: [".mcp.json"] }],
      }),
    });

    const result = await detectAndUpdateReadme("/project", "/template");

    expect(result).not.toBeNull();
    expect(result?.updated).toBe(true);
  });
});
