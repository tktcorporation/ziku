import { describe, expect, it } from "vitest";
import type { FailureReason } from "../errors";
import { ZikuError, ZikuFailure, describeFailure, zikuFailure } from "../errors";

describe("ZikuError", () => {
  it("should create error with message", () => {
    const error = new ZikuError("something went wrong");
    expect(error.message).toBe("something went wrong");
    expect(error.name).toBe("ZikuError");
    expect(error.hint).toBeUndefined();
  });

  it("should create error with hint", () => {
    const error = new ZikuError("config not found", "Run 'ziku init' first.");
    expect(error.message).toBe("config not found");
    expect(error.hint).toBe("Run 'ziku init' first.");
  });

  it("should be instanceof Error", () => {
    const error = new ZikuError("test");
    expect(error).toBeInstanceOf(Error);
  });
});

describe("describeFailure", () => {
  // 各ケースが「何が起きたか」と「次に何をするか」の両方をユーザーに渡すことを確認する。
  // ケースを増やすと describeFailure の match が網羅性で落ちるので、ここも合わせて増やす。
  const cases: Array<{ reason: FailureReason; message: string; hint: RegExp }> = [
    {
      reason: { kind: "NotInitialized", path: ".ziku/ziku.jsonc" },
      message: ".ziku/ziku.jsonc not found.",
      hint: /ziku init/,
    },
    {
      reason: { kind: "ConfigUnparsable", path: ".ziku/lock.json", detail: "Unexpected token }" },
      message: "Failed to parse .ziku/lock.json",
      hint: /Unexpected token/,
    },
    {
      reason: { kind: "ConfigInvalid", path: ".ziku/lock.json", issues: ["source: required"] },
      message: "Failed to read .ziku/lock.json",
      hint: /source: required[\s\S]*ziku init/,
    },
    {
      reason: { kind: "TemplateUnavailable", detail: "ENOTFOUND api.github.com" },
      message: "Failed to load template",
      hint: /ENOTFOUND/,
    },
    {
      reason: { kind: "TemplateNotConfigured", templateRef: "my-org/.ziku" },
      message: "Template has no .ziku/ziku.jsonc",
      hint: /ziku setup.*my-org\/\.ziku/,
    },
    {
      reason: { kind: "TemplateRepoNotFound", repos: ["my-org/.ziku", "my-org/.github"] },
      message: "Template repository not found: my-org/.ziku, my-org/.github",
      hint: /--from/,
    },
    {
      reason: { kind: "TemplateSourceUndetectable" },
      message: "Cannot detect template source",
      hint: /--from/,
    },
    {
      reason: { kind: "AmbiguousTemplateSource", candidates: ["a/.ziku", "b/.ziku"] },
      message: "Multiple template candidates found: a/.ziku, b/.ziku",
      hint: /disambiguate/,
    },
    {
      reason: { kind: "GitHubTokenMissing", operation: "create a PR" },
      message: "GitHub token required to create a PR",
      hint: /gh auth login/,
    },
    {
      reason: { kind: "GitHubAuthRejected", detail: "Bad credentials" },
      message: "GitHub authentication failed: Bad credentials",
      hint: /gh auth login/,
    },
    {
      reason: { kind: "GitHubRateLimited", authenticated: true, resetAt: undefined },
      message: "GitHub API rate limit exceeded",
      hint: /Authenticated quota \(5000\/hr\) exhausted$/,
    },
    {
      reason: { kind: "InvalidArgument", argument: "--dirs", value: "nope", expected: "one of a" },
      message: 'Invalid --dirs: "nope"',
      hint: /Expected: one of a/,
    },
    {
      reason: { kind: "MissingArgument", argument: "patterns", usage: "Usage: ziku track <p>" },
      message: "No patterns specified.",
      hint: /Usage: ziku track/,
    },
    {
      reason: { kind: "MergePaused", conflicts: [".mcp.json", "AGENTS.md"] },
      message: "Merge already in progress from a previous `ziku pull`",
      hint: /\u2022 \.mcp\.json[\s\S]*\u2022 AGENTS\.md[\s\S]*/,
    },
    {
      reason: { kind: "NoMergePaused" },
      message: "No pending merge found",
      hint: /Run `ziku pull` first/,
    },
    {
      reason: {
        kind: "ConflictsUnresolved",
        files: [{ path: ".mcp.json", lines: [3, 12] }],
      },
      message: "Unresolved conflict markers remain",
      hint: /\.mcp\.json \(lines 3, 12\)/,
    },
    {
      reason: {
        kind: "FileWriteFailed",
        path: ".ziku/ziku.jsonc",
        directory: "/project",
        detail: "EACCES",
      },
      message: "Failed to write .ziku/ziku.jsonc: EACCES",
      hint: /write permissions for \/project/,
    },
    {
      reason: { kind: "DryRunBlocked", operation: "Would create template repository a/b" },
      message: "Would create template repository a/b, but --dryRun prevents remote changes",
      hint: /without --dryRun/,
    },
  ];

  it.each(cases)("$reason.kind をメッセージと hint に変換する", ({ reason, message, hint }) => {
    const display = describeFailure(reason);
    expect(display.message).toBe(message);
    expect(display.hint).toMatch(hint);
  });

  it("解決待ちのマージは、どちらの向きでも `ziku pull --continue` へ誘導する", () => {
    // MergePaused は「pull ではなく --continue を使う」、ConflictsUnresolved は
    // 「編集してから同じコマンドを再実行する」。案内するコマンドは同じでも行動が違う。
    expect(describeFailure({ kind: "MergePaused", conflicts: ["a.txt"] }).hint).toContain(
      "ziku pull --continue",
    );
    expect(
      describeFailure({
        kind: "ConflictsUnresolved",
        files: [{ path: "a.txt", lines: [1] }],
      }).hint,
    ).toContain("`ziku pull --continue` again");
  });

  it("未解決ブロックが 1 つだけなら line と単数で数える", () => {
    const single = describeFailure({
      kind: "ConflictsUnresolved",
      files: [{ path: "a.txt", lines: [7] }],
    });
    expect(single.hint).toContain("a.txt (line 7)");
  });

  it("レート制限は未認証ならトークン設定を、リセット時刻があれば残り時間を案内する", () => {
    const display = describeFailure({
      kind: "GitHubRateLimited",
      authenticated: false,
      resetAt: new Date(Date.now() + 5 * 60_000),
    });
    expect(display.hint).toContain("Unauthenticated quota (60/hr) exhausted");
    expect(display.hint).toContain("GITHUB_TOKEN");
    expect(display.hint).toMatch(/resets in ~\d+ min/);
  });
});

describe("zikuFailure", () => {
  it("理由から message と hint を組み立て、reason をそのまま保持する", () => {
    const failure = zikuFailure({ kind: "NotInitialized", path: ".ziku/lock.json" });

    expect(failure).toBeInstanceOf(ZikuFailure);
    expect(failure).toBeInstanceOf(Error);
    expect(failure._tag).toBe("ZikuFailure");
    expect(failure.reason).toEqual({ kind: "NotInitialized", path: ".ziku/lock.json" });
    expect(failure.message).toBe(".ziku/lock.json not found.");
    expect(failure.hint).toBe("Run 'ziku init' first.");
  });

  it("原因を捨てず cause で繋ぐ", () => {
    const cause = new Error("EACCES: permission denied");
    const failure = zikuFailure(
      {
        kind: "FileWriteFailed",
        path: ".ziku/ziku.jsonc",
        directory: "/project",
        detail: String(cause),
      },
      { cause },
    );

    expect(failure.cause).toBe(cause);
  });

  it("throw して instanceof で捕まえられる", () => {
    const failure = zikuFailure({ kind: "TemplateSourceUndetectable" });
    expect(() => {
      throw failure;
    }).toThrow(ZikuFailure);
  });
});
