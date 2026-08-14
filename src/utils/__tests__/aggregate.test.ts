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
// mockResolvedValueOnce の呼び出し順（analyzeSync が並列実行する hashFiles(templateDir) →
// hashFiles(targetDir) の順、詳細は queueGlobResults 参照）で注入する。
vi.mock("tinyglobby", () => ({
  glob: vi.fn(),
}));

const mockListOwnerRepos = vi.fn();
const mockFetchRepoTextFile = vi.fn();
const mockGetLastCommitDate = vi.fn();
const mockResolveLatestCommitSha = vi.fn();
const mockGetRepoDefaultBranch = vi.fn();

vi.mock("../github", () => ({
  listOwnerRepos: (...args: unknown[]) => mockListOwnerRepos(...args),
  fetchRepoTextFile: (...args: unknown[]) => mockFetchRepoTextFile(...args),
  getLastCommitDate: (...args: unknown[]) => mockGetLastCommitDate(...args),
  resolveLatestCommitSha: (...args: unknown[]) => mockResolveLatestCommitSha(...args),
  getRepoDefaultBranch: (...args: unknown[]) => mockGetRepoDefaultBranch(...args),
}));

const mockAcquireTempTemplate = vi.fn();

vi.mock("../template", () => ({
  buildTemplateSource: (source: { owner: string; repo: string; ref?: string }) =>
    source.ref !== undefined
      ? `gh:${source.owner}/${source.repo}#${source.ref}`
      : `gh:${source.owner}/${source.repo}`,
  acquireTempTemplate: (...args: unknown[]) => mockAcquireTempTemplate(...args),
}));

// tmpBaseDir の register/finalizer 呼び出しを検証するためモックする（#10）。
// aggregate.ts の他の一時ディレクトリ操作は "../template" 経由の acquireTempTemplate が
// 完全にモックされているため、このモックの影響を受けない。
const mockRegisterTempDirEffect = vi.fn();
const mockUnregisterTempDirEffect = vi.fn();
const mockRemoveTempDirEffect = vi.fn();

vi.mock("../temp-tracker", () => ({
  registerTempDirEffect: (...args: unknown[]) => mockRegisterTempDirEffect(...args),
  unregisterTempDirEffect: (...args: unknown[]) => mockUnregisterTempDirEffect(...args),
  removeTempDirEffect: (...args: unknown[]) => mockRemoveTempDirEffect(...args),
}));

const { aggregateTemplateUsage } = await import("../aggregate");
const { hashContent } = await import("../hash");
const { ZIKU_CONFIG_FILE } = await import("../ziku-config");
const { LOCK_FILE } = await import("../lock");
const { glob } = await import("tinyglobby");
const mockedGlob = vi.mocked(glob);

mockRegisterTempDirEffect.mockImplementation(() => Effect.void);
mockUnregisterTempDirEffect.mockImplementation(() => Effect.void);
mockRemoveTempDirEffect.mockImplementation(() => Effect.void);

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

/**
 * templateDir → repoDir の順で glob 結果を積む。
 *
 * `analyzeSync` は `Promise.all([hashFiles(templateDir, ...), hashFiles(targetDir, ...)])` で
 * 2つの hashFiles を並列実行するが、配列リテラルの評価順は左から右なので、
 * template 側の hashFiles が先に glob() を呼び出す（await で中断する前に同期的に呼ばれる）。
 */
function queueGlobResults(templateFiles: string[], repoFiles: string[]): void {
  mockedGlob.mockResolvedValueOnce(templateFiles).mockResolvedValueOnce(repoFiles);
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
    // ほとんどのテストは template.ref を明示指定するため呼ばれないが、既定値も
    // 用意しておく（呼ばれるテストは個別に上書きする）。
    mockGetRepoDefaultBranch.mockReturnValue(Effect.succeed("main"));
  });

  it("`.ziku/lock.json` が無いリポジトリは skipped に入らず黙って除外される", async () => {
    mockListOwnerRepos.mockReturnValue(
      Effect.succeed([
        repoInfo({ owner: "acme", repo: "template" }),
        repoInfo({ owner: "acme", repo: "no-lock" }),
      ]),
    );
    // SHA 解決には成功する（回帰確認: SHA 解決成功後の 404 だけが黙って除外される対象）。
    shaFixtures.set("acme/no-lock", "no-lock-sha");
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

  // lock.source.ref でテンプレートの特定リビジョンに固定している利用リポジトリは、
  // 既定ブランチの先頭と比較すると「追随していないだけの差分」が未同期として並ぶ。
  it("テンプレートの別リビジョンに固定している利用リポジトリは、理由付きで skipped に残す", async () => {
    mockListOwnerRepos.mockReturnValue(
      Effect.succeed([repoInfo({ owner: "acme", repo: "pinned" })]),
    );
    setLockFixture(
      lockFixtures,
      "acme",
      "pinned",
      Effect.succeed(
        Option.some(lockJson({ source: { owner: "acme", repo: "template", ref: "v1.0.0" } })),
      ),
    );

    const report = await Effect.runPromise(
      aggregateTemplateUsage({
        template: { owner: "acme", repo: "template", ref: "tmpl-sha" },
        tmpBaseDir: "/tmp-base",
      }),
    );

    expect(report.repositories).toEqual([]);
    expect(report.skipped).toHaveLength(1);
    expect(report.skipped[0]).toMatchObject({ owner: "acme", repo: "pinned" });
    expect(report.skipped[0]?.reason).toContain("v1.0.0");
  });

  it("lock.source.ref がスキャンの比較基準と一致していれば対象に含める", async () => {
    mockListOwnerRepos.mockReturnValue(
      Effect.succeed([repoInfo({ owner: "acme", repo: "same-ref" })]),
    );
    setLockFixture(
      lockFixtures,
      "acme",
      "same-ref",
      Effect.succeed(
        Option.some(lockJson({ source: { owner: "acme", repo: "template", ref: "tmpl-sha" } })),
      ),
    );
    shaFixtures.set("acme/same-ref", "same-ref-sha");
    dirsBySource.set("gh:acme/same-ref#same-ref-sha", "/same-ref-dir");
    dirsBySource.set("gh:acme/template#tmpl-sha", "/same-ref-tmpl-dir");
    vol.fromJSON({
      "/same-ref-dir/.ziku/ziku.jsonc": JSON.stringify({ include: ["**"] }),
      "/same-ref-tmpl-dir/.ziku/ziku.jsonc": JSON.stringify({ include: ["**"] }),
    });
    queueGlobResults([], []);

    const report = await Effect.runPromise(
      aggregateTemplateUsage({
        template: { owner: "acme", repo: "template", ref: "tmpl-sha" },
        tmpBaseDir: "/tmp-base",
      }),
    );

    expect(report.skipped).toEqual([]);
    expect(report.repositories.map((r) => r.repo)).toEqual(["same-ref"]);
  });

  it("lock.source が別テンプレートを指すリポジトリは除外される", async () => {
    mockListOwnerRepos.mockReturnValue(
      Effect.succeed([repoInfo({ owner: "acme", repo: "other-template-user" })]),
    );
    shaFixtures.set("acme/other-template-user", "other-template-user-sha");
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

    shaFixtures.set("acme/broken", "broken-sha");
    shaFixtures.set("acme/good", "good-sha");
    dirsBySource.set("gh:acme/good#good-sha", "/good-dir");
    dirsBySource.set("gh:acme/template#tmpl-sha", "/tmpl-dir-simple");

    vol.fromJSON({
      "/good-dir/.ziku/ziku.jsonc": JSON.stringify({ include: ["**"] }),
      "/tmpl-dir-simple/.ziku/ziku.jsonc": JSON.stringify({ include: ["**"] }),
      "/tmpl-dir-simple/a.txt": "hello",
    });
    queueGlobResults(["a.txt"], []);

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

  it("分類結果が pendingPush / pendingPull / conflicts に正しく写る（ziku.jsonc 自身の drift を含む）", async () => {
    mockListOwnerRepos.mockReturnValue(
      Effect.succeed([repoInfo({ owner: "acme", repo: "proj-a" })]),
    );
    // リポジトリは `ziku track` で "docs/local.md" を追加済み（テンプレートには無い）。
    const templateZikuJsonc = JSON.stringify({ include: [".github/**"] });
    const repoZikuJsonc = JSON.stringify({ include: [".github/**", "docs/local.md"] });
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
              // 前回 sync 時点ではテンプレートと同じ内容だった（= track 前）。
              // withConfigTracked による同期対象化（#1）を検証するため、実運用同様に
              // baseHashes へ ziku.jsonc 自身のハッシュも含める。
              [ZIKU_CONFIG_FILE]: hashContent(templateZikuJsonc),
            },
          }),
        ),
      ),
    );
    shaFixtures.set("acme/proj-a", "proj-a-sha");
    dirsBySource.set("gh:acme/proj-a#proj-a-sha", "/repo-a-dir");
    dirsBySource.set("gh:acme/template#tmpl-sha", "/tmpl-dir");

    vol.fromJSON({
      "/repo-a-dir/.ziku/ziku.jsonc": repoZikuJsonc,
      "/repo-a-dir/.github/ci.yml": "v1",
      "/repo-a-dir/.github/old.yml": "old-content",
      "/repo-a-dir/.github/local-change.yml": "modified-by-user",
      "/repo-a-dir/docs/local.md": "local-doc-edit",
      "/tmpl-dir/.ziku/ziku.jsonc": templateZikuJsonc,
      "/tmpl-dir/.github/ci.yml": "v2",
      "/tmpl-dir/.github/new.yml": "new-from-template",
      "/tmpl-dir/.github/local-change.yml": "orig",
      "/tmpl-dir/.github/removed-locally.yml": "stable",
      "/tmpl-dir/docs/local.md": "template-doc-edit",
    });
    queueGlobResults(
      [
        ".github/ci.yml",
        ".github/new.yml",
        ".github/local-change.yml",
        ".github/removed-locally.yml",
        "docs/local.md",
      ],
      [".github/ci.yml", ".github/old.yml", ".github/local-change.yml", "docs/local.md"],
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
    // ziku.jsonc がテンプレート/ローカルどちらのハッシュマップにも載っていれば
    // deletedFiles（誤った pendingPull）には出ない（#1 の回帰確認）。
    expect(result?.pendingPull.some((e) => e.path === ZIKU_CONFIG_FILE)).toBe(false);
    expect(result?.pendingPull).toHaveLength(3);

    // ziku.jsonc は前回 sync 以降ローカルだけが変更した（track で新パターンを追加した）ので
    // localOnly → pendingPush として実差分が報告される（#1 の主張どおり）。
    expect(result?.pendingPush).toEqual(
      expect.arrayContaining([
        { path: ".github/local-change.yml", reason: "localOnly" },
        { path: ".github/removed-locally.yml", reason: "deletedLocally" },
        { path: ZIKU_CONFIG_FILE, reason: "localOnly" },
      ]),
    );
    expect(result?.pendingPush).toHaveLength(3);

    expect(result?.conflicts).toEqual([{ path: "docs/local.md" }]);
  });

  // ziku.jsonc は加法 union で同期されるため、片側だけのパターン削除はアクション不要。
  // 生の 3-way 分類のままだと localOnly → pendingPush となり、レポートを読んだエージェントが
  // テンプレートからそのパターンを消して全利用リポジトリへ波及させうる。
  it("利用リポジトリ側だけが ziku.jsonc のパターンを削除した場合、pendingPush に出さない", async () => {
    mockListOwnerRepos.mockReturnValue(Effect.succeed([repoInfo({ owner: "acme", repo: "proj" })]));
    // テンプレートは 2 パターン、利用リポジトリは 1 つ削って 1 パターンだけ持つ。
    const templateZikuJsonc = JSON.stringify({ include: ["a.txt", "b.txt"] });
    const repoZikuJsonc = JSON.stringify({ include: ["a.txt"] });
    setLockFixture(
      lockFixtures,
      "acme",
      "proj",
      Effect.succeed(
        Option.some(
          lockJson({ baseHashes: { [ZIKU_CONFIG_FILE]: hashContent(templateZikuJsonc) } }),
        ),
      ),
    );
    shaFixtures.set("acme/proj", "proj-sha");
    dirsBySource.set("gh:acme/proj#proj-sha", "/drift-repo-dir");
    dirsBySource.set("gh:acme/template#tmpl-sha", "/drift-tmpl-dir");

    vol.fromJSON({
      "/drift-repo-dir/.ziku/ziku.jsonc": repoZikuJsonc,
      "/drift-tmpl-dir/.ziku/ziku.jsonc": templateZikuJsonc,
    });
    queueGlobResults([], []);

    const report = await Effect.runPromise(
      aggregateTemplateUsage({
        template: { owner: "acme", repo: "template", ref: "tmpl-sha" },
        tmpBaseDir: "/tmp-base",
      }),
    );

    const [result] = report.repositories;
    // union == テンプレート側なので push すべき差分は無い
    expect(result?.pendingPush.some((e) => e.path === ZIKU_CONFIG_FILE)).toBe(false);
    // union == ローカルではない（テンプレートにしか無い b.txt がある）ので pull 側に出る
    expect(result?.pendingPull).toEqual(
      expect.arrayContaining([{ path: ZIKU_CONFIG_FILE, reason: "autoUpdate" }]),
    );
  });

  // classifyFiles の deletedFiles 分岐は base/template の有無だけで判定し local を見ない。
  // 切り分けずに pendingPull へ流すと、利用リポジトリ側の編集が「削除を配布せよ」と
  // 読めてしまい、そのリポジトリにしか無い変更が捨てられる。
  it("テンプレートで削除されたファイルを、利用リポジトリ側の状態で切り分ける", async () => {
    mockListOwnerRepos.mockReturnValue(Effect.succeed([repoInfo({ owner: "acme", repo: "proj" })]));
    const zikuJsonc = JSON.stringify({ include: ["f/**"] });
    setLockFixture(
      lockFixtures,
      "acme",
      "proj",
      Effect.succeed(
        Option.some(
          lockJson({
            baseHashes: {
              "f/edited.txt": hashContent("base"),
              "f/untouched.txt": hashContent("base"),
              "f/gone-both.txt": hashContent("base"),
              [ZIKU_CONFIG_FILE]: hashContent(zikuJsonc),
            },
          }),
        ),
      ),
    );
    shaFixtures.set("acme/proj", "proj-sha");
    dirsBySource.set("gh:acme/proj#proj-sha", "/del-repo-dir");
    dirsBySource.set("gh:acme/template#tmpl-sha", "/del-tmpl-dir");

    // テンプレートは 3 ファイルすべてを削除済み。
    vol.fromJSON({
      "/del-repo-dir/.ziku/ziku.jsonc": zikuJsonc,
      "/del-repo-dir/f/edited.txt": "edited-by-consumer",
      "/del-repo-dir/f/untouched.txt": "base",
      "/del-tmpl-dir/.ziku/ziku.jsonc": zikuJsonc,
    });
    queueGlobResults([], ["f/edited.txt", "f/untouched.txt"]);

    const report = await Effect.runPromise(
      aggregateTemplateUsage({
        template: { owner: "acme", repo: "template", ref: "tmpl-sha" },
        tmpBaseDir: "/tmp-base",
      }),
    );

    const [result] = report.repositories;

    // 利用リポジトリ側で編集済み → 双方が変更した状態なので conflicts
    expect(result?.conflicts).toEqual([{ path: "f/edited.txt" }]);
    // 前回 sync 時点から変わっていない → 削除をそのまま配布できる
    expect(result?.pendingPull).toEqual(
      expect.arrayContaining([{ path: "f/untouched.txt", reason: "deletedFiles" }]),
    );
    // 双方で削除済み → 保留しているものは無い
    expect(result?.pendingPull.some((e) => e.path === "f/gone-both.txt")).toBe(false);
    expect(result?.pendingPush.some((e) => e.path === "f/gone-both.txt")).toBe(false);
    expect(result?.conflicts.some((e) => e.path === "f/gone-both.txt")).toBe(false);
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
    // attachLastCommittedAt が UTC ISO 8601 へ正規化する（#7）ため、ミリ秒付きの
    // 表記 (.000Z) になる。
    expect(report.repositories[0]?.pendingPush[0]).toMatchObject({
      path: "f.txt",
      reason: "localOnly",
      lastCommittedAt: "2026-08-10T00:00:00.000Z",
    });
  });

  it("テンプレートリポジトリ自身は結果に含まれない", async () => {
    mockListOwnerRepos.mockReturnValue(
      Effect.succeed([
        repoInfo({ owner: "acme", repo: "template" }),
        repoInfo({ owner: "acme", repo: "other" }),
      ]),
    );
    // "other" は lock.json 未導入（fetchRepoTextFile 既定の Option.none()）。SHA 解決は成功させる。
    shaFixtures.set("acme/other", "other-sha");

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

  it("`.ziku/ziku.jsonc` はテンプレートと内容が同じなら pendingPull にも pendingPush にも出ない（同期対象からの漏れ修正・#1）", async () => {
    mockListOwnerRepos.mockReturnValue(
      Effect.succeed([repoInfo({ owner: "acme", repo: "config-sync" })]),
    );
    const configContent = JSON.stringify({ include: ["docs/**"] });
    setLockFixture(
      lockFixtures,
      "acme",
      "config-sync",
      Effect.succeed(
        Option.some(
          lockJson({
            // 実運用では push/pull/init が withConfigTracked 経由で ziku.jsonc 自身の
            // ハッシュを baseHashes に記録する。この値が local/template どちらの
            // ハッシュ計算からも漏れずに含まれることを検証する。
            baseHashes: {
              [ZIKU_CONFIG_FILE]: hashContent(configContent),
              "docs/a.md": hashContent("a"),
            },
          }),
        ),
      ),
    );
    shaFixtures.set("acme/config-sync", "config-sync-sha");
    dirsBySource.set("gh:acme/config-sync#config-sync-sha", "/config-sync-dir");
    dirsBySource.set("gh:acme/template#tmpl-sha", "/tmpl-dir-config");

    vol.fromJSON({
      "/config-sync-dir/.ziku/ziku.jsonc": configContent,
      "/config-sync-dir/docs/a.md": "a",
      "/tmpl-dir-config/.ziku/ziku.jsonc": configContent,
      "/tmpl-dir-config/docs/a.md": "a",
    });
    queueGlobResults(["docs/a.md"], ["docs/a.md"]);

    const report = await Effect.runPromise(
      aggregateTemplateUsage({
        template: { owner: "acme", repo: "template", ref: "tmpl-sha" },
        tmpBaseDir: "/tmp-base",
      }),
    );

    expect(report.skipped).toEqual([]);
    expect(report.repositories).toHaveLength(1);
    const [result] = report.repositories;
    expect(result?.pendingPull.some((e) => e.path === ZIKU_CONFIG_FILE)).toBe(false);
    expect(result?.pendingPush.some((e) => e.path === ZIKU_CONFIG_FILE)).toBe(false);
  });

  it("--since 指定時、コミット日時の取得が全件失敗したリポジトリは filteredBySince で消えず skipped に入る（#4）", async () => {
    mockListOwnerRepos.mockReturnValue(
      Effect.succeed([repoInfo({ owner: "acme", repo: "rate-limited" })]),
    );
    const baseHashes = { "f.txt": hashContent("v1") };
    setLockFixture(
      lockFixtures,
      "acme",
      "rate-limited",
      Effect.succeed(Option.some(lockJson({ baseHashes }))),
    );
    shaFixtures.set("acme/rate-limited", "rl-sha");
    dirsBySource.set("gh:acme/rate-limited#rl-sha", "/rl-dir");
    dirsBySource.set("gh:acme/template#tmpl-sha", "/tmpl-dir-rl");

    vol.fromJSON({
      "/rl-dir/.ziku/ziku.jsonc": JSON.stringify({ include: ["f.txt"] }),
      "/rl-dir/f.txt": "v2-local",
      "/tmpl-dir-rl/.ziku/ziku.jsonc": JSON.stringify({ include: ["f.txt"] }),
      "/tmpl-dir-rl/f.txt": "v1",
    });
    queueGlobResults(["f.txt"], ["f.txt"]);

    // レート制限などで getLastCommitDate が全件失敗する状況を再現する。
    mockGetLastCommitDate.mockReturnValue(
      Effect.fail(new GitHubApiError({ message: "rate limited", status: 403 })),
    );

    const report = await Effect.runPromise(
      aggregateTemplateUsage({
        template: { owner: "acme", repo: "template", ref: "tmpl-sha" },
        tmpBaseDir: "/tmp-base",
        since: "2026-08-01T00:00:00.000Z",
      }),
    );

    // 「0 件 = 全部同期済み」という誤読を招く filteredBySince ではなく、
    // 理由付きで skipped に入り、判定不能だったことが分かる。
    expect(report.repositories).toEqual([]);
    expect(report.skipped).toHaveLength(1);
    expect(report.skipped[0]).toMatchObject({ owner: "acme", repo: "rate-limited" });
    expect(report.skipped[0]?.reason.length).toBeGreaterThan(0);
  });

  it("--since 比較はコミット日時をオフセットに関わらず UTC へ正規化してから行う（#7）", async () => {
    mockListOwnerRepos.mockReturnValue(
      Effect.succeed([repoInfo({ owner: "acme", repo: "offset-commit" })]),
    );
    const baseHashes = { "f.txt": hashContent("v1") };
    setLockFixture(
      lockFixtures,
      "acme",
      "offset-commit",
      Effect.succeed(Option.some(lockJson({ baseHashes }))),
    );
    shaFixtures.set("acme/offset-commit", "oc-sha");
    dirsBySource.set("gh:acme/offset-commit#oc-sha", "/oc-dir");
    dirsBySource.set("gh:acme/template#tmpl-sha", "/tmpl-dir-oc");

    vol.fromJSON({
      "/oc-dir/.ziku/ziku.jsonc": JSON.stringify({ include: ["f.txt"] }),
      "/oc-dir/f.txt": "v2-local",
      "/tmpl-dir-oc/.ziku/ziku.jsonc": JSON.stringify({ include: ["f.txt"] }),
      "/tmpl-dir-oc/f.txt": "v1",
    });
    queueGlobResults(["f.txt"], ["f.txt"]);

    // UTC 換算では since (2026-08-10T00:00:00.000Z) より前だが、"+09:00" のオフセット
    // 表記のせいで文字列の辞書順比較では since 以降に見えてしまう値。
    mockGetLastCommitDate.mockReturnValue(Effect.succeed(Option.some("2026-08-10T08:00:00+09:00")));

    const report = await Effect.runPromise(
      aggregateTemplateUsage({
        template: { owner: "acme", repo: "template", ref: "tmpl-sha" },
        tmpBaseDir: "/tmp-base",
        since: "2026-08-10T00:00:00.000Z",
      }),
    );

    // UTC 正規化後は since より前 (2026-08-09T23:00:00.000Z) なので除外される。
    // 正規化しなければ文字列比較で since 以降と誤判定され、このリポジトリが
    // repositories に残ってしまう。
    expect(report.repositories).toEqual([]);
    expect(report.skipped).toEqual([]);
  });

  it("sanitizeLabel で衝突しうる owner/repo でも、候補ごとに一意なテンポラリラベルを使う（#8）", async () => {
    mockListOwnerRepos.mockReturnValue(
      Effect.succeed([
        repoInfo({ owner: "foo.bar", repo: "x" }),
        repoInfo({ owner: "foo_bar", repo: "x" }),
      ]),
    );
    const baseHashes = { "f.txt": hashContent("v1") };
    setLockFixture(
      lockFixtures,
      "foo.bar",
      "x",
      Effect.succeed(Option.some(lockJson({ baseHashes }))),
    );
    setLockFixture(
      lockFixtures,
      "foo_bar",
      "x",
      Effect.succeed(Option.some(lockJson({ baseHashes }))),
    );
    shaFixtures.set("foo.bar/x", "sha-1");
    shaFixtures.set("foo_bar/x", "sha-2");
    dirsBySource.set("gh:foo.bar/x#sha-1", "/dir-1");
    dirsBySource.set("gh:foo_bar/x#sha-2", "/dir-2");
    dirsBySource.set("gh:acme/template#tmpl-sha", "/tmpl-dir-collision");

    vol.fromJSON({
      "/dir-1/.ziku/ziku.jsonc": JSON.stringify({ include: ["f.txt"] }),
      "/dir-1/f.txt": "v1",
      "/dir-2/.ziku/ziku.jsonc": JSON.stringify({ include: ["f.txt"] }),
      "/dir-2/f.txt": "v1",
      "/tmpl-dir-collision/.ziku/ziku.jsonc": JSON.stringify({ include: ["f.txt"] }),
      "/tmpl-dir-collision/f.txt": "v1",
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

    // sanitizeLabel("foo.bar-x") と sanitizeLabel("foo_bar-x") はどちらも "foo_bar-x" に
    // 潰れる。candidateIndex を付与することで、渡されるラベル自体は一意になる。
    const repoLabels = mockAcquireTempTemplate.mock.calls
      .filter(([, source]) => source === "gh:foo.bar/x#sha-1" || source === "gh:foo_bar/x#sha-2")
      .map(([, , label]) => label);
    expect(repoLabels).toHaveLength(2);
    expect(new Set(repoLabels).size).toBe(2);
  });

  it("テンプレートの既定ブランチを GET /repos で解決する（main 決め打ちにならない・#6）", async () => {
    // searchOwner がテンプレートと別 owner のため、listOwnerRepos の列挙結果に
    // テンプレート自身が含まれない状況を再現する。
    mockListOwnerRepos.mockReturnValue(Effect.succeed([]));
    mockGetRepoDefaultBranch.mockReturnValue(Effect.succeed("develop"));
    mockResolveLatestCommitSha.mockImplementation(
      async (_owner: string, _repo: string, ref?: string) => {
        expect(ref).toBe("develop");
        return "resolved-sha";
      },
    );

    const report = await Effect.runPromise(
      aggregateTemplateUsage({
        template: { owner: "acme", repo: "template" }, // ref 未指定
        searchOwner: "another-org",
        tmpBaseDir: "/tmp-base",
      }),
    );

    expect(mockGetRepoDefaultBranch).toHaveBeenCalledWith("acme", "template");
    expect(report.template.ref).toBe("resolved-sha");
  });

  it("tmpBaseDir 省略時は Scope クローズ時に tmpBaseDir を削除する（#10）", async () => {
    mockListOwnerRepos.mockReturnValue(Effect.succeed([]));

    await Effect.runPromise(
      aggregateTemplateUsage({
        template: { owner: "acme", repo: "template", ref: "tmpl-sha" },
      }),
    );

    expect(mockRegisterTempDirEffect).toHaveBeenCalledTimes(1);
    expect(mockRemoveTempDirEffect).toHaveBeenCalledTimes(1);
    expect(mockRegisterTempDirEffect.mock.calls[0]?.[0]).toBe(
      mockRemoveTempDirEffect.mock.calls[0]?.[0],
    );
  });

  it("--since 指定時、コミット日時の取得は concurrency 分だけ並列実行される（#2）", async () => {
    mockListOwnerRepos.mockReturnValue(
      Effect.succeed([repoInfo({ owner: "acme", repo: "many-files" })]),
    );
    const paths = ["f1.txt", "f2.txt", "f3.txt", "f4.txt"];
    const baseHashes = Object.fromEntries(paths.map((p) => [p, hashContent("v1")]));
    setLockFixture(
      lockFixtures,
      "acme",
      "many-files",
      Effect.succeed(Option.some(lockJson({ baseHashes }))),
    );
    shaFixtures.set("acme/many-files", "mf-sha");
    dirsBySource.set("gh:acme/many-files#mf-sha", "/mf-dir");
    dirsBySource.set("gh:acme/template#tmpl-sha", "/tmpl-dir-mf");

    vol.fromJSON({
      "/mf-dir/.ziku/ziku.jsonc": JSON.stringify({ include: paths }),
      "/mf-dir/f1.txt": "v2",
      "/mf-dir/f2.txt": "v2",
      "/mf-dir/f3.txt": "v2",
      "/mf-dir/f4.txt": "v2",
      "/tmpl-dir-mf/.ziku/ziku.jsonc": JSON.stringify({ include: paths }),
      "/tmpl-dir-mf/f1.txt": "v1",
      "/tmpl-dir-mf/f2.txt": "v1",
      "/tmpl-dir-mf/f3.txt": "v1",
      "/tmpl-dir-mf/f4.txt": "v1",
    });
    queueGlobResults(paths, paths);

    // 各呼び出しが同時に何件走っているかを記録し、逐次実行 (常に 1) との違いを検出する。
    let inFlight = 0;
    let maxInFlight = 0;
    mockGetLastCommitDate.mockImplementation(() =>
      Effect.gen(function* () {
        inFlight += 1;
        maxInFlight = Math.max(maxInFlight, inFlight);
        yield* Effect.sleep("20 millis");
        inFlight -= 1;
        return Option.some("2026-08-10T00:00:00Z");
      }),
    );

    await Effect.runPromise(
      aggregateTemplateUsage({
        template: { owner: "acme", repo: "template", ref: "tmpl-sha" },
        tmpBaseDir: "/tmp-base",
        concurrency: 4,
        since: "2026-08-01T00:00:00.000Z",
      }),
    );

    expect(mockGetLastCommitDate).toHaveBeenCalledTimes(4);
    // 逐次実行なら maxInFlight は常に 1 のまま。並列化されていれば 1 より大きくなる。
    expect(maxInFlight).toBeGreaterThan(1);
  });

  it("skipped の reason は英語である（#5: 後段のエージェント/他の CLI 出力との一貫性）", async () => {
    mockListOwnerRepos.mockReturnValue(
      Effect.succeed([repoInfo({ owner: "acme", repo: "broken" })]),
    );
    shaFixtures.set("acme/broken", "broken-sha");
    setLockFixture(lockFixtures, "acme", "broken", Effect.succeed(Option.some("{ not valid json")));

    const report = await Effect.runPromise(
      aggregateTemplateUsage({
        template: { owner: "acme", repo: "template", ref: "tmpl-sha" },
        tmpBaseDir: "/tmp-base",
      }),
    );

    expect(report.skipped).toHaveLength(1);
    const reason = report.skipped[0]?.reason ?? "";
    // 日本語文字（ひらがな・カタカナ・漢字・全角記号: U+3000-U+9FFF, U+FF00-U+FFEF）を
    // 含まないことを確認する。
    const JAPANESE_CHAR_PATTERN = /[　-鿿＀-￯]/;
    expect(JAPANESE_CHAR_PATTERN.test(reason)).toBe(false);
    expect(reason).toContain("Failed to parse lock.json as JSON");
  });

  it("tmpBaseDir を明示指定した場合は削除しない（#10）", async () => {
    mockListOwnerRepos.mockReturnValue(Effect.succeed([]));

    await Effect.runPromise(
      aggregateTemplateUsage({
        template: { owner: "acme", repo: "template", ref: "tmpl-sha" },
        tmpBaseDir: "/explicit-tmp-base",
      }),
    );

    expect(mockRegisterTempDirEffect).not.toHaveBeenCalled();
    expect(mockRemoveTempDirEffect).not.toHaveBeenCalled();
  });

  it("lock.json の取得は、リポジトリ内容のダウンロードと同じ commit SHA を ref に使う", async () => {
    mockListOwnerRepos.mockReturnValue(Effect.succeed([repoInfo({ owner: "acme", repo: "proj" })]));
    const baseHashes = { "f.txt": hashContent("v1") };
    setLockFixture(
      lockFixtures,
      "acme",
      "proj",
      Effect.succeed(Option.some(lockJson({ baseHashes }))),
    );
    shaFixtures.set("acme/proj", "shared-sha");
    dirsBySource.set("gh:acme/proj#shared-sha", "/proj-dir");
    dirsBySource.set("gh:acme/template#tmpl-sha", "/tmpl-dir-shared");

    vol.fromJSON({
      "/proj-dir/.ziku/ziku.jsonc": JSON.stringify({ include: ["f.txt"] }),
      "/proj-dir/f.txt": "v1",
      "/tmpl-dir-shared/.ziku/ziku.jsonc": JSON.stringify({ include: ["f.txt"] }),
      "/tmpl-dir-shared/f.txt": "v1",
    });
    queueGlobResults(["f.txt"], ["f.txt"]);

    await Effect.runPromise(
      aggregateTemplateUsage({
        template: { owner: "acme", repo: "template", ref: "tmpl-sha" },
        tmpBaseDir: "/tmp-base",
      }),
    );

    // lock.json の取得は resolveLatestCommitSha が返した SHA を ref として渡す。
    expect(mockFetchRepoTextFile).toHaveBeenCalledWith("acme", "proj", LOCK_FILE, "shared-sha");
    // リポジトリ内容のダウンロード（buildTemplateSource 経由の acquireTempTemplate）も
    // 同じ SHA を使っている（"gh:acme/proj#shared-sha" 以外のソースでは呼ばれていない）。
    const repoDownloadSources = mockAcquireTempTemplate.mock.calls
      .map(([, source]) => source)
      .filter((source) => typeof source === "string" && source.startsWith("gh:acme/proj#"));
    expect(repoDownloadSources).toEqual(["gh:acme/proj#shared-sha"]);
  });

  it("利用リポジトリと分かった後に SHA 解決が undefined を返したら理由付きで skipped に残す", async () => {
    mockListOwnerRepos.mockReturnValue(
      Effect.succeed([repoInfo({ owner: "acme", repo: "no-sha" })]),
    );
    setLockFixture(lockFixtures, "acme", "no-sha", Effect.succeed(Option.some(lockJson())));
    // shaFixtures に登録しない = mockResolveLatestCommitSha は undefined を返す

    const report = await Effect.runPromise(
      aggregateTemplateUsage({
        template: { owner: "acme", repo: "template", ref: "tmpl-sha" },
        tmpBaseDir: "/tmp-base",
      }),
    );

    expect(report.repositories).toEqual([]);
    expect(report.skipped).toEqual([
      { owner: "acme", repo: "no-sha", reason: "Could not resolve the latest commit SHA" },
    ]);
  });

  // owner 配下には空リポジトリなど SHA を解決できないものが混ざる。ziku を使っていない
  // リポジトリまで skipped に並べると、レポートがノイズで読めなくなる。
  it("ziku を使っていないリポジトリは、SHA 解決を試みずに黙って除外する", async () => {
    mockListOwnerRepos.mockReturnValue(
      Effect.succeed([repoInfo({ owner: "acme", repo: "empty-repo" })]),
    );
    // lockFixtures にも shaFixtures にも登録しない

    const report = await Effect.runPromise(
      aggregateTemplateUsage({
        template: { owner: "acme", repo: "template", ref: "tmpl-sha" },
        tmpBaseDir: "/tmp-base",
      }),
    );

    expect(report.skipped).toEqual([]);
    expect(
      mockResolveLatestCommitSha.mock.calls.some(
        ([owner, repo]) => owner === "acme" && repo === "empty-repo",
      ),
    ).toBe(false);
  });

  it("SHA 解決が失敗（例外）したリポジトリは理由付きで skipped に残る", async () => {
    mockListOwnerRepos.mockReturnValue(
      Effect.succeed([repoInfo({ owner: "acme", repo: "unresolvable" })]),
    );
    setLockFixture(lockFixtures, "acme", "unresolvable", Effect.succeed(Option.some(lockJson())));
    mockResolveLatestCommitSha.mockImplementation(async (owner: string, repo: string) => {
      if (repo === "unresolvable") throw new Error("network error");
      return shaFixtures.get(`${owner}/${repo}`);
    });

    const report = await Effect.runPromise(
      aggregateTemplateUsage({
        template: { owner: "acme", repo: "template", ref: "tmpl-sha" },
        tmpBaseDir: "/tmp-base",
      }),
    );

    expect(report.repositories).toEqual([]);
    expect(report.skipped).toHaveLength(1);
    expect(report.skipped[0]).toMatchObject({ owner: "acme", repo: "unresolvable" });
    expect(report.skipped[0]?.reason).toContain("Failed to resolve the latest commit SHA");
    expect(report.skipped[0]?.reason).toContain("network error");
  });

  it("--since で全件除外された場合、除外件数が summary.excludedBySince に載る", async () => {
    mockListOwnerRepos.mockReturnValue(
      Effect.succeed([
        repoInfo({ owner: "acme", repo: "stale-a" }),
        repoInfo({ owner: "acme", repo: "stale-b" }),
      ]),
    );
    const baseHashes = { "f.txt": hashContent("v1") };
    setLockFixture(
      lockFixtures,
      "acme",
      "stale-a",
      Effect.succeed(Option.some(lockJson({ baseHashes }))),
    );
    setLockFixture(
      lockFixtures,
      "acme",
      "stale-b",
      Effect.succeed(Option.some(lockJson({ baseHashes }))),
    );
    shaFixtures.set("acme/stale-a", "stale-a-sha");
    shaFixtures.set("acme/stale-b", "stale-b-sha");
    dirsBySource.set("gh:acme/stale-a#stale-a-sha", "/stale-a-dir");
    dirsBySource.set("gh:acme/stale-b#stale-b-sha", "/stale-b-dir");
    dirsBySource.set("gh:acme/template#tmpl-sha", "/tmpl-dir-stale");

    vol.fromJSON({
      "/stale-a-dir/.ziku/ziku.jsonc": JSON.stringify({ include: ["f.txt"] }),
      "/stale-a-dir/f.txt": "v2-stale-a",
      "/stale-b-dir/.ziku/ziku.jsonc": JSON.stringify({ include: ["f.txt"] }),
      "/stale-b-dir/f.txt": "v2-stale-b",
      "/tmpl-dir-stale/.ziku/ziku.jsonc": JSON.stringify({ include: ["f.txt"] }),
      "/tmpl-dir-stale/f.txt": "v1",
    });
    queueGlobResults(["f.txt"], ["f.txt"]);
    queueGlobResults(["f.txt"], ["f.txt"]);

    // 両リポジトリとも since より古いコミット日時を返す = 全件 filteredBySince
    mockGetLastCommitDate.mockReturnValue(Effect.succeed(Option.some("2025-01-01T00:00:00Z")));

    const report = await Effect.runPromise(
      aggregateTemplateUsage({
        template: { owner: "acme", repo: "template", ref: "tmpl-sha" },
        tmpBaseDir: "/tmp-base",
        concurrency: 1,
        since: "2026-08-01T00:00:00.000Z",
      }),
    );

    expect(report.repositories).toEqual([]);
    expect(report.skipped).toEqual([]);
    expect(report.summary.totalRepositories).toBe(0);
    expect(report.summary.excludedBySince).toBe(2);
  });
});
