import { describe, expect, it } from "vitest";

// 純粋関数をインポート
import { repoRelPath } from "../../__tests__/brands";
import { getDisplayFolderFromPath, getTotalUntrackedCount } from "../untracked";

describe("getDisplayFolderFromPath", () => {
  it("ルート直下のファイルは 'root' を返す", () => {
    expect(getDisplayFolderFromPath(repoRelPath(".mcp.json"))).toBe("root");
    expect(getDisplayFolderFromPath(repoRelPath(".mise.toml"))).toBe("root");
    expect(getDisplayFolderFromPath(repoRelPath("readme.md"))).toBe("root");
  });

  it(".devcontainer 配下のファイルは '.devcontainer' を返す", () => {
    expect(getDisplayFolderFromPath(repoRelPath(".devcontainer/devcontainer.json"))).toBe(
      ".devcontainer",
    );
    expect(getDisplayFolderFromPath(repoRelPath(".devcontainer/setup.sh"))).toBe(".devcontainer");
  });

  it(".github 配下のファイルは '.github' を返す", () => {
    expect(getDisplayFolderFromPath(repoRelPath(".github/workflows/ci.yml"))).toBe(".github");
    expect(getDisplayFolderFromPath(repoRelPath(".github/labeler.yml"))).toBe(".github");
  });

  it(".claude 配下のファイルは '.claude' を返す", () => {
    expect(getDisplayFolderFromPath(repoRelPath(".claude/settings.json"))).toBe(".claude");
  });

  it("深いネストのファイルは最初のディレクトリを返す", () => {
    expect(getDisplayFolderFromPath(repoRelPath(".github/workflows/deep/nested/file.yml"))).toBe(
      ".github",
    );
  });
});

describe("getTotalUntrackedCount", () => {
  it("全フォルダの未追跡ファイル数を合計する", () => {
    const untrackedByFolder = [
      {
        folder: ".devcontainer",
        files: [
          { path: repoRelPath(".devcontainer/new.sh"), folder: ".devcontainer" },
          { path: repoRelPath(".devcontainer/test.sh"), folder: ".devcontainer" },
        ],
      },
      {
        folder: ".github",
        files: [{ path: repoRelPath(".github/new.yml"), folder: ".github" }],
      },
    ];

    expect(getTotalUntrackedCount(untrackedByFolder)).toBe(3);
  });

  it("空のリストの場合は 0 を返す", () => {
    expect(getTotalUntrackedCount([])).toBe(0);
  });

  it("ファイルのないフォルダは 0 としてカウント", () => {
    const untrackedByFolder = [
      { folder: ".devcontainer", files: [] },
      {
        folder: ".github",
        files: [{ path: repoRelPath(".github/new.yml"), folder: ".github" }],
      },
    ];

    expect(getTotalUntrackedCount(untrackedByFolder)).toBe(1);
  });
});

// getAllFilesInDirs と getRootDotFiles は tinyglobby に依存するため、
// 統合テストとしてテストするか、別途モックを用意する必要があります。
// ここでは純粋関数のみをテストしています。
