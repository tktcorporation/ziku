import { vol } from "memfs";
import { beforeEach, describe, expect, it, vi } from "vitest";

// fs モジュールをモック
vi.mock("node:fs", async () => {
  const memfs = await import("memfs");
  return memfs.fs;
});

vi.mock("node:fs/promises", async () => {
  const memfs = await import("memfs");
  return memfs.fs.promises;
});

// 純粋関数をインポート
import {
  getDisplayFolderFromPath,
  getTotalUntrackedCount,
} from "../untracked";

describe("getDisplayFolderFromPath", () => {
  it("ルート直下のファイルは 'root' を返す", () => {
    expect(getDisplayFolderFromPath(".mcp.json")).toBe("root");
    expect(getDisplayFolderFromPath(".mise.toml")).toBe("root");
    expect(getDisplayFolderFromPath("readme.md")).toBe("root");
  });

  it(".devcontainer 配下のファイルは '.devcontainer' を返す", () => {
    expect(getDisplayFolderFromPath(".devcontainer/devcontainer.json")).toBe(".devcontainer");
    expect(getDisplayFolderFromPath(".devcontainer/setup.sh")).toBe(".devcontainer");
  });

  it(".github 配下のファイルは '.github' を返す", () => {
    expect(getDisplayFolderFromPath(".github/workflows/ci.yml")).toBe(".github");
    expect(getDisplayFolderFromPath(".github/labeler.yml")).toBe(".github");
  });

  it(".claude 配下のファイルは '.claude' を返す", () => {
    expect(getDisplayFolderFromPath(".claude/settings.json")).toBe(".claude");
  });

  it("深いネストのファイルは最初のディレクトリを返す", () => {
    expect(getDisplayFolderFromPath(".github/workflows/deep/nested/file.yml")).toBe(".github");
  });
});

describe("getTotalUntrackedCount", () => {
  it("全フォルダの未追跡ファイル数を合計する", () => {
    const untrackedByFolder = [
      {
        folder: ".devcontainer",
        files: [
          { path: ".devcontainer/new.sh", folder: ".devcontainer" },
          { path: ".devcontainer/test.sh", folder: ".devcontainer" },
        ],
      },
      {
        folder: ".github",
        files: [{ path: ".github/new.yml", folder: ".github" }],
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
        files: [{ path: ".github/new.yml", folder: ".github" }],
      },
    ];

    expect(getTotalUntrackedCount(untrackedByFolder)).toBe(1);
  });
});

describe("loadAllGitignores", () => {
  beforeEach(() => {
    vol.reset();
  });

  // loadAllGitignores のテストは ignore ライブラリの動作に依存するため、
  // 統合テストとしてテストする

  it("ルートの .gitignore を読み込む", async () => {
    vol.fromJSON({
      "/project/.gitignore": "node_modules/\n*.log",
    });

    const { loadAllGitignores } = await import("../untracked");
    const ig = await loadAllGitignores("/project", []);

    expect(ig.ignores("node_modules/package.json")).toBe(true);
    expect(ig.ignores("error.log")).toBe(true);
    expect(ig.ignores("file.txt")).toBe(false);
  });

  it(".gitignore が存在しない場合も動作する", async () => {
    vol.fromJSON({
      "/project": null,
    });

    const { loadAllGitignores } = await import("../untracked");
    const ig = await loadAllGitignores("/project", []);

    // 何も無視しない
    expect(ig.ignores("file.txt")).toBe(false);
  });

  it("サブディレクトリの .gitignore を読み込む", async () => {
    vol.fromJSON({
      "/project/.gitignore": "*.log",
      "/project/.devcontainer/.gitignore": "*.local",
    });

    const { loadAllGitignores } = await import("../untracked");
    const ig = await loadAllGitignores("/project", [".devcontainer"]);

    expect(ig.ignores("error.log")).toBe(true);
    expect(ig.ignores(".devcontainer/config.local")).toBe(true);
    expect(ig.ignores("config.local")).toBe(false); // サブディレクトリ外は適用されない
  });
});

// getAllFilesInDirs と getRootDotFiles は tinyglobby に依存するため、
// 統合テストとしてテストするか、別途モックを用意する必要があります。
// ここでは純粋関数のみをテストしています。
