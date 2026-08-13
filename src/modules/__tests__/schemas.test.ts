import { describe, expect, it } from "vitest";
import {
  absPath,
  commitSha,
  contentHash,
  globPattern,
  hashMap,
  repoRelPath,
} from "../../__tests__/brands";
import type { FileDiff, LockState, SyncPoint } from "../schemas";
import {
  diffResultSchema,
  diffTypeSchema,
  fileActionSchema,
  fileDiffSchema,
  fileOperationResultSchema,
  lockSchema,
  overwriteStrategySchema,
  prResultSchema,
  zikuConfigSchema,
  templateRefSchema,
  templateRefToString,
  templateSourceSchema,
  createPendingLock,
  markMerging,
  markSynced,
  resolveMerge,
  baseCommitSha,
  baseHashesOf,
  summarizeDiff,
} from "../schemas";

describe("overwriteStrategySchema", () => {
  it("overwrite を受け入れる", () => {
    expect(overwriteStrategySchema.parse("overwrite")).toBe("overwrite");
  });

  it("skip を受け入れる", () => {
    expect(overwriteStrategySchema.parse("skip")).toBe("skip");
  });

  it("prompt を受け入れる", () => {
    expect(overwriteStrategySchema.parse("prompt")).toBe("prompt");
  });

  it("無効な値を拒否する", () => {
    expect(() => overwriteStrategySchema.parse("invalid")).toThrow();
  });
});

describe("fileActionSchema", () => {
  it("全てのアクションタイプを受け入れる", () => {
    expect(fileActionSchema.parse("copied")).toBe("copied");
    expect(fileActionSchema.parse("created")).toBe("created");
    expect(fileActionSchema.parse("overwritten")).toBe("overwritten");
    expect(fileActionSchema.parse("skipped")).toBe("skipped");
  });

  it("無効な値を拒否する", () => {
    expect(() => fileActionSchema.parse("deleted")).toThrow();
  });
});

describe("fileOperationResultSchema", () => {
  it("有効な操作結果を受け入れる", () => {
    const result = { action: "copied", path: "file.txt" };
    expect(fileOperationResultSchema.parse(result)).toEqual(result);
  });

  it("action が欠けている場合は拒否する", () => {
    expect(() => fileOperationResultSchema.parse({ path: "file.txt" })).toThrow();
  });

  it("path が欠けている場合は拒否する", () => {
    expect(() => fileOperationResultSchema.parse({ action: "copied" })).toThrow();
  });
});

describe("zikuConfigSchema", () => {
  it("有効な設定を受け入れる（include のみ）", () => {
    const config = {
      include: [".mcp.json", ".devcontainer/**"],
    };
    expect(zikuConfigSchema.parse(config)).toEqual(config);
  });

  it("$schema フィールドを受け入れる", () => {
    const config = {
      $schema: "https://example.com/schema.json",
      include: [".mcp.json"],
    };
    expect(zikuConfigSchema.parse(config)).toEqual(config);
  });

  it("exclude フィールドを受け入れる", () => {
    const config = {
      include: [".mcp.json"],
      exclude: ["*.local"],
    };
    expect(zikuConfigSchema.parse(config)).toEqual(config);
  });

  it("include が欠けている場合は拒否する", () => {
    expect(() => zikuConfigSchema.parse({ exclude: [] })).toThrow();
  });

  it("空の include 配列を受け入れる", () => {
    const config = { include: [] };
    expect(zikuConfigSchema.parse(config)).toEqual(config);
  });
});

describe("templateRefSchema", () => {
  it("ブランチ / タグ / コミットの各 ref を受け入れる", () => {
    expect(templateRefSchema.parse({ kind: "branch", name: "main" })).toEqual({
      kind: "branch",
      name: "main",
    });
    expect(templateRefSchema.parse({ kind: "tag", name: "v1.0.0" })).toEqual({
      kind: "tag",
      name: "v1.0.0",
    });
    expect(templateRefSchema.parse({ kind: "commit", sha: "abc123" })).toEqual({
      kind: "commit",
      sha: "abc123",
    });
  });

  it("判別タグの無い ref は拒否する", () => {
    expect(() => templateRefSchema.parse({ name: "main" })).toThrow();
  });
});

describe("templateRefToString", () => {
  it("種別によらず giget の #<ref> に載る文字列へ落とす", () => {
    expect(templateRefToString({ kind: "branch", name: "main" })).toBe("main");
    expect(templateRefToString({ kind: "tag", name: "v1.0.0" })).toBe("v1.0.0");
    expect(templateRefToString({ kind: "commit", sha: commitSha("abc123") })).toBe("abc123");
  });
});

describe("templateSourceSchema", () => {
  it("GitHub ソースを受け入れる", () => {
    const source = { kind: "github", owner: "tktcorporation", repo: ".github" };
    expect(templateSourceSchema.parse(source)).toEqual(source);
  });

  it("ローカルソースを受け入れる", () => {
    const source = { kind: "local", path: "/path/to/template" };
    expect(templateSourceSchema.parse(source)).toEqual(source);
  });

  it("判別タグの無い source は拒否する", () => {
    expect(() => templateSourceSchema.parse({ owner: "o", repo: "r" })).toThrow();
  });
});

describe("lockSchema", () => {
  const identity = {
    version: "0.1.0",
    installedAt: "2024-01-01T00:00:00+09:00",
  };
  const githubSource = { kind: "github", owner: "tktcorporation", repo: ".github" };
  const localSource = { kind: "local", path: "/path/to/template" };

  it("ベース未確定 (sync: pending) を受け入れる", () => {
    const lock = { ...identity, source: githubSource, sync: "pending" };
    expect(lockSchema.parse(lock)).toEqual(lock);
  });

  it("ref 付きの GitHub ソースを受け入れる", () => {
    const lock = {
      ...identity,
      source: { ...githubSource, ref: { kind: "branch", name: "main" } },
      sync: "pending",
    };
    expect(lockSchema.parse(lock)).toEqual(lock);
  });

  it("ローカルソースを受け入れる", () => {
    const lock = { ...identity, source: localSource, sync: "pending" };
    expect(lockSchema.parse(lock)).toEqual(lock);
  });

  it("GitHub ソースのベースはコミット SHA を持てる", () => {
    const lock = {
      ...identity,
      source: githubSource,
      sync: "synced",
      base: { hashes: { ".mcp.json": "abc123" }, ref: "def456" },
    };
    expect(lockSchema.parse(lock)).toEqual(lock);
  });

  it("ローカルソースのベースにコミット SHA がある lock は拒否する", () => {
    expect(() =>
      lockSchema.parse({
        ...identity,
        source: localSource,
        sync: "synced",
        base: { hashes: {}, ref: "def456" },
      }),
    ).toThrow();
  });

  it("コンフリクト解決待ち (sync: merging) を受け入れる", () => {
    const lock = {
      ...identity,
      source: githubSource,
      sync: "merging",
      base: { hashes: {} },
      merge: {
        conflicts: [".mcp.json"],
        nextBase: { hashes: { ".mcp.json": "abc123" }, ref: "def456" },
      },
    };
    expect(lockSchema.parse(lock)).toEqual(lock);
  });

  it("解決待ちのコンフリクトが空配列の lock は拒否する", () => {
    expect(() =>
      lockSchema.parse({
        ...identity,
        source: githubSource,
        sync: "merging",
        base: { hashes: {} },
        merge: { conflicts: [], nextBase: { hashes: {} } },
      }),
    ).toThrow();
  });

  it("ベース確定済みなのに base が無い lock は拒否する", () => {
    expect(() => lockSchema.parse({ ...identity, source: githubSource, sync: "synced" })).toThrow();
  });

  it("source が欠けている場合は拒否する", () => {
    expect(() => lockSchema.parse({ ...identity, sync: "pending" })).toThrow();
  });

  it("sync が欠けている場合は拒否する", () => {
    expect(() => lockSchema.parse({ ...identity, source: githubSource })).toThrow();
  });

  it("不正な datetime 形式を拒否する", () => {
    expect(() =>
      lockSchema.parse({
        version: "0.1.0",
        installedAt: "invalid-date",
        source: githubSource,
        sync: "pending",
      }),
    ).toThrow();
  });

  it("ISO 8601 形式の datetime を受け入れる", () => {
    const lock = {
      version: "0.1.0",
      installedAt: "2024-06-15T10:30:00Z",
      source: githubSource,
      sync: "pending",
    };
    expect(lockSchema.parse(lock)).toEqual(lock);
  });
});

describe("lock の状態遷移", () => {
  const githubLock = createPendingLock({
    version: "0.1.0",
    installedAt: "2024-01-01T00:00:00+09:00",
    source: { kind: "github", owner: "o", repo: "r" },
  });
  const localLock = createPendingLock({
    version: "0.1.0",
    installedAt: "2024-01-01T00:00:00+09:00",
    source: { kind: "local", path: absPath("/tpl") },
  });

  it("markSynced: GitHub ソースにはコミット SHA が載る", () => {
    const synced = markSynced(githubLock, {
      hashes: hashMap({ "a.txt": "h" }),
      commitSha: commitSha("sha1"),
    });
    expect(synced).toEqual({
      ...githubLock,
      sync: "synced",
      base: { hashes: { "a.txt": "h" }, ref: "sha1" },
    });
    expect(baseCommitSha(synced)).toBe("sha1");
  });

  it("markSynced: ローカルソースではコミット SHA が捨てられる", () => {
    // ローカルソースの lock に commitSha を渡しても、lock の型がそれを保持できない。
    // `base: { hashes, ref }` を持つローカル lock はコンパイルできないため、
    // ここで確認しているのは「渡しても落ちる」という遷移関数側の振る舞い。
    const synced = markSynced(localLock, {
      hashes: hashMap({ "a.txt": "h" }),
      commitSha: commitSha("sha1"),
    });
    expect(synced).toEqual({ ...localLock, sync: "synced", base: { hashes: { "a.txt": "h" } } });
    expect(baseCommitSha(synced)).toBeUndefined();
  });

  it("baseHashesOf: ベース未確定なら空写像", () => {
    expect(baseHashesOf(githubLock)).toEqual({});
  });

  it("markMerging: ベース未確定から入ると空のベースを記録する", () => {
    const merging = markMerging(githubLock, { hashes: hashMap({ "a.txt": "h" }) }, [
      repoRelPath("a.txt"),
    ]);
    expect(merging).toEqual({
      ...githubLock,
      sync: "merging",
      base: { hashes: {} },
      merge: { conflicts: ["a.txt"], nextBase: { hashes: { "a.txt": "h" } } },
    });
  });

  it("markMerging: ベース確定済みから入ると直前のベースを残す", () => {
    const synced = markSynced(githubLock, {
      hashes: hashMap({ "a.txt": "old" }),
      commitSha: commitSha("sha0"),
    });
    const merging = markMerging(
      synced,
      { hashes: hashMap({ "a.txt": "new" }), commitSha: commitSha("sha1") },
      [repoRelPath("a.txt")],
    );
    expect(merging).toMatchObject({
      sync: "merging",
      base: { hashes: { "a.txt": "old" }, ref: "sha0" },
      merge: { nextBase: { hashes: { "a.txt": "new" }, ref: "sha1" } },
    });
  });

  it("型: ローカルソースの lock はコミット SHA を持てない", () => {
    // ローカルソースにはベースツリーを取り直す手段が無いため、SHA を記録しても
    // 参照側が黙って無視するだけになる。この組み合わせが「コンパイルできない」ことが
    // 型の役目なので、@ts-expect-error が外れたら（= 書けるようになったら）
    // typecheck が失敗して気付ける。
    // @ts-expect-error ローカルソースの同期ベースは ref を持てない
    const invalid: LockState = {
      version: "0.1.0",
      installedAt: "2024-01-01T00:00:00+09:00",
      source: { kind: "local", path: absPath("/tpl") },
      sync: "synced",
      base: { hashes: {}, ref: commitSha("sha1") },
    };
    // 実行時の検証でも同じ組み合わせは弾かれる。
    expect(() => lockSchema.parse(invalid)).toThrow();
  });

  it("resolveMerge: nextBase をベースに確定して merge を消す", () => {
    const merging = markMerging(
      githubLock,
      { hashes: hashMap({ "a.txt": "h" }), commitSha: commitSha("sha1") },
      [repoRelPath("a.txt")],
    );
    if (merging.sync !== "merging") throw new Error("expected merging lock");
    const resolved = resolveMerge(merging);
    expect(resolved).toEqual({
      ...githubLock,
      sync: "synced",
      base: { hashes: { "a.txt": "h" }, ref: "sha1" },
    });
    expect(resolved).not.toHaveProperty("merge");
  });
});

describe("diffTypeSchema", () => {
  it("全ての差分タイプを受け入れる", () => {
    expect(diffTypeSchema.parse("added")).toBe("added");
    expect(diffTypeSchema.parse("modified")).toBe("modified");
    expect(diffTypeSchema.parse("deleted")).toBe("deleted");
    expect(diffTypeSchema.parse("unchanged")).toBe("unchanged");
  });

  it("無効な値を拒否する", () => {
    expect(() => diffTypeSchema.parse("changed")).toThrow();
  });
});

describe("fileDiffSchema", () => {
  it("modified は両側の内容を持つ", () => {
    const diff = {
      path: "file.txt",
      type: "modified",
      localContent: "local",
      templateContent: "template",
    };
    expect(fileDiffSchema.parse(diff)).toEqual(diff);
  });

  it("unchanged は両側の内容を持つ", () => {
    const diff = {
      path: "file.txt",
      type: "unchanged",
      localContent: "same",
      templateContent: "same",
    };
    expect(fileDiffSchema.parse(diff)).toEqual(diff);
  });

  it("deleted はテンプレート側の内容だけを持つ", () => {
    const diff = {
      path: "file.txt",
      type: "deleted",
      templateContent: "template",
    };
    expect(fileDiffSchema.parse(diff)).toEqual(diff);
  });

  it("added はローカル側の内容だけを持つ", () => {
    const diff = {
      path: "file.txt",
      type: "added",
      localContent: "local",
    };
    expect(fileDiffSchema.parse(diff)).toEqual(diff);
  });

  it("種別に対応する内容を欠いた差分は弾かれる", () => {
    // 内容の欠損は下流の `?? ""` で空文字列に化け、「中身が空のファイル」と
    // 区別できなくなる。検証段階で弾いて、その値が下流へ届かないようにする。
    expect(() => fileDiffSchema.parse({ path: "file.txt", type: "added" })).toThrow();
    expect(() => fileDiffSchema.parse({ path: "file.txt", type: "deleted" })).toThrow();
    expect(() =>
      fileDiffSchema.parse({ path: "file.txt", type: "modified", localContent: "local" }),
    ).toThrow();
    expect(() =>
      fileDiffSchema.parse({ path: "file.txt", type: "unchanged", templateContent: "t" }),
    ).toThrow();
  });

  it("型: 種別が持たない側の内容は読めない", () => {
    const added: FileDiff = { path: repoRelPath("file.txt"), type: "added", localContent: "local" };
    const deleted: FileDiff = {
      path: repoRelPath("file.txt"),
      type: "deleted",
      templateContent: "template",
    };

    // 存在しない内容へのアクセスがコンパイルエラーになることが型の役目。読めるように
    // なったら下の抑制コメントが不要になり、typecheck が失敗して気付ける。
    // @ts-expect-error added はテンプレート側の内容を持たない
    expect(added.templateContent).toBeUndefined();
    // @ts-expect-error deleted はローカル側の内容を持たない
    expect(deleted.localContent).toBeUndefined();
  });

  it("型: 種別が持たない側の内容は書けない", () => {
    const invalid: FileDiff = {
      path: repoRelPath("file.txt"),
      type: "added",
      localContent: "local",
      // @ts-expect-error added はテンプレート側の内容を持てない
      templateContent: "template",
    };
    // 実行時の検証でも余分な内容は落ちる。
    expect(fileDiffSchema.parse(invalid)).toEqual({
      path: "file.txt",
      type: "added",
      localContent: "local",
    });
  });

  it("型: 種別に対応する内容を欠いた差分は書けない", () => {
    // @ts-expect-error modified は両側の内容が要る
    const invalid: FileDiff = { path: "file.txt", type: "modified", localContent: "local" };
    expect(() => fileDiffSchema.parse(invalid)).toThrow();
  });
});

describe("diffResultSchema", () => {
  it("有効な差分結果を受け入れる", () => {
    const result = {
      files: [
        { path: "file.txt", type: "modified", localContent: "l", templateContent: "t" },
        { path: "new.txt", type: "added", localContent: "n" },
      ],
    };
    expect(diffResultSchema.parse(result)).toEqual(result);
  });

  it("空のファイル配列を受け入れる", () => {
    const result = { files: [] };
    expect(diffResultSchema.parse(result)).toEqual(result);
  });

  it("集計値は差分結果に載らない", () => {
    // 集計は files から導出する派生値。載せると絞り込んだ files と食い違う値を
    // 持ち回れてしまうため、検証段階で落とす。
    const parsed = diffResultSchema.parse({
      files: [],
      summary: { added: 1, modified: 0, deleted: 0, unchanged: 0 },
    });
    expect(parsed).not.toHaveProperty("summary");
  });
});

describe("summarizeDiff", () => {
  const files: FileDiff[] = [
    { path: repoRelPath("a.txt"), type: "added", localContent: "a" },
    { path: repoRelPath("b.txt"), type: "added", localContent: "b" },
    { path: repoRelPath("c.txt"), type: "modified", localContent: "c", templateContent: "C" },
    { path: repoRelPath("d.txt"), type: "deleted", templateContent: "d" },
    { path: repoRelPath("e.txt"), type: "unchanged", localContent: "e", templateContent: "e" },
  ];

  it("種別ごとの件数を数える", () => {
    expect(summarizeDiff(files)).toEqual({ added: 2, modified: 1, deleted: 1, unchanged: 1 });
  });

  it("空の差分では全て 0 になる", () => {
    expect(summarizeDiff([])).toEqual({ added: 0, modified: 0, deleted: 0, unchanged: 0 });
  });

  it("files を絞り込むと集計も追随する", () => {
    // 集計をフィールドとして持っていた頃は、files を絞り込んでも集計が元のままで
    // 食い違えた。導出関数なら絞り込んだ集合とずれようがない。
    const withoutAdded = files.filter((f) => f.type !== "added");
    const summary = summarizeDiff(withoutAdded);

    expect(summary).toEqual({ added: 0, modified: 1, deleted: 1, unchanged: 1 });
    const total = summary.added + summary.modified + summary.deleted + summary.unchanged;
    expect(total).toBe(withoutAdded.length);
  });
});

describe("prResultSchema", () => {
  it("有効な PR 結果を受け入れる", () => {
    const result = {
      url: "https://github.com/owner/repo/pull/123",
      number: 123,
      branch: "ziku-sync-1234567890",
    };
    expect(prResultSchema.parse(result)).toEqual(result);
  });

  it("必須フィールドが欠けている場合は拒否する", () => {
    expect(() =>
      prResultSchema.parse({
        url: "https://github.com/owner/repo/pull/123",
        // number が欠けている
        branch: "main",
      }),
    ).toThrow();
  });
});

describe("brand: 同じ形の文字列を取り違えない", () => {
  it("内容ハッシュは同期ベースのコミット SHA になれない", () => {
    // 内容ハッシュ（SHA-256）とコミット SHA は同じ 16 進文字列に見えるが、前者はファイル 1 つの
    // 中身、後者はテンプレートリポジトリのツリー全体を指す。取り違えるとベースツリーの取得が
    // 存在しない ref を引き、3-way マージが黙って 2-way へ落ちる。抑制コメントが不要になったら
    // （= 書けるようになったら）typecheck が失敗して気付ける。
    const at: SyncPoint = {
      hashes: hashMap({ "a.txt": "h" }),
      // @ts-expect-error 内容ハッシュはコミット SHA の位置に置けない
      commitSha: contentHash("2cf24dba5fb0a30e"),
    };
    expect(at.commitSha).toBe("2cf24dba5fb0a30e");
  });

  it("コミット SHA はパス→内容ハッシュの写像に入れられない", () => {
    const lock = createPendingLock({
      version: "0.1.0",
      installedAt: "2024-01-01T00:00:00+09:00",
      source: { kind: "github", owner: "o", repo: "r" },
    });
    // @ts-expect-error 写像の値は内容ハッシュであってコミット SHA ではない
    const synced = markSynced(lock, { hashes: { [repoRelPath("a.txt")]: commitSha("deadbeef") } });
    expect(baseHashesOf(synced)[repoRelPath("a.txt")]).toBe("deadbeef");
  });

  it("ハッシュの写像は glob パターンでは引けない", () => {
    // パターンは「どのファイルを追跡するか」の記述で、写像の鍵になる 1 ファイルのパスではない。
    const hashes = hashMap({ ".claude/rules/a.md": "h" });
    // @ts-expect-error 写像の鍵は相対パスであってパターンではない
    expect(hashes[globPattern(".claude/rules/*.md")]).toBeUndefined();
  });
});
