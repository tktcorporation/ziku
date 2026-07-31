import { vol } from "memfs";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// fs モジュールをモック
vi.mock("node:fs", async () => {
  const memfs = await import("memfs");
  return memfs.fs;
});

vi.mock("node:fs/promises", async () => {
  const memfs = await import("memfs");
  return memfs.fs.promises;
});

// ui/renderer をモック（untrack.ts が使用）
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
    yellow: (s: string) => s,
    red: (s: string) => s,
  },
}));

// process.exit をモック
vi.spyOn(process, "exit").mockImplementation(() => {
  throw new Error("process.exit called");
});

// モック後にインポート
const { untrackCommand } = await import("../untrack");
const { removeIncludePattern } = await import("../../utils/ziku-config");
const { log } = await import("../../ui/renderer");
const mockLog = vi.mocked(log);

/** ziku.jsonc を生成するヘルパー */
function writeConfig(include: string[], exclude: string[] = []): string {
  const content = JSON.stringify({ include, exclude }, null, 2);
  vol.fromJSON({ "/project/.ziku/ziku.jsonc": content });
  return content;
}

/**
 * untrack コマンドを実行する。
 * parsePatternArgs は process.argv を直接読むため、argv を組み立てて差し替える。
 * 差し替えた argv は describe の afterEach で復元する。afterEach はテストが
 * throw しても必ず走るため、finally と同等の復元保証になりテスト間汚染を防ぐ。
 */
function runUntrack(patternArgv: string[], dir = "/project"): Promise<void> {
  process.argv = ["node", "ziku", "untrack", ...patternArgv];
  return (untrackCommand.run as (ctx: unknown) => Promise<void>)({
    args: { dir },
    rawArgs: patternArgv,
    cmd: untrackCommand,
  });
}

describe("removeIncludePattern", () => {
  it("include から指定パターンを削除する（exclude は保持）", () => {
    const raw = JSON.stringify(
      { include: [".cloud/config.json", ".cloud/rules/*.md"], exclude: ["secret.json"] },
      null,
      2,
    );

    const result = removeIncludePattern(raw, [".cloud/rules/*.md"]);

    const parsed = JSON.parse(result);
    expect(parsed.include).toEqual([".cloud/config.json"]);
    expect(parsed.exclude).toEqual(["secret.json"]);
  });

  it("一致するパターンが無ければ rawContent をそのまま返す", () => {
    const raw = JSON.stringify({ include: [".mcp.json"], exclude: [] }, null, 2);

    const result = removeIncludePattern(raw, [".cloud/missing.md"]);

    expect(result).toBe(raw);
  });

  it("複数パターンをまとめて削除できる", () => {
    const raw = JSON.stringify({ include: ["a", "b", "c"], exclude: [] }, null, 2);

    const result = removeIncludePattern(raw, ["a", "c"]);

    expect(JSON.parse(result).include).toEqual(["b"]);
  });
});

describe("untrack command", () => {
  let originalArgv: string[];

  beforeEach(() => {
    vol.reset();
    vi.clearAllMocks();
    originalArgv = process.argv;
  });

  afterEach(() => {
    vol.reset();
    process.argv = originalArgv;
  });

  it("追跡中のパターンを include から削除して保存する", async () => {
    writeConfig([".cloud/config.json", ".cloud/rules/*.md"]);

    await runUntrack([".cloud/rules/*.md"]);

    const saved = vol.readFileSync("/project/.ziku/ziku.jsonc", "utf8") as string;
    expect(JSON.parse(saved).include).toEqual([".cloud/config.json"]);
    expect(mockLog.success).toHaveBeenCalledWith("Patterns removed!");
  });

  it("未追跡パターンは警告のみで設定を変更しない", async () => {
    const original = writeConfig([".cloud/config.json"]);

    await runUntrack([".cloud/not-tracked.md"]);

    expect(mockLog.warn).toHaveBeenCalledWith("Not tracked (skipped): .cloud/not-tracked.md");
    expect(mockLog.info).toHaveBeenCalledWith(
      "None of the specified patterns are tracked. No changes needed.",
    );
    // ファイルは変更されない
    const saved = vol.readFileSync("/project/.ziku/ziku.jsonc", "utf8") as string;
    expect(saved).toBe(original);
  });

  it("追跡中・未追跡が混在する場合、追跡中のみ削除し未追跡を警告する", async () => {
    writeConfig([".cloud/config.json", ".cloud/rules/*.md"]);

    await runUntrack([".cloud/rules/*.md", ".cloud/ghost.md", "--dir", "/project"]);

    expect(mockLog.warn).toHaveBeenCalledWith("Not tracked (skipped): .cloud/ghost.md");
    const saved = vol.readFileSync("/project/.ziku/ziku.jsonc", "utf8") as string;
    expect(JSON.parse(saved).include).toEqual([".cloud/config.json"]);
  });

  it("ziku.jsonc が無ければ ZikuError を投げる", async () => {
    vol.reset();
    await expect(runUntrack([".cloud/rules/*.md"])).rejects.toMatchObject({
      name: "ZikuError",
      message: expect.stringContaining("not found"),
    });
  });

  it("パターン未指定なら ZikuError を投げる", async () => {
    writeConfig([".cloud/config.json"]);
    await expect(runUntrack([])).rejects.toMatchObject({
      name: "ZikuError",
      message: expect.stringContaining("No patterns specified"),
    });
  });
});
