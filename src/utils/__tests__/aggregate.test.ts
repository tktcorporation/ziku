import { Effect, Either, Option } from "effect";
import { vol } from "memfs";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { TemplateError, ZikuFailure, zikuFailure } from "../../errors";
import type { CommitSha } from "../../modules/schemas";
import { commitShaSchema } from "../../modules/schemas";

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
const mockResolveSourceCommit = vi.fn();
const mockGetRepoIdentity = vi.fn();
const mockFetchRateLimitStatus = vi.fn();
const mockGetObservedRateLimitRemaining = vi.fn();

vi.mock("../github", async (importOriginal) => {
  // 純粋な判定関数（getGitHubToken の形式検査・detectGitHubRateLimit の HTTP ステータス/
  // ヘッダー判定）や、この分割ではモックしない他の export は実装のまま使う。
  // aggregate.ts からの named import はモックオブジェクトに存在しないと
  // vitest がエラーにするため、個別にモックする関数だけを上書きする形にする。
  const actual = await importOriginal<typeof import("../github")>();
  return {
    ...actual,
    listOwnerRepos: (...args: unknown[]) => mockListOwnerRepos(...args),
    fetchRepoTextFile: (...args: unknown[]) => mockFetchRepoTextFile(...args),
    getLastCommitDate: (...args: unknown[]) => mockGetLastCommitDate(...args),
    resolveLatestCommitSha: (...args: unknown[]) => mockResolveLatestCommitSha(...args),
    resolveSourceCommit: (...args: unknown[]) => mockResolveSourceCommit(...args),
    getRepoIdentity: (...args: unknown[]) => mockGetRepoIdentity(...args),
    fetchRateLimitStatus: (...args: unknown[]) => mockFetchRateLimitStatus(...args),
    getObservedRateLimitRemaining: (...args: unknown[]) =>
      mockGetObservedRateLimitRemaining(...args),
  };
});

const mockAcquireTempTemplate = vi.fn();

// buildTemplateSource / buildCommitPinnedSource は純粋な文字列組み立てなので実装のまま使う。
// acquireTempTemplate だけを差し替える（テンポラリディレクトリを実際には作らない）。
vi.mock("../template", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../template")>();
  return {
    ...actual,
    acquireTempTemplate: (...args: unknown[]) => mockAcquireTempTemplate(...args),
  };
});

// tmpBaseDir の register/finalizer 呼び出しを検証するためモックする。
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
const { absPath } = await import("../paths");
const { glob } = await import("tinyglobby");
const mockedGlob = vi.mocked(glob);

mockRegisterTempDirEffect.mockImplementation(() => Effect.void);
mockUnregisterTempDirEffect.mockImplementation(() => Effect.void);
mockRemoveTempDirEffect.mockImplementation(() => Effect.void);

// ---------------------------------------------------------------------------
// フィクスチャヘルパー
// ---------------------------------------------------------------------------

/** テスト用の commit SHA を brand する。 */
function sha(value: string): CommitSha {
  return commitShaSchema.parse(value);
}

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

type LockJsonRef =
  | { readonly kind: "branch" | "tag"; readonly name: string }
  | { readonly kind: "commit"; readonly sha: string };

interface LockJsonOptions {
  readonly source?: { readonly owner: string; readonly repo: string; readonly ref?: LockJsonRef };
  readonly baseHashes?: Record<string, string>;
  readonly merging?: {
    readonly conflicts: readonly { readonly path: string; readonly reason: "noBase" }[];
  };
}

/** 新スキーマ（kind 判別 union の source / sync 状態機械）に沿った lock.json フィクスチャを作る。 */
function lockJson(opts: LockJsonOptions = {}): string {
  const source = { kind: "github" as const, owner: "acme", repo: "template", ...opts.source };
  const base = { hashes: opts.baseHashes ?? {} };

  if (opts.merging) {
    return JSON.stringify({
      version: "1.0.0",
      installedAt: "2024-01-01T00:00:00Z",
      source,
      sync: "merging",
      base,
      merge: { conflicts: opts.merging.conflicts, nextBase: base },
    });
  }

  if (opts.baseHashes === undefined) {
    return JSON.stringify({
      version: "1.0.0",
      installedAt: "2024-01-01T00:00:00Z",
      source,
      sync: "pending",
    });
  }

  return JSON.stringify({
    version: "1.0.0",
    installedAt: "2024-01-01T00:00:00Z",
    source,
    sync: "synced",
    base,
  });
}

/** owner/repo をキーに lock.json の取得結果を差し替える（reject する thunk も渡せる）。 */
function setLockFixture(
  fixtures: Map<string, () => Promise<Option.Option<string>>>,
  owner: string,
  repo: string,
  thunk: () => Promise<Option.Option<string>>,
): void {
  fixtures.set(`${owner}/${repo}`, thunk);
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
  const lockFixtures = new Map<string, () => Promise<Option.Option<string>>>();
  const shaFixtures = new Map<string, CommitSha>();
  const dirsBySource = new Map<string, string>();

  beforeEach(() => {
    vol.reset();
    vi.clearAllMocks();
    lockFixtures.clear();
    shaFixtures.clear();
    dirsBySource.clear();

    mockFetchRepoTextFile.mockImplementation((owner: string, repo: string) => {
      const thunk = lockFixtures.get(`${owner}/${repo}`);
      return thunk ? thunk() : Promise.resolve(Option.none());
    });
    mockResolveLatestCommitSha.mockImplementation(async (owner: string, repo: string) => {
      const fixture = shaFixtures.get(`${owner}/${repo}`);
      return fixture !== undefined
        ? { _tag: "Resolved", sha: fixture }
        : { _tag: "Unresolved", reason: "no fixture registered" };
    });
    // resolveSourceCommit は commit 種別を API 呼び出しなしで解決する（実装と同じ挙動）。
    // ブランチ・タグの解決は個別テストで上書きする。
    mockResolveSourceCommit.mockImplementation(
      async (_owner: string, _repo: string, ref?: LockJsonRef) => {
        if (ref?.kind === "commit") return { _tag: "Resolved", sha: ref.sha };
        return { _tag: "Unresolved", reason: "no fixture registered" };
      },
    );
    mockAcquireTempTemplate.mockImplementation((_targetDir: string, source: string) => {
      const dir = dirsBySource.get(source);
      if (dir === undefined) {
        return Effect.fail(
          new TemplateError({ message: `no fixture dir registered for source: ${source}` }),
        );
      }
      return Effect.succeed(absPath(dir));
    });
    mockGetLastCommitDate.mockImplementation(() => Promise.resolve(Option.none()));
    // 既定では「リネームされていない」（owner/repo をそのまま正規名として返す）状態にする。
    // ほとんどのテストは template.ref を明示指定するため呼ばれないが、lock.source が
    // テンプレートと owner/repo 文字列で一致しない候補（canonical 解決）や、
    // template.ref 省略時の既定ブランチ解決から呼ばれる。個別に上書きする場合はそちらが優先される。
    mockGetRepoIdentity.mockImplementation((owner: string, repo: string) =>
      Promise.resolve({ owner, repo, defaultBranch: "main" }),
    );
    // 既定では「レート制限の残量を取得できなかった」状態にする。レート制限由来の絞り込みは
    // 適用できないため、候補数の上限は呼び出し側が指定した maxCandidates（未指定なら固定の
    // 既定値 DEFAULT_MAX_CANDIDATES=30）に従う（`resolveCandidateLimit` の `Unresolved` 分岐）。
    // 個別に事前絞り込みの挙動を見るテストは、ここを上書きする。
    mockFetchRateLimitStatus.mockResolvedValue({
      _tag: "Unresolved",
      reason: "not configured in this fixture",
    });
    // 動的ブレーキは既定では発動しない（観測値なし）。
    mockGetObservedRateLimitRemaining.mockReturnValue(undefined);
  });

  it("`.ziku/lock.json` が無いリポジトリは skipped に入らず黙って除外される", async () => {
    mockListOwnerRepos.mockResolvedValue([
      repoInfo({ owner: "acme", repo: "template" }),
      repoInfo({ owner: "acme", repo: "no-lock" }),
    ]);
    // SHA 解決には成功する（回帰確認: SHA 解決成功後の 404 だけが黙って除外される対象）。
    shaFixtures.set("acme/no-lock", sha("no-lock-sha"));
    // lockFixtures に何も登録しない = fetchRepoTextFile は既定で Option.none()（404 相当）を返す

    const report = await Effect.runPromise(
      aggregateTemplateUsage({
        template: { owner: "acme", repo: "template", ref: sha("tmpl-sha") },
        tmpBaseDir: "/tmp-base",
      }),
    );

    expect(report.repositories).toEqual([]);
    expect(report.skipped).toEqual([]);
    expect(report.summary.totalRepositories).toBe(0);
  });

  // pull の途中で止まっているリポジトリは、ファイルに衝突マーカーが残りうる一方
  // base のハッシュは前進していない。その中間状態を統合の対象に上げてはいけない。
  it("pull の衝突が未解決のリポジトリは、理由付きで skipped に残す", async () => {
    mockListOwnerRepos.mockResolvedValue([repoInfo({ owner: "acme", repo: "mid-pull" })]);
    setLockFixture(lockFixtures, "acme", "mid-pull", () =>
      Promise.resolve(
        Option.some(
          lockJson({
            merging: {
              conflicts: [
                { path: ".claude/rules/a.md", reason: "noBase" },
                { path: ".claude/rules/b.md", reason: "noBase" },
              ],
            },
          }),
        ),
      ),
    );

    const report = await Effect.runPromise(
      aggregateTemplateUsage({
        template: { owner: "acme", repo: "template", ref: sha("tmpl-sha") },
        tmpBaseDir: "/tmp-base",
      }),
    );

    expect(report.repositories).toEqual([]);
    expect(report.skipped).toHaveLength(1);
    expect(report.skipped[0]).toMatchObject({ owner: "acme", repo: "mid-pull" });
    expect(report.skipped[0]?.reason).toContain("pull --continue");
  });

  // lock.source.ref でテンプレートの特定リビジョンに固定している利用リポジトリは、
  // 既定ブランチの先頭と比較すると「追随していないだけの差分」が未同期として並ぶ。
  it("テンプレートの別リビジョンに固定している利用リポジトリは、理由付きで skipped に残す", async () => {
    mockListOwnerRepos.mockResolvedValue([repoInfo({ owner: "acme", repo: "pinned" })]);
    setLockFixture(lockFixtures, "acme", "pinned", () =>
      Promise.resolve(
        Option.some(
          lockJson({
            source: { owner: "acme", repo: "template", ref: { kind: "tag", name: "v1.0.0" } },
          }),
        ),
      ),
    );

    const report = await Effect.runPromise(
      aggregateTemplateUsage({
        template: { owner: "acme", repo: "template", ref: sha("tmpl-sha") },
        tmpBaseDir: "/tmp-base",
      }),
    );

    expect(report.repositories).toEqual([]);
    expect(report.skipped).toHaveLength(1);
    expect(report.skipped[0]).toMatchObject({ owner: "acme", repo: "pinned" });
    expect(report.skipped[0]?.reason).toContain("v1.0.0");
  });

  // lock.source.ref はブランチ名・タグ名も取りうる。比較基準は解決済み SHA なので、
  // 種別を問わず resolveSourceCommit で解決してから比較する。
  it("ブランチ名で固定していても、同じ SHA に解決されるなら対象に含める", async () => {
    mockListOwnerRepos.mockResolvedValue([repoInfo({ owner: "acme", repo: "branch-pinned" })]);
    setLockFixture(lockFixtures, "acme", "branch-pinned", () =>
      Promise.resolve(
        Option.some(
          lockJson({
            source: { owner: "acme", repo: "template", ref: { kind: "branch", name: "main" } },
          }),
        ),
      ),
    );
    shaFixtures.set("acme/branch-pinned", sha("branch-pinned-sha"));
    // テンプレートの "main" は比較基準と同じ SHA に解決される
    mockResolveSourceCommit.mockImplementation(
      async (owner: string, repo: string, ref?: LockJsonRef) => {
        if (
          owner === "acme" &&
          repo === "template" &&
          ref?.kind === "branch" &&
          ref.name === "main"
        ) {
          return { _tag: "Resolved", sha: sha("tmpl-sha") };
        }
        if (ref?.kind === "commit") return { _tag: "Resolved", sha: ref.sha };
        return { _tag: "Unresolved", reason: "no fixture registered" };
      },
    );
    dirsBySource.set("gh:acme/branch-pinned#branch-pinned-sha", "/branch-pinned-dir");
    dirsBySource.set("gh:acme/template#tmpl-sha", "/branch-pinned-tmpl-dir");
    vol.fromJSON({
      "/branch-pinned-dir/.ziku/ziku.jsonc": JSON.stringify({ include: ["**"] }),
      "/branch-pinned-tmpl-dir/.ziku/ziku.jsonc": JSON.stringify({ include: ["**"] }),
    });
    queueGlobResults([], []);

    const report = await Effect.runPromise(
      aggregateTemplateUsage({
        template: { owner: "acme", repo: "template", ref: sha("tmpl-sha") },
        tmpBaseDir: "/tmp-base",
      }),
    );

    expect(report.skipped).toEqual([]);
    expect(report.repositories.map((r) => r.repo)).toEqual(["branch-pinned"]);
  });

  it("lock.source.ref がスキャンの比較基準と一致していれば対象に含める", async () => {
    mockListOwnerRepos.mockResolvedValue([repoInfo({ owner: "acme", repo: "same-ref" })]);
    setLockFixture(lockFixtures, "acme", "same-ref", () =>
      Promise.resolve(
        Option.some(
          lockJson({
            source: { owner: "acme", repo: "template", ref: { kind: "commit", sha: "tmpl-sha" } },
          }),
        ),
      ),
    );
    shaFixtures.set("acme/same-ref", sha("same-ref-sha"));
    dirsBySource.set("gh:acme/same-ref#same-ref-sha", "/same-ref-dir");
    dirsBySource.set("gh:acme/template#tmpl-sha", "/same-ref-tmpl-dir");
    vol.fromJSON({
      "/same-ref-dir/.ziku/ziku.jsonc": JSON.stringify({ include: ["**"] }),
      "/same-ref-tmpl-dir/.ziku/ziku.jsonc": JSON.stringify({ include: ["**"] }),
    });
    queueGlobResults([], []);

    const report = await Effect.runPromise(
      aggregateTemplateUsage({
        template: { owner: "acme", repo: "template", ref: sha("tmpl-sha") },
        tmpBaseDir: "/tmp-base",
      }),
    );

    expect(report.skipped).toEqual([]);
    expect(report.repositories.map((r) => r.repo)).toEqual(["same-ref"]);
  });

  it("lock.source が別テンプレートを指すリポジトリは除外される", async () => {
    mockListOwnerRepos.mockResolvedValue([
      repoInfo({ owner: "acme", repo: "other-template-user" }),
    ]);
    shaFixtures.set("acme/other-template-user", sha("other-template-user-sha"));
    setLockFixture(lockFixtures, "acme", "other-template-user", () =>
      Promise.resolve(
        Option.some(lockJson({ source: { owner: "someone-else", repo: "different-template" } })),
      ),
    );

    const report = await Effect.runPromise(
      aggregateTemplateUsage({
        template: { owner: "acme", repo: "template", ref: sha("tmpl-sha") },
        tmpBaseDir: "/tmp-base",
      }),
    );

    expect(report.repositories).toEqual([]);
    expect(report.skipped).toEqual([]);
  });

  // テンプレートリポジトリがリネーム・移管されると、それ以前に init された利用リポジトリの
  // lock.source には旧名が残る。文字列比較だけでは無関係なリポジトリと誤判定して
  // 黙って除外してしまうため、正規名（GitHub のリダイレクト後の full_name）へ解決してから
  // 比べ直す。
  describe("テンプレートのリネーム・移管（lock.source の正規名解決）", () => {
    it("lock.source が旧名のままでも、正規名の解決を経てレポートに含める", async () => {
      mockListOwnerRepos.mockResolvedValue([repoInfo({ owner: "acme", repo: "renamed-consumer" })]);
      setLockFixture(lockFixtures, "acme", "renamed-consumer", () =>
        Promise.resolve(
          Option.some(lockJson({ source: { owner: "old-owner", repo: "old-template" } })),
        ),
      );
      // lock.source (old-owner/old-template) は GitHub 上のリダイレクトで
      // 現在のテンプレート (acme/template) を指す。
      mockGetRepoIdentity.mockImplementation((owner: string, repo: string) =>
        Promise.resolve(
          owner === "old-owner" && repo === "old-template"
            ? { owner: "acme", repo: "template", defaultBranch: "main" }
            : { owner, repo, defaultBranch: "main" },
        ),
      );
      shaFixtures.set("acme/renamed-consumer", sha("renamed-consumer-sha"));
      dirsBySource.set("gh:acme/renamed-consumer#renamed-consumer-sha", "/renamed-consumer-dir");
      dirsBySource.set("gh:acme/template#tmpl-sha", "/renamed-consumer-tmpl-dir");
      vol.fromJSON({
        "/renamed-consumer-dir/.ziku/ziku.jsonc": JSON.stringify({ include: ["**"] }),
        "/renamed-consumer-tmpl-dir/.ziku/ziku.jsonc": JSON.stringify({ include: ["**"] }),
      });
      queueGlobResults([], []);

      const report = await Effect.runPromise(
        aggregateTemplateUsage({
          template: { owner: "acme", repo: "template", ref: sha("tmpl-sha") },
          tmpBaseDir: "/tmp-base",
        }),
      );

      expect(report.skipped).toEqual([]);
      expect(report.repositories.map((r) => r.repo)).toEqual(["renamed-consumer"]);
    });

    it("正規名の解決が 404 だったリポジトリは skipped に積まず静かに除外する", async () => {
      mockListOwnerRepos.mockResolvedValue([repoInfo({ owner: "acme", repo: "unrelated-repo" })]);
      setLockFixture(lockFixtures, "acme", "unrelated-repo", () =>
        Promise.resolve(
          Option.some(lockJson({ source: { owner: "gone-owner", repo: "gone-template" } })),
        ),
      );
      mockGetRepoIdentity.mockImplementation((owner: string, repo: string) =>
        owner === "gone-owner" && repo === "gone-template"
          ? Promise.reject(
              zikuFailure({
                kind: "GitHubTargetNotFound",
                operation: "look up the canonical identity",
                detail: "Not Found",
              }),
            )
          : Promise.resolve({ owner, repo, defaultBranch: "main" }),
      );

      const report = await Effect.runPromise(
        aggregateTemplateUsage({
          template: { owner: "acme", repo: "template", ref: sha("tmpl-sha") },
          tmpBaseDir: "/tmp-base",
        }),
      );

      expect(report.repositories).toEqual([]);
      expect(report.skipped).toEqual([]);
    });

    it("正規名の解決が 403 など判定不能な失敗をしたリポジトリは、理由付きで skipped に残す", async () => {
      mockListOwnerRepos.mockResolvedValue([
        repoInfo({ owner: "acme", repo: "rate-limited-consumer" }),
      ]);
      setLockFixture(lockFixtures, "acme", "rate-limited-consumer", () =>
        Promise.resolve(
          Option.some(lockJson({ source: { owner: "maybe-renamed", repo: "maybe-template" } })),
        ),
      );
      mockGetRepoIdentity.mockImplementation((owner: string, repo: string) =>
        owner === "maybe-renamed" && repo === "maybe-template"
          ? Promise.reject(
              zikuFailure({
                kind: "GitHubPermissionDenied",
                operation: "look up the canonical identity",
                detail: "rate limit exceeded",
              }),
            )
          : Promise.resolve({ owner, repo, defaultBranch: "main" }),
      );

      const report = await Effect.runPromise(
        aggregateTemplateUsage({
          template: { owner: "acme", repo: "template", ref: sha("tmpl-sha") },
          tmpBaseDir: "/tmp-base",
        }),
      );

      expect(report.repositories).toEqual([]);
      expect(report.skipped).toHaveLength(1);
      expect(report.skipped[0]).toMatchObject({ owner: "acme", repo: "rate-limited-consumer" });
      expect(report.skipped[0]?.reason).toContain("rate limit exceeded");
    });

    it("lock.source が文字列としてテンプレートと一致する場合は正規名解決 API を呼ばない", async () => {
      mockListOwnerRepos.mockResolvedValue([repoInfo({ owner: "acme", repo: "exact-match" })]);
      setLockFixture(
        lockFixtures,
        "acme",
        "exact-match",
        () => Promise.resolve(Option.some(lockJson())), // source: { owner: "acme", repo: "template" }
      );
      shaFixtures.set("acme/exact-match", sha("exact-match-sha"));
      dirsBySource.set("gh:acme/exact-match#exact-match-sha", "/exact-match-dir");
      dirsBySource.set("gh:acme/template#tmpl-sha", "/exact-match-tmpl-dir");
      vol.fromJSON({
        "/exact-match-dir/.ziku/ziku.jsonc": JSON.stringify({ include: ["**"] }),
        "/exact-match-tmpl-dir/.ziku/ziku.jsonc": JSON.stringify({ include: ["**"] }),
      });
      queueGlobResults([], []);

      const report = await Effect.runPromise(
        aggregateTemplateUsage({
          template: { owner: "acme", repo: "template", ref: sha("tmpl-sha") },
          tmpBaseDir: "/tmp-base",
        }),
      );

      expect(report.repositories.map((r) => r.repo)).toEqual(["exact-match"]);
      // template.ref を明示指定しているため resolveTemplateRef 経由では呼ばれず、
      // lock.source が文字列一致するため canonical 解決経由でも呼ばれない。1 回だけ呼ばれるのは
      // listOwnerRepos の excludeRepo に渡すテンプレート自身の正規名解決分。
      expect(mockGetRepoIdentity).toHaveBeenCalledTimes(1);
      expect(mockGetRepoIdentity).toHaveBeenCalledWith("acme", "template");
    });
  });

  // 分類できない失敗（5xx や想定外のレスポンス）は defect のまま運ばれる。owner 配下
  // 全件を相手にする走査では、1 件の defect で他の全リポジトリの結果まで失う。
  it("1 リポジトリで想定外の失敗が起きても、他のリポジトリの結果は返る", async () => {
    mockListOwnerRepos.mockResolvedValue([
      repoInfo({ owner: "acme", repo: "boom" }),
      repoInfo({ owner: "acme", repo: "good" }),
    ]);
    setLockFixture(lockFixtures, "acme", "boom", () => {
      // classified() が分類できずそのまま投げ直す失敗を模す。
      throw new Error("Internal Server Error");
    });
    setLockFixture(lockFixtures, "acme", "good", () => Promise.resolve(Option.some(lockJson())));
    shaFixtures.set("acme/good", sha("good-sha"));
    dirsBySource.set("gh:acme/good#good-sha", "/good-dir");
    dirsBySource.set("gh:acme/template#tmpl-sha", "/tmpl-dir-defect");
    vol.fromJSON({
      "/good-dir/.ziku/ziku.jsonc": JSON.stringify({ include: ["**"] }),
      "/tmpl-dir-defect/.ziku/ziku.jsonc": JSON.stringify({ include: ["**"] }),
    });
    queueGlobResults([], []);

    const report = await Effect.runPromise(
      aggregateTemplateUsage({
        template: { owner: "acme", repo: "template", ref: sha("tmpl-sha") },
        tmpBaseDir: absPath("/tmp-base"),
        concurrency: 1,
      }),
    );

    // 走査は落ちず、good の結果が返る
    expect(report.repositories.map((r) => r.repo)).toEqual(["good"]);
    // 想定外の失敗は握りつぶさず、分類済みの失敗と区別できる文言で残す
    const boom = report.skipped.find((s) => s.repo === "boom");
    expect(boom?.reason).toContain("Unexpected failure");
    expect(boom?.reason).toContain("Internal Server Error");
  });

  it("lock.json が壊れているリポジトリは skipped に理由付きで入り、他のリポジトリの結果は返る", async () => {
    mockListOwnerRepos.mockResolvedValue([
      repoInfo({ owner: "acme", repo: "broken" }),
      repoInfo({ owner: "acme", repo: "good" }),
    ]);
    setLockFixture(lockFixtures, "acme", "broken", () =>
      Promise.resolve(Option.some("{ not valid json")),
    );
    setLockFixture(lockFixtures, "acme", "good", () => Promise.resolve(Option.some(lockJson())));

    shaFixtures.set("acme/broken", sha("broken-sha"));
    shaFixtures.set("acme/good", sha("good-sha"));
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
        template: { owner: "acme", repo: "template", ref: sha("tmpl-sha") },
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
    mockListOwnerRepos.mockResolvedValue([repoInfo({ owner: "acme", repo: "proj-a" })]);
    // リポジトリは `ziku track` で "docs/local.md" を追加済み（テンプレートには無い）。
    const templateZikuJsonc = JSON.stringify({ include: [".github/**"] });
    const repoZikuJsonc = JSON.stringify({ include: [".github/**", "docs/local.md"] });
    setLockFixture(lockFixtures, "acme", "proj-a", () =>
      Promise.resolve(
        Option.some(
          lockJson({
            baseHashes: {
              ".github/ci.yml": hashContent("v1"),
              ".github/old.yml": hashContent("old-content"),
              ".github/local-change.yml": hashContent("orig"),
              ".github/removed-locally.yml": hashContent("stable"),
              "docs/local.md": hashContent("base-doc"),
              // 実運用では init/pull/push が同期対象化のため ziku.jsonc 自身のハッシュも
              // baseHashes へ記録する。この値が local/template どちらのハッシュ計算からも
              // 漏れずに含まれることを検証する。
              [ZIKU_CONFIG_FILE]: hashContent(templateZikuJsonc),
            },
          }),
        ),
      ),
    );
    shaFixtures.set("acme/proj-a", sha("proj-a-sha"));
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
        template: { owner: "acme", repo: "template", ref: sha("tmpl-sha") },
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
    // deletedFiles（誤った pendingPull）には出ない。
    expect(result?.pendingPull.some((e) => e.path === ZIKU_CONFIG_FILE)).toBe(false);
    expect(result?.pendingPull).toHaveLength(3);

    // ziku.jsonc は前回 sync 以降ローカルだけが変更した（track で新パターンを追加した）ので
    // localOnly → pendingPush として実差分が報告される。
    expect(result?.pendingPush).toEqual(
      expect.arrayContaining([
        { path: ".github/local-change.yml", reason: "localOnly" },
        { path: ".github/removed-locally.yml", reason: "deletedLocally" },
        { path: ZIKU_CONFIG_FILE, reason: "localOnly" },
      ]),
    );
    expect(result?.pendingPush).toHaveLength(3);

    expect(result?.conflicts).toEqual([{ path: "docs/local.md", reason: "textConflict" }]);
  });

  // ziku.jsonc は加法 union で同期されるため、片側だけのパターン削除はアクション不要。
  // status と同じ状態機械（zikuConfigStatus）を経由することで、テンプレートからそのパターンを
  // 消して全利用リポジトリへ波及させる pendingPush を出さない。
  it("利用リポジトリ側だけが ziku.jsonc のパターンを削除した場合、pendingPush に出さない", async () => {
    mockListOwnerRepos.mockResolvedValue([repoInfo({ owner: "acme", repo: "proj" })]);
    // テンプレートは 2 パターン、利用リポジトリは 1 つ削って 1 パターンだけ持つ。
    const templateZikuJsonc = JSON.stringify({ include: ["a.txt", "b.txt"] });
    const repoZikuJsonc = JSON.stringify({ include: ["a.txt"] });
    setLockFixture(lockFixtures, "acme", "proj", () =>
      Promise.resolve(
        Option.some(
          lockJson({ baseHashes: { [ZIKU_CONFIG_FILE]: hashContent(templateZikuJsonc) } }),
        ),
      ),
    );
    shaFixtures.set("acme/proj", sha("proj-sha"));
    dirsBySource.set("gh:acme/proj#proj-sha", "/drift-repo-dir");
    dirsBySource.set("gh:acme/template#tmpl-sha", "/drift-tmpl-dir");

    vol.fromJSON({
      "/drift-repo-dir/.ziku/ziku.jsonc": repoZikuJsonc,
      "/drift-tmpl-dir/.ziku/ziku.jsonc": templateZikuJsonc,
    });
    queueGlobResults([], []);

    const report = await Effect.runPromise(
      aggregateTemplateUsage({
        template: { owner: "acme", repo: "template", ref: sha("tmpl-sha") },
        tmpBaseDir: "/tmp-base",
      }),
    );

    const [result] = report.repositories;
    // 利用リポジトリがパターンを削っただけの状態が pendingPush に出ると、レポートを読んだ
    // エージェントがテンプレートからそのパターンを消し、全利用リポジトリへ波及しうる。
    expect(result?.pendingPush.some((e) => e.path === ZIKU_CONFIG_FILE)).toBe(false);
    expect(result?.conflicts.some((e) => e.path === ZIKU_CONFIG_FILE)).toBe(false);
  });

  // classifyFiles の deletedFiles 分岐は base/template の有無だけで判定し、local を見ない。
  // テンプレート側で削除され、ローカルは base から変更している場合は
  // deletedWithLocalEdits に分離され、双方で削除済みの場合は保留が無い。
  it("テンプレートで削除されたファイルを、利用リポジトリ側の状態で切り分ける", async () => {
    mockListOwnerRepos.mockResolvedValue([repoInfo({ owner: "acme", repo: "proj" })]);
    const zikuJsonc = JSON.stringify({ include: ["f/**"] });
    setLockFixture(lockFixtures, "acme", "proj", () =>
      Promise.resolve(
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
    shaFixtures.set("acme/proj", sha("proj-sha"));
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
        template: { owner: "acme", repo: "template", ref: sha("tmpl-sha") },
        tmpBaseDir: "/tmp-base",
      }),
    );

    const [result] = report.repositories;

    // 利用リポジトリ側で編集済み → 双方が変更した状態なので conflicts（deletedWithLocalEdits）
    expect(result?.conflicts).toEqual([{ path: "f/edited.txt", reason: "deletedWithLocalEdits" }]);
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
    mockListOwnerRepos.mockResolvedValue([
      repoInfo({ owner: "acme", repo: "recent" }),
      repoInfo({ owner: "acme", repo: "stale" }),
    ]);
    const baseHashes = { "f.txt": hashContent("v1") };
    setLockFixture(lockFixtures, "acme", "recent", () =>
      Promise.resolve(Option.some(lockJson({ baseHashes }))),
    );
    setLockFixture(lockFixtures, "acme", "stale", () =>
      Promise.resolve(Option.some(lockJson({ baseHashes }))),
    );
    shaFixtures.set("acme/recent", sha("recent-sha"));
    shaFixtures.set("acme/stale", sha("stale-sha"));
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
      if (repo === "recent") return Promise.resolve(Option.some("2026-08-10T00:00:00Z"));
      if (repo === "stale") return Promise.resolve(Option.some("2025-01-01T00:00:00Z"));
      return Promise.resolve(Option.none());
    });

    const report = await Effect.runPromise(
      aggregateTemplateUsage({
        template: { owner: "acme", repo: "template", ref: sha("tmpl-sha") },
        tmpBaseDir: "/tmp-base",
        concurrency: 1,
        since: "2026-08-01T00:00:00Z",
      }),
    );

    expect(report.repositories.map((r) => r.repo)).toEqual(["recent"]);
    expect(report.skipped).toEqual([]);
    // attachLastCommittedAt が UTC ISO 8601 へ正規化するため、ミリ秒付きの
    // 表記 (.000Z) になる。
    expect(report.repositories[0]?.pendingPush[0]).toMatchObject({
      path: "f.txt",
      reason: "localOnly",
      lastCommittedAt: "2026-08-10T00:00:00.000Z",
    });
  });

  it("テンプレートリポジトリ自身は結果に含まれない", async () => {
    mockListOwnerRepos.mockResolvedValue([
      repoInfo({ owner: "acme", repo: "template" }),
      repoInfo({ owner: "acme", repo: "other" }),
    ]);
    // "other" は lock.json 未導入（fetchRepoTextFile 既定の Option.none()）。SHA 解決は成功させる。
    shaFixtures.set("acme/other", sha("other-sha"));

    const report = await Effect.runPromise(
      aggregateTemplateUsage({
        template: { owner: "acme", repo: "template", ref: sha("tmpl-sha") },
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
    mockListOwnerRepos.mockResolvedValue([
      repoInfo({ owner: "acme", repo: "a" }),
      repoInfo({ owner: "acme", repo: "b" }),
    ]);
    const baseHashes = { "f.txt": hashContent("v1") };
    setLockFixture(lockFixtures, "acme", "a", () =>
      Promise.resolve(Option.some(lockJson({ baseHashes }))),
    );
    setLockFixture(lockFixtures, "acme", "b", () =>
      Promise.resolve(Option.some(lockJson({ baseHashes }))),
    );
    shaFixtures.set("acme/a", sha("a-sha"));
    shaFixtures.set("acme/b", sha("b-sha"));
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
        template: { owner: "acme", repo: "template", ref: sha("tmpl-sha") },
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
    mockListOwnerRepos.mockResolvedValue([]);

    await Effect.runPromise(
      aggregateTemplateUsage({
        template: { owner: "acme", repo: "template", ref: sha("tmpl-sha") },
        searchOwner: "another-org",
        tmpBaseDir: "/tmp-base",
      }),
    );

    expect(mockListOwnerRepos.mock.calls[0]?.[0]).toBe("another-org");
  });

  it("`.ziku/ziku.jsonc` はテンプレートと内容が同じなら pendingPull にも pendingPush にも出ない（同期対象からの漏れ修正）", async () => {
    mockListOwnerRepos.mockResolvedValue([repoInfo({ owner: "acme", repo: "config-sync" })]);
    const configContent = JSON.stringify({ include: ["docs/**"] });
    setLockFixture(lockFixtures, "acme", "config-sync", () =>
      Promise.resolve(
        Option.some(
          lockJson({
            // 実運用では push/pull/init が ziku.jsonc 自身のハッシュを baseHashes に記録する。
            // この値が local/template どちらのハッシュ計算からも漏れずに含まれることを検証する。
            baseHashes: {
              [ZIKU_CONFIG_FILE]: hashContent(configContent),
              "docs/a.md": hashContent("a"),
            },
          }),
        ),
      ),
    );
    shaFixtures.set("acme/config-sync", sha("config-sync-sha"));
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
        template: { owner: "acme", repo: "template", ref: sha("tmpl-sha") },
        tmpBaseDir: "/tmp-base",
      }),
    );

    expect(report.skipped).toEqual([]);
    expect(report.repositories).toHaveLength(1);
    const [result] = report.repositories;
    expect(result?.pendingPull.some((e) => e.path === ZIKU_CONFIG_FILE)).toBe(false);
    expect(result?.pendingPush.some((e) => e.path === ZIKU_CONFIG_FILE)).toBe(false);
  });

  it("--since 指定時、コミット日時の取得が全件失敗したリポジトリは filteredBySince で消えず skipped に入る", async () => {
    mockListOwnerRepos.mockResolvedValue([repoInfo({ owner: "acme", repo: "rate-limited" })]);
    const baseHashes = { "f.txt": hashContent("v1") };
    setLockFixture(lockFixtures, "acme", "rate-limited", () =>
      Promise.resolve(Option.some(lockJson({ baseHashes }))),
    );
    shaFixtures.set("acme/rate-limited", sha("rl-sha"));
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
      Promise.reject(
        zikuFailure({ kind: "GitHubRateLimited", authenticated: false, resetAt: undefined }),
      ),
    );

    const report = await Effect.runPromise(
      aggregateTemplateUsage({
        template: { owner: "acme", repo: "template", ref: sha("tmpl-sha") },
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

  it("--since 比較はコミット日時をオフセットに関わらず UTC へ正規化してから行う", async () => {
    mockListOwnerRepos.mockResolvedValue([repoInfo({ owner: "acme", repo: "offset-commit" })]);
    const baseHashes = { "f.txt": hashContent("v1") };
    setLockFixture(lockFixtures, "acme", "offset-commit", () =>
      Promise.resolve(Option.some(lockJson({ baseHashes }))),
    );
    shaFixtures.set("acme/offset-commit", sha("oc-sha"));
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
    mockGetLastCommitDate.mockReturnValue(
      Promise.resolve(Option.some("2026-08-10T08:00:00+09:00")),
    );

    const report = await Effect.runPromise(
      aggregateTemplateUsage({
        template: { owner: "acme", repo: "template", ref: sha("tmpl-sha") },
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

  it("sanitizeLabel で衝突しうる owner/repo でも、候補ごとに一意なテンポラリラベルを使う", async () => {
    mockListOwnerRepos.mockResolvedValue([
      repoInfo({ owner: "foo.bar", repo: "x" }),
      repoInfo({ owner: "foo_bar", repo: "x" }),
    ]);
    const baseHashes = { "f.txt": hashContent("v1") };
    setLockFixture(lockFixtures, "foo.bar", "x", () =>
      Promise.resolve(Option.some(lockJson({ baseHashes }))),
    );
    setLockFixture(lockFixtures, "foo_bar", "x", () =>
      Promise.resolve(Option.some(lockJson({ baseHashes }))),
    );
    shaFixtures.set("foo.bar/x", sha("sha-1"));
    shaFixtures.set("foo_bar/x", sha("sha-2"));
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
        template: { owner: "acme", repo: "template", ref: sha("tmpl-sha") },
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

  it("テンプレートの既定ブランチを GET /repos で解決する（main 決め打ちにならない）", async () => {
    // searchOwner がテンプレートと別 owner のため、listOwnerRepos の列挙結果に
    // テンプレート自身が含まれない状況を再現する。
    mockListOwnerRepos.mockResolvedValue([]);
    mockGetRepoIdentity.mockResolvedValue({
      owner: "acme",
      repo: "template",
      defaultBranch: "develop",
    });
    mockResolveLatestCommitSha.mockImplementation(
      async (_owner: string, _repo: string, branch?: { kind: "branch"; name: string }) => {
        expect(branch).toEqual({ kind: "branch", name: "develop" });
        return { _tag: "Resolved", sha: sha("resolved-sha") };
      },
    );

    const report = await Effect.runPromise(
      aggregateTemplateUsage({
        template: { owner: "acme", repo: "template" }, // ref 未指定
        searchOwner: "another-org",
        tmpBaseDir: "/tmp-base",
      }),
    );

    expect(mockGetRepoIdentity).toHaveBeenCalledWith("acme", "template");
    expect(report.template.ref).toBe("resolved-sha");
  });

  it("listOwnerRepos にテンプレート自身を excludeRepo として渡す", async () => {
    mockListOwnerRepos.mockResolvedValue([]);

    await Effect.runPromise(
      aggregateTemplateUsage({
        template: { owner: "acme", repo: "template", ref: sha("tmpl-sha") },
        tmpBaseDir: "/tmp-base",
      }),
    );

    expect(mockListOwnerRepos).toHaveBeenCalledWith(
      "acme",
      expect.objectContaining({ excludeRepo: { owner: "acme", repo: "template" } }),
    );
  });

  // テンプレートがリネーム・移管された後、呼び出し側が渡す template.owner/repo が旧名の
  // ままでも、listOwnerRepos へは正規名（GitHub のリダイレクト後の表記）を excludeRepo として
  // 渡す。旧名のまま渡すと、リネーム後の一覧に含まれる正規名のテンプレート自身を
  // 除外できない。
  it("テンプレートがリネームされていても、listOwnerRepos へ正規名の excludeRepo を渡す", async () => {
    mockListOwnerRepos.mockResolvedValue([]);
    mockGetRepoIdentity.mockImplementation((owner: string, repo: string) =>
      Promise.resolve(
        owner === "old-owner" && repo === "old-template"
          ? { owner: "new-owner", repo: "new-template", defaultBranch: "main" }
          : { owner, repo, defaultBranch: "main" },
      ),
    );

    await Effect.runPromise(
      aggregateTemplateUsage({
        // ローカルの git remote 等から検出した、リネーム前の旧名。
        template: { owner: "old-owner", repo: "old-template", ref: sha("tmpl-sha") },
        tmpBaseDir: "/tmp-base",
      }),
    );

    expect(mockListOwnerRepos).toHaveBeenCalledWith(
      "old-owner",
      expect.objectContaining({ excludeRepo: { owner: "new-owner", repo: "new-template" } }),
    );
  });

  it("tmpBaseDir 省略時は Scope クローズ時に tmpBaseDir を削除する", async () => {
    mockListOwnerRepos.mockResolvedValue([]);

    await Effect.runPromise(
      aggregateTemplateUsage({
        template: { owner: "acme", repo: "template", ref: sha("tmpl-sha") },
      }),
    );

    expect(mockRegisterTempDirEffect).toHaveBeenCalledTimes(1);
    expect(mockRemoveTempDirEffect).toHaveBeenCalledTimes(1);
    expect(mockRegisterTempDirEffect.mock.calls[0]?.[0]).toBe(
      mockRemoveTempDirEffect.mock.calls[0]?.[0],
    );
  });

  it("--since 指定時、コミット日時の取得は concurrency 分だけ並列実行される", async () => {
    mockListOwnerRepos.mockResolvedValue([repoInfo({ owner: "acme", repo: "many-files" })]);
    const paths = ["f1.txt", "f2.txt", "f3.txt", "f4.txt"];
    const baseHashes = Object.fromEntries(paths.map((p) => [p, hashContent("v1")]));
    setLockFixture(lockFixtures, "acme", "many-files", () =>
      Promise.resolve(Option.some(lockJson({ baseHashes }))),
    );
    shaFixtures.set("acme/many-files", sha("mf-sha"));
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
    mockGetLastCommitDate.mockImplementation(
      () =>
        new Promise((resolve) => {
          inFlight += 1;
          maxInFlight = Math.max(maxInFlight, inFlight);
          setTimeout(() => {
            inFlight -= 1;
            resolve(Option.some("2026-08-10T00:00:00Z"));
          }, 20);
        }),
    );

    await Effect.runPromise(
      aggregateTemplateUsage({
        template: { owner: "acme", repo: "template", ref: sha("tmpl-sha") },
        tmpBaseDir: "/tmp-base",
        concurrency: 4,
        since: "2026-08-01T00:00:00.000Z",
      }),
    );

    expect(mockGetLastCommitDate).toHaveBeenCalledTimes(4);
    // 逐次実行なら maxInFlight は常に 1 のまま。並列化されていれば 1 より大きくなる。
    expect(maxInFlight).toBeGreaterThan(1);
  });

  // defect の封じ込めは候補の評価フェーズと差分処理フェーズの両方に要る。片方だけを
  // 包むと、もう片方の想定外の失敗で走査全体が落ちる。
  it("差分処理の途中で想定外の失敗が起きても、他のリポジトリの結果は返る", async () => {
    mockListOwnerRepos.mockResolvedValue([
      repoInfo({ owner: "acme", repo: "boom" }),
      repoInfo({ owner: "acme", repo: "good" }),
    ]);
    for (const r of ["boom", "good"]) {
      setLockFixture(lockFixtures, "acme", r, () => Promise.resolve(Option.some(lockJson())));
      shaFixtures.set(`acme/${r}`, sha(`${r}-sha`));
    }
    // boom はリポジトリ内容のダウンロード（評価フェーズの後）で想定外の失敗を起こす。
    dirsBySource.set("gh:acme/good#good-sha", "/good-dir2");
    dirsBySource.set("gh:acme/template#tmpl-sha", "/tmpl-dir-proc");
    vol.fromJSON({
      "/good-dir2/.ziku/ziku.jsonc": JSON.stringify({ include: ["**"] }),
      "/tmpl-dir-proc/.ziku/ziku.jsonc": JSON.stringify({ include: ["**"] }),
    });
    queueGlobResults([], []);

    const report = await Effect.runPromise(
      aggregateTemplateUsage({
        template: { owner: "acme", repo: "template", ref: sha("tmpl-sha") },
        tmpBaseDir: "/tmp-base",
        concurrency: 1,
      }),
    );

    expect(report.repositories.map((r) => r.repo)).toEqual(["good"]);
    expect(report.skipped.some((s) => s.repo === "boom")).toBe(true);
  });

  // リポジトリ側とファイル側の両方に同じ並列度を渡すと掛け算になり、指定値の 2 乗まで
  // 同時リクエストが膨らむ。上限が全リポジトリ横断で効いていることを固定する。
  it("--since 指定時、コミット日時の取得は全リポジトリ横断で concurrency を超えない", async () => {
    const repos = ["r1", "r2"];
    const paths = ["f1.txt", "f2.txt", "f3.txt", "f4.txt"];
    const baseHashes = Object.fromEntries(paths.map((p) => [p, hashContent("v1")]));
    mockListOwnerRepos.mockResolvedValue(repos.map((r) => repoInfo({ owner: "acme", repo: r })));

    const files: Record<string, string> = {
      "/tmpl-dir-cap/.ziku/ziku.jsonc": JSON.stringify({ include: paths }),
    };
    for (const p of paths) files[`/tmpl-dir-cap/${p}`] = "v1";
    for (const r of repos) {
      setLockFixture(lockFixtures, "acme", r, () =>
        Promise.resolve(Option.some(lockJson({ baseHashes }))),
      );
      shaFixtures.set(`acme/${r}`, sha(`${r}-sha`));
      dirsBySource.set(`gh:acme/${r}#${r}-sha`, `/${r}-dir`);
      files[`/${r}-dir/.ziku/ziku.jsonc`] = JSON.stringify({ include: paths });
      for (const p of paths) files[`/${r}-dir/${p}`] = "v2";
    }
    dirsBySource.set("gh:acme/template#tmpl-sha", "/tmpl-dir-cap");
    vol.fromJSON(files);
    for (const _ of repos) queueGlobResults(paths, paths);

    let inFlight = 0;
    let maxInFlight = 0;
    mockGetLastCommitDate.mockImplementation(
      () =>
        new Promise((resolve) => {
          inFlight += 1;
          maxInFlight = Math.max(maxInFlight, inFlight);
          setTimeout(() => {
            inFlight -= 1;
            resolve(Option.some("2026-08-10T00:00:00Z"));
          }, 10);
        }),
    );

    await Effect.runPromise(
      aggregateTemplateUsage({
        template: { owner: "acme", repo: "template", ref: sha("tmpl-sha") },
        tmpBaseDir: "/tmp-base",
        concurrency: 2,
        since: "2026-08-01T00:00:00.000Z",
      }),
    );

    // 2 リポジトリ × 4 ファイル = 8 件を投げるが、同時に走るのは 2 件まで。
    expect(mockGetLastCommitDate).toHaveBeenCalledTimes(8);
    expect(maxInFlight).toBeLessThanOrEqual(2);
  });

  // tryGitHubGated の事後ゲートは実際に 403/429 を受け取って初めて発動するため、変更
  // ファイルが多いリポジトリでは、枯渇するまでファイルごとに新規リクエストを送り続けて
  // しまう。ファイル単位の動的ブレーキ（cannotAffordRemainingRequests）が、実際に
  // レート制限へ達する前に以降のファイルへの getLastCommitDate 呼び出しを止めることを
  // 固定する回帰ケース。
  it("--since 指定時、コミット日時取得中に観測残量が枯渇に近づいたら、以降のファイルへは getLastCommitDate を呼ばない", async () => {
    mockListOwnerRepos.mockResolvedValue([repoInfo({ owner: "acme", repo: "many-files-rl" })]);
    const paths = ["f1.txt", "f2.txt", "f3.txt", "f4.txt"];
    const baseHashes = Object.fromEntries(paths.map((p) => [p, hashContent("v1")]));
    setLockFixture(lockFixtures, "acme", "many-files-rl", () =>
      Promise.resolve(Option.some(lockJson({ baseHashes }))),
    );
    shaFixtures.set("acme/many-files-rl", sha("mfrl-sha"));
    dirsBySource.set("gh:acme/many-files-rl#mfrl-sha", "/mfrl-dir");
    dirsBySource.set("gh:acme/template#tmpl-sha", "/tmpl-dir-mfrl");

    vol.fromJSON({
      "/mfrl-dir/.ziku/ziku.jsonc": JSON.stringify({ include: paths }),
      "/mfrl-dir/f1.txt": "v2",
      "/mfrl-dir/f2.txt": "v2",
      "/mfrl-dir/f3.txt": "v2",
      "/mfrl-dir/f4.txt": "v2",
      "/tmpl-dir-mfrl/.ziku/ziku.jsonc": JSON.stringify({ include: paths }),
      "/tmpl-dir-mfrl/f1.txt": "v1",
      "/tmpl-dir-mfrl/f2.txt": "v1",
      "/tmpl-dir-mfrl/f3.txt": "v1",
      "/tmpl-dir-mfrl/f4.txt": "v1",
    });
    queueGlobResults(paths, paths);

    mockGetLastCommitDate.mockImplementation(() =>
      Promise.resolve(Option.some("2026-08-10T00:00:00Z")),
    );

    // 1 回目（評価フェーズ）と f1・f2 の直前（2・3 回目）は未観測のままとし、f3 の直前
    // （4 回目）で観測残量 1 を返す。f3 の必要見積もりは (remainingAfter(1)+1) * 1 = 2 なので
    // 1 < 2 でブレーキが発動し、f3・f4 は getLastCommitDate を呼ばれない。
    let observedCallCount = 0;
    mockGetObservedRateLimitRemaining.mockImplementation(() => {
      observedCallCount += 1;
      return observedCallCount <= 3 ? undefined : { remaining: 1, resetAt: undefined };
    });

    const report = await Effect.runPromise(
      aggregateTemplateUsage({
        template: { owner: "acme", repo: "template", ref: sha("tmpl-sha") },
        tmpBaseDir: "/tmp-base",
        concurrency: 1,
        since: "2026-08-01T00:00:00.000Z",
      }),
    );

    expect(mockGetLastCommitDate).toHaveBeenCalledTimes(2);
    expect(report.repositories).toEqual([]);
    expect(report.skipped).toHaveLength(1);
    expect(report.skipped[0]).toMatchObject({ owner: "acme", repo: "many-files-rl" });
  });

  // attachLastCommittedAt の動的ブレーキ（cannotAffordRemainingRequests）が、境界値
  // （観測残量がちょうど残りエントリ数分足りる）で誤発動しないことを固定する。
  it("--since 指定時、観測残量がちょうど残りエントリ数分足りる場合、動的ブレーキは誤発動しない", async () => {
    mockListOwnerRepos.mockResolvedValue([repoInfo({ owner: "acme", repo: "exact-fit" })]);
    const baseHashes = { "f.txt": hashContent("v1") };
    setLockFixture(lockFixtures, "acme", "exact-fit", () =>
      Promise.resolve(Option.some(lockJson({ baseHashes }))),
    );
    shaFixtures.set("acme/exact-fit", sha("exact-fit-sha"));
    dirsBySource.set("gh:acme/exact-fit#exact-fit-sha", "/exact-fit-dir");
    dirsBySource.set("gh:acme/template#tmpl-sha", "/tmpl-dir-exact-fit");

    vol.fromJSON({
      "/exact-fit-dir/.ziku/ziku.jsonc": JSON.stringify({ include: ["f.txt"] }),
      "/exact-fit-dir/f.txt": "v2",
      "/tmpl-dir-exact-fit/.ziku/ziku.jsonc": JSON.stringify({ include: ["f.txt"] }),
      "/tmpl-dir-exact-fit/f.txt": "v1",
    });
    queueGlobResults(["f.txt"], ["f.txt"]);

    mockGetLastCommitDate.mockImplementation(() =>
      Promise.resolve(Option.some("2026-08-10T00:00:00Z")),
    );

    // 評価フェーズ（1 回目の呼び出し）は未観測のままとし、唯一のファイル（f.txt、
    // remainingAfter=0）の直前で観測残量 1 を返す。`cannotAffordRemainingRequests(1, 0, 1)` は
    // `1 < (0+1)*1 = 1` が false なので、ちょうどまかなえてブレーキは発動しない。
    let observedCallCount = 0;
    mockGetObservedRateLimitRemaining.mockImplementation(() => {
      observedCallCount += 1;
      return observedCallCount === 1 ? undefined : { remaining: 1, resetAt: undefined };
    });

    const report = await Effect.runPromise(
      aggregateTemplateUsage({
        template: { owner: "acme", repo: "template", ref: sha("tmpl-sha") },
        tmpBaseDir: "/tmp-base",
        since: "2026-08-01T00:00:00.000Z",
      }),
    );

    expect(mockGetLastCommitDate).toHaveBeenCalledTimes(1);
    expect(report.skipped).toEqual([]);
    expect(report.repositories).toHaveLength(1);
  });

  it("--since 指定時、観測残量が残りエントリ数分より1つ足りない場合、動的ブレーキは発動する", async () => {
    mockListOwnerRepos.mockResolvedValue([repoInfo({ owner: "acme", repo: "one-short" })]);
    const baseHashes = { "f.txt": hashContent("v1") };
    setLockFixture(lockFixtures, "acme", "one-short", () =>
      Promise.resolve(Option.some(lockJson({ baseHashes }))),
    );
    shaFixtures.set("acme/one-short", sha("one-short-sha"));
    dirsBySource.set("gh:acme/one-short#one-short-sha", "/one-short-dir");
    dirsBySource.set("gh:acme/template#tmpl-sha", "/tmpl-dir-one-short");

    vol.fromJSON({
      "/one-short-dir/.ziku/ziku.jsonc": JSON.stringify({ include: ["f.txt"] }),
      "/one-short-dir/f.txt": "v2",
      "/tmpl-dir-one-short/.ziku/ziku.jsonc": JSON.stringify({ include: ["f.txt"] }),
      "/tmpl-dir-one-short/f.txt": "v1",
    });
    queueGlobResults(["f.txt"], ["f.txt"]);

    mockGetLastCommitDate.mockImplementation(() =>
      Promise.resolve(Option.some("2026-08-10T00:00:00Z")),
    );

    // 観測残量 0 は、唯一のファイル（remainingAfter=0）の必要見積もり
    // `(0+1)*1 = 1` を 1 つ下回る。境界のもう一方として、この場合は発動することを固定する。
    let observedCallCount = 0;
    mockGetObservedRateLimitRemaining.mockImplementation(() => {
      observedCallCount += 1;
      return observedCallCount === 1 ? undefined : { remaining: 0, resetAt: undefined };
    });

    const report = await Effect.runPromise(
      aggregateTemplateUsage({
        template: { owner: "acme", repo: "template", ref: sha("tmpl-sha") },
        tmpBaseDir: "/tmp-base",
        since: "2026-08-01T00:00:00.000Z",
      }),
    );

    expect(mockGetLastCommitDate).not.toHaveBeenCalled();
    expect(report.repositories).toEqual([]);
    expect(report.skipped).toHaveLength(1);
    expect(report.skipped[0]).toMatchObject({ owner: "acme", repo: "one-short" });
  });

  // classifyAgainstTemplate は giget 経由でテンプレート/候補内容をダウンロードするが、giget は
  // githubFetch を経由しないためダウンロードの成功がレート制限残量の観測に反映されない。
  // ダウンロード直後・attachLastCommittedAt の動的ブレーキ判定に入る前に fetchRateLimitStatus
  // を呼び、observedRateLimit を明示的にリフレッシュすることを固定する。
  it("--since 指定時、候補のダウンロード後・動的ブレーキ判定前に fetchRateLimitStatus を呼ぶ", async () => {
    mockListOwnerRepos.mockResolvedValue([repoInfo({ owner: "acme", repo: "refresh-rl" })]);
    const baseHashes = { "f.txt": hashContent("v1") };
    setLockFixture(lockFixtures, "acme", "refresh-rl", () =>
      Promise.resolve(Option.some(lockJson({ baseHashes }))),
    );
    shaFixtures.set("acme/refresh-rl", sha("refresh-rl-sha"));
    dirsBySource.set("gh:acme/refresh-rl#refresh-rl-sha", "/refresh-rl-dir");
    dirsBySource.set("gh:acme/template#tmpl-sha", "/tmpl-dir-refresh");

    vol.fromJSON({
      "/refresh-rl-dir/.ziku/ziku.jsonc": JSON.stringify({ include: ["f.txt"] }),
      "/refresh-rl-dir/f.txt": "v2",
      "/tmpl-dir-refresh/.ziku/ziku.jsonc": JSON.stringify({ include: ["f.txt"] }),
      "/tmpl-dir-refresh/f.txt": "v1",
    });
    queueGlobResults(["f.txt"], ["f.txt"]);

    const callOrder: string[] = [];
    mockAcquireTempTemplate.mockImplementation((_targetDir: string, source: string) => {
      if (source.startsWith("gh:acme/refresh-rl#")) {
        callOrder.push("download-repo");
      }
      const dir = dirsBySource.get(source);
      if (dir === undefined) {
        return Effect.fail(
          new TemplateError({
            message: `no fixture dir registered for source: ${source}`,
          }),
        );
      }
      return Effect.succeed(absPath(dir));
    });
    mockFetchRateLimitStatus.mockImplementation(() => {
      callOrder.push("fetch-rate-limit-status");
      return Promise.resolve({
        _tag: "Resolved",
        status: { limit: 5000, remaining: 4000, resetAt: undefined, authenticated: false },
      });
    });
    mockGetLastCommitDate.mockImplementation(() => {
      callOrder.push("get-last-commit-date");
      return Promise.resolve(Option.some("2026-08-10T00:00:00Z"));
    });

    const report = await Effect.runPromise(
      aggregateTemplateUsage({
        template: { owner: "acme", repo: "template", ref: sha("tmpl-sha") },
        tmpBaseDir: "/tmp-base",
        since: "2026-08-01T00:00:00.000Z",
      }),
    );

    // resolveCandidateLimit（スキャン開始前の候補数見積もり）でも fetchRateLimitStatus は
    // 1 回呼ばれるため、ここでは「候補のダウンロード後に呼ばれた分」を最後の呼び出しとして
    // 特定し、それが download-repo より後・get-last-commit-date より前であることを見る。
    const downloadIndex = callOrder.indexOf("download-repo");
    const lastRateLimitIndex = callOrder.lastIndexOf("fetch-rate-limit-status");
    const commitDateIndex = callOrder.indexOf("get-last-commit-date");
    expect(downloadIndex).toBeGreaterThanOrEqual(0);
    expect(lastRateLimitIndex).toBeGreaterThan(downloadIndex);
    expect(commitDateIndex).toBeGreaterThan(lastRateLimitIndex);
    expect(mockFetchRateLimitStatus).toHaveBeenCalledTimes(2);
    expect(report.repositories).toHaveLength(1);
  });

  it("since 未指定時は attachLastCommittedAt を呼ばず、fetchRateLimitStatus を候補処理中に追加で呼ばない", async () => {
    mockListOwnerRepos.mockResolvedValue([repoInfo({ owner: "acme", repo: "no-since" })]);
    const baseHashes = { "f.txt": hashContent("v1") };
    setLockFixture(lockFixtures, "acme", "no-since", () =>
      Promise.resolve(Option.some(lockJson({ baseHashes }))),
    );
    shaFixtures.set("acme/no-since", sha("no-since-sha"));
    dirsBySource.set("gh:acme/no-since#no-since-sha", "/no-since-dir");
    dirsBySource.set("gh:acme/template#tmpl-sha", "/tmpl-dir-no-since");

    vol.fromJSON({
      "/no-since-dir/.ziku/ziku.jsonc": JSON.stringify({ include: ["f.txt"] }),
      // テンプレート側と内容を変え、pendingPush に 1 件入る状態を作る。この関数が
      // `since` の有無を見ずに attachLastCommittedAt を呼んでしまう回帰を検知するには、
      // attachLastCommittedAt に渡るエントリ配列が空でない（呼ばれれば必ず
      // getLastCommitDate が実行される）必要がある。
      "/no-since-dir/f.txt": "v2",
      "/tmpl-dir-no-since/.ziku/ziku.jsonc": JSON.stringify({ include: ["f.txt"] }),
      "/tmpl-dir-no-since/f.txt": "v1",
    });
    queueGlobResults(["f.txt"], ["f.txt"]);

    const report = await Effect.runPromise(
      aggregateTemplateUsage({
        template: { owner: "acme", repo: "template", ref: sha("tmpl-sha") },
        tmpBaseDir: "/tmp-base",
      }),
    );

    expect(report.repositories).toHaveLength(1);
    expect(mockGetLastCommitDate).not.toHaveBeenCalled();
    // resolveCandidateLimit の事前見積もりで 1 回呼ばれるだけで、--since 用のリフレッシュは
    // 発生しない。
    expect(mockFetchRateLimitStatus).toHaveBeenCalledTimes(1);
  });

  it("skipped の reason は英語である（後段のエージェント/他の CLI 出力との一貫性）", async () => {
    mockListOwnerRepos.mockResolvedValue([repoInfo({ owner: "acme", repo: "broken" })]);
    shaFixtures.set("acme/broken", sha("broken-sha"));
    setLockFixture(lockFixtures, "acme", "broken", () =>
      Promise.resolve(Option.some("{ not valid json")),
    );

    const report = await Effect.runPromise(
      aggregateTemplateUsage({
        template: { owner: "acme", repo: "template", ref: sha("tmpl-sha") },
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

  it("tmpBaseDir を明示指定した場合は削除しない", async () => {
    mockListOwnerRepos.mockResolvedValue([]);

    await Effect.runPromise(
      aggregateTemplateUsage({
        template: { owner: "acme", repo: "template", ref: sha("tmpl-sha") },
        tmpBaseDir: "/explicit-tmp-base",
      }),
    );

    expect(mockRegisterTempDirEffect).not.toHaveBeenCalled();
    expect(mockRemoveTempDirEffect).not.toHaveBeenCalled();
  });

  it("lock.json の取得は、リポジトリ内容のダウンロードと同じ commit SHA を ref に使う", async () => {
    mockListOwnerRepos.mockResolvedValue([repoInfo({ owner: "acme", repo: "proj" })]);
    const baseHashes = { "f.txt": hashContent("v1") };
    setLockFixture(lockFixtures, "acme", "proj", () =>
      Promise.resolve(Option.some(lockJson({ baseHashes }))),
    );
    shaFixtures.set("acme/proj", sha("shared-sha"));
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
        template: { owner: "acme", repo: "template", ref: sha("tmpl-sha") },
        tmpBaseDir: "/tmp-base",
      }),
    );

    // lock.json の取得は resolveLatestCommitSha が返した SHA を ref として渡す。
    expect(mockFetchRepoTextFile).toHaveBeenCalledWith("acme", "proj", LOCK_FILE, "shared-sha");
    // リポジトリ内容のダウンロード（buildCommitPinnedSource 経由の acquireTempTemplate）も
    // 同じ SHA を使っている（"gh:acme/proj#shared-sha" 以外のソースでは呼ばれていない）。
    const repoDownloadSources = mockAcquireTempTemplate.mock.calls
      .map(([, source]) => source)
      .filter((source) => typeof source === "string" && source.startsWith("gh:acme/proj#"));
    expect(repoDownloadSources).toEqual(["gh:acme/proj#shared-sha"]);
  });

  it("利用リポジトリと分かった後に SHA 解決が失敗したら理由付きで skipped に残す", async () => {
    mockListOwnerRepos.mockResolvedValue([repoInfo({ owner: "acme", repo: "no-sha" })]);
    setLockFixture(lockFixtures, "acme", "no-sha", () => Promise.resolve(Option.some(lockJson())));
    // shaFixtures に登録しない = mockResolveLatestCommitSha は既定で Unresolved を返す

    const report = await Effect.runPromise(
      aggregateTemplateUsage({
        template: { owner: "acme", repo: "template", ref: sha("tmpl-sha") },
        tmpBaseDir: "/tmp-base",
      }),
    );

    expect(report.repositories).toEqual([]);
    expect(report.skipped).toHaveLength(1);
    expect(report.skipped[0]).toMatchObject({ owner: "acme", repo: "no-sha" });
    expect(report.skipped[0]?.reason).toContain("Could not resolve the latest commit SHA");
  });

  // owner 配下には空リポジトリなど SHA を解決できないものが混ざる。ziku を使っていない
  // リポジトリまで skipped に並べると、レポートがノイズで読めなくなる。
  it("ziku を使っていないリポジトリは、SHA 解決を試みずに黙って除外する", async () => {
    mockListOwnerRepos.mockResolvedValue([repoInfo({ owner: "acme", repo: "empty-repo" })]);
    // lockFixtures にも shaFixtures にも登録しない

    const report = await Effect.runPromise(
      aggregateTemplateUsage({
        template: { owner: "acme", repo: "template", ref: sha("tmpl-sha") },
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

  it("SHA 解決がネットワークエラーで解決不能だったリポジトリは理由付きで skipped に残る", async () => {
    mockListOwnerRepos.mockResolvedValue([repoInfo({ owner: "acme", repo: "unresolvable" })]);
    setLockFixture(lockFixtures, "acme", "unresolvable", () =>
      Promise.resolve(Option.some(lockJson())),
    );
    mockResolveLatestCommitSha.mockImplementation(async (owner: string, repo: string) => {
      if (repo === "unresolvable") return { _tag: "Unresolved", reason: "network error" };
      const fixture = shaFixtures.get(`${owner}/${repo}`);
      return fixture !== undefined
        ? { _tag: "Resolved", sha: fixture }
        : { _tag: "Unresolved", reason: "no fixture registered" };
    });

    const report = await Effect.runPromise(
      aggregateTemplateUsage({
        template: { owner: "acme", repo: "template", ref: sha("tmpl-sha") },
        tmpBaseDir: "/tmp-base",
      }),
    );

    expect(report.repositories).toEqual([]);
    expect(report.skipped).toHaveLength(1);
    expect(report.skipped[0]).toMatchObject({ owner: "acme", repo: "unresolvable" });
    expect(report.skipped[0]?.reason).toContain("Could not resolve the latest commit SHA");
    expect(report.skipped[0]?.reason).toContain("network error");
  });

  it("--since で全件除外された場合、除外件数が summary.excludedBySince に載る", async () => {
    mockListOwnerRepos.mockResolvedValue([
      repoInfo({ owner: "acme", repo: "stale-a" }),
      repoInfo({ owner: "acme", repo: "stale-b" }),
    ]);
    const baseHashes = { "f.txt": hashContent("v1") };
    setLockFixture(lockFixtures, "acme", "stale-a", () =>
      Promise.resolve(Option.some(lockJson({ baseHashes }))),
    );
    setLockFixture(lockFixtures, "acme", "stale-b", () =>
      Promise.resolve(Option.some(lockJson({ baseHashes }))),
    );
    shaFixtures.set("acme/stale-a", sha("stale-a-sha"));
    shaFixtures.set("acme/stale-b", sha("stale-b-sha"));
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
    mockGetLastCommitDate.mockReturnValue(Promise.resolve(Option.some("2025-01-01T00:00:00Z")));

    const report = await Effect.runPromise(
      aggregateTemplateUsage({
        template: { owner: "acme", repo: "template", ref: sha("tmpl-sha") },
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

  // レート制限を検知した後も候補ごとに新規リクエストを送り続けると、枠切れ後の残り候補
  // 全件が同じレート制限応答を受け取るだけの無駄になる。検知した時点で以降の候補への
  // GitHub API 呼び出し自体を止めることを固定する。
  it("レート制限を検知した後は、残りの候補へ GitHub API 呼び出しを行わない", async () => {
    const repos = ["rl-1", "rl-2", "rl-3"];
    mockListOwnerRepos.mockResolvedValue(repos.map((r) => repoInfo({ owner: "acme", repo: r })));

    mockFetchRepoTextFile.mockImplementation((_owner: string, repo: string) => {
      if (repo === "rl-1") {
        return Promise.reject(
          zikuFailure({ kind: "GitHubRateLimited", authenticated: false, resetAt: undefined }),
        );
      }
      // rl-2 / rl-3 でここに到達したら、ゲートが後続候補への呼び出しを止められていない。
      return Promise.resolve(Option.some(lockJson()));
    });

    const report = await Effect.runPromise(
      aggregateTemplateUsage({
        template: { owner: "acme", repo: "template", ref: sha("tmpl-sha") },
        tmpBaseDir: "/tmp-base",
        concurrency: 1,
      }),
    );

    // fetchRepoTextFile が呼ばれるのは最初にレート制限を検知する rl-1 だけ。
    expect(mockFetchRepoTextFile).toHaveBeenCalledTimes(1);
    expect(report.repositories).toEqual([]);
    expect(report.skipped).toHaveLength(3);

    const [first, second, third] = report.skipped;
    expect(first).toMatchObject({ owner: "acme", repo: "rl-1" });
    expect(first?.reason).toContain("Failed to fetch lock.json");
    expect(second).toMatchObject({ owner: "acme", repo: "rl-2" });
    // 実際に 403 を受け取って検知したケース（"observed"）なので、予防的な打ち切り
    // （"preemptive"、動的ブレーキ）とは文言を分ける。
    expect(second?.reason).toBe(
      "GitHub API rate limit reached; not checking further repositories in this scan.",
    );
    expect(third).toMatchObject({ owner: "acme", repo: "rl-3" });
    expect(third?.reason).toBe(second?.reason);
  });

  // 評価フェーズを通過した後、差分処理フェーズ（利用リポジトリ内容のダウンロード）で
  // 実際にレート制限を受けた場合も、evaluateCandidate と同じゲートへ反映され、以降の候補は
  // テンプレート内容のダウンロードすら行わない。
  it("差分処理フェーズでレート制限を受けると、以降の候補もゲートに反映されてスキップされる", async () => {
    const repos = ["rl-1", "rl-2"];
    mockListOwnerRepos.mockResolvedValue(repos.map((r) => repoInfo({ owner: "acme", repo: r })));
    for (const repo of repos) {
      shaFixtures.set(`acme/${repo}`, sha(`${repo}-sha`));
      setLockFixture(lockFixtures, "acme", repo, () => Promise.resolve(Option.some(lockJson())));
    }

    const downloadedRepos: string[] = [];
    mockAcquireTempTemplate.mockImplementation((_targetDir: string, source: string) => {
      if (source === "gh:acme/template#tmpl-sha") {
        return Effect.succeed(absPath("/template-dir"));
      }
      downloadedRepos.push(source);
      // giget（tarball ダウンロードの実装）は失敗時にプレーンな Error しか投げず、
      // `status` プロパティも `response` プロパティも持たない
      // （`node_modules/giget/dist/_chunks/giget.mjs` の `download()`）。この形を
      // 手動構築すると production では起きない経路をテストするだけの偽陽性になるため、
      // giget が実際に投げるメッセージ形（`Failed to download <url>: <status> <statusText>`）
      // に揃える。429 を使うのは、`detectGigetRateLimit` が 403（権限不足と区別できない）を
      // 意図的に検出せず、レート制限専用のステータスである 429 だけを検出する設計のため。
      return Effect.fail(
        new TemplateError({
          message: "Failed to download template",
          cause: new Error(`Failed to download ${source}: 429 Too Many Requests`),
        }),
      );
    });

    const report = await Effect.runPromise(
      aggregateTemplateUsage({
        template: { owner: "acme", repo: "template", ref: sha("tmpl-sha") },
        tmpBaseDir: "/tmp-base",
        concurrency: 1,
      }),
    );

    // 利用リポジトリ内容のダウンロードは最初の候補だけ。ゲートが立った以降は
    // テンプレート内容のダウンロードそのものを行わない。
    expect(downloadedRepos).toHaveLength(1);
    expect(report.repositories).toEqual([]);
    expect(report.skipped).toHaveLength(2);
    const [first, second] = report.skipped;
    expect(first).toMatchObject({ owner: "acme", repo: "rl-1" });
    expect(first?.reason).toBe(
      "GitHub API rate limit reached; not checking further repositories in this scan.",
    );
    expect(second).toMatchObject({ owner: "acme", repo: "rl-2" });
    expect(second?.reason).toBe(first?.reason);
  });

  // giget の 403 は権限不足（private リポジトリへのアクセス権が無い等）とレート制限を区別
  // できない。誤ってスキャン全体を打ち切るゲートを立てると、owner 配下にアクセス権の無い
  // リポジトリが 1 つあるだけで残り全候補の結果を失う。この関数は誤って候補 1 件を通常の
  // TemplateUnavailable として skip するだけに留め、ゲートは立てないことを固定する。
  it("差分処理フェーズの giget 403 は権限不足と区別できないため、その候補だけ skip しゲートは立てない", async () => {
    const repos = ["forbidden-1", "forbidden-2"];
    mockListOwnerRepos.mockResolvedValue(repos.map((r) => repoInfo({ owner: "acme", repo: r })));
    for (const repo of repos) {
      shaFixtures.set(`acme/${repo}`, sha(`${repo}-sha`));
      setLockFixture(lockFixtures, "acme", repo, () => Promise.resolve(Option.some(lockJson())));
    }

    const downloadedRepos: string[] = [];
    mockAcquireTempTemplate.mockImplementation((_targetDir: string, source: string) => {
      if (source === "gh:acme/template#tmpl-sha") {
        return Effect.succeed(absPath("/template-dir"));
      }
      downloadedRepos.push(source);
      return Effect.fail(
        new TemplateError({
          message: "Failed to download template",
          cause: new Error(`Failed to download ${source}: 403 Forbidden`),
        }),
      );
    });

    const report = await Effect.runPromise(
      aggregateTemplateUsage({
        template: { owner: "acme", repo: "template", ref: sha("tmpl-sha") },
        tmpBaseDir: "/tmp-base",
        concurrency: 1,
      }),
    );

    // ゲートが立っていれば 2 件目のダウンロードは行われない。両方ダウンロードを試み、
    // 両方とも「その候補限りの失敗」として個別に skip されることを確認する。
    expect(downloadedRepos).toHaveLength(2);
    expect(report.repositories).toEqual([]);
    expect(report.skipped).toHaveLength(2);
    for (const skip of report.skipped) {
      expect(skip.reason).toContain("Failed to classify the diff against the template");
      expect(skip.reason).not.toContain("rate limit");
    }
  });

  // `--since` のコミット日時取得（attachLastCommittedAt）も同じゲートを共有するため、
  // 評価フェーズでレート制限を検知した候補は、差分処理フェーズのコミット日時取得にも進まない。
  it("評価フェーズでレート制限を検知した候補は、--since のコミット日時取得にも進まない", async () => {
    mockListOwnerRepos.mockResolvedValue([repoInfo({ owner: "acme", repo: "rl-since" })]);
    mockFetchRepoTextFile.mockImplementation(() =>
      Promise.reject(
        zikuFailure({ kind: "GitHubRateLimited", authenticated: false, resetAt: undefined }),
      ),
    );

    const report = await Effect.runPromise(
      aggregateTemplateUsage({
        template: { owner: "acme", repo: "template", ref: sha("tmpl-sha") },
        tmpBaseDir: "/tmp-base",
        since: "2026-08-01T00:00:00.000Z",
      }),
    );

    expect(mockGetLastCommitDate).not.toHaveBeenCalled();
    expect(report.repositories).toEqual([]);
    expect(report.skipped).toHaveLength(1);
    expect(report.skipped[0]).toMatchObject({ owner: "acme", repo: "rl-since" });
  });

  // 401（トークン拒否）とレート制限（403/429）は取れる行動が違うため、混同してはいけない
  // （`error-handling.md`）。401 は候補ごとの絞り込みロジックに一切入らず即座に失敗する。
  describe("候補数の事前絞り込み", () => {
    it("レート制限の残量から候補数上限を算出し、listOwnerRepos に渡す", async () => {
      mockFetchRateLimitStatus.mockResolvedValue({
        _tag: "Resolved",
        status: { limit: 60, remaining: 50, resetAt: undefined, authenticated: false },
      });
      mockListOwnerRepos.mockResolvedValue([repoInfo({ owner: "acme", repo: "only-one" })]);

      const report = await Effect.runPromise(
        aggregateTemplateUsage({
          template: { owner: "acme", repo: "template", ref: sha("tmpl-sha") },
          tmpBaseDir: "/tmp-base",
        }),
      );

      // (remaining(50) - 安全マージン(10)) / 候補あたりの想定リクエスト数(7) = floor(40/7) = 5
      expect(mockListOwnerRepos).toHaveBeenCalledWith(
        "acme",
        expect.objectContaining({ maxCandidates: 5 }),
      );
      expect(report.summary.candidateScanLimit).toBe(5);
      expect(report.summary.candidatesScanned).toBe(1);
    });

    it("換算後の候補数上限が 0 以下になるほど枠が無ければ、GitHubRateLimited として失敗する", async () => {
      mockFetchRateLimitStatus.mockResolvedValue({
        _tag: "Resolved",
        status: {
          limit: 60,
          remaining: 10,
          resetAt: new Date("2026-01-01T00:00:00Z"),
          authenticated: false,
        },
      });

      const result = await Effect.runPromise(
        Effect.either(
          aggregateTemplateUsage({
            template: { owner: "acme", repo: "template", ref: sha("tmpl-sha") },
            tmpBaseDir: "/tmp-base",
          }),
        ),
      );

      expect(Either.isLeft(result)).toBe(true);
      if (Either.isLeft(result)) {
        expect(result.left).toBeInstanceOf(ZikuFailure);
        expect(result.left.reason).toMatchObject({
          kind: "GitHubRateLimited",
          authenticated: false,
          resetAt: new Date("2026-01-01T00:00:00Z"),
        });
      }
      // 候補を 1 件もまかなえないと分かった時点で失敗するので、列挙にすら進まない。
      expect(mockListOwnerRepos).not.toHaveBeenCalled();
    });

    it("換算後の候補数上限が 1 件以上まかなえるぎりぎりの残量なら、失敗せず続行する", async () => {
      // (remaining(17) - 安全マージン(10)) / 7 = 1（境界値）
      mockFetchRateLimitStatus.mockResolvedValue({
        _tag: "Resolved",
        status: { limit: 60, remaining: 17, resetAt: undefined, authenticated: false },
      });
      mockListOwnerRepos.mockResolvedValue([]);

      const report = await Effect.runPromise(
        aggregateTemplateUsage({
          template: { owner: "acme", repo: "template", ref: sha("tmpl-sha") },
          tmpBaseDir: "/tmp-base",
        }),
      );

      expect(mockListOwnerRepos).toHaveBeenCalledWith(
        "acme",
        expect.objectContaining({ maxCandidates: 1 }),
      );
      expect(report.summary.candidateScanLimit).toBe(1);
    });

    it("呼び出し側が指定した maxCandidates と、レート制限由来の上限の小さい方を使う", async () => {
      mockFetchRateLimitStatus.mockResolvedValue({
        _tag: "Resolved",
        status: { limit: 5000, remaining: 5000, resetAt: undefined, authenticated: true },
      });
      mockListOwnerRepos.mockResolvedValue([]);

      await Effect.runPromise(
        aggregateTemplateUsage({
          template: { owner: "acme", repo: "template", ref: sha("tmpl-sha") },
          tmpBaseDir: "/tmp-base",
          maxCandidates: 3,
        }),
      );

      // レート制限由来の上限（floor((5000 - 10) / 7) = 712）よりユーザー指定（3）の方が小さい。
      expect(mockListOwnerRepos).toHaveBeenCalledWith(
        "acme",
        expect.objectContaining({ maxCandidates: 3 }),
      );
    });

    it("レート制限の事前確認に失敗しても、既定の候補数上限でスキャンを続ける", async () => {
      mockFetchRateLimitStatus.mockResolvedValue({
        _tag: "Unresolved",
        reason: "network down",
      });
      mockListOwnerRepos.mockResolvedValue([repoInfo({ owner: "acme", repo: "proj" })]);

      const report = await Effect.runPromise(
        aggregateTemplateUsage({
          template: { owner: "acme", repo: "template", ref: sha("tmpl-sha") },
          tmpBaseDir: "/tmp-base",
        }),
      );

      expect(mockListOwnerRepos).toHaveBeenCalledWith(
        "acme",
        expect.objectContaining({ maxCandidates: 30 }),
      );
      expect(report.summary.candidateScanLimit).toBe(30);
    });

    it("レート制限の事前確認に失敗しても、ユーザー指定の候補数上限は尊重する", async () => {
      mockFetchRateLimitStatus.mockResolvedValue({
        _tag: "Unresolved",
        reason: "network down",
      });
      mockListOwnerRepos.mockResolvedValue([repoInfo({ owner: "acme", repo: "proj" })]);

      const report = await Effect.runPromise(
        aggregateTemplateUsage({
          template: { owner: "acme", repo: "template", ref: sha("tmpl-sha") },
          tmpBaseDir: "/tmp-base",
          maxCandidates: 5,
        }),
      );

      expect(mockListOwnerRepos).toHaveBeenCalledWith(
        "acme",
        expect.objectContaining({ maxCandidates: 5 }),
      );
      expect(report.summary.candidateScanLimit).toBe(5);
    });

    it("レート制限の事前確認が 401 なら、候補の絞り込みロジックに入らず即座に失敗する", async () => {
      mockFetchRateLimitStatus.mockResolvedValue({
        _tag: "AuthRejected",
        detail: "Bad credentials",
      });
      mockListOwnerRepos.mockResolvedValue([repoInfo({ owner: "acme", repo: "should-not-run" })]);

      const result = await Effect.runPromise(
        Effect.either(
          aggregateTemplateUsage({
            template: { owner: "acme", repo: "template", ref: sha("tmpl-sha") },
            tmpBaseDir: "/tmp-base",
          }),
        ),
      );

      expect(Either.isLeft(result)).toBe(true);
      if (Either.isLeft(result)) {
        expect(result.left).toBeInstanceOf(ZikuFailure);
        expect(result.left.reason).toMatchObject({ kind: "GitHubAuthRejected" });
      }
      // 401 は待っても解消しないため、候補の列挙にすら進まない。
      expect(mockListOwnerRepos).not.toHaveBeenCalled();
    });

    it("ユーザー指定が無ければ、レート制限由来の上限が大きくても固定の既定値(30)で頭打ちにする", async () => {
      mockFetchRateLimitStatus.mockResolvedValue({
        _tag: "Resolved",
        status: { limit: 5000, remaining: 5000, resetAt: undefined, authenticated: true },
      });
      mockListOwnerRepos.mockResolvedValue([]);

      await Effect.runPromise(
        aggregateTemplateUsage({
          template: { owner: "acme", repo: "template", ref: sha("tmpl-sha") },
          tmpBaseDir: "/tmp-base",
        }),
      );

      // レート制限由来の上限（floor((5000 - 10) / 7) = 712）より固定の既定値（30）の方が小さい。
      expect(mockListOwnerRepos).toHaveBeenCalledWith(
        "acme",
        expect.objectContaining({ maxCandidates: 30 }),
      );
    });

    it("ユーザー指定が固定の既定値(30)より大きくても、レート制限由来の上限の範囲内ならそちらを使う", async () => {
      mockFetchRateLimitStatus.mockResolvedValue({
        _tag: "Resolved",
        status: { limit: 5000, remaining: 5000, resetAt: undefined, authenticated: true },
      });
      mockListOwnerRepos.mockResolvedValue([]);

      await Effect.runPromise(
        aggregateTemplateUsage({
          template: { owner: "acme", repo: "template", ref: sha("tmpl-sha") },
          tmpBaseDir: "/tmp-base",
          maxCandidates: 100,
        }),
      );

      // ユーザー指定（100）は既定値（30）より緩めてよい意思表示として扱われ、
      // レート制限由来の上限（floor((5000 - 10) / 7) = 712）の範囲内なのでそのまま使われる。
      expect(mockListOwnerRepos).toHaveBeenCalledWith(
        "acme",
        expect.objectContaining({ maxCandidates: 100 }),
      );
    });
  });

  describe("直近 push フィルタ", () => {
    it("既定では 90 日前を pushedSince として listOwnerRepos に渡す", async () => {
      const now = new Date("2026-09-19T00:00:00.000Z");
      vi.useFakeTimers();
      vi.setSystemTime(now);
      try {
        mockListOwnerRepos.mockResolvedValue([]);

        const report = await Effect.runPromise(
          aggregateTemplateUsage({
            template: { owner: "acme", repo: "template", ref: sha("tmpl-sha") },
            tmpBaseDir: "/tmp-base",
          }),
        );

        const expected = new Date(now.getTime() - 90 * 24 * 60 * 60 * 1000).toISOString();
        expect(mockListOwnerRepos).toHaveBeenCalledWith(
          "acme",
          expect.objectContaining({ pushedSince: expected }),
        );
        // レポートの消費者が「利用リポジトリが無い」のか「直近 push フィルタで最初から
        // 対象に入らなかった」のかを区別できるよう、実際に使った下限をレポートへも残す。
        expect(report.summary.recentPushSince).toBe(expected);
      } finally {
        vi.useRealTimers();
      }
    });

    it("recentPushDays を指定すると、その日数分前を pushedSince として渡し、レポートにも残す", async () => {
      const now = new Date("2026-09-19T00:00:00.000Z");
      vi.useFakeTimers();
      vi.setSystemTime(now);
      try {
        mockListOwnerRepos.mockResolvedValue([]);

        const report = await Effect.runPromise(
          aggregateTemplateUsage({
            template: { owner: "acme", repo: "template", ref: sha("tmpl-sha") },
            tmpBaseDir: "/tmp-base",
            recentPushDays: 30,
          }),
        );

        const expected = new Date(now.getTime() - 30 * 24 * 60 * 60 * 1000).toISOString();
        expect(mockListOwnerRepos).toHaveBeenCalledWith(
          "acme",
          expect.objectContaining({ pushedSince: expected }),
        );
        expect(report.summary.recentPushSince).toBe(expected);
      } finally {
        vi.useRealTimers();
      }
    });
  });

  describe("実行中の動的ブレーキ", () => {
    it("観測した残量が少ないと、実際にレート制限に達する前に以降の候補への呼び出しを止める", async () => {
      const repos = ["rl-1", "rl-2", "rl-3"];
      mockListOwnerRepos.mockResolvedValue(repos.map((r) => repoInfo({ owner: "acme", repo: r })));

      let observedCallCount = 0;
      mockGetObservedRateLimitRemaining.mockImplementation(() => {
        observedCallCount += 1;
        // rl-1 を評価する時点ではまだ何も観測していない。rl-1 の lock.json 取得が返って
        // きた後、残量が少ないとレスポンスヘッダーから分かったことを模す。
        return observedCallCount === 1 ? undefined : { remaining: 3, resetAt: undefined };
      });

      const report = await Effect.runPromise(
        aggregateTemplateUsage({
          template: { owner: "acme", repo: "template", ref: sha("tmpl-sha") },
          tmpBaseDir: "/tmp-base",
          concurrency: 1,
        }),
      );

      // lock.json の取得が行われるのは観測前の rl-1 だけ。rl-2/rl-3 は動的ブレーキにより
      // GitHub への新規リクエストなしでスキップされる。
      expect(mockFetchRepoTextFile).toHaveBeenCalledTimes(1);
      // rl-1 は lock.json 未導入（既定のフィクスチャ）につき黙って除外され、
      // repositories にも skipped にも載らない。
      expect(report.repositories).toEqual([]);
      expect(report.skipped).toHaveLength(2);
      expect(report.skipped.map((s) => s.repo)).toEqual(["rl-2", "rl-3"]);
      for (const s of report.skipped) {
        // 実際にはまだ 403 を受け取っておらず、観測残量からの予防的な打ち切り
        // （"preemptive"）なので、実際に検知した場合（"observed"）とは文言を分ける。
        expect(s.reason).toBe(
          "Stopped short of the GitHub API rate limit based on the observed remaining quota; not checking further repositories in this scan.",
        );
      }
    });

    it("観測した残量が十分なら、動的ブレーキは発動しない", async () => {
      const repos = ["ok-1", "ok-2"];
      mockListOwnerRepos.mockResolvedValue(repos.map((r) => repoInfo({ owner: "acme", repo: r })));
      mockGetObservedRateLimitRemaining.mockReturnValue({ remaining: 5000, resetAt: undefined });

      const report = await Effect.runPromise(
        aggregateTemplateUsage({
          template: { owner: "acme", repo: "template", ref: sha("tmpl-sha") },
          tmpBaseDir: "/tmp-base",
          concurrency: 1,
        }),
      );

      expect(mockFetchRepoTextFile).toHaveBeenCalledTimes(2);
      expect(report.skipped).toEqual([]);
    });

    // 候補 1 件の処理には複数回の GitHub API リクエストがかかるため、動的ブレーキは
    // 「残り候補数」ではなく「残り候補数 × 候補あたりの想定リクエスト数」で見積もる。
    // この係数を掛けなければブレーキが発動しない残量でも、掛けた結果発動することを確認する。
    it("候補あたりの想定リクエスト数を考慮し、残り候補数だけの見積もりより早めに止まる", async () => {
      const repos = ["ok", "rl"];
      mockListOwnerRepos.mockResolvedValue(repos.map((r) => repoInfo({ owner: "acme", repo: r })));

      let observedCallCount = 0;
      mockGetObservedRateLimitRemaining.mockImplementation(() => {
        observedCallCount += 1;
        // ok を評価する時点ではまだ何も観測していない。
        // rl の直前の時点で remaining(3) が観測されたとする。
        // 残り候補数（1 件、自分自身のみ）だけの見積もりでは 3 < 1 は false で発動しないが、
        // 候補あたりの想定リクエスト数（7）を掛けた見積もりでは 3 < 1*7 で発動する。
        return observedCallCount === 1 ? undefined : { remaining: 3, resetAt: undefined };
      });

      const report = await Effect.runPromise(
        aggregateTemplateUsage({
          template: { owner: "acme", repo: "template", ref: sha("tmpl-sha") },
          tmpBaseDir: "/tmp-base",
          concurrency: 1,
        }),
      );

      expect(mockFetchRepoTextFile).toHaveBeenCalledTimes(1);
      expect(report.skipped).toHaveLength(1);
      expect(report.skipped[0]).toMatchObject({ owner: "acme", repo: "rl" });
    });

    // 事前の候補数上限算出（resolveCandidateLimit）は安全マージン（RATE_LIMIT_SAFETY_MARGIN）を
    // 引いた残量を候補数へ換算する。動的ブレーキがこのマージンを重ねて引くと、候補数が事前算出
    // の上限どおりで、かつ準備段階（isOrganization・resolveTemplateRef の識別解決等）の消費が
    // ちょうどマージン分だった正常なシナリオでも、初回候補から誤って発動する
    // （修正前: `(remaining - margin) < 見積もり` で判定していたため、`remaining` が既に
    // マージン分減っている状態だとさらに引かれて見積もりを割り込んでしまっていた）。
    // マージンを二重に引かないことを、そのちょうど境界になる数値で固定する。
    it("候補数が事前算出の上限ちょうどで、準備段階の消費がマージン相当でも、初回候補でブレーキが誤発動しない", async () => {
      // 安全マージン(10) 込みで remaining=66 から算出される上限は floor((66-10)/7) = 8。
      mockFetchRateLimitStatus.mockResolvedValue({
        _tag: "Resolved",
        status: { limit: 5000, remaining: 66, resetAt: undefined, authenticated: false },
      });
      // テンプレート自身は列挙結果に含まれず、resolveTemplateRef の識別解決で準備段階の
      // GitHub API 呼び出しが発生する状況を模す（template.ref を明示せず解決させる）。
      shaFixtures.set("acme/template", sha("tmpl-sha"));

      // 候補数を事前算出の上限（8）ちょうどにする。
      const repoNames = Array.from({ length: 8 }, (_, i) => `cand-${i}`);
      mockListOwnerRepos.mockResolvedValue(
        repoNames.map((r) => repoInfo({ owner: "acme", repo: r })),
      );
      // 準備段階の消費でマージン(10)分ぴったり減り、初回候補の評価時点では
      // remaining(66) - margin(10) = 56 が観測される状況を模す。
      //
      // 先頭候補（残り候補 8 件中の 1 件目、remainingAfter=7）の必要見積もりは
      // (7+1) * ESTIMATED_REQUESTS_PER_CANDIDATE(7) = 56 で、観測残量とちょうど一致する。
      // 修正前の実装はここからさらにマージン(10)を引いて `56 - 10 = 46 < 56` が true になり
      // 誤発動していた。
      mockGetObservedRateLimitRemaining.mockReturnValue({ remaining: 56, resetAt: undefined });

      const report = await Effect.runPromise(
        aggregateTemplateUsage({
          template: { owner: "acme", repo: "template" },
          tmpBaseDir: "/tmp-base",
          concurrency: 1,
        }),
      );

      // 動的ブレーキが誤発動していれば、それ以降の候補は lock.json 取得すら行われず
      // skipped になる。全候補が lock.json 取得まで進んだことを確認する。
      expect(mockFetchRepoTextFile).toHaveBeenCalledTimes(repoNames.length);
      expect(report.skipped).toEqual([]);
    });
  });
});
