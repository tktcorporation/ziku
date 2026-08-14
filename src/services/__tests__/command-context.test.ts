/**
 * resolveBaseRef が、コミット SHA を引けなかった理由ごとに違う扱いをすることの検証。
 *
 * 記録済みのベースへ倒してよい失敗と、止めるべき失敗を取り違えると、失効したトークンに
 * 誰も気づかないまま陳腐化したベースで 3-way マージが続く。
 */
import { Cause, Effect, Exit, Option } from "effect";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { ZikuFailure } from "../../errors";
import type { LockState, TemplateSource } from "../../modules/schemas";
import { createPendingLock, markSynced } from "../../modules/schemas";
import { absPath, commitSha, hashMap } from "../../__tests__/brands";

const githubSource: TemplateSource = {
  kind: "github",
  owner: "tktcorporation",
  repo: ".github",
};

const localSource: TemplateSource = { kind: "local", path: absPath("/tmp/local-template") };

function lockWith(source: TemplateSource): LockState {
  return markSynced(
    createPendingLock({ version: "0.1.0", installedAt: "2024-01-01T00:00:00.000Z", source }),
    { hashes: hashMap({ ".mcp.json": "abc123" }) },
  );
}

vi.mock("../../utils/ziku-config", async () => {
  const effectMod = await import("effect");
  const brands = await import("../../__tests__/brands");
  return {
    loadZikuConfig: vi.fn(() =>
      effectMod.Effect.succeed({
        config: { include: brands.globPatterns([".mcp.json"]), exclude: [] },
        rawContent: "{}",
      }),
    ),
  };
});

vi.mock("../../utils/lock", async () => {
  const effectMod = await import("effect");
  return { loadLock: vi.fn(() => effectMod.Effect.succeed(undefined)) };
});

vi.mock("../../utils/template-resolve", async () => {
  const effectMod = await import("effect");
  const brands = await import("../../__tests__/brands");
  return {
    resolveTemplateDirScoped: vi.fn(() =>
      effectMod.Effect.succeed(brands.absPath("/tmp/template")),
    ),
  };
});

vi.mock("../../utils/github", () => ({ resolveSourceCommit: vi.fn() }));

const { loadCommandContext } = await import("../command-context");
const { loadLock } = await import("../../utils/lock");
const { resolveSourceCommit } = await import("../../utils/github");

const mockLoadLock = vi.mocked(loadLock);
const mockResolveSourceCommit = vi.mocked(resolveSourceCommit);

/** 指定のソースを持つ lock でコンテキストを組み立て、resolveBaseRef を走らせる。 */
async function runResolveBaseRef(source: TemplateSource) {
  mockLoadLock.mockReturnValue(Effect.succeed(lockWith(source)));
  const ctx = await Effect.runPromise(loadCommandContext(absPath("/test")));
  return Effect.runPromiseExit(ctx.resolveBaseRef);
}

/** Exit から失敗値を取り出す。成功していれば undefined。 */
function failureOf(exit: Exit.Exit<unknown, ZikuFailure>): ZikuFailure | undefined {
  return Exit.isFailure(exit) ? Option.getOrUndefined(Cause.failureOption(exit.cause)) : undefined;
}

describe("resolveBaseRef", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("SHA を解決できたら Some で返す", async () => {
    mockResolveSourceCommit.mockResolvedValue({ _tag: "Resolved", sha: commitSha("sha-latest") });

    const exit = await runResolveBaseRef(githubSource);

    expect(exit).toStrictEqual(Exit.succeed(Option.some("sha-latest")));
  });

  it("認証が拒否されたら失敗として返し、記録済みのベースへ黙って倒さない", async () => {
    mockResolveSourceCommit.mockResolvedValue({ _tag: "AuthRejected", detail: "Bad credentials" });

    const failure = failureOf(await runResolveBaseRef(githubSource));

    expect(failure).toBeInstanceOf(ZikuFailure);
    expect(failure?.reason).toEqual({ kind: "GitHubAuthRejected", detail: "Bad credentials" });
  });

  it("一時的な失敗は None にして呼び出し側のフォールバックへ倒す", async () => {
    mockResolveSourceCommit.mockResolvedValue({ _tag: "Unresolved", reason: "Network error" });

    const exit = await runResolveBaseRef(githubSource);

    expect(exit).toStrictEqual(Exit.succeed(Option.none()));
  });

  it("ローカルソースは API を呼ばずに None を返す", async () => {
    const exit = await runResolveBaseRef(localSource);

    expect(exit).toStrictEqual(Exit.succeed(Option.none()));
    expect(mockResolveSourceCommit).not.toHaveBeenCalled();
  });
});
