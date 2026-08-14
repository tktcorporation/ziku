import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const mockRunCommand = vi.fn();
const mockSelect = vi.fn();
const mockText = vi.fn();
const mockCancel = vi.fn();

vi.mock("citty", () => ({
  // 実際のコマンド定義はこのテストの対象外。定義オブジェクトをそのまま返す。
  defineCommand: (config: unknown) => config,
  runCommand: mockRunCommand,
  runMain: vi.fn(),
}));

vi.mock("@clack/prompts", () => ({
  select: mockSelect,
  text: mockText,
  isCancel: (value: unknown) => value === CANCEL,
  cancel: mockCancel,
  log: { message: vi.fn() },
}));

/** @clack/prompts のキャンセル値の代役。`isCancel` の判定と対で使う。 */
const CANCEL = Symbol("cancel");

vi.mock("../ui/renderer", () => ({
  intro: vi.fn(),
  log: {
    info: vi.fn(),
    success: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    step: vi.fn(),
    message: vi.fn(),
  },
  logDiffSummary: vi.fn(),
  logFileResults: vi.fn(),
  logUnexpectedError: vi.fn(),
  logZikuError: vi.fn(),
  outro: vi.fn(),
  pc: new Proxy({}, { get: () => (s: string) => s }),
  withSpinner: (_label: string, fn: () => unknown) => fn(),
}));

import { logUnexpectedError, logZikuError } from "../ui/renderer";

type Errors = typeof import("../errors");

/**
 * index.ts を読み込んで CLI を起動し、Promise チェーンが終わるまで待つ。
 *
 * `vi.resetModules()` の後で errors を読み直す理由: index.ts が使うクラスと同じ
 * モジュールインスタンスから失敗値を作らないと、`instanceof` 判定が一致しない。
 */
async function runCli(makeRejection?: (errors: Errors) => unknown): Promise<void> {
  vi.resetModules();
  const errors = await import("../errors");
  if (makeRejection) {
    mockRunCommand.mockRejectedValue(makeRejection(errors));
  } else {
    mockRunCommand.mockResolvedValue({ result: undefined });
  }
  await import("../index");
  await new Promise((done) => {
    setTimeout(done, 0);
  });
}

/** logZikuError に渡された失敗の表示内容を取り出す。 */
function shownFailure(): { message: string; hint: string | undefined } {
  const [shown] = vi.mocked(logZikuError).mock.calls[0];
  return { message: shown.message, hint: shown.hint };
}

/**
 * 指定した引数で CLI を起動する。
 *
 * `dispatch` は `process.argv` を直接読むため、モジュールを読み込む前に差し替える。
 */
async function runWithArgv(argv: string[]): Promise<void> {
  process.argv = ["node", "ziku", ...argv];
  mockRunCommand.mockResolvedValue({ result: undefined });
  vi.resetModules();
  await import("../index");
  await new Promise((done) => {
    setTimeout(done, 0);
  });
}

/**
 * 位置引数のうち、既定値を持たないものの名前。
 *
 * 既定値があれば引数なしでも解決するが、無ければ呼び出し側が値を渡さないと成り立たない。
 * メニューがそれを用意しているかを、コマンド定義の側から確かめるのに使う。
 */
function positionalsNeedingValue(cmd: unknown): string[] {
  const args = (cmd as { args?: Record<string, { type?: string; default?: unknown }> }).args ?? {};
  return Object.entries(args)
    .filter(([, def]) => def.type === "positional" && def.default === undefined)
    .map(([name]) => name);
}

/** runCommand に渡されたコマンド定義と rawArgs を取り出す。 */
function dispatchedCommand(): { cmd: unknown; rawArgs: string[] } {
  const [cmd, opts] = mockRunCommand.mock.calls[0] as [unknown, { rawArgs: string[] }];
  return { cmd, rawArgs: opts.rawArgs };
}

describe("トップレベルエラーハンドラ", () => {
  const originalArgv = process.argv;
  let exitSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    vi.clearAllMocks();
    process.argv = ["node", "ziku", "status"];
    exitSpy = vi.spyOn(process, "exit").mockImplementation((() => undefined) as never);
  });

  afterEach(() => {
    process.argv = originalArgv;
    exitSpy.mockRestore();
  });

  it("成功したら終了コードを触らない", async () => {
    await runCli();

    expect(exitSpy).not.toHaveBeenCalled();
    expect(logZikuError).not.toHaveBeenCalled();
    expect(logUnexpectedError).not.toHaveBeenCalled();
  });

  it("ZikuFailure は message と hint だけを表示して終了コード 1", async () => {
    await runCli((e) => e.zikuFailure({ kind: "NotInitialized", path: ".ziku/lock.json" }));

    // Error インスタンスの message は列挙不可なので、呼び出し引数を直接読む
    expect(shownFailure()).toEqual({
      message: ".ziku/lock.json not found.",
      hint: "Run 'ziku init' first.",
    });
    expect(logUnexpectedError).not.toHaveBeenCalled();
    expect(exitSpy).toHaveBeenCalledWith(1);
  });

  it("予期しないエラーは unhandled rejection にせず、原因を見せて終了コード 1", async () => {
    const unexpected = new TypeError("Cannot read properties of undefined");
    const unhandled = vi.fn();

    process.on("unhandledRejection", unhandled);
    await runCli(() => unexpected);
    process.off("unhandledRejection", unhandled);

    expect(logUnexpectedError).toHaveBeenCalledWith(unexpected);
    expect(logZikuError).not.toHaveBeenCalled();
    expect(unhandled).not.toHaveBeenCalled();
    expect(exitSpy).toHaveBeenCalledWith(1);
  });

  it("citty の引数エラーは使い方の案内に変える", async () => {
    const usageError = new Error("Unknown command nope");
    usageError.name = "CLIError";

    await runCli(() => usageError);

    expect(shownFailure()).toEqual({
      message: "Unknown command nope",
      hint: "Run `ziku --help` to see available commands.",
    });
    expect(logUnexpectedError).not.toHaveBeenCalled();
    expect(exitSpy).toHaveBeenCalledWith(1);
  });

  it("Error ですらない値が投げられても表示して終了コード 1", async () => {
    await runCli(() => "string rejection");

    expect(logUnexpectedError).toHaveBeenCalledWith("string rejection");
    expect(exitSpy).toHaveBeenCalledWith(1);
  });
});

describe("引数の振り分け", () => {
  const originalArgv = process.argv;
  let exitSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    vi.clearAllMocks();
    exitSpy = vi.spyOn(process, "exit").mockImplementation((() => undefined) as never);
  });

  afterEach(() => {
    process.argv = originalArgv;
    exitSpy.mockRestore();
  });

  describe("サブコマンド名の打ち間違い", () => {
    it.each([
      ["pul", "pull"],
      ["puhs", "push"],
      ["staus", "status"],
      ["traxk", "track"],
      ["ini", "init"],
    ])("`ziku %s` は init を実行せず %s を提案する", async (typo, expected) => {
      await runWithArgv([typo]);

      // init として実行されない = 存在しないディレクトリを作らない
      expect(mockRunCommand).not.toHaveBeenCalled();
      expect(shownFailure().message).toBe(`Invalid command: "${typo}"`);
      expect(shownFailure().hint).toContain(`ziku ${expected}`);
      expect(exitSpy).toHaveBeenCalledWith(1);
    });

    it("ディレクトリとして使いたい場合の逃げ道を案内する", async () => {
      await runWithArgv(["pul"]);

      expect(shownFailure().hint).toContain("ziku init pul");
    });

    it("大文字のサブコマンド名も打ち間違いとして扱う", async () => {
      await runWithArgv(["Pull"]);

      expect(mockRunCommand).not.toHaveBeenCalled();
      expect(shownFailure().hint).toContain("ziku pull");
    });
  });

  describe("init へのフォールバック", () => {
    it.each([["."], ["./my-project"], ["../sibling"], ["/abs/path"], ["~/projects/app"]])(
      "`ziku %s` は init として実行する",
      async (dir) => {
        await runWithArgv([dir]);

        const { cmd, rawArgs } = dispatchedCommand();
        const { initCommand } = await import("../commands/init");
        expect(cmd).toBe(initCommand);
        expect(rawArgs).toEqual([dir]);
      },
    );

    it("サブコマンド名から遠いディレクトリ名は init として実行する", async () => {
      await runWithArgv(["my-new-project"]);

      const { cmd, rawArgs } = dispatchedCommand();
      const { initCommand } = await import("../commands/init");
      expect(cmd).toBe(initCommand);
      expect(rawArgs).toEqual(["my-new-project"]);
    });

    describe("サブコマンド名と近いが実在するディレクトリ名", () => {
      let workDir: string;
      let originalCwd: string;

      beforeEach(() => {
        originalCwd = process.cwd();
        workDir = mkdtempSync(join(tmpdir(), "ziku-dispatch-"));
        process.chdir(workDir);
      });

      afterEach(() => {
        process.chdir(originalCwd);
        rmSync(workDir, { recursive: true, force: true });
      });

      it("`ziku dist` は dist が実在すれば init として実行する", async () => {
        mkdirSync(join(workDir, "dist"));

        await runWithArgv(["dist"]);

        const { cmd, rawArgs } = dispatchedCommand();
        const { initCommand } = await import("../commands/init");
        expect(cmd).toBe(initCommand);
        expect(rawArgs).toEqual(["dist"]);
      });

      it("`ziku dist` は dist が実在しなければ diff の打ち間違いとして扱う", async () => {
        await runWithArgv(["dist"]);

        expect(mockRunCommand).not.toHaveBeenCalled();
        expect(shownFailure().hint).toContain("ziku diff");
      });

      it("同名のファイルはディレクトリではないので打ち間違い判定にかける", async () => {
        writeFileSync(join(workDir, "dist"), "");

        await runWithArgv(["dist"]);

        expect(mockRunCommand).not.toHaveBeenCalled();
        expect(shownFailure().hint).toContain("ziku diff");
      });

      it("ディレクトリ名として使えない引数でも実在判定でクラッシュしない", async () => {
        // ENAMETOOLONG は不在ではないので statSync が例外を投げる。ziku の不具合として
        // スタックトレースを出さず、通常の入力として init へ渡す。
        const tooLong = "x".repeat(5000);

        await runWithArgv([tooLong]);

        const { cmd, rawArgs } = dispatchedCommand();
        const { initCommand } = await import("../commands/init");
        expect(cmd).toBe(initCommand);
        expect(rawArgs).toEqual([tooLong]);
      });
    });
  });

  describe("対話メニュー", () => {
    it("全サブコマンドが並ぶ", async () => {
      mockSelect.mockResolvedValue("status");

      await runWithArgv([]);

      const [{ options }] = mockSelect.mock.calls[0] as [{ options: Array<{ value: string }> }];
      expect(options.map((o) => o.value)).toEqual([
        "init",
        "setup",
        "push",
        "pull",
        "diff",
        "status",
        "track",
      ]);
    });

    it.each(["init", "setup", "push", "pull", "diff", "status", "track"])(
      "%s を選ぶとそのコマンドを実行し、値の要る位置引数を空のまま渡さない",
      async (name) => {
        mockSelect.mockResolvedValue(name);
        mockText.mockResolvedValue(".claude/rules/*.md");

        await runWithArgv([]);

        const commands = {
          init: (await import("../commands/init")).initCommand,
          setup: (await import("../commands/setup")).setupCommand,
          push: (await import("../commands/push")).pushCommand,
          pull: (await import("../commands/pull")).pullCommand,
          diff: (await import("../commands/diff")).diffCommand,
          status: (await import("../commands/status")).statusCommand,
          track: (await import("../commands/track")).trackCommand,
        };
        const { cmd, rawArgs } = dispatchedCommand();
        expect(cmd).toBe(commands[name as keyof typeof commands]);
        // 既定値の無い位置引数はメニュー側が値を用意しないと、起動直後に引数不足で落ちる。
        expect(rawArgs.length).toBeGreaterThanOrEqual(positionalsNeedingValue(cmd).length);
      },
    );

    it.each(["init", "setup", "push", "pull", "diff", "status"])(
      "%s はカレントディレクトリが対象になるので引数なしで実行する",
      async (name) => {
        mockSelect.mockResolvedValue(name);

        await runWithArgv([]);

        expect(dispatchedCommand().rawArgs).toEqual([]);
        expect(mockText).not.toHaveBeenCalled();
      },
    );

    it("track は入力されたパターンを位置引数として渡す", async () => {
      mockSelect.mockResolvedValue("track");
      mockText.mockResolvedValue("  .claude/rules/*.md   .mcp.json ");

      await runWithArgv([]);

      const { cmd, rawArgs } = dispatchedCommand();
      const { trackCommand } = await import("../commands/track");
      expect(cmd).toBe(trackCommand);
      expect(rawArgs).toEqual([".claude/rules/*.md", ".mcp.json"]);
    });

    it("track のパターン入力は空を受け付けず、brace 展開のコンマでは分割しない", async () => {
      mockSelect.mockResolvedValue("track");
      mockText.mockResolvedValue(".claude/rules/*.{md,json}");

      await runWithArgv([]);

      const [{ validate }] = mockText.mock.calls[0] as [
        { validate: (value: string | undefined) => string | undefined },
      ];
      expect(validate("   ")).toBeTypeOf("string");
      expect(validate(".mcp.json")).toBeUndefined();
      // コンマは brace 展開の一部なので、1 つのパターンとして渡す
      expect(dispatchedCommand().rawArgs).toEqual([".claude/rules/*.{md,json}"]);
    });

    it("track のパターン入力をキャンセルするとコマンドを実行しない", async () => {
      mockSelect.mockResolvedValue("track");
      mockText.mockResolvedValue(CANCEL);

      await runWithArgv([]);

      expect(mockRunCommand).not.toHaveBeenCalled();
      expect(mockCancel).toHaveBeenCalledWith("Cancelled.");
    });

    it("キャンセルするとコマンドを実行しない", async () => {
      mockSelect.mockResolvedValue(CANCEL);

      await runWithArgv([]);

      expect(mockRunCommand).not.toHaveBeenCalled();
      expect(mockCancel).toHaveBeenCalledWith("Cancelled.");
    });
  });
});
