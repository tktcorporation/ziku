import { execFileSync } from "node:child_process";
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
  execFileSync: vi.fn(),
}));

afterEach(() => {
  vi.mocked(execFileSync).mockReset();
});

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
  it("リモート HEAD が指すブランチ名を返す", () => {
    vi.mocked(execFileSync).mockReturnValue(
      "ref: refs/heads/master\tHEAD\n1111111111111111111111111111111111111111\tHEAD\n",
    );

    expect(lsRemoteDefaultBranch("owner", "repo")).toBe("master");
    expect(execFileSync).toHaveBeenCalledWith(
      "git",
      ["ls-remote", "--symref", "https://github.com/owner/repo.git", "HEAD"],
      expect.anything(),
    );
  });

  it("スラッシュを含むブランチ名も取れる", () => {
    vi.mocked(execFileSync).mockReturnValue("ref: refs/heads/release/2026\tHEAD\n");

    expect(lsRemoteDefaultBranch("owner", "repo")).toBe("release/2026");
  });

  it("git が失敗した場合は undefined を返す", () => {
    vi.mocked(execFileSync).mockImplementation(() => {
      throw new Error("could not read Username");
    });

    expect(lsRemoteDefaultBranch("owner", "repo")).toBeUndefined();
  });

  it("symref 行が無い出力からは名前を作らない", () => {
    vi.mocked(execFileSync).mockReturnValue("1111111111111111111111111111111111111111\tHEAD\n");

    expect(lsRemoteDefaultBranch("owner", "repo")).toBeUndefined();
  });
});

describe("lsRemoteCommitSha", () => {
  const branchSha = "1111111111111111111111111111111111111111";
  const tagObjectSha = "2222222222222222222222222222222222222222";
  const taggedCommitSha = "3333333333333333333333333333333333333333";

  it("ブランチの SHA を返す", () => {
    vi.mocked(execFileSync).mockReturnValue(`${branchSha}\trefs/heads/main\n`);

    expect(lsRemoteCommitSha("owner", "repo", "main")).toBe(branchSha);
    expect(execFileSync).toHaveBeenCalledWith(
      "git",
      [
        "ls-remote",
        "https://github.com/owner/repo.git",
        "refs/heads/main",
        "refs/tags/main",
        "refs/tags/main^{}",
      ],
      expect.anything(),
    );
  });

  // 注釈付きタグの refs/tags/<name> はタグオブジェクトの SHA で、コミットの SHA ではない。
  it("注釈付きタグでは剥がしたコミットの SHA を返す", () => {
    vi.mocked(execFileSync).mockReturnValue(
      `${tagObjectSha}\trefs/tags/v1.0.0\n${taggedCommitSha}\trefs/tags/v1.0.0^{}\n`,
    );

    expect(lsRemoteCommitSha("owner", "repo", "v1.0.0")).toBe(taggedCommitSha);
  });

  it("軽量タグではタグの参照が指す SHA を返す", () => {
    vi.mocked(execFileSync).mockReturnValue(`${tagObjectSha}\trefs/tags/v1.0.0\n`);

    expect(lsRemoteCommitSha("owner", "repo", "v1.0.0")).toBe(tagObjectSha);
  });

  it("同名のブランチとタグがある場合はブランチを採る", () => {
    vi.mocked(execFileSync).mockReturnValue(
      `${branchSha}\trefs/heads/release\n${tagObjectSha}\trefs/tags/release\n`,
    );

    expect(lsRemoteCommitSha("owner", "repo", "release")).toBe(branchSha);
  });

  it("一致する参照が無ければ undefined を返す", () => {
    vi.mocked(execFileSync).mockReturnValue("");

    expect(lsRemoteCommitSha("owner", "repo", "missing")).toBeUndefined();
  });

  it("git が失敗した場合は undefined を返す", () => {
    vi.mocked(execFileSync).mockImplementation(() => {
      throw new Error("repository not found");
    });

    expect(lsRemoteCommitSha("owner", "repo", "main")).toBeUndefined();
  });
});
