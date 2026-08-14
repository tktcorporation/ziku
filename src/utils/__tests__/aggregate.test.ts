import { Effect, Option } from "effect";
import { vol } from "memfs";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { GitHubApiError } from "../../errors";

// fs をモック
vi.mock("node:fs/promises", async () => {
  const memfs = await import("memfs");
  return memfs.fs.promises;
});
vi.mock("node:fs", async () => {
  const memfs = await import("memfs");
  return memfs.fs;
});

// tinyglobby は実際の fs を直接使うため memfs と互換性がない（hash.test.ts と同じ理由）。
// glob 自体をモックし、各テストで cwd ごとに期待するファイル一覧を
// mockResolvedValueOnce の呼び出し順（repoDir → templateDir）で注入する。
vi.mock("tinyglobby", () => ({
  glob: vi.fn(),
}));

const mockListOwnerRepos = vi.fn();
const mockFetchRepoTextFile = vi.fn();
const mockGetLastCommitDate = vi.fn();
const mockResolveLatestCommitSha = vi.fn();

vi.mock("../github", () => ({
  listOwnerRepos: (...args: unknown[]) => mockListOwnerRepos(...args),
  fetchRepoTextFile: (...args: unknown[]) => mockFetchRepoTextFile(...args),
  getLastCommitDate: (...args: unknown[]) => mockGetLastCommitDate(...args),
  resolveLatestCommitSha: (...args: unknown[]) => mockResolveLatestCommitSha(...args),
}));

const mockAcquireTempTemplate = vi.fn();

vi.mock("../template", () => ({
  buildTemplateSource: (source: { owner: string; repo: string; ref?: string }) =>
    source.ref !== undefined
      ? `gh:${source.owner}/${source.repo}#${source.ref}`
      : `gh:${source.owner}/${source.repo}`,
  acquireTempTemplate: (...args: unknown[]) => mockAcquireTempTemplate(...args),
}));

const { aggregateTemplateUsage } = await import("../aggregate");
const { hashContent } = await import("../hash");
const { glob } = await import("tinyglobby");
const mockedGlob = vi.mocked(glob);

// ---------------------------------------------------------------------------
// フィクスチャヘルパー
// ---------------------------------------------------------------------------

interface OwnerRepoFixture {
  owner: string;
  repo: string;
  defaultBranch?: string;
  archived?: boolean;
  pushedAt?: string | null;
  isPrivate?: boolean;
}

function repoInfo(fixture: OwnerRepoFixture) {
  return {
    owner: fixture.owner,
    repo: fixture.repo,
    defaultBranch: fixture.defaultBranch ?? "main",
    archived: fixture.archived ?? false,
    pushedAt: fixture.pushedAt ?? "2024-01-01T00:00:00Z",
    isPrivate: fixture.isPrivate ?? false,
  };
}

function lockJson(overrides: Record<string, unknown> = {}): string {
  return JSON.stringify({
    version: "1.0.0",
    installedAt: "2024-01-01T00:00:00Z",
    source: { owner: "acme", repo: "template" },
    ...overrides,
  });
}

/** owner/repo をキーに lock.json の取得結果を差し替える */
function setLockFixture(
  fixtures: Map<string, Effect.Effect<Option.Option<string>, GitHubApiError>>,
  owner: string,
  repo: string,
  result: Effect.Effect<Option.Option<string>, GitHubApiError>,
): void {
  fixtures.set(`${owner}/${repo}`, result);
}

/** repoDir → templateDir の順で glob 結果を積む（hashFiles の呼び出し順に対応） */
function queueGlobResults(repoFiles: string[], templateFiles: string[]): void {
  mockedGlob.mockResolvedValueOnce(repoFiles).mockResolvedValueOnce(templateFiles);
}

describe("aggregateTemplateUsage", () => {
  const lockFixtures = new Map<string, Effect.Effect<Option.Option<string>, GitHubApiError>>();
  const shaFixtures = new Map<string, string | undefined>();
  const dirsBySource = new Map<string, string>();

  beforeEach(() => {
    vol.reset();
    vi.clearAllMocks();
    lockFixtures.clear();
    shaFixtures.clear();
    dirsBySource.clear();

    mockFetchRepoTextFile.mockImplementation((owner: string, repo: string) => {
      return lockFixtures.get(`${owner}/${repo}`) ?? Effect.succeed(Option.none());
    });
    mockResolveLatestCommitSha.mockImplementation(async (owner: string, repo: string) =>
      shaFixtures.get(`${owner}/${repo}`),
    );
    mockAcquireTempTemplate.mockImplementation((_targetDir: string, source: string) => {
      const dir = dirsBySource.get(source);
      if (dir === undefined) {
        return Effect.fail(new Error(`no fixture dir registered for source: ${source}`));
      }
      return Effect.succeed(dir);
    });
    mockGetLastCommitDate.mockImplementation(() => Effect.succeed(Option.none()));
  });

  it("`.ziku/lock.json` が無いリポジトリは skipped に入らず黙って除外される", async () => {
    mockListOwnerRepos.mockReturnValue(
      Effect.succeed([
        repoInfo({ owner: "acme", repo: "template" }),
        repoInfo({ owner: "acme", repo: "no-lock" }),
      ]),
    );
    // lockFixtures に何も登録しない = fetchRepoTextFile は既定で Option.none()（404 相当）を返す

    const report = await Effect.runPromise(
      aggregateTemplateUsage({
        template: { owner: "acme", repo: "template", ref: "tmpl-sha" },
        tmpBaseDir: "/tmp-base",
      }),
    );

    expect(report.repositories).toEqual([]);
    expect(report.skipped).toEqual([]);
    expect(report.summary.totalRepositories).toBe(0);
  });

  it("lock.source が別テンプレートを指すリポジトリは除外される", async () => {
    mockListOwnerRepos.mockReturnValue(
      Effect.succeed([repoInfo({ owner: "acme", repo: "other-template-user" })]),
    );
    setLockFixture(
      lockFixtures,
      "acme",
      "other-template-user",
      Effect.succeed(
        Option.some(lockJson({ source: { owner: "someone-else", repo: "different-template" } })),
      ),
    );

    const report = await Effect.runPromise(
      aggregateTemplateUsage({
        template: { owner: "acme", repo: "template", ref: "tmpl-sha" },
        tmpBaseDir: "/tmp-base",
      }),
    );

    expect(report.repositories).toEqual([]);
    expect(report.skipped).toEqual([]);
  });

  it("lock.json が壊れているリポジトリは skipped に理由付きで入り、他のリポジトリの結果は返る", async () => {
    mockListOwnerRepos.mockReturnValue(
      Effect.succeed([
        repoInfo({ owner: "acme", repo: "broken" }),
        repoInfo({ owner: "acme", repo: "good" }),
      ]),
    );
    setLockFixture(lockFixtures, "acme", "broken", Effect.succeed(Option.some("{ not valid json")));
    setLockFixture(lockFixtures, "acme", "good", Effect.succeed(Option.some(lockJson())));

    shaFixtures.set("acme/good", "good-sha");
    dirsBySource.set("gh:acme/good#good-sha", "/good-dir");
    dirsBySource.set("gh:acme/template#tmpl-sha", "/tmpl-dir-simple");

    vol.fromJSON({
      "/good-dir/.ziku/ziku.jsonc": JSON.stringify({ include: ["**"] }),
      "/tmpl-dir-simple/.ziku/ziku.jsonc": JSON.stringify({ include: ["**"] }),
      "/tmpl-dir-simple/a.txt": "hello",
    });
    queueGlobResults([], ["a.txt"]);

    const report = await Effect.runPromise(
      aggregateTemplateUsage({
        template: { owner: "acme", repo: "template", ref: "tmpl-sha" },
        tmpBaseDir: "/tmp-base",
        concurrency: 1,
      }),
    );

    expect(report.skipped).toHaveLength(1);
    expect(report.skipped[0]).toMatchObject({ owner: "acme", repo: "broken" });
    expect(report.skipped[0]?.reason.length).toBeGreaterThan(0);

    expect(report.repositories).toHaveLength(1);
    expect(report.repositories[0]).toMatchObject({
      owner: "acme",
      repo: "good",
      ref: "good-sha",
      pendingPull: [{ path: "a.txt", reason: "newFiles" }],
      pendingPush: [],
      conflicts: [],
    });
  });

  it("分類結果が pendingPush / pendingPull / conflicts に正しく写る", async () => {
    mockListOwnerRepos.mockReturnValue(
      Effect.succeed([repoInfo({ owner: "acme", repo: "proj-a" })]),
    );
    setLockFixture(
      lockFixtures,
      "acme",
      "proj-a",
      Effect.succeed(
        Option.some(
          lockJson({
            baseHashes: {
              ".github/ci.yml": hashContent("v1"),
              ".github/old.yml": hashContent("old-content"),
              ".github/local-change.yml": hashContent("orig"),
              ".github/removed-locally.yml": hashContent("stable"),
              "docs/local.md": hashContent("base-doc"),
            },
          }),
        ),
      ),
    );
    shaFixtures.set("acme/proj-a", "proj-a-sha");
    dirsBySource.set("gh:acme/proj-a#proj-a-sha", "/repo-a-dir");
    dirsBySource.set("gh:acme/template#tmpl-sha", "/tmpl-dir");

    vol.fromJSON({
      "/repo-a-dir/.ziku/ziku.jsonc": JSON.stringify({ include: [".github/**", "docs/local.md"] }),
      "/repo-a-dir/.github/ci.yml": "v1",
      "/repo-a-dir/.github/old.yml": "old-content",
      "/repo-a-dir/.github/local-change.yml": "modified-by-user",
      "/repo-a-dir/docs/local.md": "local-doc-edit",
      "/tmpl-dir/.ziku/ziku.jsonc": JSON.stringify({ include: [".github/**"] }),
      "/tmpl-dir/.github/ci.yml": "v2",
      "/tmpl-dir/.github/new.yml": "new-from-template",
      "/tmpl-dir/.github/local-change.yml": "orig",
      "/tmpl-dir/.github/removed-locally.yml": "stable",
      "/tmpl-dir/docs/local.md": "template-doc-edit",
    });
    queueGlobResults(
      [".github/ci.yml", ".github/old.yml", ".github/local-change.yml", "docs/local.md"],
      [
        ".github/ci.yml",
        ".github/new.yml",
        ".github/local-change.yml",
        ".github/removed-locally.yml",
        "docs/local.md",
      ],
    );

    const report = await Effect.runPromise(
      aggregateTemplateUsage({
        template: { owner: "acme", repo: "template", ref: "tmpl-sha" },
        tmpBaseDir: "/tmp-base",
      }),
    );

    expect(report.skipped).toEqual([]);
    expect(report.repositories).toHaveLength(1);
    const [result] = report.repositories;

    expect(result?.pendingPull).toEqual(
      expect.arrayContaining([
        { path: ".github/ci.yml", reason: "autoUpdate" },
        { path: ".github/new.yml", reason: "newFiles" },
        { path: ".github/old.yml", reason: "deletedFiles" },
      ]),
    );
    expect(result?.pendingPull).toHaveLength(3);

    expect(result?.pendingPush).toEqual(
      expect.arrayContaining([
        { path: ".github/local-change.yml", reason: "localOnly" },
        { path: ".github/removed-locally.yml", reason: "deletedLocally" },
      ]),
    );
    expect(result?.pendingPush).toHaveLength(2);

    expect(result?.conflicts).toEqual([{ path: "docs/local.md" }]);
  });

  it("since フィルタが効く（pendingPush/conflicts の最終コミット日時でリポジトリ単位に絞り込む）", async () => {
    mockListOwnerRepos.mockReturnValue(
      Effect.succeed([
        repoInfo({ owner: "acme", repo: "recent" }),
        repoInfo({ owner: "acme", repo: "stale" }),
      ]),
    );
    const baseHashes = { "f.txt": hashContent("v1") };
    setLockFixture(
      lockFixtures,
      "acme",
      "recent",
      Effect.succeed(Option.some(lockJson({ baseHashes }))),
    );
    setLockFixture(
      lockFixtures,
      "acme",
      "stale",
      Effect.succeed(Option.some(lockJson({ baseHashes }))),
    );
    shaFixtures.set("acme/recent", "recent-sha");
    shaFixtures.set("acme/stale", "stale-sha");
    dirsBySource.set("gh:acme/recent#recent-sha", "/recent-dir");
    dirsBySource.set("gh:acme/stale#stale-sha", "/stale-dir");
    dirsBySource.set("gh:acme/template#tmpl-sha", "/tmpl-dir-since");

    vol.fromJSON({
      "/recent-dir/.ziku/ziku.jsonc": JSON.stringify({ include: ["f.txt"] }),
      "/recent-dir/f.txt": "v2-recent",
      "/stale-dir/.ziku/ziku.jsonc": JSON.stringify({ include: ["f.txt"] }),
      "/stale-dir/f.txt": "v2-stale",
      "/tmpl-dir-since/.ziku/ziku.jsonc": JSON.stringify({ include: ["f.txt"] }),
      "/tmpl-dir-since/f.txt": "v1",
    });
    // recent → template, stale → template の順（Effect.forEach concurrency:1 の処理順）
    queueGlobResults(["f.txt"], ["f.txt"]);
    queueGlobResults(["f.txt"], ["f.txt"]);

    mockGetLastCommitDate.mockImplementation((owner: string, repo: string) => {
      if (repo === "recent") return Effect.succeed(Option.some("2026-08-10T00:00:00Z"));
      if (repo === "stale") return Effect.succeed(Option.some("2025-01-01T00:00:00Z"));
      return Effect.succeed(Option.none());
    });

    const report = await Effect.runPromise(
      aggregateTemplateUsage({
        template: { owner: "acme", repo: "template", ref: "tmpl-sha" },
        tmpBaseDir: "/tmp-base",
        concurrency: 1,
        since: "2026-08-01T00:00:00Z",
      }),
    );

    expect(report.repositories.map((r) => r.repo)).toEqual(["recent"]);
    expect(report.skipped).toEqual([]);
    expect(report.repositories[0]?.pendingPush[0]).toMatchObject({
      path: "f.txt",
      reason: "localOnly",
      lastCommittedAt: "2026-08-10T00:00:00Z",
    });
  });

  it("テンプレートリポジトリ自身は結果に含まれない", async () => {
    mockListOwnerRepos.mockReturnValue(
      Effect.succeed([
        repoInfo({ owner: "acme", repo: "template" }),
        repoInfo({ owner: "acme", repo: "other" }),
      ]),
    );
    // "other" は lock.json 未導入（fetchRepoTextFile 既定の Option.none()）

    const report = await Effect.runPromise(
      aggregateTemplateUsage({
        template: { owner: "acme", repo: "template", ref: "tmpl-sha" },
        tmpBaseDir: "/tmp-base",
      }),
    );

    expect(report.repositories.some((r) => r.repo === "template")).toBe(false);
    expect(report.skipped.some((r) => r.repo === "template")).toBe(false);
    expect(
      mockFetchRepoTextFile.mock.calls.some(
        ([owner, repo]) => owner === "acme" && repo === "template",
      ),
    ).toBe(false);
  });

  it("テンプレートは利用リポジトリが何件あっても 1 度しか取得しない", async () => {
    mockListOwnerRepos.mockReturnValue(
      Effect.succeed([
        repoInfo({ owner: "acme", repo: "a" }),
        repoInfo({ owner: "acme", repo: "b" }),
      ]),
    );
    const baseHashes = { "f.txt": hashContent("v1") };
    setLockFixture(
      lockFixtures,
      "acme",
      "a",
      Effect.succeed(Option.some(lockJson({ baseHashes }))),
    );
    setLockFixture(
      lockFixtures,
      "acme",
      "b",
      Effect.succeed(Option.some(lockJson({ baseHashes }))),
    );
    shaFixtures.set("acme/a", "a-sha");
    shaFixtures.set("acme/b", "b-sha");
    dirsBySource.set("gh:acme/a#a-sha", "/a-dir");
    dirsBySource.set("gh:acme/b#b-sha", "/b-dir");
    dirsBySource.set("gh:acme/template#tmpl-sha", "/tmpl-dir-once");

    vol.fromJSON({
      "/a-dir/.ziku/ziku.jsonc": JSON.stringify({ include: ["f.txt"] }),
      "/a-dir/f.txt": "v1",
      "/b-dir/.ziku/ziku.jsonc": JSON.stringify({ include: ["f.txt"] }),
      "/b-dir/f.txt": "v1",
      "/tmpl-dir-once/.ziku/ziku.jsonc": JSON.stringify({ include: ["f.txt"] }),
      "/tmpl-dir-once/f.txt": "v1",
    });
    queueGlobResults(["f.txt"], ["f.txt"]);
    queueGlobResults(["f.txt"], ["f.txt"]);

    await Effect.runPromise(
      aggregateTemplateUsage({
        template: { owner: "acme", repo: "template", ref: "tmpl-sha" },
        tmpBaseDir: "/tmp-base",
        concurrency: 1,
      }),
    );

    const templateDownloads = mockAcquireTempTemplate.mock.calls.filter(
      ([, source]) => source === "gh:acme/template#tmpl-sha",
    );
    expect(templateDownloads).toHaveLength(1);
  });

  it("searchOwner を指定するとテンプレートの owner ではなくそちらを探索する", async () => {
    mockListOwnerRepos.mockReturnValue(Effect.succeed([]));

    await Effect.runPromise(
      aggregateTemplateUsage({
        template: { owner: "acme", repo: "template", ref: "tmpl-sha" },
        searchOwner: "another-org",
        tmpBaseDir: "/tmp-base",
      }),
    );

    expect(mockListOwnerRepos.mock.calls[0]?.[0]).toBe("another-org");
  });
});
