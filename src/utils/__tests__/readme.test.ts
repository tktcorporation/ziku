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

const CONFIG_PATH = "/project/.ziku/ziku.jsonc";

describe("generateReadme", () => {
  beforeEach(() => {
    vol.reset();
  });

  it("README が存在しない場合は updated: false を返す", async () => {
    vol.fromJSON({});

    const result = await generateReadme({
      readmePath: "/project/README.md",
      configPath: CONFIG_PATH,
    });

    expect(result.updated).toBe(false);
    expect(result.content).toBe("");
  });

  it("マーカーがない README は更新しない", async () => {
    const originalReadme = "# My Project\n\nSome content";
    vol.fromJSON({
      "/project/README.md": originalReadme,
      [CONFIG_PATH]: JSON.stringify({ include: [] }),
    });

    const result = await generateReadme({
      readmePath: "/project/README.md",
      configPath: CONFIG_PATH,
    });

    expect(result.updated).toBe(false);
    expect(result.content).toBe(originalReadme);
  });

  it("ziku.jsonc の include から FEATURES マーカー間を更新する", async () => {
    const readme = `# My Project

<!-- FEATURES:START -->
Old content
<!-- FEATURES:END -->

Other content`;

    vol.fromJSON({
      "/project/README.md": readme,
      [CONFIG_PATH]: JSON.stringify({
        $schema: "https://example.test/ziku.json",
        include: [".devcontainer/devcontainer.json"],
      }),
    });

    const result = await generateReadme({
      readmePath: "/project/README.md",
      configPath: CONFIG_PATH,
    });

    expect(result.updated).toBe(true);
    expect(result.content).toContain(".devcontainer");
    expect(result.content).not.toContain("Old content");
  });

  it("ziku.jsonc の include から FILES マーカー間を更新する", async () => {
    const readme = `# My Project

<!-- FILES:START -->
Old files
<!-- FILES:END -->`;

    vol.fromJSON({
      "/project/README.md": readme,
      [CONFIG_PATH]: JSON.stringify({
        include: [".devcontainer/devcontainer.json"],
      }),
    });

    const result = await generateReadme({
      readmePath: "/project/README.md",
      configPath: CONFIG_PATH,
    });

    expect(result.updated).toBe(true);
    expect(result.content).toContain(".devcontainer/devcontainer.json");
    expect(result.content).not.toContain("Old files");
  });

  it("コメント付き JSONC を読める", async () => {
    const readme = `# My Project

<!-- FILES:START -->
<!-- FILES:END -->`;

    vol.fromJSON({
      "/project/README.md": readme,
      [CONFIG_PATH]: `{
  // 同期対象
  "include": [".mcp.json"],
}`,
    });

    const result = await generateReadme({
      readmePath: "/project/README.md",
      configPath: CONFIG_PATH,
    });

    expect(result.content).toContain(".mcp.json");
  });

  it("ziku.jsonc が存在しない場合はマーカー間を書き換えない", async () => {
    const readme = `# My Project

<!-- FEATURES:START -->
Old content
<!-- FEATURES:END -->`;

    vol.fromJSON({
      "/project/README.md": readme,
    });

    const result = await generateReadme({
      readmePath: "/project/README.md",
      configPath: CONFIG_PATH,
    });

    expect(result.updated).toBe(false);
    expect(result.content).toContain("Old content");
  });

  it("ziku.jsonc の形式が不正な場合はマーカー間を書き換えない", async () => {
    const readme = `# My Project

<!-- FEATURES:START -->
Old content
<!-- FEATURES:END -->`;

    vol.fromJSON({
      "/project/README.md": readme,
      [CONFIG_PATH]: JSON.stringify({ include: "not-an-array" }),
    });

    const result = await generateReadme({
      readmePath: "/project/README.md",
      configPath: CONFIG_PATH,
    });

    expect(result.updated).toBe(false);
    expect(result.content).toContain("Old content");
  });

  it("COMMANDS マーカーをカスタム関数で更新する", async () => {
    const readme = `# My Project

<!-- COMMANDS:START -->
Old commands
<!-- COMMANDS:END -->`;

    vol.fromJSON({
      "/project/README.md": readme,
      [CONFIG_PATH]: JSON.stringify({ include: [] }),
    });

    const result = await generateReadme({
      readmePath: "/project/README.md",
      configPath: CONFIG_PATH,
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

    vol.fromJSON({
      "/project/README.md": readme,
      [CONFIG_PATH]: JSON.stringify({ include: [".mcp.json"] }),
    });

    const result = await generateReadme({
      readmePath: "/project/README.md",
      configPath: CONFIG_PATH,
    });

    expect(result.updated).toBe(true);
    expect(result.content).toContain(".mcp.json");
    expect(result.content).not.toContain("Old features");
    expect(result.content).not.toContain("Old files");
  });

  it("glob パターンを持つファイルに (パターン) ラベルを付ける", async () => {
    const readme = `# My Project

<!-- FILES:START -->
<!-- FILES:END -->`;

    vol.fromJSON({
      "/project/README.md": readme,
      [CONFIG_PATH]: JSON.stringify({ include: [".devcontainer/*.sh"] }),
    });

    const result = await generateReadme({
      readmePath: "/project/README.md",
      configPath: CONFIG_PATH,
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

    vol.fromJSON({
      "/project/README.md": readme,
      [CONFIG_PATH]: JSON.stringify({ include: [".mcp.json"] }),
    });

    const result = await updateReadmeFile({
      readmePath: "/project/README.md",
      configPath: CONFIG_PATH,
    });

    expect(result.updated).toBe(true);

    const savedContent = vol.readFileSync("/project/README.md", "utf8");
    expect(savedContent).toContain(".mcp.json");
  });

  it("更新がなければファイルに書き込まない", async () => {
    const readme = "# My Project\n\nNo markers here";

    vol.fromJSON({
      "/project/README.md": readme,
      [CONFIG_PATH]: JSON.stringify({ include: [] }),
    });

    await updateReadmeFile({
      readmePath: "/project/README.md",
      configPath: CONFIG_PATH,
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

  it("FEATURES マーカーを ziku.jsonc の include で更新する", async () => {
    vol.fromJSON({
      "/project/README.md": "# My Project\n\n<!-- FEATURES:START -->\n<!-- FEATURES:END -->",
      "/template/.ziku/ziku.jsonc": JSON.stringify({ include: [".mcp.json"] }),
    });

    const result = await detectAndUpdateReadme("/project", "/template");

    expect(result?.updated).toBe(true);
    expect(result?.content).toContain(".mcp.json");
  });

  it("FILES マーカーを ziku.jsonc の include で更新する", async () => {
    vol.fromJSON({
      "/project/README.md": "# My Project\n\n<!-- FILES:START -->\n<!-- FILES:END -->",
      "/template/.ziku/ziku.jsonc": JSON.stringify({
        include: [".claude/rules/*.md", ".mcp.json"],
      }),
    });

    const result = await detectAndUpdateReadme("/project", "/template");

    expect(result?.updated).toBe(true);
    expect(result?.content).toContain(".claude/rules/*.md");
    expect(result?.content).toContain(".mcp.json");
  });
});
