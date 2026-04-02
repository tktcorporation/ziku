import { describe, expect, it } from "vitest";
import {
  DEFAULT_TEMPLATE_REPO,
  DEFAULT_TEMPLATE_REPOS,
  parseGitHubOwner,
  parseGitHubRepo,
} from "../git-remote";

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
