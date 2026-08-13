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
const { runCommand } = await import("citty");

/**
 * track コマンドを CLI と同じ引数解釈で実行するテストヘルパー。
 *
 * citty の runCommand に生の引数列を渡すことで、パターン・フラグの切り分けを
 * 実装と同じパーサーに任せる。
 */
function runTrack(rawArgs: string[]): Promise<unknown> {
  return runCommand(trackCommand, { rawArgs });
}

/** 追跡中の include パターンをファイルから読み出す */
function readIncludePatterns(dir: string): string[] {
  const saved = vol.readFileSync(`${dir}/.ziku/ziku.jsonc`, "utf8") as string;
  return JSON.parse(saved).include;
}

function seedProject(include: string[] = [".mcp.json"]): void {
  vol.fromJSON({
    "/project/.ziku/ziku.jsonc": JSON.stringify({ include, exclude: [] }),
  });
}

describe("trackCommand", () => {
  beforeEach(() => {
    vol.reset();
    vi.clearAllMocks();
  });

  describe("引数の受け取り", () => {
    it("複数パターンを位置引数で受け取る", async () => {
      seedProject();

      await runTrack([".cloud/rules/*.md", ".cloud/config.json", "--dir", "/project"]);

      expect(readIncludePatterns("/project")).toEqual([
        ".mcp.json",
        ".cloud/rules/*.md",
        ".cloud/config.json",
      ]);
    });

    it("--dir の値をパターンとして扱わない", async () => {
      seedProject();

      await runTrack([".env.example", "--dir", "/project"]);

      expect(readIncludePatterns("/project")).toEqual([".mcp.json", ".env.example"]);
    });

    it("--dir=<path> 形式でも値をパターンとして扱わない", async () => {
      seedProject();

      await runTrack([".env.example", "--dir=/project"]);

      expect(readIncludePatterns("/project")).toEqual([".mcp.json", ".env.example"]);
    });

    it("エイリアス -d でもディレクトリを指定できる", async () => {
      seedProject();

      await runTrack(["-d", "/project", ".env.example"]);

      expect(readIncludePatterns("/project")).toEqual([".mcp.json", ".env.example"]);
    });

    it("パターン未指定ならエラーになる", async () => {
      seedProject();

      await expect(runTrack(["--dir", "/project"])).rejects.toThrow("No patterns specified");
    });
  });

  it("--list は patterns なしで追跡中のパターンを表示する", async () => {
    seedProject([".mcp.json", ".claude/rules/*.md"]);

    await runTrack(["--list", "--dir", "/project"]);

    expect(mockLog.info).toHaveBeenCalledWith("Tracked patterns:");
    expect(mockLog.message).toHaveBeenCalledWith(expect.stringContaining(".claude/rules/*.md"));
    expect(readIncludePatterns("/project")).toEqual([".mcp.json", ".claude/rules/*.md"]);
  });

  describe("dry run (--dryRun)", () => {
    it("dryRun 引数のデフォルト値は false", () => {
      const args = trackCommand.args as { dryRun: { default: boolean } };
      expect(args.dryRun.default).toBe(false);
    });

    it("--dryRun では ziku.jsonc を書き込まない", async () => {
      seedProject();

      await runTrack([".cloud/rules/*.md", "--dir", "/project", "--dryRun"]);

      expect(readIncludePatterns("/project")).toEqual([".mcp.json"]);
      expect(mockLog.message).toHaveBeenCalledWith(expect.stringContaining("Would add:"));
      expect(mockOutro).toHaveBeenCalledWith(expect.stringContaining("not written"));
    });

    it("エイリアス -n でも書き込まない", async () => {
      seedProject();

      await runTrack([".cloud/rules/*.md", "--dir", "/project", "-n"]);

      expect(readIncludePatterns("/project")).toEqual([".mcp.json"]);
    });

    it("全パターンが既に追跡済みなら --dryRun でもその旨を伝える", async () => {
      seedProject();

      await runTrack([".mcp.json", "--dir", "/project", "--dryRun"]);

      expect(mockLog.info).toHaveBeenCalledWith(
        expect.stringContaining("All patterns are already tracked"),
      );
    });

    it("--dryRun 無しでは実際に ziku.jsonc へ書き込む", async () => {
      seedProject();

      await runTrack([".cloud/rules/*.md", "--dir", "/project"]);

      expect(readIncludePatterns("/project")).toContain(".cloud/rules/*.md");
    });

    it("既存パターンと新規パターンが混在する場合、プレビューには新規分だけを表示する", async () => {
      seedProject();

      await runTrack([".mcp.json", ".env.example", "--dir", "/project", "--dryRun"]);

      const messageCall = mockLog.message.mock.calls.find(
        (c) => typeof c[0] === "string" && c[0].includes("Would add:"),
      );
      expect(messageCall?.[0]).toContain(".env.example");
      expect(messageCall?.[0]).not.toContain(".mcp.json");
    });

    it("既存パターンと新規パターンが混在する場合、実行時ログにも新規分だけを表示する", async () => {
      seedProject();

      await runTrack([".mcp.json", ".env.example", "--dir", "/project"]);

      const messageCall = mockLog.message.mock.calls.find(
        (c) => typeof c[0] === "string" && c[0].includes("Added:"),
      );
      expect(messageCall?.[0]).toContain(".env.example");
      expect(messageCall?.[0]).not.toContain(".mcp.json");
    });
  });

  describe("読めない ziku.jsonc の報告", () => {
    /** 生の内容で ziku.jsonc を用意する（壊れた設定を書くため seedProject とは別立て） */
    function seedRawConfig(raw: string): void {
      vol.fromJSON({ "/project/.ziku/ziku.jsonc": raw });
    }

    it("JSONC として壊れていれば構文エラーとして報告する", async () => {
      seedRawConfig('{ "include": [ }');

      await expect(runTrack([".env.example", "--dir", "/project"])).rejects.toThrow(
        "Failed to parse .ziku/ziku.jsonc",
      );
    });

    it("スキーマ違反は構文エラーではなく、不正なフィールド名付きで報告する", async () => {
      seedRawConfig('{ "include": "not-an-array" }');

      await expect(runTrack([".env.example", "--dir", "/project"])).rejects.toMatchObject({
        message: "Failed to read .ziku/ziku.jsonc",
        hint: expect.stringContaining("include: "),
        reason: { kind: "ConfigInvalid" },
      });
    });

    it("--list でも同じ分類で報告する", async () => {
      seedRawConfig('{ "include": "not-an-array" }');

      await expect(runTrack(["--list", "--dir", "/project"])).rejects.toThrow(
        "Failed to read .ziku/ziku.jsonc",
      );
    });
  });
});
