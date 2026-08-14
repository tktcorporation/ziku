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
const { absPath, repoRelPath } = await import("../../__tests__/brands");
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
      expect(files.filter((f) => !ig.ignores(repoRelPath(f)))).toEqual(files);
    });

    it("単一ディレクトリの .gitignore を読み込む", async () => {
      vol.fromJSON({
        "/project/.gitignore": "*.env\nnode_modules/",
      });

      const ig = await loadMergedGitignore([absPath("/project")], []);

      expect(
        ["app.ts", "secret.env", "node_modules/pkg"].filter((f) => !ig.ignores(repoRelPath(f))),
      ).toEqual(["app.ts"]);
    });

    it("複数ディレクトリの .gitignore をマージする", async () => {
      vol.fromJSON({
        "/local/.gitignore": "*.env",
        "/template/.gitignore": "*.secret",
      });

      const ig = await loadMergedGitignore([absPath("/local"), absPath("/template")], []);

      // 両方の .gitignore ルールが適用される
      expect(
        ["app.ts", "config.env", "api.secret", "readme.md"].filter(
          (f) => !ig.ignores(repoRelPath(f)),
        ),
      ).toEqual(["app.ts", "readme.md"]);
    });

    it("片方のディレクトリにのみ .gitignore がある場合", async () => {
      vol.fromJSON({
        "/local/.gitignore": "*.env",
        // /template には .gitignore がない
      });

      const ig = await loadMergedGitignore([absPath("/local"), absPath("/template")], []);

      expect(["app.ts", "config.env"].filter((f) => !ig.ignores(repoRelPath(f)))).toEqual([
        "app.ts",
      ]);
    });

    it("空の .gitignore ファイルを正しく処理する", async () => {
      vol.fromJSON({
        "/project/.gitignore": "",
      });

      const ig = await loadMergedGitignore([absPath("/project")], []);

      const files = ["file.txt", "secret.env"];
      expect(files.filter((f) => !ig.ignores(repoRelPath(f)))).toEqual(files);
    });

    it("コメント行のみの .gitignore を正しく処理する", async () => {
      vol.fromJSON({
        "/project/.gitignore": "# This is a comment\n# Another comment",
      });

      const ig = await loadMergedGitignore([absPath("/project")], []);

      const files = ["file.txt", "secret.env"];
      expect(files.filter((f) => !ig.ignores(repoRelPath(f)))).toEqual(files);
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

      expect(files.filter((f) => !ig.ignores(repoRelPath(f)))).toEqual([
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

      expect(ig.ignores(repoRelPath("error.log"))).toBe(true);
      expect(ig.ignores(repoRelPath(".devcontainer/config.local"))).toBe(true);
      // 接頭辞が付くので、同名のファイルでもサブディレクトリ外には適用されない
      expect(ig.ignores(repoRelPath("config.local"))).toBe(false);
    });

    it("否定パターンは ! の後ろに接頭辞が付く", async () => {
      vol.fromJSON({
        "/project/.claude/.gitignore": "*.local.md\n!keep.local.md",
      });

      const ig = await loadMergedGitignore([absPath("/project")], [".claude"]);

      expect(ig.ignores(repoRelPath(".claude/settings.local.md"))).toBe(true);
      expect(ig.ignores(repoRelPath(".claude/keep.local.md"))).toBe(false);
    });

    it("テンプレート側のネストした .gitignore も同じ規則で畳み込む", async () => {
      vol.fromJSON({
        "/template/.claude/.gitignore": "*.local.md",
      });

      const ig = await loadMergedGitignore([absPath("/local"), absPath("/template")], [".claude"]);

      expect(ig.ignores(repoRelPath(".claude/settings.local.md"))).toBe(true);
    });

    it("スラッシュを含まない規則はそのディレクトリ配下の全階層に当たる", async () => {
      vol.fromJSON({
        "/project/.claude/.gitignore": "*.pem",
      });

      const ig = await loadMergedGitignore([absPath("/project")], [".claude"]);

      expect(ig.ignores(repoRelPath(".claude/key.pem"))).toBe(true);
      expect(ig.ignores(repoRelPath(".claude/sub/deep/key.pem"))).toBe(true);
      // ディレクトリの外へは広がらない
      expect(ig.ignores(repoRelPath("key.pem"))).toBe(false);
    });

    it("スラッシュを含む規則はそのディレクトリ起点に固定される", async () => {
      vol.fromJSON({
        "/project/.claude/.gitignore": "sub/*.pem\n/root-only.key",
      });

      const ig = await loadMergedGitignore([absPath("/project")], [".claude"]);

      expect(ig.ignores(repoRelPath(".claude/sub/key.pem"))).toBe(true);
      expect(ig.ignores(repoRelPath(".claude/other/key.pem"))).toBe(false);
      expect(ig.ignores(repoRelPath(".claude/root-only.key"))).toBe(true);
      expect(ig.ignores(repoRelPath(".claude/sub/root-only.key"))).toBe(false);
    });

    it("ディレクトリ限定の規則も配下の全階層に当たる", async () => {
      vol.fromJSON({
        "/project/.claude/.gitignore": "cache/",
      });

      const ig = await loadMergedGitignore([absPath("/project")], [".claude"]);

      expect(ig.ignores(repoRelPath(".claude/cache/a.json"))).toBe(true);
      expect(ig.ignores(repoRelPath(".claude/sub/cache/a.json"))).toBe(true);
    });

    it("否定パターンも元の適用範囲を保つ", async () => {
      vol.fromJSON({
        "/project/.claude/.gitignore": "*.pem\n!keep.pem",
      });

      const ig = await loadMergedGitignore([absPath("/project")], [".claude"]);

      expect(ig.ignores(repoRelPath(".claude/sub/key.pem"))).toBe(true);
      expect(ig.ignores(repoRelPath(".claude/sub/keep.pem"))).toBe(false);
    });

    it("片方のリポジトリの否定規則が、もう片方の無視を打ち消さない", async () => {
      // 規則を 1 つの matcher へ連結すると gitignore の「後の規則が勝つ」順序が働き、
      // ローカルが無視すると決めた資格情報がテンプレート側の否定で同期対象へ戻る。
      vol.fromJSON({
        "/local/.gitignore": ".claude/secret.env",
        "/template/.claude/.gitignore": "!secret.env",
      });

      const ig = await loadMergedGitignore([absPath("/local"), absPath("/template")], [".claude"]);

      expect(ig.ignores(repoRelPath(".claude/secret.env"))).toBe(true);
    });

    it("同じリポジトリ内の否定規則は効く", async () => {
      vol.fromJSON({
        "/local/.gitignore": "*.env\n!keep.env",
      });

      const ig = await loadMergedGitignore([absPath("/local"), absPath("/template")], []);

      expect(ig.ignores(repoRelPath("secret.env"))).toBe(true);
      expect(ig.ignores(repoRelPath("keep.env"))).toBe(false);
    });

    it("ネストした .gitignore が無いディレクトリを渡しても動作する", async () => {
      vol.fromJSON({
        "/project/.gitignore": "*.log",
      });

      const ig = await loadMergedGitignore([absPath("/project")], [".claude", ".github"]);

      expect(ig.ignores(repoRelPath("error.log"))).toBe(true);
      expect(ig.ignores(repoRelPath(".claude/rules.md"))).toBe(false);
    });
  });
});
