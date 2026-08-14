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
  MARKERS,
  generateReadme,
  updateReadmeFile,
  detectReadmeUpdate,
  renderTemplateReadme,
  updateSection,
} = await import("../readme");

const CONFIG_DIR = "/project";
const CONFIG_PATH = `${CONFIG_DIR}/.ziku/ziku.jsonc`;

describe("generateReadme", () => {
  beforeEach(() => {
    vol.reset();
  });

  it("README が存在しない場合は updated: false を返す", async () => {
    vol.fromJSON({});

    const result = await generateReadme({
      readmePath: "/project/README.md",
      configDir: CONFIG_DIR,
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
      configDir: CONFIG_DIR,
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
      configDir: CONFIG_DIR,
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
      configDir: CONFIG_DIR,
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
      configDir: CONFIG_DIR,
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
      configDir: CONFIG_DIR,
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
      configDir: CONFIG_DIR,
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
      configDir: CONFIG_DIR,
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
      configDir: CONFIG_DIR,
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
      configDir: CONFIG_DIR,
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
      configDir: CONFIG_DIR,
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
      configDir: CONFIG_DIR,
    });

    const savedContent = vol.readFileSync("/project/README.md", "utf8");
    expect(savedContent).toBe(readme);
  });
});

describe("detectReadmeUpdate", () => {
  beforeEach(() => {
    vol.reset();
  });

  it("マーカーが無ければ null を返す", async () => {
    vol.fromJSON({
      "/project/README.md": "# My Project\n\nNo markers",
      "/template/.ziku/ziku.jsonc": JSON.stringify({ include: [".mcp.json"] }),
    });

    expect(await detectReadmeUpdate("/project", "/template")).toBeNull();
  });

  it("更新後の内容を返すが README には書き込まない", async () => {
    const original = "# My Project\n\n<!-- FILES:START -->\n<!-- FILES:END -->";
    vol.fromJSON({
      "/project/README.md": original,
      "/template/.ziku/ziku.jsonc": JSON.stringify({ include: [".mcp.json"] }),
    });

    const result = await detectReadmeUpdate("/project", "/template");

    expect(result?.updated).toBe(true);
    expect(result?.content).toContain(".mcp.json");
    expect(vol.readFileSync("/project/README.md", "utf8")).toBe(original);
  });
});

/**
 * 配る内容から README を組み直す経路のテスト。
 *
 * README も `ziku.jsonc` も同じ変更で書き換わるので、ディスク上の内容から組むと配る
 * README が導出元と食い違う。渡した内容が優先されることを確かめる。
 */
describe("renderTemplateReadme", () => {
  const TEMPLATE_README = "# Template\n\n<!-- FILES:START -->\n<!-- FILES:END -->\n";

  beforeEach(() => {
    vol.reset();
  });

  it("渡した ziku.jsonc のパターンを反映する（ディスク上の内容は見ない）", async () => {
    vol.fromJSON({
      "/template/README.md": TEMPLATE_README,
      "/template/.ziku/ziku.jsonc": JSON.stringify({ include: [".mcp.json"] }),
    });

    const result = await renderTemplateReadme({
      templateDir: "/template",
      readme: undefined,
      config: JSON.stringify({ include: [".mcp.json", "docs/new.md"] }),
    });

    expect(result?.updated).toBe(true);
    expect(result?.content).toContain("docs/new.md");
  });

  it("渡した README を土台にして、マーカー間だけを組み直す", async () => {
    vol.fromJSON({
      "/template/README.md": TEMPLATE_README,
      "/template/.ziku/ziku.jsonc": JSON.stringify({ include: [".mcp.json"] }),
    });

    const result = await renderTemplateReadme({
      templateDir: "/template",
      readme: `# Rewritten by the user\n\n<!-- FILES:START -->\n<!-- FILES:END -->\n`,
      config: undefined,
    });

    // マーカー外はユーザーの文章のまま残り、マーカー間だけが ziku.jsonc から入る
    expect(result?.content).toContain("# Rewritten by the user");
    expect(result?.content).toContain(".mcp.json");
  });

  it("マーカーが無い README には触れない", async () => {
    vol.fromJSON({
      "/template/README.md": "# Template\n\nNo markers\n",
      "/template/.ziku/ziku.jsonc": JSON.stringify({ include: [".mcp.json"] }),
    });

    expect(
      await renderTemplateReadme({
        templateDir: "/template",
        readme: undefined,
        config: undefined,
      }),
    ).toBeNull();
  });

  it("テンプレートに README が無く、配る内容にも無ければ null", async () => {
    vol.fromJSON({ "/template/.ziku/ziku.jsonc": JSON.stringify({ include: [".mcp.json"] }) });

    expect(
      await renderTemplateReadme({
        templateDir: "/template",
        readme: undefined,
        config: undefined,
      }),
    ).toBeNull();
  });

  it("ディスクへは書き込まない", async () => {
    vol.fromJSON({
      "/template/README.md": TEMPLATE_README,
      "/template/.ziku/ziku.jsonc": JSON.stringify({ include: [".mcp.json"] }),
    });

    await renderTemplateReadme({ templateDir: "/template", readme: undefined, config: undefined });

    expect(vol.readFileSync("/template/README.md", "utf8")).toBe(TEMPLATE_README);
  });
});

describe("updateSection", () => {
  it("マーカー間を差し替えた内容を返す", () => {
    const readme = `# P\n\n${MARKERS.features.start}\nOld\n${MARKERS.features.end}\n`;

    const result = updateSection(readme, MARKERS.features.start, MARKERS.features.end, "New");

    expect(result).toEqual({
      _tag: "Replaced",
      content: `# P\n\n${MARKERS.features.start}\n\nNew\n${MARKERS.features.end}\n`,
      updated: true,
    });
  });

  it("マーカーが無いことを呼び出し側へ返す（元の内容を黙って返さない）", () => {
    // 潰して元の内容を返すと、生成器が「書いたのに何も変わっていない」ことに気づけない。
    expect(updateSection("# P\n", MARKERS.files.start, MARKERS.files.end, "New")).toEqual({
      _tag: "MarkerNotFound",
      startMarker: MARKERS.files.start,
    });
  });
});
