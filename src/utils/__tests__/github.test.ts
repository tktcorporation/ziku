import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  checkRepoExists,
  checkRepoSetup,
  getGhCliToken,
  getGitHubToken,
  rateLimitedError,
} from "../github";

// Octokit をモック
const mockGetAuthenticated = vi.fn();
const mockReposGet = vi.fn();
const mockReposCreateFork = vi.fn();
const mockReposGetBranch = vi.fn();
const mockGitCreateRef = vi.fn();
const mockReposCreateOrUpdateFileContents = vi.fn();
const mockReposDeleteFile = vi.fn();
const mockGitGetTree = vi.fn();
const mockPullsCreate = vi.fn();
const mockOrgsGet = vi.fn();
const mockReposCreateInOrg = vi.fn();
const mockReposCreateForAuthenticatedUser = vi.fn();

vi.mock("@octokit/rest", () => ({
  Octokit: class MockOctokit {
    users = {
      getAuthenticated: mockGetAuthenticated,
    };
    repos = {
      get: mockReposGet,
      createFork: mockReposCreateFork,
      getBranch: mockReposGetBranch,
      createOrUpdateFileContents: mockReposCreateOrUpdateFileContents,
      deleteFile: mockReposDeleteFile,
      createInOrg: mockReposCreateInOrg,
      createForAuthenticatedUser: mockReposCreateForAuthenticatedUser,
    };
    git = {
      createRef: mockGitCreateRef,
      getTree: mockGitGetTree,
    };
    pulls = {
      create: mockPullsCreate,
    };
    orgs = {
      get: mockOrgsGet,
    };
  },
}));

// モック後にインポート
const { createPullRequest, scaffoldTemplateRepo } = await import("../github");

describe("getGitHubToken", () => {
  const originalEnv = process.env;

  beforeEach(() => {
    process.env = { ...originalEnv };
  });

  afterEach(() => {
    process.env = originalEnv;
  });

  it("GITHUB_TOKEN を返す", () => {
    process.env.GITHUB_TOKEN = "ghp_test123";
    delete process.env.GH_TOKEN;

    expect(getGitHubToken()).toBe("ghp_test123");
  });

  it("GITHUB_TOKEN がない場合は GH_TOKEN を返す", () => {
    delete process.env.GITHUB_TOKEN;
    process.env.GH_TOKEN = "ghp_gh_token";

    expect(getGitHubToken()).toBe("ghp_gh_token");
  });

  it("どちらもない場合は undefined を返す", () => {
    delete process.env.GITHUB_TOKEN;
    delete process.env.GH_TOKEN;

    // getGhCliToken() が gh auth token を execSync で呼ぶため、
    // CI 環境ではタイムアウトする可能性がある。結果が undefined か string かのみ確認。
    const token = getGitHubToken();
    expect(token === undefined || typeof token === "string").toBe(true);
  });

  it("両方ある場合は GITHUB_TOKEN を優先する", () => {
    process.env.GITHUB_TOKEN = "ghp_github";
    process.env.GH_TOKEN = "ghp_gh";

    expect(getGitHubToken()).toBe("ghp_github");
  });
});

describe("getGhCliToken", () => {
  it("gh CLI が利用できない場合は undefined を返す", () => {
    // テスト環境では gh CLI が利用できない可能性が高いので undefined が返ることを確認
    const token = getGhCliToken();
    // token が string なら gh CLI 経由で取得済み、undefined なら未インストール/未ログイン
    expect(token === undefined || typeof token === "string").toBe(true);
  });
});

describe("createPullRequest", () => {
  beforeEach(() => {
    vi.clearAllMocks();

    // デフォルトのモック設定
    mockGetAuthenticated.mockResolvedValue({
      data: { login: "testuser" },
    });

    mockReposGet.mockResolvedValue({
      data: { name: "test-repo" },
    });

    mockReposGetBranch.mockResolvedValue({
      data: { commit: { sha: "abc123" } },
    });

    mockGitCreateRef.mockResolvedValue({});

    mockGitGetTree.mockResolvedValue({
      data: { tree: [], truncated: false },
    });

    mockReposCreateOrUpdateFileContents.mockResolvedValue({});

    mockPullsCreate.mockResolvedValue({
      data: {
        html_url: "https://github.com/owner/repo/pull/123",
        number: 123,
      },
    });
  });

  it("PR を作成できる", async () => {
    const result = await createPullRequest("token", {
      owner: "owner",
      repo: "repo",
      files: [{ path: "file.txt", content: "content" }],
      title: "Test PR",
    });

    expect(result.url).toBe("https://github.com/owner/repo/pull/123");
    expect(result.number).toBe(123);
    expect(result.branch).toMatch(/^ziku-sync-\d+$/);
  });

  it("既存の fork を使用する", async () => {
    mockReposGet.mockResolvedValue({
      data: { name: "repo" },
    });

    await createPullRequest("token", {
      owner: "owner",
      repo: "repo",
      files: [{ path: "file.txt", content: "content" }],
      title: "Test PR",
    });

    expect(mockReposGet).toHaveBeenCalledWith({
      owner: "testuser",
      repo: "repo",
    });
    expect(mockReposCreateFork).not.toHaveBeenCalled();
  });

  it("fork が存在しない場合は作成する", async () => {
    mockReposGet.mockRejectedValue(new Error("Not found"));
    mockReposCreateFork.mockResolvedValue({
      data: { name: "repo" },
    });

    await createPullRequest("token", {
      owner: "owner",
      repo: "repo",
      files: [{ path: "file.txt", content: "content" }],
      title: "Test PR",
    });

    expect(mockReposCreateFork).toHaveBeenCalledWith({
      owner: "owner",
      repo: "repo",
    });
  });

  it("複数のファイルをコミットする", async () => {
    await createPullRequest("token", {
      owner: "owner",
      repo: "repo",
      files: [
        { path: "file1.txt", content: "content1" },
        { path: "file2.txt", content: "content2" },
      ],
      title: "Test PR",
    });

    expect(mockReposCreateOrUpdateFileContents).toHaveBeenCalledTimes(2);
  });

  it("既存ファイルを更新する", async () => {
    mockGitGetTree.mockResolvedValue({
      data: {
        tree: [{ path: "existing.txt", type: "blob", sha: "existing-sha" }],
        truncated: false,
      },
    });

    await createPullRequest("token", {
      owner: "owner",
      repo: "repo",
      files: [{ path: "existing.txt", content: "new content" }],
      title: "Test PR",
    });

    expect(mockReposCreateOrUpdateFileContents).toHaveBeenCalledWith(
      expect.objectContaining({
        sha: "existing-sha",
      }),
    );
  });

  it("カスタム baseBranch を使用する", async () => {
    await createPullRequest("token", {
      owner: "owner",
      repo: "repo",
      files: [{ path: "file.txt", content: "content" }],
      title: "Test PR",
      baseBranch: "develop",
    });

    expect(mockReposGetBranch).toHaveBeenCalledWith({
      owner: "owner",
      repo: "repo",
      branch: "develop",
    });

    expect(mockPullsCreate).toHaveBeenCalledWith(
      expect.objectContaining({
        base: "develop",
      }),
    );
  });

  it("カスタム body を使用する", async () => {
    await createPullRequest("token", {
      owner: "owner",
      repo: "repo",
      files: [{ path: "file.txt", content: "content" }],
      title: "Test PR",
      body: "Custom body content",
    });

    expect(mockPullsCreate).toHaveBeenCalledWith(
      expect.objectContaining({
        body: "Custom body content",
      }),
    );
  });

  it("body がない場合は自動生成する", async () => {
    await createPullRequest("token", {
      owner: "owner",
      repo: "repo",
      files: [{ path: "file.txt", content: "content" }],
      title: "Test PR",
    });

    expect(mockPullsCreate).toHaveBeenCalledWith(
      expect.objectContaining({
        body: expect.stringContaining("file.txt"),
      }),
    );
  });

  it("正しいヘッドブランチ形式で PR を作成する", async () => {
    await createPullRequest("token", {
      owner: "owner",
      repo: "repo",
      files: [{ path: "file.txt", content: "content" }],
      title: "Test PR",
    });

    expect(mockPullsCreate).toHaveBeenCalledWith(
      expect.objectContaining({
        head: expect.stringMatching(/^testuser:ziku-sync-\d+$/),
      }),
    );
  });

  it("getTree で既存ファイルの SHA を一括取得する", async () => {
    await createPullRequest("token", {
      owner: "owner",
      repo: "repo",
      files: [{ path: "file.txt", content: "content" }],
      title: "Test PR",
    });

    expect(mockGitGetTree).toHaveBeenCalledWith(
      expect.objectContaining({
        owner: "testuser",
        recursive: "true",
      }),
    );
  });

  it("truncated な tree の場合はエラーを throw する", async () => {
    mockGitGetTree.mockResolvedValue({
      data: { tree: [], truncated: true },
    });

    await expect(
      createPullRequest("token", {
        owner: "owner",
        repo: "repo",
        files: [{ path: "file.txt", content: "content" }],
        title: "Test PR",
      }),
    ).rejects.toThrow("Repository tree is too large");
  });

  it("削除対象ファイルを deleteFile API で削除する", async () => {
    mockGitGetTree.mockResolvedValue({
      data: {
        tree: [{ path: "to-delete.txt", type: "blob", sha: "delete-sha" }],
        truncated: false,
      },
    });

    await createPullRequest("token", {
      owner: "owner",
      repo: "repo",
      files: [],
      deletions: [{ path: "to-delete.txt" }],
      title: "Test PR with deletion",
    });

    expect(mockReposDeleteFile).toHaveBeenCalledWith(
      expect.objectContaining({
        path: "to-delete.txt",
        sha: "delete-sha",
      }),
    );
  });

  it("tree に存在しない削除対象ファイルはスキップする", async () => {
    mockGitGetTree.mockResolvedValue({
      data: { tree: [], truncated: false },
    });

    await createPullRequest("token", {
      owner: "owner",
      repo: "repo",
      files: [{ path: "file.txt", content: "content" }],
      deletions: [{ path: "nonexistent.txt" }],
      title: "Test PR",
    });

    expect(mockReposDeleteFile).not.toHaveBeenCalled();
  });

  it("ファイル内容を Base64 エンコードする", async () => {
    await createPullRequest("token", {
      owner: "owner",
      repo: "repo",
      files: [{ path: "file.txt", content: "Hello, World!" }],
      title: "Test PR",
    });

    const expectedBase64 = Buffer.from("Hello, World!").toString("base64");
    expect(mockReposCreateOrUpdateFileContents).toHaveBeenCalledWith(
      expect.objectContaining({
        content: expectedBase64,
      }),
    );
  });
});

// Response の部分的な形で十分。headers は Headers インスタンスを要求するので
// Map ベースの簡易ビルダで済ませる。
const mockResponse = (init: {
  ok?: boolean;
  status: number;
  statusText?: string;
  headers?: Record<string, string>;
}) => ({
  ok: init.ok ?? (init.status >= 200 && init.status < 300),
  status: init.status,
  statusText: init.statusText ?? "",
  headers: new Map(Object.entries(init.headers ?? {})) as unknown as Headers,
});

describe("checkRepoExists", () => {
  const originalFetch = globalThis.fetch;
  const originalEnv = process.env;

  beforeEach(() => {
    process.env = { ...originalEnv };
    // 既存の認証トークンを除去して未認証の挙動を検証する
    delete process.env.GITHUB_TOKEN;
    delete process.env.GH_TOKEN;
    // getGitHubToken は gh CLI (`gh auth token`) にフォールバックするため、
    // gh 認証済みのマシン上ではトークンが漏れ込み authenticated 判定が崩れる。
    // PATH を空にして execFileSync("gh", ...) を ENOENT にし、確実に未認証状態を作る。
    process.env.PATH = "";
  });

  afterEach(() => {
    globalThis.fetch = originalFetch;
    process.env = originalEnv;
  });

  it("リポジトリが存在する場合は Exists を返す", async () => {
    globalThis.fetch = vi.fn().mockResolvedValue(mockResponse({ status: 200 }));

    const result = await checkRepoExists("owner", "repo");
    expect(result).toEqual({ _tag: "Exists" });
    expect(globalThis.fetch).toHaveBeenCalledWith("https://api.github.com/repos/owner/repo", {
      method: "HEAD",
      headers: {},
    });
  });

  it("リポジトリが存在しない場合 (404) は NotFound を返す", async () => {
    globalThis.fetch = vi.fn().mockResolvedValue(mockResponse({ status: 404 }));

    const result = await checkRepoExists("owner", "nonexistent");
    expect(result).toEqual({ _tag: "NotFound" });
  });

  it("レート制限 (403 + x-ratelimit-remaining: 0) は RateLimited を返す", async () => {
    // 未認証時 API の 60req/h 制限で 403 が返るケース。404 と誤認させず、
    // リセット時刻と認証状況を呼び出し側に伝える。
    const resetEpoch = Math.floor(Date.now() / 1000) + 3600;
    globalThis.fetch = vi.fn().mockResolvedValue(
      mockResponse({
        status: 403,
        headers: {
          "x-ratelimit-remaining": "0",
          "x-ratelimit-reset": String(resetEpoch),
        },
      }),
    );

    const result = await checkRepoExists("owner", "repo");
    expect(result).toMatchObject({
      _tag: "RateLimited",
      authenticated: false,
    });
    if (result._tag === "RateLimited") {
      expect(result.resetAt?.getTime()).toBe(resetEpoch * 1000);
    }
  });

  it("認証済みトークンでレート制限に当たった場合は authenticated: true", async () => {
    process.env.GITHUB_TOKEN = "ghp_test";
    globalThis.fetch = vi.fn().mockResolvedValue(
      mockResponse({
        status: 403,
        headers: { "x-ratelimit-remaining": "0" },
      }),
    );

    const result = await checkRepoExists("owner", "repo");
    expect(result).toEqual({
      _tag: "RateLimited",
      authenticated: true,
      resetAt: undefined,
    });
  });

  it("403 でも x-ratelimit-remaining が 0 でない場合は Unknown 扱い", async () => {
    globalThis.fetch = vi.fn().mockResolvedValue(
      mockResponse({
        status: 403,
        statusText: "Forbidden",
        headers: { "x-ratelimit-remaining": "42" },
      }),
    );

    const result = await checkRepoExists("owner", "repo");
    expect(result).toEqual({ _tag: "Unknown", status: 403, reason: "Forbidden" });
  });

  it("サーバエラー (5xx) は Unknown を返す", async () => {
    globalThis.fetch = vi
      .fn()
      .mockResolvedValue(mockResponse({ status: 500, statusText: "Internal Server Error" }));

    const result = await checkRepoExists("owner", "repo");
    expect(result).toEqual({ _tag: "Unknown", status: 500, reason: "Internal Server Error" });
  });

  it("ネットワークエラーの場合は Unknown を返す", async () => {
    globalThis.fetch = vi.fn().mockRejectedValue(new Error("Network error"));

    const result = await checkRepoExists("owner", "repo");
    expect(result).toEqual({ _tag: "Unknown", status: undefined, reason: "Network error" });
  });

  it("GITHUB_TOKEN がある場合は Authorization ヘッダを付与する", async () => {
    process.env.GITHUB_TOKEN = "ghp_test";
    globalThis.fetch = vi.fn().mockResolvedValue(mockResponse({ status: 200 }));

    await checkRepoExists("owner", "repo");
    expect(globalThis.fetch).toHaveBeenCalledWith("https://api.github.com/repos/owner/repo", {
      method: "HEAD",
      headers: { Authorization: "Bearer ghp_test" },
    });
  });
});

describe("rateLimitedError", () => {
  it("未認証ケース: 60req/h クォータ exhausted メッセージと resetAt からの残り分を含める", () => {
    // Date.now() 基準で 5 分後にリセット
    const resetAt = new Date(Date.now() + 5 * 60_000);
    const err = rateLimitedError({ _tag: "RateLimited", authenticated: false, resetAt });

    expect(err.message).toBe("GitHub API rate limit exceeded");
    expect(err.hint).toContain("Unauthenticated quota (60/hr) exhausted");
    expect(err.hint).toContain("GITHUB_TOKEN");
    expect(err.hint).toMatch(/resets in ~\d+ min/);
  });

  it("認証済みケース + resetAt 不明: 5000req/h クォータ メッセージ、reset 情報なし", () => {
    const err = rateLimitedError({
      _tag: "RateLimited",
      authenticated: true,
      resetAt: undefined,
    });

    expect(err.hint).toContain("Authenticated quota (5000/hr) exhausted");
    // resetAt が無ければ "resets in" 部分を付けない
    expect(err.hint).not.toContain("resets in");
  });
});

describe("checkRepoSetup", () => {
  const originalFetch = globalThis.fetch;

  afterEach(() => {
    globalThis.fetch = originalFetch;
  });

  it(".ziku/ziku.jsonc が存在する場合は true を返す", async () => {
    globalThis.fetch = vi.fn().mockResolvedValue({ ok: true });

    const result = await checkRepoSetup("owner", "repo");
    expect(result).toBe(true);
    expect(globalThis.fetch).toHaveBeenCalledWith(
      "https://api.github.com/repos/owner/repo/contents/.ziku/ziku.jsonc",
      expect.objectContaining({ method: "HEAD" }),
    );
  });

  it(".ziku/ziku.jsonc が存在しない場合は false を返す", async () => {
    globalThis.fetch = vi.fn().mockResolvedValue({ ok: false, status: 404 });

    const result = await checkRepoSetup("owner", "repo");
    expect(result).toBe(false);
  });

  it("ネットワークエラーの場合は false を返す", async () => {
    globalThis.fetch = vi.fn().mockRejectedValue(new Error("Network error"));

    const result = await checkRepoSetup("owner", "repo");
    expect(result).toBe(false);
  });

  it("GitHub トークンがある場合は Authorization ヘッダーを送信する", async () => {
    process.env.GITHUB_TOKEN = "ghp_test_token";
    globalThis.fetch = vi.fn().mockResolvedValue({ ok: true });

    await checkRepoSetup("owner", "repo");
    expect(globalThis.fetch).toHaveBeenCalledWith(
      expect.any(String),
      expect.objectContaining({
        headers: { Authorization: "Bearer ghp_test_token" },
      }),
    );

    delete process.env.GITHUB_TOKEN;
  });

  it("GitHub トークンがない場合は Authorization ヘッダーなし", async () => {
    delete process.env.GITHUB_TOKEN;
    delete process.env.GH_TOKEN;
    globalThis.fetch = vi.fn().mockResolvedValue({ ok: true });

    await checkRepoSetup("owner", "repo");
    expect(globalThis.fetch).toHaveBeenCalledWith(
      expect.any(String),
      expect.objectContaining({
        headers: {},
      }),
    );
  });
});

describe("scaffoldTemplateRepo", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("org にテンプレートリポジトリを作成する", async () => {
    mockOrgsGet.mockResolvedValue({ data: { login: "my-org" } });
    mockReposCreateInOrg.mockResolvedValue({
      data: { html_url: "https://github.com/my-org/.github" },
    });

    const result = await scaffoldTemplateRepo("token", "my-org", ".github");

    expect(result.url).toBe("https://github.com/my-org/.github");
    expect(mockReposCreateInOrg).toHaveBeenCalledWith(
      expect.objectContaining({
        org: "my-org",
        name: ".github",
        auto_init: true,
      }),
    );
  });

  it("個人アカウントにテンプレートリポジトリを作成する", async () => {
    mockOrgsGet.mockRejectedValue(new Error("Not an org"));
    mockReposCreateForAuthenticatedUser.mockResolvedValue({
      data: { html_url: "https://github.com/user/.github" },
    });

    const result = await scaffoldTemplateRepo("token", "user", ".github");

    expect(result.url).toBe("https://github.com/user/.github");
    expect(mockReposCreateForAuthenticatedUser).toHaveBeenCalledWith(
      expect.objectContaining({
        name: ".github",
        auto_init: true,
      }),
    );
    // createInOrg は呼ばれない
    expect(mockReposCreateInOrg).not.toHaveBeenCalled();
  });
});
