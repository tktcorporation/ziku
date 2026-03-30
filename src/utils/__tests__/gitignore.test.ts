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

// モック後にインポート
const { loadMergedGitignore, filterByGitignore } = await import("../gitignore");

describe("gitignore", () => {
  beforeEach(() => {
    vol.reset();
  });

  describe("loadMergedGitignore", () => {
    it(".gitignore が存在しない場合は空の Ignore を返す", async () => {
      vol.fromJSON({});

      const ig = await loadMergedGitignore(["/project"]);

      // 何もフィルタリングされない
      const files = ["file.txt", "secret.env"];
      expect(ig.filter(files)).toEqual(files);
    });

    it("単一ディレクトリの .gitignore を読み込む", async () => {
      vol.fromJSON({
        "/project/.gitignore": "*.env\nnode_modules/",
      });

      const ig = await loadMergedGitignore(["/project"]);

      expect(ig.filter(["app.ts", "secret.env", "node_modules/pkg"])).toEqual(["app.ts"]);
    });

    it("複数ディレクトリの .gitignore をマージする", async () => {
      vol.fromJSON({
        "/local/.gitignore": "*.env",
        "/template/.gitignore": "*.secret",
      });

      const ig = await loadMergedGitignore(["/local", "/template"]);

      // 両方の .gitignore ルールが適用される
      expect(ig.filter(["app.ts", "config.env", "api.secret", "readme.md"])).toEqual([
        "app.ts",
        "readme.md",
      ]);
    });

    it("片方のディレクトリにのみ .gitignore がある場合", async () => {
      vol.fromJSON({
        "/local/.gitignore": "*.env",
        // /template には .gitignore がない
      });

      const ig = await loadMergedGitignore(["/local", "/template"]);

      expect(ig.filter(["app.ts", "config.env"])).toEqual(["app.ts"]);
    });

    it("空の .gitignore ファイルを正しく処理する", async () => {
      vol.fromJSON({
        "/project/.gitignore": "",
      });

      const ig = await loadMergedGitignore(["/project"]);

      const files = ["file.txt", "secret.env"];
      expect(ig.filter(files)).toEqual(files);
    });

    it("コメント行のみの .gitignore を正しく処理する", async () => {
      vol.fromJSON({
        "/project/.gitignore": "# This is a comment\n# Another comment",
      });

      const ig = await loadMergedGitignore(["/project"]);

      const files = ["file.txt", "secret.env"];
      expect(ig.filter(files)).toEqual(files);
    });

    it("複雑な gitignore パターンを処理する", async () => {
      vol.fromJSON({
        "/project/.gitignore": `
# 環境変数ファイル
*.env
.env.*

# ビルド成果物
dist/
build/

# 依存関係
node_modules/

# IDE
.vscode/
.idea/

# ネゲーション（除外から除外）
!.env.example
`,
      });

      const ig = await loadMergedGitignore(["/project"]);

      const files = [
        "src/app.ts",
        ".env",
        ".env.local",
        ".env.example",
        "dist/bundle.js",
        "node_modules/pkg/index.js",
        ".vscode/settings.json",
        "README.md",
      ];

      expect(ig.filter(files)).toEqual([
        "src/app.ts",
        ".env.example", // ネゲーションで除外から復帰
        "README.md",
      ]);
    });
  });

  describe("filterByGitignore", () => {
    it("gitignore ルールに従ってファイルをフィルタリングする", async () => {
      vol.fromJSON({
        "/project/.gitignore": "*.env\n*.secret",
      });

      const ig = await loadMergedGitignore(["/project"]);
      const files = ["app.ts", "config.env", "api.secret", "readme.md"];

      expect(filterByGitignore(files, ig)).toEqual(["app.ts", "readme.md"]);
    });

    it("空のファイルリストを正しく処理する", async () => {
      vol.fromJSON({
        "/project/.gitignore": "*.env",
      });

      const ig = await loadMergedGitignore(["/project"]);

      expect(filterByGitignore([], ig)).toEqual([]);
    });

    it("ディレクトリパターンを正しく処理する", async () => {
      vol.fromJSON({
        "/project/.gitignore": ".devcontainer/",
      });

      const ig = await loadMergedGitignore(["/project"]);

      const files = [
        ".devcontainer/devcontainer.json",
        ".devcontainer/setup.sh",
        ".github/workflows/ci.yml",
      ];

      expect(filterByGitignore(files, ig)).toEqual([".github/workflows/ci.yml"]);
    });
  });
});
