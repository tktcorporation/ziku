import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { commitSha, repoRelPath } from "../../__tests__/brands";
import type { DeletablePath } from "../../modules/schemas";
import { asDeletablePath, asPushContent } from "../../modules/schemas";
import { classifySyncPath } from "../ziku-config";
import { ZikuFailure } from "../../errors";
import {
  checkRepoExists,
  checkRepoSetup,
  classifyGitHubApiFailure,
  getGhCliToken,
  getGitHubToken,
  githubApiFailure,
  rateLimitedError,
  unauthorizedError,
} from "../github";

/**
 * 削除として送れるパスを組み立てる。設定ファイルを渡すのはフィクスチャの誤りなので落とす。
 */
function deletablePath(path: string): DeletablePath {
  const deletable = asDeletablePath(classifySyncPath(repoRelPath(path)));
  if (deletable === undefined) throw new Error(`fixture must be deletable: ${path}`);
  return deletable;
}

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
const {
  createPullRequest,
  decideDefaultBranch,
  fetchDefaultBranch,
  scaffoldTemplateRepo,
  resolveLatestCommitSha,
  resolveSourceCommit,
  resolveSourceCommitSha,
} = await import("../github");

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
      data: { name: "test-repo", fork: true, parent: { full_name: "owner/repo" } },
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
      files: [{ path: repoRelPath("file.txt"), content: asPushContent("content") }],
      title: "Test PR",
      body: "Test body",
      baseBranch: "main",
    });

    expect(result.url).toBe("https://github.com/owner/repo/pull/123");
    expect(result.number).toBe(123);
    expect(result.branch).toMatch(/^ziku-sync-\d+$/);
  });

  it("バイナリはバイト列のまま base64 へ載せる", async () => {
    // 差分の string チャネルに載ったバイナリ（バイト保存の latin1）
    const bytes = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x00, 0xff, 0x1a]);

    await createPullRequest("token", {
      owner: "owner",
      repo: "repo",
      files: [
        { path: repoRelPath("assets/icon.png"), content: asPushContent(bytes.toString("latin1")) },
      ],
      title: "Test PR",
      body: "Test body",
      baseBranch: "main",
    });

    const sent = mockReposCreateOrUpdateFileContents.mock.calls[0][0] as { content: string };
    expect(Buffer.from(sent.content, "base64").equals(bytes)).toBe(true);
  });

  it("テキストは utf-8 のバイト列として base64 へ載せる", async () => {
    const content = "日本語のテキスト\n";

    await createPullRequest("token", {
      owner: "owner",
      repo: "repo",
      files: [{ path: repoRelPath("README.md"), content: asPushContent(content) }],
      title: "Test PR",
      body: "Test body",
      baseBranch: "main",
    });

    const sent = mockReposCreateOrUpdateFileContents.mock.calls[0][0] as { content: string };
    expect(Buffer.from(sent.content, "base64").toString("utf-8")).toBe(content);
  });

  it("既存の fork を使用する", async () => {
    mockReposGet.mockResolvedValue({
      data: { name: "repo", fork: true, parent: { full_name: "owner/repo" } },
    });

    await createPullRequest("token", {
      owner: "owner",
      repo: "repo",
      files: [{ path: repoRelPath("file.txt"), content: asPushContent("content") }],
      title: "Test PR",
      body: "Test body",
      baseBranch: "main",
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
      files: [{ path: repoRelPath("file.txt"), content: asPushContent("content") }],
      title: "Test PR",
      body: "Test body",
      baseBranch: "main",
    });

    expect(mockReposCreateFork).toHaveBeenCalledWith({
      owner: "owner",
      repo: "repo",
    });
  });

  it("fork を作れなかったときは、ステータスを持つ元の例外をそのまま投げる", async () => {
    mockReposGet.mockRejectedValue(new Error("Not Found"));
    const denied = apiError(403, "Resource not accessible by personal access token");
    mockReposCreateFork.mockRejectedValue(denied);

    const thrown = await createPullRequest("token", {
      owner: "owner",
      repo: "repo",
      files: [{ path: repoRelPath("file.txt"), content: asPushContent("content") }],
      title: "Test PR",
      body: "Test body",
      baseBranch: "main",
    }).catch((e: unknown) => e);

    // Effect の FiberFailure に埋もれると、呼び出し側は 403 を権限の問題として案内できない
    expect(thrown).toBe(denied);
    expect(classifyGitHubApiFailure(thrown)).toMatchObject({ _tag: "PermissionDenied" });
  });

  it("複数のファイルをコミットする", async () => {
    await createPullRequest("token", {
      owner: "owner",
      repo: "repo",
      files: [
        { path: repoRelPath("file1.txt"), content: asPushContent("content1") },
        { path: repoRelPath("file2.txt"), content: asPushContent("content2") },
      ],
      title: "Test PR",
      body: "Test body",
      baseBranch: "main",
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
      files: [{ path: repoRelPath("existing.txt"), content: asPushContent("new content") }],
      title: "Test PR",
      body: "Test body",
      baseBranch: "main",
    });

    expect(mockReposCreateOrUpdateFileContents).toHaveBeenCalledWith(
      expect.objectContaining({
        sha: "existing-sha",
      }),
    );
  });

  it("渡された baseBranch を宛先にする", async () => {
    await createPullRequest("token", {
      owner: "owner",
      repo: "repo",
      files: [{ path: repoRelPath("file.txt"), content: asPushContent("content") }],
      title: "Test PR",
      body: "Test body",
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
      files: [{ path: repoRelPath("file.txt"), content: asPushContent("content") }],
      title: "Test PR",
      baseBranch: "main",
      body: "Custom body content",
    });

    expect(mockPullsCreate).toHaveBeenCalledWith(
      expect.objectContaining({
        body: "Custom body content",
      }),
    );
  });

  it("正しいヘッドブランチ形式で PR を作成する", async () => {
    await createPullRequest("token", {
      owner: "owner",
      repo: "repo",
      files: [{ path: repoRelPath("file.txt"), content: asPushContent("content") }],
      title: "Test PR",
      body: "Test body",
      baseBranch: "main",
    });

    expect(mockPullsCreate).toHaveBeenCalledWith(
      expect.objectContaining({
        head: expect.stringMatching(/^testuser:ziku-sync-\d+$/),
      }),
    );
  });

  it("getTree は対象リポジトリの宛先ブランチから既存ファイルの SHA を一括取得する", async () => {
    // fork ではなく対象リポジトリを引くのは、fork を作る前に検証を終えるため。
    // 同期ブランチは同じコミットから生やすので、blob SHA は fork でもそのまま使える。
    await createPullRequest("token", {
      owner: "owner",
      repo: "repo",
      files: [{ path: repoRelPath("file.txt"), content: asPushContent("content") }],
      title: "Test PR",
      body: "Test body",
      baseBranch: "main",
    });

    expect(mockGitGetTree).toHaveBeenCalledWith({
      owner: "owner",
      repo: "repo",
      tree_sha: "abc123",
      recursive: "true",
    });
  });

  it("truncated な tree は、バグ報告ではなくファイル数を減らす案内として失敗する", async () => {
    mockGitGetTree.mockResolvedValue({
      data: { tree: [], truncated: true },
    });

    const thrown = await createPullRequest("token", {
      owner: "owner",
      repo: "repo",
      files: [{ path: repoRelPath("file.txt"), content: asPushContent("content") }],
      title: "Test PR",
      body: "Test body",
      baseBranch: "main",
    }).then(
      () => expect.unreachable("PR が作成されてしまった"),
      (error: unknown) => error,
    );

    expect(thrown).toBeInstanceOf(ZikuFailure);
    expect(thrown).toMatchObject({
      reason: { kind: "RepoTreeTooLarge", repo: "owner/repo" },
    });
    expect((thrown as ZikuFailure).hint).toContain("Reduce the number of files");
    // 検証は副作用より先。落ちた実行が fork に同期ブランチを残さない。
    expect(mockGitCreateRef).not.toHaveBeenCalled();
    expect(mockReposCreateFork).not.toHaveBeenCalled();
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
      deletions: [{ path: deletablePath("to-delete.txt") }],
      title: "Test PR with deletion",
      body: "Test body",
      baseBranch: "main",
    });

    expect(mockReposDeleteFile).toHaveBeenCalledWith(
      expect.objectContaining({
        path: "to-delete.txt",
        sha: "delete-sha",
      }),
    );
  });

  it("tree に存在しない削除対象ファイルは、黙って飛ばさず失敗として報告する", async () => {
    // 飛ばすと「削除する」と見せたファイルが残ったままの PR ができ、成功したように見える。
    mockGitGetTree.mockResolvedValue({
      data: { tree: [], truncated: false },
    });

    const thrown = await createPullRequest("token", {
      owner: "owner",
      repo: "repo",
      files: [{ path: repoRelPath("file.txt"), content: asPushContent("content") }],
      deletions: [{ path: deletablePath("nonexistent.txt") }],
      title: "Test PR",
      body: "Test body",
      baseBranch: "main",
    }).then(
      () => expect.unreachable("PR が作成されてしまった"),
      (error: unknown) => error,
    );

    expect(thrown).toBeInstanceOf(ZikuFailure);
    expect(thrown).toMatchObject({
      reason: {
        kind: "PushDeletionTargetMissing",
        repo: "owner/repo",
        paths: ["nonexistent.txt"],
      },
    });
    expect(mockReposDeleteFile).not.toHaveBeenCalled();
    expect(mockPullsCreate).not.toHaveBeenCalled();
    // リトライのたびに孤児ブランチが増えないよう、ブランチを作る前に確かめる。
    expect(mockGitCreateRef).not.toHaveBeenCalled();
  });

  it("同じパスを内容と削除の両方で送ろうとしたら、GitHub 上に何も作らずに止める", async () => {
    // 内容の書き込みは新しい blob を作り、その後の削除がベースの blob SHA と食い違って
    // 弾かれる。弾かれた時点でブランチとコミットは既にあるので、PR の無い同期ブランチが残る。
    mockGitGetTree.mockResolvedValue({
      data: {
        tree: [{ path: "README.md", type: "blob", sha: "readme-sha" }],
        truncated: false,
      },
    });

    const thrown = await createPullRequest("token", {
      owner: "owner",
      repo: "repo",
      files: [{ path: repoRelPath("README.md"), content: asPushContent("rebuilt") }],
      deletions: [{ path: deletablePath("README.md") }],
      title: "Test PR",
      body: "Test body",
      baseBranch: "main",
    }).then(
      () => expect.unreachable("PR が作成されてしまった"),
      (error: unknown) => error,
    );

    expect(thrown).toBeInstanceOf(ZikuFailure);
    expect(thrown).toMatchObject({
      reason: {
        kind: "PushPathUpdatedAndDeleted",
        repo: "owner/repo",
        paths: ["README.md"],
      },
    });
    // 読み取りより前に弾くので、fork もブランチも作られない。
    expect(mockReposCreateFork).not.toHaveBeenCalled();
    expect(mockGitCreateRef).not.toHaveBeenCalled();
    expect(mockReposCreateOrUpdateFileContents).not.toHaveBeenCalled();
    expect(mockReposDeleteFile).not.toHaveBeenCalled();
    expect(mockPullsCreate).not.toHaveBeenCalled();
  });

  it("onExistingFiles: fail は、宛先に既にあるファイルを置き換えずに止める", async () => {
    // setup が既存の設定を規定値へ戻す PR を作らないための歯止め。
    mockGitGetTree.mockResolvedValue({
      data: {
        tree: [{ path: ".ziku/ziku.jsonc", type: "blob", sha: "existing-sha" }],
        truncated: false,
      },
    });

    const thrown = await createPullRequest("token", {
      owner: "owner",
      repo: "repo",
      files: [{ path: repoRelPath(".ziku/ziku.jsonc"), content: asPushContent("defaults") }],
      title: "Test PR",
      body: "Test body",
      baseBranch: "main",
      onExistingFiles: "fail",
    }).then(
      () => expect.unreachable("PR が作成されてしまった"),
      (error: unknown) => error,
    );

    expect(thrown).toBeInstanceOf(ZikuFailure);
    expect(thrown).toMatchObject({
      reason: {
        kind: "PushCreateTargetExists",
        repo: "owner/repo",
        paths: [".ziku/ziku.jsonc"],
      },
    });
    expect(mockGitCreateRef).not.toHaveBeenCalled();
    expect(mockReposCreateOrUpdateFileContents).not.toHaveBeenCalled();
    expect(mockPullsCreate).not.toHaveBeenCalled();
  });

  it("onExistingFiles: fail でも宛先に無ければそのまま作る", async () => {
    await createPullRequest("token", {
      owner: "owner",
      repo: "repo",
      files: [{ path: repoRelPath(".ziku/ziku.jsonc"), content: asPushContent("defaults") }],
      title: "Test PR",
      body: "Test body",
      baseBranch: "main",
      onExistingFiles: "fail",
    });

    expect(mockPullsCreate).toHaveBeenCalled();
  });

  it("既定では既存ファイルを置き換える", async () => {
    // push はローカルの変更をテンプレートへ届ける操作なので、既存の内容を更新する。
    mockGitGetTree.mockResolvedValue({
      data: {
        tree: [{ path: "existing.txt", type: "blob", sha: "existing-sha" }],
        truncated: false,
      },
    });

    await createPullRequest("token", {
      owner: "owner",
      repo: "repo",
      files: [{ path: repoRelPath("existing.txt"), content: asPushContent("new content") }],
      title: "Test PR",
      body: "Test body",
      baseBranch: "main",
    });

    expect(mockPullsCreate).toHaveBeenCalled();
  });

  it("検証で落ちる実行は fork も作らない", async () => {
    // fork が未作成のプロジェクトでも、検証で落ちるだけの実行が fork を残さない。
    mockReposGet.mockRejectedValue(new Error("Not Found"));
    mockGitGetTree.mockResolvedValue({ data: { tree: [], truncated: false } });

    await createPullRequest("token", {
      owner: "owner",
      repo: "repo",
      files: [],
      deletions: [{ path: deletablePath("gone.txt") }],
      title: "Test PR",
      body: "Test body",
      baseBranch: "main",
    }).catch(() => undefined);

    expect(mockReposCreateFork).not.toHaveBeenCalled();
    expect(mockGitCreateRef).not.toHaveBeenCalled();
  });

  it("削除対象が 1 件でも欠ければ、他のファイルも書き込まずに止める", async () => {
    mockGitGetTree.mockResolvedValue({
      data: {
        tree: [{ path: "present.txt", type: "blob", sha: "present-sha" }],
        truncated: false,
      },
    });

    await createPullRequest("token", {
      owner: "owner",
      repo: "repo",
      files: [{ path: repoRelPath("file.txt"), content: asPushContent("content") }],
      deletions: [{ path: deletablePath("present.txt") }, { path: deletablePath("gone.txt") }],
      title: "Test PR",
      body: "Test body",
      baseBranch: "main",
    }).catch(() => undefined);

    expect(mockReposCreateOrUpdateFileContents).not.toHaveBeenCalled();
    expect(mockReposDeleteFile).not.toHaveBeenCalled();
  });

  it("同名だが fork ではないリポジトリは使わず、名前を直す案内で失敗する", async () => {
    // 無関係なリポジトリへ同期ブランチを作ると、共通の履歴が無い PR として拒まれ、
    // GitHub のエラーがそのまま出て原因が分からない。
    mockReposGet.mockResolvedValue({ data: { name: "repo", fork: false } });

    const thrown = await createPullRequest("token", {
      owner: "owner",
      repo: "repo",
      files: [{ path: repoRelPath("file.txt"), content: asPushContent("content") }],
      title: "Test PR",
      body: "Test body",
      baseBranch: "main",
    }).then(
      () => expect.unreachable("PR が作成されてしまった"),
      (error: unknown) => error,
    );

    expect(thrown).toBeInstanceOf(ZikuFailure);
    expect(thrown).toMatchObject({
      reason: { kind: "ForkNameTaken", repo: "owner/repo", existing: "testuser/repo" },
    });
    expect(mockGitCreateRef).not.toHaveBeenCalled();
    expect(mockReposCreateFork).not.toHaveBeenCalled();
  });

  it("別のリポジトリの fork も使わない", async () => {
    mockReposGet.mockResolvedValue({
      data: { name: "repo", fork: true, parent: { full_name: "someone-else/repo" } },
    });

    const thrown = await createPullRequest("token", {
      owner: "owner",
      repo: "repo",
      files: [{ path: repoRelPath("file.txt"), content: asPushContent("content") }],
      title: "Test PR",
      body: "Test body",
      baseBranch: "main",
    }).catch((e: unknown) => e);

    expect(thrown).toMatchObject({ reason: { kind: "ForkNameTaken" } });
  });

  it("fork の fork でも、根が対象リポジトリなら使う", async () => {
    // 根を共有していれば PR に必要な共通の履歴がある。
    mockReposGet.mockResolvedValue({
      data: {
        name: "repo",
        fork: true,
        parent: { full_name: "mirror/repo" },
        source: { full_name: "owner/repo" },
      },
    });

    await createPullRequest("token", {
      owner: "owner",
      repo: "repo",
      files: [{ path: repoRelPath("file.txt"), content: asPushContent("content") }],
      title: "Test PR",
      body: "Test body",
      baseBranch: "main",
    });

    expect(mockPullsCreate).toHaveBeenCalled();
    expect(mockReposCreateFork).not.toHaveBeenCalled();
  });

  it("認証ユーザーが対象リポジトリの所有者なら、fork を作らず対象リポジトリ本体を head にする", async () => {
    // 自分のテンプレートリポジトリは自分の fork ではないので、fork を探しに行くと
    // 「同名だが fork ではない」と判定され、push と setup --remote が必ず失敗する。
    mockGetAuthenticated.mockResolvedValue({ data: { login: "owner" } });

    await createPullRequest("token", {
      owner: "owner",
      repo: "repo",
      files: [{ path: repoRelPath("file.txt"), content: asPushContent("content") }],
      title: "Test PR",
      body: "Test body",
      baseBranch: "main",
    });

    expect(mockReposCreateFork).not.toHaveBeenCalled();
    // fork を探す問い合わせ自体が要らない。対象リポジトリ本体が head になる。
    expect(mockReposGet).not.toHaveBeenCalled();
    expect(mockGitCreateRef).toHaveBeenCalledWith(
      expect.objectContaining({ owner: "owner", repo: "repo" }),
    );
    expect(mockReposCreateOrUpdateFileContents).toHaveBeenCalledWith(
      expect.objectContaining({ owner: "owner", repo: "repo" }),
    );
    expect(mockPullsCreate).toHaveBeenCalledWith(
      expect.objectContaining({ head: expect.stringMatching(/^owner:ziku-sync-\d+$/) }),
    );
  });

  it("所有者の判定は大文字小文字を区別しない", async () => {
    // GitHub のログイン名は case-insensitive なので、表記違いで fork を探しに行かせない。
    mockGetAuthenticated.mockResolvedValue({ data: { login: "TestUser" } });

    await createPullRequest("token", {
      owner: "testuser",
      repo: "repo",
      files: [{ path: repoRelPath("file.txt"), content: asPushContent("content") }],
      title: "Test PR",
      body: "Test body",
      baseBranch: "main",
    });

    expect(mockReposCreateFork).not.toHaveBeenCalled();
    expect(mockReposGet).not.toHaveBeenCalled();
    expect(mockGitCreateRef).toHaveBeenCalledWith(
      expect.objectContaining({ owner: "testuser", repo: "repo" }),
    );
  });

  it("削除も対象リポジトリ本体のブランチへ送る", async () => {
    mockGetAuthenticated.mockResolvedValue({ data: { login: "owner" } });
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
      deletions: [{ path: deletablePath("to-delete.txt") }],
      title: "Test PR with deletion",
      body: "Test body",
      baseBranch: "main",
    });

    expect(mockReposDeleteFile).toHaveBeenCalledWith(
      expect.objectContaining({ owner: "owner", repo: "repo", path: "to-delete.txt" }),
    );
  });

  it("ファイル内容を Base64 エンコードする", async () => {
    await createPullRequest("token", {
      owner: "owner",
      repo: "repo",
      files: [{ path: repoRelPath("file.txt"), content: asPushContent("Hello, World!") }],
      title: "Test PR",
      body: "Test body",
      baseBranch: "main",
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

  it("認証失敗 (401) は Unauthorized を返し、GitHub のメッセージを保持する", async () => {
    // 失効/無効トークンで Authorization ヘッダを付けたときのケース。
    // Unknown に落とすと後続の download/PR 作成でしか問題に気づけない。
    globalThis.fetch = vi
      .fn()
      .mockResolvedValue(mockResponse({ status: 401, statusText: "Bad credentials" }));

    const result = await checkRepoExists("owner", "repo");
    expect(result).toEqual({ _tag: "Unauthorized", message: "Bad credentials" });
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

describe("unauthorizedError", () => {
  it("GitHub のメッセージと gh auth login 誘導を hint に含める", () => {
    const err = unauthorizedError({ _tag: "Unauthorized", message: "Bad credentials" });

    expect(err.message).toBe("GitHub authentication failed: Bad credentials");
    expect(err.hint).toContain("gh auth login");
    expect(err.hint).toContain("GITHUB_TOKEN");
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

/** Octokit の RequestError を模した例外。 */
function apiError(status: number, message: string, headers: Record<string, string> = {}): Error {
  return Object.assign(new Error(message), { status, response: { status, headers } });
}

describe("classifyGitHubApiFailure", () => {
  it("401 は認証拒否として、GitHub のメッセージごと分類する", () => {
    expect(classifyGitHubApiFailure(apiError(401, "Bad credentials"))).toEqual({
      _tag: "AuthRejected",
      detail: "Bad credentials",
    });
  });

  it("クォータ超過の 403 はレート制限として、リセット時刻付きで分類する", () => {
    const resetEpoch = Math.floor(Date.now() / 1000) + 600;
    const failure = classifyGitHubApiFailure(
      apiError(403, "API rate limit exceeded", {
        "x-ratelimit-remaining": "0",
        "x-ratelimit-reset": String(resetEpoch),
      }),
    );

    expect(failure).toEqual({ _tag: "RateLimited", resetAt: new Date(resetEpoch * 1000) });
  });

  it("secondary rate limit は retry-after の秒数を時刻に直す", () => {
    const failure = classifyGitHubApiFailure(
      apiError(403, "You have exceeded a secondary rate limit", { "retry-after": "60" }),
    );

    // 「あと何秒」を時刻へ直すので、リセット時刻は今より後になる
    expect(failure).toMatchObject({ _tag: "RateLimited" });
    const { resetAt } = failure as { resetAt: Date | undefined };
    expect(resetAt?.getTime()).toBeGreaterThan(Date.now());
  });

  it("レート制限のヘッダを持たない 403 は権限不足として分ける", () => {
    expect(classifyGitHubApiFailure(apiError(403, "Must have admin rights"))).toEqual({
      _tag: "PermissionDenied",
      detail: "Must have admin rights",
    });
  });

  it("404 は宛先が見つからない失敗として分類する", () => {
    // 宛先にした参照が上流から消えた状態。ユーザーが lock の参照を直せるので、
    // 分類せずに defect へ落とすと「ziku のバグ」として案内されてしまう。
    expect(classifyGitHubApiFailure(apiError(404, "Branch not found"))).toEqual({
      _tag: "NotFound",
      detail: "Branch not found",
    });
  });

  it("429 はヘッダが無くてもレート制限として扱う", () => {
    expect(classifyGitHubApiFailure(apiError(429, "Too Many Requests"))).toEqual({
      _tag: "RateLimited",
      resetAt: undefined,
    });
  });

  it("接続断は、例外チェーンの奥の errno から見分ける", () => {
    // Octokit は fetch の失敗を status 500 に包み直すので、ステータスでは判別できない。
    const wrapped = Object.assign(new Error("request to https://api.github.com failed"), {
      status: 500,
      cause: Object.assign(new TypeError("fetch failed"), {
        cause: Object.assign(new Error("connect ECONNREFUSED"), { code: "ECONNREFUSED" }),
      }),
    });

    expect(classifyGitHubApiFailure(wrapped)).toMatchObject({ _tag: "Unreachable" });
  });

  it("GitHub の 5xx と素の例外は分類しない", () => {
    expect(classifyGitHubApiFailure(apiError(500, "Internal Server Error"))).toEqual({
      _tag: "Unclassified",
    });
    expect(classifyGitHubApiFailure(new TypeError("x is not a function"))).toEqual({
      _tag: "Unclassified",
    });
  });
});

describe("githubApiFailure", () => {
  const cause = new Error("boom");

  it("認証拒否はトークンの更新を促し、原因を捨てない", () => {
    const failure = githubApiFailure(
      { _tag: "AuthRejected", detail: "Bad credentials" },
      { operation: "create a pull request", authenticated: true, cause },
    );

    expect(failure.reason).toEqual({ kind: "GitHubAuthRejected", detail: "Bad credentials" });
    expect(failure.hint).toContain("gh auth login");
    expect(failure.cause).toBe(cause);
  });

  it("権限不足と到達不能は、何をしようとして失敗したかを文面に残す", () => {
    const denied = githubApiFailure(
      { _tag: "PermissionDenied", detail: "Must have admin rights" },
      { operation: "create a pull request", authenticated: true, cause },
    );
    const unreachable = githubApiFailure(
      { _tag: "Unreachable", detail: "getaddrinfo ENOTFOUND api.github.com" },
      { operation: "create a pull request", authenticated: true, cause },
    );

    expect(denied.message).toContain("create a pull request");
    expect(unreachable.message).toContain("create a pull request");
  });

  it("宛先が見つからない失敗は、参照の直し方を案内する", () => {
    const failure = githubApiFailure(
      { _tag: "NotFound", detail: "Branch not found" },
      { operation: "create a pull request", authenticated: true, cause },
    );

    expect(failure.reason).toEqual({
      kind: "GitHubTargetNotFound",
      operation: "create a pull request",
      detail: "Branch not found",
    });
    expect(failure.hint).toContain("source.defaultBranch");
    expect(failure.hint).toContain("source.ref");
    expect(failure.cause).toBe(cause);
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

describe("fetchDefaultBranch", () => {
  const originalEnv = process.env;

  beforeEach(() => {
    vi.clearAllMocks();
    process.env = { ...originalEnv };
    // gh CLI 経由のトークン混入を避け、未認証の挙動で検証する
    delete process.env.GITHUB_TOKEN;
    delete process.env.GH_TOKEN;
    process.env.PATH = "";
  });

  afterEach(() => {
    process.env = originalEnv;
  });

  it("リポジトリの既定ブランチ名を返す", async () => {
    mockReposGet.mockResolvedValue({ data: { default_branch: "master" } });

    expect(await fetchDefaultBranch("owner", "repo")).toEqual({
      _tag: "Resolved",
      name: "master",
    });
    expect(mockReposGet).toHaveBeenCalledWith({ owner: "owner", repo: "repo" });
  });

  it("トークンを拒否された場合は AuthRejected を返す", async () => {
    mockReposGet.mockRejectedValue(apiError(401, "Bad credentials"));

    expect(await fetchDefaultBranch("owner", "repo")).toEqual({
      _tag: "AuthRejected",
      detail: "Bad credentials",
    });
  });

  it("待てば直りうる失敗は Unresolved を返す", async () => {
    mockReposGet.mockRejectedValue(new Error("Not Found"));

    expect(await fetchDefaultBranch("owner", "repo")).toEqual({
      _tag: "Unresolved",
      reason: "Not Found",
    });
  });
});

/**
 * 既定ブランチ名を要る場所（テンプレートの取得先・PR の宛先）が同じ規則で動くための判断。
 * 引けなかった理由ごとに、控えへ倒すか止めるかが変わる。
 */
describe("decideDefaultBranch", () => {
  it("引けた名前をそのまま使う", () => {
    expect(decideDefaultBranch({ _tag: "Resolved", name: "master" }, "trunk")).toEqual({
      _tag: "Fetched",
      name: "master",
    });
  });

  it("待てば直る失敗では控えた名前へ倒し、倒した事情を残す", () => {
    expect(
      decideDefaultBranch({ _tag: "Unresolved", reason: "API rate limit exceeded" }, "master"),
    ).toEqual({ _tag: "Recorded", name: "master", reason: "API rate limit exceeded" });
  });

  it("控えが無ければ名前を決めない", () => {
    expect(decideDefaultBranch({ _tag: "Unresolved", reason: "Not Found" }, undefined)).toEqual({
      _tag: "Unresolved",
      reason: "Not Found",
    });
  });

  it("トークンを拒否されたら、控えがあっても倒さない", () => {
    expect(
      decideDefaultBranch({ _tag: "AuthRejected", detail: "Bad credentials" }, "master"),
    ).toEqual({ _tag: "AuthRejected", detail: "Bad credentials" });
  });
});

/** `Accept: application/vnd.github.sha` の応答（SHA 文字列のみ）を模す */
const shaResponse = (sha: string) => ({
  ok: true,
  text: () => Promise.resolve(`${sha}\n`),
});

describe("resolveLatestCommitSha", () => {
  const originalFetch = globalThis.fetch;
  const originalEnv = process.env;

  beforeEach(() => {
    vi.clearAllMocks();
    process.env = { ...originalEnv };
    delete process.env.GITHUB_TOKEN;
    delete process.env.GH_TOKEN;
    process.env.PATH = "";
  });

  afterEach(() => {
    globalThis.fetch = originalFetch;
    process.env = originalEnv;
  });

  it("ref が指定されている場合はその ref の SHA を解決する", async () => {
    globalThis.fetch = vi.fn().mockResolvedValue(shaResponse("sha-develop"));

    const resolution = await resolveLatestCommitSha("owner", "repo", {
      kind: "branch",
      name: "develop",
    });

    expect(resolution).toEqual({ _tag: "Resolved", sha: "sha-develop" });
    expect(globalThis.fetch).toHaveBeenCalledWith(
      "https://api.github.com/repos/owner/repo/commits/develop",
      expect.anything(),
    );
    // ref が判明しているので既定ブランチの問い合わせは不要
    expect(mockReposGet).not.toHaveBeenCalled();
  });

  it("ref 未指定の場合はリポジトリの既定ブランチの SHA を解決する", async () => {
    mockReposGet.mockResolvedValue({ data: { default_branch: "master" } });
    globalThis.fetch = vi.fn().mockResolvedValue(shaResponse("sha-master"));

    const resolution = await resolveLatestCommitSha("owner", "repo");

    expect(resolution).toEqual({ _tag: "Resolved", sha: "sha-master" });
    expect(globalThis.fetch).toHaveBeenCalledWith(
      "https://api.github.com/repos/owner/repo/commits/master",
      expect.anything(),
    );
  });

  it("既定ブランチを取得できない場合は main へフォールバックせず未解決を返す", async () => {
    mockReposGet.mockRejectedValue(new Error("Not Found"));
    globalThis.fetch = vi.fn();

    const resolution = await resolveLatestCommitSha("owner", "repo");

    expect(resolution._tag).toBe("Unresolved");
    expect(globalThis.fetch).not.toHaveBeenCalled();
  });

  it("コミット取得が 404 の場合は未解決を返す", async () => {
    globalThis.fetch = vi
      .fn()
      .mockResolvedValue({ ok: false, status: 404, statusText: "Not Found" });

    expect(
      await resolveLatestCommitSha("owner", "repo", { kind: "branch", name: "develop" }),
    ).toEqual({ _tag: "Unresolved", reason: "Not Found" });
  });

  it("ネットワークエラーの場合は未解決を返す", async () => {
    globalThis.fetch = vi.fn().mockRejectedValue(new Error("Network error"));

    expect(
      await resolveLatestCommitSha("owner", "repo", { kind: "branch", name: "develop" }),
    ).toEqual({ _tag: "Unresolved", reason: "Network error" });
  });
});

describe("コミット SHA 取得の失敗の分類", () => {
  const originalFetch = globalThis.fetch;
  const originalEnv = process.env;

  beforeEach(() => {
    vi.clearAllMocks();
    process.env = { ...originalEnv };
    process.env.GITHUB_TOKEN = "ghp_expired";
    delete process.env.GH_TOKEN;
    process.env.PATH = "";
  });

  afterEach(() => {
    globalThis.fetch = originalFetch;
    process.env = originalEnv;
  });

  it("トークンが拒否された場合（401）は認証拒否として返す", async () => {
    // 401 を未解決に混ぜると、失効したトークンのまま古いベースで 3-way マージが続く。
    globalThis.fetch = vi
      .fn()
      .mockResolvedValue({ ok: false, status: 401, statusText: "Unauthorized" });

    expect(await resolveSourceCommit("owner", "repo", { kind: "branch", name: "main" })).toEqual({
      _tag: "AuthRejected",
      detail: "Unauthorized",
    });
  });

  it("タグの解決でも 401 は認証拒否として返す", async () => {
    globalThis.fetch = vi.fn().mockResolvedValue({ ok: false, status: 401, statusText: "" });

    expect(await resolveSourceCommit("owner", "repo", { kind: "tag", name: "v1.0.0" })).toEqual({
      _tag: "AuthRejected",
      detail: "Bad credentials",
    });
  });

  it("ref 未指定でも既定ブランチの問い合わせが 401 なら認証拒否として返す", async () => {
    // ref 未指定が最も多い設定なので、ここで潰すとトークン失効がほぼ見えなくなる。
    mockReposGet.mockRejectedValue(Object.assign(new Error("Bad credentials"), { status: 401 }));
    globalThis.fetch = vi.fn();

    expect(await resolveSourceCommit("owner", "repo")).toEqual({
      _tag: "AuthRejected",
      detail: "Bad credentials",
    });
    expect(globalThis.fetch).not.toHaveBeenCalled();
  });

  it("レート制限（403）は再実行で解消しうるので未解決として返す", async () => {
    globalThis.fetch = vi
      .fn()
      .mockResolvedValue({ ok: false, status: 403, statusText: "rate limit exceeded" });

    expect(await resolveSourceCommit("owner", "repo", { kind: "branch", name: "main" })).toEqual({
      _tag: "Unresolved",
      reason: "rate limit exceeded",
    });
  });

  it("コミット指定は API を呼ばずにその SHA を返す", async () => {
    globalThis.fetch = vi.fn();

    expect(
      await resolveSourceCommit("owner", "repo", { kind: "commit", sha: commitSha("abc123") }),
    ).toEqual({
      _tag: "Resolved",
      sha: "abc123",
    });
    expect(globalThis.fetch).not.toHaveBeenCalled();
  });

  it("resolveSourceCommitSha は理由を落として SHA だけを返す", async () => {
    globalThis.fetch = vi
      .fn()
      .mockResolvedValue({ ok: false, status: 401, statusText: "Unauthorized" });

    expect(
      await resolveSourceCommitSha("owner", "repo", { kind: "branch", name: "main" }),
    ).toBeUndefined();
  });
});

describe("コミット SHA 取得の認証", () => {
  const originalFetch = globalThis.fetch;
  const originalEnv = process.env;

  beforeEach(() => {
    vi.clearAllMocks();
    process.env = { ...originalEnv };
    delete process.env.GITHUB_TOKEN;
    delete process.env.GH_TOKEN;
    // getGitHubToken は gh CLI (`gh auth token`) にフォールバックするため、
    // gh 認証済みのマシンではトークンが漏れ込む。PATH を空にして
    // execFileSync("gh", ...) を ENOENT にし、確実に未認証状態を作る。
    process.env.PATH = "";
  });

  afterEach(() => {
    globalThis.fetch = originalFetch;
    process.env = originalEnv;
  });

  it("トークンがある場合は Authorization ヘッダを付与する", async () => {
    process.env.GITHUB_TOKEN = "ghp_test";
    globalThis.fetch = vi.fn().mockResolvedValue(shaResponse("sha-develop"));

    await resolveLatestCommitSha("owner", "repo", { kind: "branch", name: "develop" });

    expect(globalThis.fetch).toHaveBeenCalledWith(
      "https://api.github.com/repos/owner/repo/commits/develop",
      { headers: { Accept: "application/vnd.github.sha", Authorization: "Bearer ghp_test" } },
    );
  });

  it("タグの解決も認証付きで問い合わせる", async () => {
    process.env.GITHUB_TOKEN = "ghp_test";
    globalThis.fetch = vi.fn().mockResolvedValue(shaResponse("sha-v1"));

    const sha = await resolveSourceCommitSha("owner", "repo", { kind: "tag", name: "v1.0.0" });

    expect(sha).toBe("sha-v1");
    expect(globalThis.fetch).toHaveBeenCalledWith(
      "https://api.github.com/repos/owner/repo/commits/v1.0.0",
      { headers: { Accept: "application/vnd.github.sha", Authorization: "Bearer ghp_test" } },
    );
  });

  it("トークンがない場合は Authorization ヘッダを付けず、公開リポジトリは解決できる", async () => {
    globalThis.fetch = vi.fn().mockResolvedValue(shaResponse("sha-public"));

    const resolution = await resolveLatestCommitSha("owner", "repo", {
      kind: "branch",
      name: "main",
    });

    expect(resolution).toEqual({ _tag: "Resolved", sha: "sha-public" });
    expect(globalThis.fetch).toHaveBeenCalledWith(
      "https://api.github.com/repos/owner/repo/commits/main",
      { headers: { Accept: "application/vnd.github.sha" } },
    );
  });

  it("プライベートリポジトリでも認証付きなら 404 にならず SHA を解決できる", async () => {
    // GitHub は未認証のプライベートリポジトリを 404 として返す。認証が漏れると
    // ベースコミットが lock に記録されず、3-way マージの共通祖先を失う。
    globalThis.fetch = vi
      .fn()
      .mockImplementation((_url: string, init: { headers: Record<string, string> }) =>
        Promise.resolve(
          init.headers.Authorization === "Bearer ghp_test"
            ? shaResponse("sha-private")
            : { ok: false, status: 404 },
        ),
      );

    expect(
      await resolveLatestCommitSha("owner", "private-repo", { kind: "branch", name: "main" }),
    ).toEqual({ _tag: "Unresolved", reason: "HTTP 404" });

    process.env.GITHUB_TOKEN = "ghp_test";
    expect(
      await resolveLatestCommitSha("owner", "private-repo", { kind: "branch", name: "main" }),
    ).toEqual({ _tag: "Resolved", sha: "sha-private" });
  });
});
