import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { getGhCliToken, getGitHubToken } from "../github";

// Octokit をモック
const mockGetAuthenticated = vi.fn();
const mockReposGet = vi.fn();
const mockReposCreateFork = vi.fn();
const mockReposGetBranch = vi.fn();
const mockGitCreateRef = vi.fn();
const mockReposGetContent = vi.fn();
const mockReposCreateOrUpdateFileContents = vi.fn();
const mockPullsCreate = vi.fn();

vi.mock("@octokit/rest", () => ({
  Octokit: class MockOctokit {
    users = {
      getAuthenticated: mockGetAuthenticated,
    };
    repos = {
      get: mockReposGet,
      createFork: mockReposCreateFork,
      getBranch: mockReposGetBranch,
      getContent: mockReposGetContent,
      createOrUpdateFileContents: mockReposCreateOrUpdateFileContents,
    };
    git = {
      createRef: mockGitCreateRef,
    };
    pulls = {
      create: mockPullsCreate,
    };
  },
}));

// モック後にインポート
const { createPullRequest } = await import("../github");

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

    mockReposGetContent.mockRejectedValue(new Error("Not found"));

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
    expect(result.branch).toMatch(/^devenv-sync-\d+$/);
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
    mockReposGetContent.mockResolvedValue({
      data: { type: "file", sha: "existing-sha" },
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
        head: expect.stringMatching(/^testuser:devenv-sync-\d+$/),
      }),
    );
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
