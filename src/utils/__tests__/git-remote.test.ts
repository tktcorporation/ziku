import { execFile } from "node:child_process";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  DEFAULT_TEMPLATE_REPO,
  DEFAULT_TEMPLATE_REPOS,
  lsRemoteCommitSha,
  lsRemoteDefaultBranch,
  parseGitHubOwner,
  parseGitHubRepo,
} from "../git-remote";

// `git ls-remote` のサブプロセス起動をテストから制御する。実際の git とネットワークに
// 依存させない。
vi.mock("node:child_process", () => ({
  execFile: vi.fn(),
  execFileSync: vi.fn(),
}));

afterEach(() => {
  vi.mocked(execFile).mockReset();
});

/**
 * `git ls-remote` の標準出力を差し替える。
 *
 * `promisify(execFile)` が呼ぶのはコールバック版なので、コールバックを成功で呼ぶ実装を
 * 差し込む。`promisify` は関数の最後の引数をコールバックとして扱う。
 */
function mockLsRemoteOutput(stdout: string): void {
  vi.mocked(execFile).mockImplementation(((...args: unknown[]) => {
    const callback = args.at(-1) as (
      error: null,
      result: { stdout: string; stderr: string },
    ) => void;
    callback(null, { stdout, stderr: "" });
    return undefined;
  }) as unknown as typeof execFile);
}

/** `git ls-remote` の失敗（対象が無い・認証できない等）を模す。 */
function mockLsRemoteFailure(message: string): void {
  vi.mocked(execFile).mockImplementation(((...args: unknown[]) => {
    const callback = args.at(-1) as (error: Error) => void;
    callback(new Error(message));
    return undefined;
  }) as unknown as typeof execFile);
}

/** `git ls-remote` へ渡した引数（`git` の後ろ）。 */
function lsRemoteArgs(): unknown {
  return vi.mocked(execFile).mock.calls[0]?.[1];
}

describe("parseGitHubOwner", () => {
  it("HTTPS URL (.git 付き) からオーナーを抽出", () => {
    expect(parseGitHubOwner("https://github.com/my-org/my-repo.git")).toBe("my-org");
  });

  it("HTTPS URL (.git なし) からオーナーを抽出", () => {
    expect(parseGitHubOwner("https://github.com/my-org/my-repo")).toBe("my-org");
  });

  it("SSH URL からオーナーを抽出", () => {
    expect(parseGitHubOwner("git@github.com:my-org/my-repo.git")).toBe("my-org");
  });

  it("SSH URL (.git なし) からオーナーを抽出", () => {
    expect(parseGitHubOwner("git@github.com:someone/dotfiles")).toBe("someone");
  });

  it("GitHub 以外の URL は null を返す", () => {
    expect(parseGitHubOwner("https://gitlab.com/my-org/my-repo.git")).toBeNull();
  });

  it("空文字列は null を返す", () => {
    expect(parseGitHubOwner("")).toBeNull();
  });

  it("不正な形式は null を返す", () => {
    expect(parseGitHubOwner("not-a-url")).toBeNull();
  });
});

describe("parseGitHubRepo", () => {
  it("HTTPS URL (.git 付き) からオーナーとリポ名を抽出", () => {
    expect(parseGitHubRepo("https://github.com/my-org/my-repo.git")).toEqual({
      owner: "my-org",
      repo: "my-repo",
    });
  });

  it("HTTPS URL (.git なし) からオーナーとリポ名を抽出", () => {
    expect(parseGitHubRepo("https://github.com/my-org/my-repo")).toEqual({
      owner: "my-org",
      repo: "my-repo",
    });
  });

  it("SSH URL からオーナーとリポ名を抽出", () => {
    expect(parseGitHubRepo("git@github.com:my-org/my-repo.git")).toEqual({
      owner: "my-org",
      repo: "my-repo",
    });
  });

  it("SSH URL (.git なし) からオーナーとリポ名を抽出", () => {
    expect(parseGitHubRepo("git@github.com:someone/dotfiles")).toEqual({
      owner: "someone",
      repo: "dotfiles",
    });
  });

  it("GitHub 以外の URL は null を返す", () => {
    expect(parseGitHubRepo("https://gitlab.com/my-org/my-repo.git")).toBeNull();
  });

  it("空文字列は null を返す", () => {
    expect(parseGitHubRepo("")).toBeNull();
  });

  it("不正な形式は null を返す", () => {
    expect(parseGitHubRepo("not-a-url")).toBeNull();
  });

  it(".github リポジトリ名を正しく抽出", () => {
    expect(parseGitHubRepo("https://github.com/my-org/.github")).toEqual({
      owner: "my-org",
      repo: ".github",
    });
  });
});

describe("default constants", () => {
  it("デフォルトリポジトリ候補が .ziku と .github を含む", () => {
    expect(DEFAULT_TEMPLATE_REPOS).toEqual([".ziku", ".github"]);
    expect(DEFAULT_TEMPLATE_REPO).toBe(".ziku");
  });
});

describe("lsRemoteDefaultBranch", () => {
  it("リモート HEAD が指すブランチ名を返す", async () => {
    mockLsRemoteOutput(
      "ref: refs/heads/master\tHEAD\n1111111111111111111111111111111111111111\tHEAD\n",
    );

    await expect(lsRemoteDefaultBranch("owner", "repo")).resolves.toBe("master");
    expect(lsRemoteArgs()).toEqual([
      "ls-remote",
      "--symref",
      "https://github.com/owner/repo.git",
      "HEAD",
    ]);
  });

  it("スラッシュを含むブランチ名も取れる", async () => {
    mockLsRemoteOutput("ref: refs/heads/release/2026\tHEAD\n");

    await expect(lsRemoteDefaultBranch("owner", "repo")).resolves.toBe("release/2026");
  });

  it("git が失敗した場合は undefined を返す", async () => {
    mockLsRemoteFailure("could not read Username");

    await expect(lsRemoteDefaultBranch("owner", "repo")).resolves.toBeUndefined();
  });

  it("symref 行が無い出力からは名前を作らない", async () => {
    mockLsRemoteOutput("1111111111111111111111111111111111111111\tHEAD\n");

    await expect(lsRemoteDefaultBranch("owner", "repo")).resolves.toBeUndefined();
  });
});

describe("lsRemoteCommitSha", () => {
  const branchSha = "1111111111111111111111111111111111111111";
  const tagObjectSha = "2222222222222222222222222222222222222222";
  const taggedCommitSha = "3333333333333333333333333333333333333333";

  it("ブランチの SHA を返す", async () => {
    mockLsRemoteOutput(`${branchSha}\trefs/heads/main\n`);

    await expect(lsRemoteCommitSha("owner", "repo", "main")).resolves.toBe(branchSha);
    expect(lsRemoteArgs()).toEqual([
      "ls-remote",
      "https://github.com/owner/repo.git",
      "refs/heads/main",
      "refs/tags/main",
      "refs/tags/main^{}",
    ]);
  });

  // 注釈付きタグの refs/tags/<name> はタグオブジェクトの SHA で、コミットの SHA ではない。
  it("注釈付きタグでは剥がしたコミットの SHA を返す", async () => {
    mockLsRemoteOutput(
      `${tagObjectSha}\trefs/tags/v1.0.0\n${taggedCommitSha}\trefs/tags/v1.0.0^{}\n`,
    );

    await expect(lsRemoteCommitSha("owner", "repo", "v1.0.0")).resolves.toBe(taggedCommitSha);
  });

  it("軽量タグではタグの参照が指す SHA を返す", async () => {
    mockLsRemoteOutput(`${tagObjectSha}\trefs/tags/v1.0.0\n`);

    await expect(lsRemoteCommitSha("owner", "repo", "v1.0.0")).resolves.toBe(tagObjectSha);
  });

  it("同名のブランチとタグがある場合はブランチを採る", async () => {
    mockLsRemoteOutput(`${branchSha}\trefs/heads/release\n${tagObjectSha}\trefs/tags/release\n`);

    await expect(lsRemoteCommitSha("owner", "repo", "release")).resolves.toBe(branchSha);
  });

  it("一致する参照が無ければ undefined を返す", async () => {
    mockLsRemoteOutput("");

    await expect(lsRemoteCommitSha("owner", "repo", "missing")).resolves.toBeUndefined();
  });

  it("git が失敗した場合は undefined を返す", async () => {
    mockLsRemoteFailure("repository not found");

    await expect(lsRemoteCommitSha("owner", "repo", "main")).resolves.toBeUndefined();
  });
});
