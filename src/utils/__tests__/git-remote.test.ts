import { describe, expect, it } from "vitest";
import { DEFAULT_TEMPLATE_OWNER, DEFAULT_TEMPLATE_REPO, parseGitHubOwner } from "../git-remote";

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

describe("default constants", () => {
  it("デフォルトオーナーが定義されている", () => {
    expect(DEFAULT_TEMPLATE_OWNER).toBe("tktcorporation");
  });

  it("デフォルトリポジトリが定義されている", () => {
    expect(DEFAULT_TEMPLATE_REPO).toBe(".github");
  });
});
