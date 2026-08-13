import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const mockRunCommand = vi.fn();

vi.mock("citty", () => ({
  // 実際のコマンド定義はこのテストの対象外。定義オブジェクトをそのまま返す。
  defineCommand: (config: unknown) => config,
  runCommand: mockRunCommand,
  runMain: vi.fn(),
}));

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

  it("ZikuError も同じ経路で表示する", async () => {
    await runCli((e) => new e.ZikuError("Push failed", "Resolve conflicts first"));

    expect(shownFailure()).toEqual({
      message: "Push failed",
      hint: "Resolve conflicts first",
    });
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
