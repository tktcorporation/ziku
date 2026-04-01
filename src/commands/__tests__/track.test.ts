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

// utils/ui をモック
vi.mock("../../utils/ui", () => ({
  showHeader: vi.fn(),
  log: {
    info: vi.fn(),
    warn: vi.fn(),
    dim: vi.fn(),
    newline: vi.fn(),
    error: vi.fn(),
    success: vi.fn(),
  },
  pc: {
    bold: (s: string) => s,
    cyan: (s: string) => s,
    dim: (s: string) => s,
    green: (s: string) => s,
  },
  box: vi.fn(),
}));

// ui/renderer をモック（track.ts が使用）
vi.mock("../../ui/renderer", () => ({
  intro: vi.fn(),
  outro: vi.fn(),
  log: {
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    success: vi.fn(),
    step: vi.fn(),
    message: vi.fn(),
  },
  pc: {
    cyan: (s: string) => s,
    bold: (s: string) => s,
    dim: (s: string) => s,
    green: (s: string) => s,
  },
}));

// console.log をモック
vi.spyOn(console, "log").mockImplementation(() => {});

// process.exit をモック
vi.spyOn(process, "exit").mockImplementation(() => {
  throw new Error("process.exit called");
});

// モック後にインポート
const { loadPatternsFile, saveModulesFile, modulesFileExists } = await import("../../modules");
const { addIncludePattern } = await import("../../modules/loader");

describe("track command - core logic", () => {
  beforeEach(() => {
    vol.reset();
  });

  describe("addIncludePattern", () => {
    it("既存の include 配列にパターンを追加できる", () => {
      const rawContent = JSON.stringify(
        {
          include: [".cloud/config.json"],
          exclude: [],
        },
        null,
        2,
      );

      const result = addIncludePattern(rawContent, [".cloud/rules/*.md"]);

      const parsed = JSON.parse(result);
      expect(parsed.include).toContain(".cloud/config.json");
      expect(parsed.include).toContain(".cloud/rules/*.md");
    });

    it("新しいパターンを include 配列に追加できる", () => {
      const rawContent = JSON.stringify(
        {
          include: [".mcp.json"],
          exclude: [],
        },
        null,
        2,
      );

      const result = addIncludePattern(rawContent, [
        ".cloud/rules/*.md",
        ".cloud/config.json",
      ]);

      const parsed = JSON.parse(result);
      expect(parsed.include).toContain(".mcp.json");
      expect(parsed.include).toContain(".cloud/rules/*.md");
      expect(parsed.include).toContain(".cloud/config.json");
      expect(parsed.include).toHaveLength(3);
    });
  });

  describe("modules.jsonc の読み書き", () => {
    it("パターン追加後にファイルを正しく保存できる", async () => {
      const initialContent = JSON.stringify(
        {
          include: [".mcp.json"],
          exclude: [],
        },
        null,
        2,
      );

      vol.fromJSON({
        "/project/.ziku/modules.jsonc": initialContent,
      });

      const { rawContent } = await loadPatternsFile("/project");
      const updated = addIncludePattern(rawContent, [
        ".cloud/rules/*.md",
      ]);
      await saveModulesFile("/project", updated);

      const saved = vol.readFileSync("/project/.ziku/modules.jsonc", "utf8") as string;
      const parsed = JSON.parse(saved);
      expect(parsed.include).toContain(".mcp.json");
      expect(parsed.include).toContain(".cloud/rules/*.md");
      expect(parsed.include).toHaveLength(2);
    });

    it("modules.jsonc が存在しない場合を検知できる", () => {
      vol.fromJSON({});
      expect(modulesFileExists("/project")).toBe(false);
    });
  });
});

// trackCommand の統合テスト
// モック後にインポートする（既存パターンに従う）
const { trackCommand } = await import("../track");

describe("trackCommand", () => {
  beforeEach(() => {
    vol.reset();
    vi.clearAllMocks();
  });

  it("--list のみで patterns なしでも動作する（required: false）", async () => {
    vol.fromJSON({
      "/project/.ziku/modules.jsonc": JSON.stringify({
        include: [".mcp.json"],
        exclude: [],
      }),
    });

    // エラーなく完了することを確認
    await expect(
      (trackCommand.run as any)({
        args: {
          dir: "/project",
          list: true,
        },
        rawArgs: ["--list"],
        cmd: trackCommand,
      }),
    ).resolves.not.toThrow();
  });
});
