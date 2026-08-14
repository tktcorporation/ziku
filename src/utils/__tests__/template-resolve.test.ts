/**
 * テンプレートの取得先ブランチが、同じ実行の中で決まる他の解決と食い違わないことの検証。
 *
 * 取得するツリー・lock に記録するコミット SHA・PR の宛先が別々のブランチを指しても、差分も
 * マージ結果も「テンプレートと比べた結果」として表示されるだけで、食い違い自体は出力に現れない。
 */
import { Effect, Exit } from "effect";
import { vol } from "memfs";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { GitHubSource } from "../../modules/schemas";

vi.mock("node:fs", async () => {
  const memfs = await import("memfs");
  return memfs.fs;
});

// giget の downloadTemplate をモック: tempDir に空ファイルを作って成功扱い
vi.mock("giget", () => ({
  downloadTemplate: vi.fn(async (_source: string, opts: { dir: string }) => {
    const { mkdirSync, writeFileSync } = await import("node:fs");
    mkdirSync(opts.dir, { recursive: true });
    writeFileSync(`${opts.dir}/dummy.txt`, "hi");
    return { dir: opts.dir };
  }),
}));

const mockReposGet = vi.fn();
vi.mock("@octokit/rest", () => ({
  Octokit: class MockOctokit {
    repos = { get: mockReposGet };
  },
}));

const { absPath } = await import("../../__tests__/brands");
const { DefaultBranchUnresolvedError } = await import("../../errors");
const { resolvePrBaseBranch } = await import("../../commands/push-plan");
const { resolveDefaultBranch, resolveSourceCommit } = await import("../github");
const { resolveTemplateDirScoped } = await import("../template-resolve");
const { _resetForTest } = await import("../temp-tracker");
const giget = await import("giget");

const source: GitHubSource = { kind: "github", owner: "tktcorporation", repo: ".github" };
const targetDir = absPath("/work");

/** `Accept: application/vnd.github.sha` の応答（SHA 文字列のみ）を模す */
const shaResponse = (sha: string) => ({
  ok: true,
  text: () => Promise.resolve(`${sha}\n`),
});

/** テンプレートを取得し、giget へ渡されたソース文字列を返す。 */
async function fetchedSourceString(templateSource: Parameters<typeof resolveTemplateDirScoped>[0]) {
  await Effect.runPromise(Effect.scoped(resolveTemplateDirScoped(templateSource, targetDir)));
  return vi.mocked(giget.downloadTemplate).mock.calls[0]?.[0];
}

describe("resolveTemplateDirScoped の取得先ブランチ", () => {
  const originalFetch = globalThis.fetch;
  const originalEnv = process.env;

  beforeEach(() => {
    vol.reset();
    _resetForTest();
    vi.clearAllMocks();
    process.env = { ...originalEnv };
    // gh CLI 経由のトークン混入を避け、未認証の挙動で検証する
    delete process.env.GITHUB_TOKEN;
    delete process.env.GH_TOKEN;
    process.env.PATH = "";
  });

  afterEach(() => {
    globalThis.fetch = originalFetch;
    process.env = originalEnv;
    _resetForTest();
  });

  it("ref 未指定なら、取得するツリー・記録する SHA・PR の宛先が同じ既定ブランチを指す", async () => {
    mockReposGet.mockResolvedValue({ data: { default_branch: "master" } });
    globalThis.fetch = vi.fn().mockResolvedValue(shaResponse("sha-master"));

    const fetched = await fetchedSourceString(source);
    const recorded = await resolveSourceCommit(source.owner, source.repo, source.ref);
    const prBase = resolvePrBaseBranch(
      source,
      await resolveDefaultBranch(source.owner, source.repo),
    );

    expect(fetched).toBe("gh:tktcorporation/.github#master");
    expect(recorded).toEqual({ _tag: "Resolved", sha: "sha-master" });
    expect(globalThis.fetch).toHaveBeenCalledWith(
      "https://api.github.com/repos/tktcorporation/.github/commits/master",
      expect.anything(),
    );
    expect(prBase).toEqual({ _tag: "Branch", name: "master" });
  });

  it("source.ref のブランチから取得し、既定ブランチは問い合わせない", async () => {
    const pinned = { ...source, ref: { kind: "branch", name: "develop" } } as const;

    expect(await fetchedSourceString(pinned)).toBe("gh:tktcorporation/.github#develop");
    expect(mockReposGet).not.toHaveBeenCalled();
  });

  it("source.ref のタグ・コミットもそのまま取得先になる", async () => {
    expect(await fetchedSourceString({ ...source, ref: { kind: "tag", name: "v1.2.3" } })).toBe(
      "gh:tktcorporation/.github#v1.2.3",
    );
  });

  it("既定ブランチを引けなければ、giget の既定へ倒さずに取得を止める", async () => {
    mockReposGet.mockRejectedValue(new Error("Not Found"));

    const exit = await Effect.runPromiseExit(
      Effect.scoped(resolveTemplateDirScoped(source, targetDir)),
    );

    expect(exit).toStrictEqual(
      Exit.fail(new DefaultBranchUnresolvedError({ owner: "tktcorporation", repo: ".github" })),
    );
    expect(giget.downloadTemplate).not.toHaveBeenCalled();
  });

  it("ローカルソースは GitHub へ問い合わせずにパスをそのまま返す", async () => {
    const dir = await Effect.runPromise(
      Effect.scoped(
        resolveTemplateDirScoped({ kind: "local", path: absPath("/tmp/tpl") }, targetDir),
      ),
    );

    expect(dir).toBe("/tmp/tpl");
    expect(mockReposGet).not.toHaveBeenCalled();
    expect(giget.downloadTemplate).not.toHaveBeenCalled();
  });
});
