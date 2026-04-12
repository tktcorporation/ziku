/**
 * conflict-io の統合テスト — 実ファイル I/O で検証
 *
 * モックを使わず、実際の一時ディレクトリ上でファイルの読み書き・マージを行い、
 * delete/modify conflict 等のエッジケースが正しく動作することを確認する。
 */
import { existsSync } from "node:fs";
import { mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { Effect } from "effect";
import { join } from "pathe";
import { afterEach, describe, expect, it } from "vitest";
import { mergeOneFile, readFileOrEmpty, writeFileEnsureDir } from "../merge";
import { tmpdir } from "node:os";

/** テストごとにユニークな一時ディレクトリを作成 */
async function createTempDir(label: string): Promise<string> {
  const dir = join(
    tmpdir(),
    `ziku-test-conflict-io-${label}-${Date.now()}-${Math.random().toString(36).slice(2)}`,
  );
  await mkdir(dir, { recursive: true });
  return dir;
}

/** ディレクトリ配下にファイルを配置するヘルパー */
async function writeFiles(baseDir: string, files: Record<string, string>): Promise<void> {
  for (const [relativePath, content] of Object.entries(files)) {
    const fullPath = join(baseDir, relativePath);
    const dir = join(fullPath, "..");
    if (!existsSync(dir)) {
      await mkdir(dir, { recursive: true });
    }
    await writeFile(fullPath, content, "utf-8");
  }
}

describe("conflict-io", () => {
  const tempDirs: string[] = [];

  afterEach(async () => {
    // テスト後に一時ディレクトリをクリーンアップ
    for (const dir of tempDirs) {
      await rm(dir, { recursive: true, force: true });
    }
    tempDirs.length = 0;
  });

  async function temp(label: string): Promise<string> {
    const dir = await createTempDir(label);
    tempDirs.push(dir);
    return dir;
  }

  describe("readFileOrEmpty", () => {
    it("存在するファイルの内容を返す", async () => {
      const dir = await temp("read-exists");
      await writeFile(join(dir, "test.txt"), "hello", "utf-8");

      const content = await Effect.runPromise(readFileOrEmpty(join(dir, "test.txt")));
      expect(content).toBe("hello");
    });

    it("存在しないファイルに対して空文字列を返す（ENOENT にならない）", async () => {
      const dir = await temp("read-missing");

      const content = await Effect.runPromise(readFileOrEmpty(join(dir, "nonexistent.txt")));
      expect(content).toBe("");
    });

    it("存在しないディレクトリ配下のファイルに対して空文字列を返す", async () => {
      const dir = await temp("read-missing-dir");

      const content = await Effect.runPromise(
        readFileOrEmpty(join(dir, "nonexistent-dir", "file.txt")),
      );
      expect(content).toBe("");
    });
  });

  describe("writeFileEnsureDir", () => {
    it("既存ディレクトリにファイルを書き込む", async () => {
      const dir = await temp("write-existing");

      await Effect.runPromise(writeFileEnsureDir(join(dir, "test.txt"), "content"));

      const content = await readFile(join(dir, "test.txt"), "utf-8");
      expect(content).toBe("content");
    });

    it("存在しないネストされたディレクトリを自動作成してファイルを書き込む", async () => {
      const dir = await temp("write-nested");

      await Effect.runPromise(
        writeFileEnsureDir(join(dir, "a", "b", "c", "file.txt"), "deep content"),
      );

      expect(existsSync(join(dir, "a", "b", "c"))).toBe(true);
      const content = await readFile(join(dir, "a", "b", "c", "file.txt"), "utf-8");
      expect(content).toBe("deep content");
    });
  });

  describe("mergeOneFile", () => {
    it("ローカルとテンプレートが同一なら自動マージ成功", async () => {
      const targetDir = await temp("merge-same-target");
      const templateDir = await temp("merge-same-template");

      await writeFiles(targetDir, { "config.json": '{"key": "value"}' });
      await writeFiles(templateDir, { "config.json": '{"key": "value"}' });

      const result = await Effect.runPromise(
        mergeOneFile({ file: "config.json", targetDir, templateDir }),
      );

      expect(result.hasConflicts).toBe(false);
      expect(result.content).toBe('{"key": "value"}');
      expect(result.file).toBe("config.json");
    });

    it("3-way マージ: ローカルとテンプレートの両方が変更、コンフリクトなし", async () => {
      const targetDir = await temp("merge-3way-target");
      const templateDir = await temp("merge-3way-template");
      const baseDir = await temp("merge-3way-base");

      // node-diff3 は隣接行の変更をコンフリクトと見なすため、
      // 変更箇所を十分に離す（間にコンテキスト行を挟む）
      const base = "line1\nline2\nline3\nline4\nline5\n";
      await writeFiles(baseDir, { "file.txt": base });
      // local: 行1を変更
      await writeFiles(targetDir, { "file.txt": "line1-local\nline2\nline3\nline4\nline5\n" });
      // template: 行5を変更
      await writeFiles(templateDir, { "file.txt": "line1\nline2\nline3\nline4\nline5-template\n" });

      const result = await Effect.runPromise(
        mergeOneFile({
          file: "file.txt",
          targetDir,
          templateDir,
          baseTemplateDir: baseDir,
        }),
      );

      expect(result.hasConflicts).toBe(false);
      expect(result.content).toContain("line1-local");
      expect(result.content).toContain("line5-template");
    });

    it("3-way マージ: 同じ行を両方が変更 → コンフリクトマーカー", async () => {
      const targetDir = await temp("merge-conflict-target");
      const templateDir = await temp("merge-conflict-template");
      const baseDir = await temp("merge-conflict-base");

      await writeFiles(baseDir, { "file.txt": "original\n" });
      await writeFiles(targetDir, { "file.txt": "local-change\n" });
      await writeFiles(templateDir, { "file.txt": "template-change\n" });

      const result = await Effect.runPromise(
        mergeOneFile({
          file: "file.txt",
          targetDir,
          templateDir,
          baseTemplateDir: baseDir,
        }),
      );

      expect(result.hasConflicts).toBe(true);
      expect(result.content).toContain("<<<<<<< LOCAL");
      expect(result.content).toContain("local-change");
      expect(result.content).toContain("template-change");
      expect(result.content).toContain(">>>>>>> TEMPLATE");
    });

    it("delete/modify conflict: ローカルにファイルが存在しなくても ENOENT にならない", async () => {
      const targetDir = await temp("merge-delete-target");
      const templateDir = await temp("merge-delete-template");
      const baseDir = await temp("merge-delete-base");

      // ローカルにはファイルが存在しない（削除済み）
      await writeFiles(baseDir, { ".claude/rules/worktree.md": "base content\n" });
      await writeFiles(templateDir, { ".claude/rules/worktree.md": "updated template content\n" });
      // targetDir には .claude/rules/worktree.md を作らない

      const result = await Effect.runPromise(
        mergeOneFile({
          file: ".claude/rules/worktree.md",
          targetDir,
          templateDir,
          baseTemplateDir: baseDir,
        }),
      );

      // local が空文字列 → delete/modify conflict としてマーカーが入る
      expect(result.hasConflicts).toBe(true);
      expect(result.file).toBe(".claude/rules/worktree.md");
      expect(result.content).toContain("<<<<<<< LOCAL");
      expect(result.content).toContain(">>>>>>> TEMPLATE");
    });

    it("delete/modify conflict: ローカルにファイルもディレクトリも存在しなくても動作する", async () => {
      const targetDir = await temp("merge-delete-nodir-target");
      const templateDir = await temp("merge-delete-nodir-template");
      const baseDir = await temp("merge-delete-nodir-base");

      await writeFiles(baseDir, { "deep/nested/file.md": "base\n" });
      await writeFiles(templateDir, { "deep/nested/file.md": "updated\n" });
      // targetDir には deep/ ディレクトリ自体がない

      const result = await Effect.runPromise(
        mergeOneFile({
          file: "deep/nested/file.md",
          targetDir,
          templateDir,
          baseTemplateDir: baseDir,
        }),
      );

      expect(result.hasConflicts).toBe(true);
      expect(result.file).toBe("deep/nested/file.md");
    });

    it("base がない場合（初回 pull）: ローカルとテンプレートが異なれば conflict", async () => {
      const targetDir = await temp("merge-nobase-target");
      const templateDir = await temp("merge-nobase-template");

      await writeFiles(targetDir, { "settings.json": '{"local": true}' });
      await writeFiles(templateDir, { "settings.json": '{"template": true}' });
      // baseTemplateDir を渡さない

      const result = await Effect.runPromise(
        mergeOneFile({ file: "settings.json", targetDir, templateDir }),
      );

      // base が空 → 全内容が「両方から追加された」扱い → conflict
      expect(result.hasConflicts).toBe(true);
      expect(result.content).toContain("<<<<<<< LOCAL");
    });
  });
});
