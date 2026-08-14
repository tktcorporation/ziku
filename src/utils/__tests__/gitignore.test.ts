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
const { absPath } = await import("../../__tests__/brands");
const { loadMergedGitignore } = await import("../gitignore");

describe("gitignore", () => {
  beforeEach(() => {
    vol.reset();
  });

  describe("loadMergedGitignore", () => {
    it(".gitignore が存在しない場合は空の Ignore を返す", async () => {
      vol.fromJSON({});

      const ig = await loadMergedGitignore([absPath("/project")], []);

      // 何もフィルタリングされない
      const files = ["file.txt", "secret.env"];
      expect(ig.filter(files)).toEqual(files);
    });

    it("単一ディレクトリの .gitignore を読み込む", async () => {
      vol.fromJSON({
        "/project/.gitignore": "*.env\nnode_modules/",
      });

      const ig = await loadMergedGitignore([absPath("/project")], []);

      expect(ig.filter(["app.ts", "secret.env", "node_modules/pkg"])).toEqual(["app.ts"]);
    });

    it("複数ディレクトリの .gitignore をマージする", async () => {
      vol.fromJSON({
        "/local/.gitignore": "*.env",
        "/template/.gitignore": "*.secret",
      });

      const ig = await loadMergedGitignore([absPath("/local"), absPath("/template")], []);

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

      const ig = await loadMergedGitignore([absPath("/local"), absPath("/template")], []);

      expect(ig.filter(["app.ts", "config.env"])).toEqual(["app.ts"]);
    });

    it("空の .gitignore ファイルを正しく処理する", async () => {
      vol.fromJSON({
        "/project/.gitignore": "",
      });

      const ig = await loadMergedGitignore([absPath("/project")], []);

      const files = ["file.txt", "secret.env"];
      expect(ig.filter(files)).toEqual(files);
    });

    it("コメント行のみの .gitignore を正しく処理する", async () => {
      vol.fromJSON({
        "/project/.gitignore": "# This is a comment\n# Another comment",
      });

      const ig = await loadMergedGitignore([absPath("/project")], []);

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

      const ig = await loadMergedGitignore([absPath("/project")], []);

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

  describe("ネストした .gitignore", () => {
    it("サブディレクトリの .gitignore をディレクトリ接頭辞付きで読み込む", async () => {
      vol.fromJSON({
        "/project/.gitignore": "*.log",
        "/project/.devcontainer/.gitignore": "*.local",
      });

      const ig = await loadMergedGitignore([absPath("/project")], [".devcontainer"]);

      expect(ig.ignores("error.log")).toBe(true);
      expect(ig.ignores(".devcontainer/config.local")).toBe(true);
      // 接頭辞が付くので、同名のファイルでもサブディレクトリ外には適用されない
      expect(ig.ignores("config.local")).toBe(false);
    });

    it("否定パターンは ! の後ろに接頭辞が付く", async () => {
      vol.fromJSON({
        "/project/.claude/.gitignore": "*.local.md\n!keep.local.md",
      });

      const ig = await loadMergedGitignore([absPath("/project")], [".claude"]);

      expect(ig.ignores(".claude/settings.local.md")).toBe(true);
      expect(ig.ignores(".claude/keep.local.md")).toBe(false);
    });

    it("テンプレート側のネストした .gitignore も同じ規則で畳み込む", async () => {
      vol.fromJSON({
        "/template/.claude/.gitignore": "*.local.md",
      });

      const ig = await loadMergedGitignore([absPath("/local"), absPath("/template")], [".claude"]);

      expect(ig.ignores(".claude/settings.local.md")).toBe(true);
    });

    it("ネストした .gitignore が無いディレクトリを渡しても動作する", async () => {
      vol.fromJSON({
        "/project/.gitignore": "*.log",
      });

      const ig = await loadMergedGitignore([absPath("/project")], [".claude", ".github"]);

      expect(ig.ignores("error.log")).toBe(true);
      expect(ig.ignores(".claude/rules.md")).toBe(false);
    });
  });
});
