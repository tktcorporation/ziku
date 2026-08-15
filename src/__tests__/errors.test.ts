import { describe, expect, it } from "vitest";
import type { FailureReason } from "../errors";
import { ZikuFailure, describeFailure, zikuFailure } from "../errors";

/** 1 つの失敗理由と、そこから出るべき文言。 */
interface FailureCase<K extends FailureReason["kind"]> {
  readonly reason: Extract<FailureReason, { readonly kind: K }>;
  readonly message: string;
  readonly hint: RegExp;
}

/**
 * すべての失敗理由の文言を検査するための材料。
 *
 * 理由の種別をキーにした写像で持ち、値を 1 件以上のタプルにする。新しい `FailureReason` を
 * 足すとキーが欠けてコンパイルエラーになるので、検査から漏れたケースは残せない。文言そのものを
 * 見る検査（英語で書かれているか）も、ソースの行ではなくここから作った `describeFailure` の
 * 戻り値を見る。行を走査する形だと、複数行に分かれたテンプレートリテラルの継続行が検査対象から
 * 外れる。
 */
type FailureCases = {
  readonly [K in FailureReason["kind"]]: readonly [FailureCase<K>, ...FailureCase<K>[]];
};

const cases: FailureCases = {
  NotInitialized: [
    {
      reason: { kind: "NotInitialized", path: ".ziku/ziku.jsonc" },
      message: ".ziku/ziku.jsonc not found.",
      hint: /ziku init/,
    },
  ],
  ConfigUnparsable: [
    {
      reason: { kind: "ConfigUnparsable", path: ".ziku/lock.json", detail: "Unexpected token }" },
      message: "Failed to parse .ziku/lock.json",
      hint: /Unexpected token/,
    },
  ],
  ConfigInvalid: [
    {
      reason: { kind: "ConfigInvalid", path: ".ziku/lock.json", issues: ["source: required"] },
      message: "Failed to read .ziku/lock.json",
      hint: /source: required[\s\S]*ziku init/,
    },
  ],
  TemplateUnavailable: [
    {
      reason: { kind: "TemplateUnavailable", detail: "ENOTFOUND api.github.com" },
      message: "Failed to load template",
      hint: /ENOTFOUND/,
    },
  ],
  TemplateNotConfigured: [
    {
      reason: { kind: "TemplateNotConfigured", templateRef: "my-org/.ziku" },
      message: "Template has no .ziku/ziku.jsonc",
      hint: /ziku setup.*my-org\/\.ziku/,
    },
  ],
  TemplateRepoNotFound: [
    {
      reason: { kind: "TemplateRepoNotFound", repos: ["my-org/.ziku", "my-org/.github"] },
      message: "Template repository not found: my-org/.ziku, my-org/.github",
      hint: /--from/,
    },
  ],
  TemplateSourceUndetectable: [
    {
      reason: { kind: "TemplateSourceUndetectable" },
      message: "Cannot detect template source",
      hint: /--from/,
    },
  ],
  AmbiguousTemplateSource: [
    {
      reason: { kind: "AmbiguousTemplateSource", candidates: ["a/.ziku", "b/.ziku"] },
      message: "Multiple template candidates found: a/.ziku, b/.ziku",
      hint: /disambiguate/,
    },
  ],
  GitHubTokenMissing: [
    {
      reason: { kind: "GitHubTokenMissing", operation: "create a PR" },
      message: "GitHub token required to create a PR",
      hint: /gh auth login/,
    },
  ],
  GitHubAuthRejected: [
    {
      reason: { kind: "GitHubAuthRejected", detail: "Bad credentials" },
      message: "GitHub authentication failed: Bad credentials",
      hint: /gh auth login/,
    },
  ],
  GitHubRateLimited: [
    {
      reason: { kind: "GitHubRateLimited", authenticated: true, resetAt: undefined },
      message: "GitHub API rate limit exceeded",
      hint: /Authenticated quota \(5000\/hr\) exhausted, or a secondary rate limit was hit$/,
    },
    {
      // 未認証はトークン設定を促し、リセット時刻があれば残り時間まで案内する。
      reason: {
        kind: "GitHubRateLimited",
        authenticated: false,
        resetAt: new Date(Date.now() + 5 * 60_000),
      },
      message: "GitHub API rate limit exceeded",
      hint: /Unauthenticated quota \(60\/hr\) exhausted[\s\S]*GITHUB_TOKEN[\s\S]*resets in ~\d+ min/,
    },
  ],
  GitHubPermissionDenied: [
    {
      reason: {
        kind: "GitHubPermissionDenied",
        operation: "create a pull request",
        detail: "Must have admin rights",
      },
      message: "GitHub refused to create a pull request: Must have admin rights",
      hint: /write access[\s\S]*forking/,
    },
  ],
  GitHubUnreachable: [
    {
      reason: {
        kind: "GitHubUnreachable",
        operation: "create a pull request",
        detail: "getaddrinfo ENOTFOUND api.github.com",
      },
      message: "Cannot reach GitHub to create a pull request: getaddrinfo ENOTFOUND api.github.com",
      hint: /network connection/,
    },
  ],
  GitHubUnusableResponse: [
    {
      reason: {
        kind: "GitHubUnusableResponse",
        operation: "read acme/proj/.ziku/lock.json",
        detail: "the response carried no usable content (size=2000000 bytes)",
      },
      message:
        "GitHub returned a response ziku cannot use while trying to read acme/proj/.ziku/lock.json: the response carried no usable content (size=2000000 bytes)",
      hint: /Re-running will not change the result/,
    },
  ],
  GitHubTargetNotFound: [
    {
      reason: {
        kind: "GitHubTargetNotFound",
        operation: "create a pull request",
        detail: "Branch not found",
      },
      message: "GitHub has no such repository or branch to create a pull request: Branch not found",
      hint: /source\.ref/,
    },
  ],
  PushDeletionTargetMissing: [
    {
      reason: {
        kind: "PushDeletionTargetMissing",
        repo: "me/my-template",
        paths: ["docs/old.md"],
      },
      message: "me/my-template has no such file to delete: docs/old.md",
      hint: /ziku pull/,
    },
  ],
  PushCreateTargetExists: [
    {
      reason: {
        kind: "PushCreateTargetExists",
        repo: "me/my-template",
        paths: [".ziku/ziku.jsonc"],
      },
      message: "me/my-template already has: .ziku/ziku.jsonc",
      hint: /Edit the file in me\/my-template directly/,
    },
  ],
  PushPathUpdatedAndDeleted: [
    {
      reason: {
        kind: "PushPathUpdatedAndDeleted",
        repo: "me/my-template",
        paths: [".mcp.json"],
      },
      message: "Cannot push .mcp.json to me/my-template as both new content and a deletion",
      hint: /--files/,
    },
  ],
  ForkNameTaken: [
    {
      reason: { kind: "ForkNameTaken", repo: "me/my-template", existing: "you/my-template" },
      message: "you/my-template already exists and is not a fork of me/my-template",
      hint: /Rename or delete you\/my-template/,
    },
  ],
  RepoTreeTooLarge: [
    {
      reason: { kind: "RepoTreeTooLarge", repo: "me/my-template" },
      message:
        "GitHub could not list every file in me/my-template: the repository tree is too large",
      hint: /Reduce the number of files in me\/my-template/,
    },
  ],
  InvalidArgument: [
    {
      reason: { kind: "InvalidArgument", argument: "--dirs", value: "nope", expected: "one of a" },
      message: 'Invalid --dirs: "nope"',
      hint: /Expected: one of a/,
    },
  ],
  MissingArgument: [
    {
      reason: { kind: "MissingArgument", argument: "patterns", usage: "Usage: ziku track <p>" },
      message: "No patterns specified.",
      hint: /Usage: ziku track/,
    },
  ],
  MergePaused: [
    {
      reason: { kind: "MergePaused", conflicts: [".mcp.json", "AGENTS.md"] },
      message: "Merge already in progress from a previous `ziku pull`",
      hint: /\u2022 \.mcp\.json[\s\S]*\u2022 AGENTS\.md[\s\S]*/,
    },
  ],
  NoMergePaused: [
    {
      reason: { kind: "NoMergePaused" },
      message: "No pending merge found",
      hint: /Run `ziku pull` first/,
    },
  ],
  ConflictsUnresolved: [
    {
      reason: {
        kind: "ConflictsUnresolved",
        files: [{ path: ".mcp.json", lines: [3, 12] }],
      },
      message: "Unresolved conflict markers remain",
      hint: /\.mcp\.json \(lines 3, 12\)/,
    },
  ],
  UnmergedChoiceRequired: [
    {
      reason: { kind: "UnmergedChoiceRequired", files: [".mcp.json", "icon.png"] },
      message: "2 file(s) could not be auto-merged and need your decision",
      hint: /without --yes \/ --force[\s\S]*• \.mcp\.json[\s\S]*• icon\.png/,
    },
  ],
  TemplateFileMissing: [
    {
      reason: { kind: "TemplateFileMissing", path: "icon.png" },
      message: "icon.png is not in the template being merged",
      hint: /keep your local version/,
    },
  ],
  DefaultBranchUnresolved: [
    {
      reason: { kind: "DefaultBranchUnresolved", repo: "owner/repo" },
      message: "Cannot determine the default branch of owner/repo",
      hint: /source\.ref/,
    },
  ],
  PushBlockedByConflicts: [
    {
      reason: { kind: "PushBlockedByConflicts", files: [".mcp.json", "AGENTS.md"] },
      message: "2 selected file(s) have conflicts that couldn't be auto-merged",
      hint: /• \.mcp\.json[\s\S]*• AGENTS\.md[\s\S]*ziku pull/,
    },
  ],
  TemplateRefNotBranch: [
    {
      reason: { kind: "TemplateRefNotBranch", refKind: "tag" },
      message: "Cannot open a pull request against a template pinned to a tag",
      hint: /source\.ref/,
    },
  ],
  FileWriteFailed: [
    {
      reason: {
        kind: "FileWriteFailed",
        path: ".ziku/ziku.jsonc",
        directory: "/project",
        detail: "EACCES",
      },
      message: "Failed to write .ziku/ziku.jsonc: EACCES",
      hint: /write permissions and free space for \/project/,
    },
  ],
  DryRunBlocked: [
    {
      reason: { kind: "DryRunBlocked", operation: "Would create template repository a/b" },
      message: "Would create template repository a/b, but --dryRun prevents remote changes",
      hint: /without --dryRun/,
    },
  ],
};

/**
 * 種別ごとの写像を、1 件ずつ検査できる並びへ均す。
 *
 * 要素の型で種別を保たないのは、並べた時点で「どの種別か」を使わないため。種別ごとの
 * 対応（`reason` の形）は {@link cases} の型が担保する。
 */
const allCases: readonly {
  readonly reason: FailureReason;
  readonly message: string;
  readonly hint: RegExp;
}[] = Object.values(cases).flat();

describe("利用者へ出す文言", () => {
  // 網羅性検査はケースが存在することしか要求しないので、文言の書き方は担保されない。
  // ケースを足す人が周りのコメント（日本語）に引きずられて日本語で書いても、型は通る。
  // 組み立てた文言そのものを見て、書き方を担保する。
  it.each(allCases)("$reason.kind の message と hint は英語で書かれている", ({ reason }) => {
    // em dash のような英文で使う記号は許す。仮名・漢字・全角記号だけを見る。
    const japanese = /[　-〿぀-ゟ゠-ヿ一-鿿＀-￯]/;
    const display = describeFailure(reason);

    expect(display.message).not.toMatch(japanese);
    expect(display.hint).not.toMatch(japanese);
  });
});

describe("describeFailure", () => {
  // 各ケースが「何が起きたか」と「次に何をするか」の両方をユーザーに渡すことを確認する。
  it.each(allCases)("$reason.kind をメッセージと hint に変換する", ({ reason, message, hint }) => {
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

  it("push を止めた衝突は、マージの再開ではなく `ziku pull` から始めるよう案内する", () => {
    // マージがまだ始まっていないので `--continue` では進めない。
    const hint = describeFailure({ kind: "PushBlockedByConflicts", files: ["a.txt"] }).hint;
    expect(hint).toContain("Run `ziku pull`");
    expect(hint).not.toContain("--continue");
  });

  it("未解決ブロックが 1 つだけなら line と単数で数える", () => {
    const single = describeFailure({
      kind: "ConflictsUnresolved",
      files: [{ path: "a.txt", lines: [7] }],
    });
    expect(single.hint).toContain("a.txt (line 7)");
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
