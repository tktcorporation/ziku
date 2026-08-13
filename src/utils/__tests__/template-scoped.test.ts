import { vol } from "memfs";
import { Effect, Exit, Scope } from "effect";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("node:fs", async () => {
  const memfs = await import("memfs");
  return memfs.fs;
});

// giget の downloadTemplate をモック: tempDir に空ファイルを作って成功扱い
vi.mock("giget", () => ({
  downloadTemplate: vi.fn(async (_source: string, opts: { dir: string }) => {
    const { mkdirSync, writeFileSync } = await import("node:fs");
    mkdirSync(opts.dir, { recursive: true });
    writeFileSync(`${opts.dir}/dummy.txt`, "hi");
    return { dir: opts.dir };
  }),
}));

const { absPath } = await import("../../__tests__/brands");
const { acquireTempTemplate } = await import("../template");
const { _resetForTest, _getTrackedCountForTest } = await import("../temp-tracker");
const giget = await import("giget");

describe("acquireTempTemplate (Scope ベースのリソース管理)", () => {
  beforeEach(() => {
    vol.reset();
    _resetForTest();
    vi.clearAllMocks();
  });

  afterEach(() => {
    _resetForTest();
  });

  it("Scope 終了で temp dir が削除され、tracker からも除外される", async () => {
    const program = Effect.gen(function* () {
      const dir = yield* acquireTempTemplate(absPath("/work"), "gh:foo/bar");
      // Scope 内: dir が存在する
      expect(vol.existsSync(dir)).toBe(true);
      expect(_getTrackedCountForTest()).toBe(1);
      return dir;
    });

    const dir = await Effect.runPromise(Effect.scoped(program));

    // Scope 外: 削除済み + unregister 済み
    expect(vol.existsSync(dir)).toBe(false);
    expect(_getTrackedCountForTest()).toBe(0);
  });

  it("Scope 内で失敗しても finalizer が走って temp dir が削除される", async () => {
    const program = Effect.gen(function* () {
      const dir = yield* acquireTempTemplate(absPath("/work"), "gh:foo/bar");
      expect(vol.existsSync(dir)).toBe(true);
      // 中で失敗
      return yield* Effect.fail("boom" as const);
    });

    const exit = await Effect.runPromiseExit(Effect.scoped(program));
    expect(Exit.isFailure(exit)).toBe(true);

    // 失敗しても削除される
    expect(vol.existsSync("/work/.ziku-temp")).toBe(false);
    expect(_getTrackedCountForTest()).toBe(0);
  });

  it("downloadTemplate 失敗時も finalizer で tracker 登録が解除される", async () => {
    vi.mocked(giget.downloadTemplate).mockRejectedValueOnce(new Error("network"));

    const program = acquireTempTemplate(absPath("/work"), "gh:foo/bar");
    const exit = await Effect.runPromiseExit(Effect.scoped(program));

    expect(Exit.isFailure(exit)).toBe(true);
    expect(_getTrackedCountForTest()).toBe(0);
  });

  it("手動 Scope + Effect.onError パターンで失敗時に tracker から外れる (command-context の保証)", async () => {
    // command-context.loadCommandContext と同じパターンを再現:
    //   const scope = yield* Scope.make();
    //   const dir = yield* acquireTempTemplate(...).pipe(
    //     Scope.extend(scope),
    //     Effect.onError(() => Scope.close(scope, Exit.void)),
    //   );
    // resolveTemplateDirScoped が失敗したとき、onError がない場合は
    // scope が閉じられず tracker に残る (Codex review #74 の指摘)。
    vi.mocked(giget.downloadTemplate).mockRejectedValueOnce(new Error("network"));

    const program = Effect.gen(function* () {
      const scope = yield* Scope.make();
      const dir = yield* acquireTempTemplate(absPath("/work"), "gh:foo/bar").pipe(
        Scope.extend(scope),
        Effect.onError(() => Scope.close(scope, Exit.void)),
      );
      return dir;
    });

    const exit = await Effect.runPromiseExit(program);
    expect(Exit.isFailure(exit)).toBe(true);
    // onError がないと count は 1 のまま残る。
    expect(_getTrackedCountForTest()).toBe(0);
  });

  it("downloadTemplateToTemp: download 失敗時に tracker から登録解除される (codex review #74)", async () => {
    const { downloadTemplateToTemp } = await import("../template");
    vi.mocked(giget.downloadTemplate).mockRejectedValueOnce(new Error("network"));

    await expect(downloadTemplateToTemp(absPath("/work"), "gh:foo/bar")).rejects.toThrow("network");
    // 失敗パスでも tracker から外れていること
    expect(_getTrackedCountForTest()).toBe(0);
  });

  it("fetchTemplates: download 失敗時に tracker から登録解除される (codex review #74)", async () => {
    const { fetchTemplates } = await import("../template");
    vi.mocked(giget.downloadTemplate).mockRejectedValueOnce(new Error("network"));

    await expect(
      fetchTemplates({
        targetDir: absPath("/work"),
        overwriteStrategy: "skip",
        patterns: { include: [], exclude: [] },
      }),
    ).rejects.toThrow("network");
    expect(_getTrackedCountForTest()).toBe(0);
  });

  it("label を付けると別ディレクトリに展開される", async () => {
    const program = Effect.gen(function* () {
      const a = yield* acquireTempTemplate(absPath("/work"), "gh:foo/bar");
      const b = yield* acquireTempTemplate(absPath("/work"), "gh:foo/bar", "base");
      expect(a).not.toBe(b);
      expect(a.endsWith("/.ziku-temp")).toBe(true);
      expect(b.endsWith("/.ziku-temp-base")).toBe(true);
      expect(_getTrackedCountForTest()).toBe(2);
    });

    await Effect.runPromise(Effect.scoped(program));
    expect(_getTrackedCountForTest()).toBe(0);
  });
});
