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
const { addIncludePattern, saveZikuConfig, zikuConfigExists } =
  await import("../../utils/ziku-config");
const { log, outro } = await import("../../ui/renderer");
const mockLog = vi.mocked(log);
const mockOutro = vi.mocked(outro);

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

      const result = addIncludePattern(rawContent, [".cloud/rules/*.md", ".cloud/config.json"]);

      const parsed = JSON.parse(result);
      expect(parsed.include).toContain(".mcp.json");
      expect(parsed.include).toContain(".cloud/rules/*.md");
      expect(parsed.include).toContain(".cloud/config.json");
      expect(parsed.include).toHaveLength(3);
    });
  });

  describe("ziku.jsonc の読み書き", () => {
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
        "/project/.ziku/ziku.jsonc": initialContent,
      });

      const updated = addIncludePattern(initialContent, [".cloud/rules/*.md"]);
      await saveZikuConfig("/project", updated);

      const saved = vol.readFileSync("/project/.ziku/ziku.jsonc", "utf8") as string;
      const parsed = JSON.parse(saved);
      expect(parsed.include).toContain(".mcp.json");
      expect(parsed.include).toContain(".cloud/rules/*.md");
      expect(parsed.include).toHaveLength(2);
    });

    it("ziku.jsonc が存在しない場合を検知できる", () => {
      vol.fromJSON({});
      expect(zikuConfigExists("/project")).toBe(false);
    });
  });
});

// trackCommand の統合テスト
// モック後にインポートする（既存パターンに従う）
const { trackCommand } = await import("../track");

/**
 * track コマンドを実行するテストヘルパー。
 *
 * track.ts の parsePatternArgs() は citty の args ではなく process.argv を直接
 * 読むため、パターン引数を渡すテストでは argv も併せてスタブする必要がある。
 */
function runTrack(dir: string, patterns: string[], opts: { dryRun?: boolean } = {}) {
  const originalArgv = process.argv;
  const flagArgs = opts.dryRun ? ["--dryRun"] : [];
  process.argv = ["node", "ziku", "track", ...patterns, "--dir", dir, ...flagArgs];

  const promise = (trackCommand.run as any)({
    args: { dir, list: false, dryRun: opts.dryRun ?? false },
    rawArgs: [],
    cmd: trackCommand,
  });

  return promise.finally(() => {
    process.argv = originalArgv;
  });
}

describe("trackCommand", () => {
  beforeEach(() => {
    vol.reset();
    vi.clearAllMocks();
  });

  it("--list のみで patterns なしでも動作する（required: false）", async () => {
    vol.fromJSON({
      "/project/.ziku/ziku.jsonc": JSON.stringify({
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

  describe("dry run (--dryRun)", () => {
    it("dryRun 引数のデフォルト値は false", () => {
      const args = trackCommand.args as { dryRun: { default: boolean } };
      expect(args.dryRun.default).toBe(false);
    });

    it("--dryRun では ziku.jsonc を書き込まない", async () => {
      vol.fromJSON({
        "/project/.ziku/ziku.jsonc": JSON.stringify({ include: [".mcp.json"], exclude: [] }),
      });

      await runTrack("/project", [".cloud/rules/*.md"], { dryRun: true });

      const saved = vol.readFileSync("/project/.ziku/ziku.jsonc", "utf8") as string;
      const parsed = JSON.parse(saved);
      expect(parsed.include).toEqual([".mcp.json"]);
      expect(parsed.include).not.toContain(".cloud/rules/*.md");
      expect(mockLog.message).toHaveBeenCalledWith(expect.stringContaining("Would add:"));
      expect(mockOutro).toHaveBeenCalledWith(expect.stringContaining("not written"));
    });

    it("全パターンが既に追跡済みなら --dryRun でもその旨を伝える", async () => {
      vol.fromJSON({
        "/project/.ziku/ziku.jsonc": JSON.stringify({ include: [".mcp.json"], exclude: [] }),
      });

      await runTrack("/project", [".mcp.json"], { dryRun: true });

      expect(mockLog.info).toHaveBeenCalledWith(
        expect.stringContaining("All patterns are already tracked"),
      );
    });

    it("--dryRun 無しでは実際に ziku.jsonc へ書き込む", async () => {
      vol.fromJSON({
        "/project/.ziku/ziku.jsonc": JSON.stringify({ include: [".mcp.json"], exclude: [] }),
      });

      await runTrack("/project", [".cloud/rules/*.md"]);

      const saved = vol.readFileSync("/project/.ziku/ziku.jsonc", "utf8") as string;
      const parsed = JSON.parse(saved);
      expect(parsed.include).toContain(".cloud/rules/*.md");
    });
  });
});
