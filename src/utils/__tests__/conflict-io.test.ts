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
import { absPath, repoRelPath, repoRelPaths } from "../../__tests__/brands";
import { joinAbs } from "../paths";
import type { FileMergeOutcome, MergeOneFileOutput } from "../merge";
import { mergeConflictFiles, mergeOneFile, readFileSafe, writeFileEnsureDir } from "../merge";
import type { AbsPath, LockState } from "../../modules/schemas";
import { createPendingLock } from "../../modules/schemas";
import { tmpdir } from "node:os";

/**
 * マージできた内容を取り出す。ベース不在（NoBase）には内容が無いので、
 * 内容を検証するテストがベース不在の結末をすり抜けないよう明示的に失敗させる。
 */
function mergedContentOf(outcome: FileMergeOutcome): string {
  if (outcome._tag === "NoBase") {
    throw new Error("expected a merge attempt, but the base was unavailable");
  }
  return outcome.content;
}

/** ベースツリーを取り直せない lock（ローカルテンプレート）。 */
function localSourceLock(templatePath: AbsPath): LockState {
  return createPendingLock({
    version: "0.1.0",
    installedAt: "2024-01-01T00:00:00.000Z",
    source: { kind: "local", path: templatePath },
  });
}

/** テストごとにユニークな一時ディレクトリを作成 */
async function createTempDir(label: string): Promise<AbsPath> {
  const dir = absPath(
    join(
      tmpdir(),
      `ziku-test-conflict-io-${label}-${Date.now()}-${Math.random().toString(36).slice(2)}`,
    ),
  );
  await mkdir(dir, { recursive: true });
  return dir;
}

/** ディレクトリ配下にファイルを配置するヘルパー */
async function writeFiles(baseDir: AbsPath, files: Record<string, string>): Promise<void> {
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
  const tempDirs: AbsPath[] = [];

  afterEach(async () => {
    // テスト後に一時ディレクトリをクリーンアップ
    for (const dir of tempDirs) {
      await rm(dir, { recursive: true, force: true });
    }
    tempDirs.length = 0;
  });

  async function temp(label: string): Promise<AbsPath> {
    const dir = await createTempDir(label);
    tempDirs.push(dir);
    return dir;
  }

  describe("readFileSafe", () => {
    it("存在するファイルの内容を返す", async () => {
      const dir = await temp("read-exists");
      await writeFile(join(dir, "test.txt"), "hello", "utf-8");

      const content = await Effect.runPromise(readFileSafe(joinAbs(dir, "test.txt")));
      expect(content).toBe("hello");
    });

    it("存在しないファイルに対して FileNotFoundError を返す", async () => {
      const dir = await temp("read-missing");
      const path = joinAbs(dir, "nonexistent.txt");

      const exit = await Effect.runPromiseExit(readFileSafe(path));
      expect(exit._tag).toBe("Failure");
    });

    it("存在しないディレクトリ配下のファイルに対して FileNotFoundError を返す", async () => {
      const dir = await temp("read-missing-dir");
      const path = joinAbs(dir, "nonexistent-dir", "file.txt");

      const exit = await Effect.runPromiseExit(readFileSafe(path));
      expect(exit._tag).toBe("Failure");
    });

    it("catchTag で FileNotFoundError をフォールバックできる", async () => {
      const dir = await temp("read-catchTag");
      const path = joinAbs(dir, "nonexistent.txt");

      const content = await Effect.runPromise(
        readFileSafe(path).pipe(
          Effect.catchTag("FileNotFoundError", () => Effect.succeed("fallback")),
        ),
      );
      expect(content).toBe("fallback");
    });
  });

  describe("writeFileEnsureDir", () => {
    it("既存ディレクトリにファイルを書き込む", async () => {
      const dir = await temp("write-existing");

      await Effect.runPromise(writeFileEnsureDir(joinAbs(dir, "test.txt"), "content"));

      const content = await readFile(join(dir, "test.txt"), "utf-8");
      expect(content).toBe("content");
    });

    it("存在しないネストされたディレクトリを自動作成してファイルを書き込む", async () => {
      const dir = await temp("write-nested");

      await Effect.runPromise(
        writeFileEnsureDir(joinAbs(dir, "a", "b", "c", "file.txt"), "deep content"),
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
        mergeOneFile({
          file: repoRelPath("config.json"),
          targetDir,
          templateDir,
          base: { kind: "with-base", dir: templateDir },
        }),
      );

      expect(result.outcome._tag).toBe("Clean");
      expect(mergedContentOf(result.outcome)).toBe('{"key": "value"}');
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
          file: repoRelPath("file.txt"),
          targetDir,
          templateDir,
          base: { kind: "with-base", dir: baseDir },
        }),
      );

      expect(result.outcome._tag).toBe("Clean");
      expect(mergedContentOf(result.outcome)).toContain("line1-local");
      expect(mergedContentOf(result.outcome)).toContain("line5-template");
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
          file: repoRelPath("file.txt"),
          targetDir,
          templateDir,
          base: { kind: "with-base", dir: baseDir },
        }),
      );

      expect(result.outcome._tag).toBe("Conflicted");
      expect(mergedContentOf(result.outcome)).toContain("<<<<<<< LOCAL");
      expect(mergedContentOf(result.outcome)).toContain("local-change");
      expect(mergedContentOf(result.outcome)).toContain("template-change");
      expect(mergedContentOf(result.outcome)).toContain(">>>>>>> TEMPLATE");
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
          file: repoRelPath(".claude/rules/worktree.md"),
          targetDir,
          templateDir,
          base: { kind: "with-base", dir: baseDir },
        }),
      );

      // local が空文字列 → delete/modify conflict としてマーカーが入る
      expect(result.outcome._tag).toBe("Conflicted");
      expect(result.file).toBe(".claude/rules/worktree.md");
      expect(mergedContentOf(result.outcome)).toContain("<<<<<<< LOCAL");
      expect(mergedContentOf(result.outcome)).toContain(">>>>>>> TEMPLATE");
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
          file: repoRelPath("deep/nested/file.md"),
          targetDir,
          templateDir,
          base: { kind: "with-base", dir: baseDir },
        }),
      );

      expect(result.outcome._tag).toBe("Conflicted");
      expect(result.file).toBe("deep/nested/file.md");
    });

    it("base を取得できない場合: 自動マージを試みず NoBase を返す（マーカー入りの内容を作らない）", async () => {
      const targetDir = await temp("merge-nobase-target");
      const templateDir = await temp("merge-nobase-template");

      await writeFiles(targetDir, { "settings.json": '{"local": true}' });
      await writeFiles(templateDir, { "settings.json": '{"template": true}' });

      const result = await Effect.runPromise(
        mergeOneFile({
          file: repoRelPath("settings.json"),
          targetDir,
          templateDir,
          base: { kind: "no-base" },
        }),
      );

      // 共通祖先が無いので 2-way でしか比較できない。空ベースで代用して全行を
      // 衝突させた「マージ結果」は作らず、試みなかったことを結末として返す。
      expect(result.outcome).toEqual({ _tag: "NoBase" });
      // ローカルのファイルは触られない
      expect(await readFile(join(targetDir, "settings.json"), "utf-8")).toBe('{"local": true}');
    });
  });

  describe("mergeConflictFiles", () => {
    it("base を取得できない lock では全ファイルを未解決として返す", async () => {
      const targetDir = await temp("loop-nobase-target");
      const templateDir = await temp("loop-nobase-template");

      await writeFiles(targetDir, { "a.txt": "local a", "b.txt": "local b" });
      await writeFiles(templateDir, { "a.txt": "template a", "b.txt": "template b" });

      const seen: MergeOneFileOutput[] = [];
      const unresolved = await Effect.runPromise(
        mergeConflictFiles({
          conflicts: repoRelPaths(["a.txt", "b.txt"]),
          targetDir,
          templateDir,
          lock: localSourceLock(templateDir),
          onFileResult: (result) => Effect.sync(() => void seen.push(result)),
        }),
      );

      // 経路まで残す: ベース不在は「ローカルに何も書いていない」ので、再開時に
      // マーカーの有無で解決を判定できない側になる。
      expect(unresolved).toEqual([
        { path: "a.txt", reason: "noBase" },
        { path: "b.txt", reason: "noBase" },
      ]);
      expect(seen.map((r) => r.outcome)).toEqual([{ _tag: "NoBase" }, { _tag: "NoBase" }]);
    });

    it("base 不在時の未解決判定はハンドラの内容に依らない（pull と push が同じ集合を受け取る）", async () => {
      const targetDir = await temp("loop-same-target");
      const templateDir = await temp("loop-same-template");

      await writeFiles(targetDir, { "a.txt": "local a" });
      await writeFiles(templateDir, { "a.txt": "template a" });

      const lock = localSourceLock(templateDir);
      // pull 相当: 結果をローカルへ書き戻そうとするハンドラ
      const writtenByPull: string[] = [];
      const pullUnresolved = await Effect.runPromise(
        mergeConflictFiles({
          conflicts: repoRelPaths(["a.txt"]),
          targetDir,
          templateDir,
          lock,
          onFileResult: ({ file, outcome }) =>
            Effect.sync(() => {
              if (outcome._tag !== "NoBase") writtenByPull.push(file);
            }),
        }),
      );

      // push 相当: クリーンな結果だけをメモリへ保持するハンドラ
      const keptByPush = new Map<string, string>();
      const pushUnresolved = await Effect.runPromise(
        mergeConflictFiles({
          conflicts: repoRelPaths(["a.txt"]),
          targetDir,
          templateDir,
          lock,
          onFileResult: ({ file, outcome }) =>
            Effect.sync(() => {
              if (outcome._tag === "Clean") keptByPush.set(file, outcome.content);
            }),
        }),
      );

      expect(pullUnresolved).toEqual(pushUnresolved);
      expect(pullUnresolved).toEqual([{ path: "a.txt", reason: "noBase" }]);
      // どちらの側にもマージ結果は渡らない
      expect(writtenByPull).toEqual([]);
      expect(keptByPush.size).toBe(0);
    });

    it("バイナリファイルはマージを試みず未解決になる", async () => {
      const targetDir = await temp("loop-binary-target");
      const templateDir = await temp("loop-binary-template");

      // PNG のシグネチャ。NUL を含むのでバイナリと判定される
      const localBytes = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x00, 0x01]);
      const templateBytes = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x00, 0x02]);
      await writeFile(join(targetDir, "icon.png"), localBytes);
      await writeFile(join(templateDir, "icon.png"), templateBytes);
      await writeFiles(targetDir, { "a.txt": "local a" });
      await writeFiles(templateDir, { "a.txt": "template a" });

      const seen: MergeOneFileOutput[] = [];
      const unresolved = await Effect.runPromise(
        mergeConflictFiles({
          conflicts: repoRelPaths(["icon.png", "a.txt"]),
          targetDir,
          templateDir,
          lock: localSourceLock(templateDir),
          onFileResult: (result) => Effect.sync(() => void seen.push(result)),
        }),
      );

      expect(unresolved).toEqual([
        { path: "icon.png", reason: "binary" },
        { path: "a.txt", reason: "noBase" },
      ]);
      // バイナリはマージ経路に入らないので結末が作られない（テキストは NoBase として渡る）
      expect(seen.map((r) => r.file)).toEqual(["a.txt"]);
      // ローカルのバイト列は 1 バイトも変わらない
      const afterMerge = await readFile(join(targetDir, "icon.png"));
      expect(afterMerge.equals(localBytes)).toBe(true);
    });

    it("対象が空なら base を取得せずに空配列を返す", async () => {
      const targetDir = await temp("loop-empty-target");
      const templateDir = await temp("loop-empty-template");

      const onFileResult = (): Effect.Effect<void> =>
        Effect.sync(() => {
          throw new Error("onFileResult should not be called");
        });

      const unresolved = await Effect.runPromise(
        mergeConflictFiles({
          conflicts: [],
          targetDir,
          templateDir,
          lock: localSourceLock(templateDir),
          onFileResult,
        }),
      );

      expect(unresolved).toEqual([]);
    });
  });
});
