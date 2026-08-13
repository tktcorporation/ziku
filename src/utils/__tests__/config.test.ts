import { Cause, Effect, Exit, Option } from "effect";
import { vol } from "memfs";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { ParseError, ValidationError } from "../../errors";
import type { LockState, ZikuConfig } from "../../modules/schemas";
import { baseCommitSha, baseHashesOf, markSynced } from "../../modules/schemas";
import { toZikuFailure } from "../../services/command-context";
import {
  absPath,
  commitSha,
  globPatterns,
  hashMap,
  pathAsPattern,
  repoRelPath,
} from "../../__tests__/brands";

// fs モジュールをモック
vi.mock("node:fs/promises", async () => {
  const memfs = await import("memfs");
  return memfs.fs.promises;
});

vi.mock("node:fs", async () => {
  const memfs = await import("memfs");
  return memfs.fs;
});

// モック後にインポート
const {
  loadZikuConfig,
  saveZikuConfig,
  zikuConfigExists,
  generateZikuJsonc,
  addIncludePattern,
  alwaysTrackedPathsIn,
  classifySyncPath,
  isZikuConfigPath,
  withConfigTracked,
  withoutConfigTracked,
  ZIKU_CONFIG_FILE,
} = await import("../ziku-config");

const { loadLock, saveLock, LOCK_FILE } = await import("../lock");

// ---------------------------------------------------------------------------
// ziku-config.ts
// ---------------------------------------------------------------------------

describe("loadZikuConfig", () => {
  beforeEach(() => {
    vol.reset();
  });

  const runLoad = (dir: string): Promise<{ config: ZikuConfig; rawContent: string }> =>
    Effect.runPromise(loadZikuConfig(absPath(dir)));
  const loadFailure = async (dir: string): Promise<unknown> => {
    const exit = await Effect.runPromiseExit(loadZikuConfig(absPath(dir)));
    return Exit.isFailure(exit) ? Cause.failureOption(exit.cause) : undefined;
  };

  it("正常な .ziku/ziku.jsonc を読み込める", async () => {
    const config = {
      include: [".github/**"],
    };

    vol.fromJSON({
      "/project/.ziku/ziku.jsonc": JSON.stringify(config),
    });

    const result = await runLoad("/project");
    expect(result.config).toEqual(config);
    expect(typeof result.rawContent).toBe("string");
  });

  it("$schema と exclude を含む設定を読み込める", async () => {
    const config = {
      $schema: "https://example.com/schema.json",
      include: [".github/**"],
      exclude: ["*.secret"],
    };

    vol.fromJSON({
      "/project/.ziku/ziku.jsonc": JSON.stringify(config),
    });

    const result = await runLoad("/project");
    expect(result.config.$schema).toBe("https://example.com/schema.json");
    expect(result.config.exclude).toEqual(["*.secret"]);
  });

  it("JSONC (コメント付き) を読み込める", async () => {
    const jsonc = `{
  // include patterns
  "include": [".github/**"]
}`;

    vol.fromJSON({
      "/project/.ziku/ziku.jsonc": jsonc,
    });

    const result = await runLoad("/project");
    expect(result.config.include).toEqual([".github/**"]);
    expect(result.rawContent).toBe(jsonc);
  });

  it("末尾カンマ付きの JSONC を読み込める", async () => {
    vol.fromJSON({
      "/project/.ziku/ziku.jsonc": '{ "include": [".github/**",], }',
    });

    const result = await runLoad("/project");
    expect(result.config.include).toEqual([".github/**"]);
  });

  it("ファイルが存在しない場合は FileNotFoundError", async () => {
    vol.fromJSON({});
    expect(await loadFailure("/project")).toMatchObject(
      Option.some(expect.objectContaining({ _tag: "FileNotFoundError" })),
    );
  });

  it("JSONC として壊れている場合は ParseError", async () => {
    vol.fromJSON({
      "/project/.ziku/ziku.jsonc": '{ "include": [ }',
    });

    const failure = await loadFailure("/project");
    expect(failure).toMatchObject(
      Option.some(expect.objectContaining({ _tag: "ParseError", path: ZIKU_CONFIG_FILE })),
    );

    // 構文エラーとして報告され、ファイルのどこが壊れているかが hint に残ること
    const parseError = Option.getOrThrow(failure as Option.Option<ParseError>);
    const zikuFailure = toZikuFailure(parseError);
    expect(zikuFailure.reason).toMatchObject({ kind: "ConfigUnparsable", path: ZIKU_CONFIG_FILE });
    expect(zikuFailure.hint).toContain("line 1, column");
  });

  it("スキーマに合わない場合は ValidationError (include が欠けている)", async () => {
    vol.fromJSON({
      "/project/.ziku/ziku.jsonc": JSON.stringify({
        exclude: ["*.secret"],
      }),
    });
    expect(await loadFailure("/project")).toMatchObject(
      Option.some(expect.objectContaining({ _tag: "ValidationError" })),
    );
  });

  it("型の違う include は、構文エラーではなく検証失敗としてフィールド名付きで報告される", async () => {
    vol.fromJSON({
      "/project/.ziku/ziku.jsonc": JSON.stringify({ include: "not-an-array" }),
    });

    const failure = await loadFailure("/project");
    expect(failure).toMatchObject(
      Option.some(expect.objectContaining({ _tag: "ValidationError", path: ZIKU_CONFIG_FILE })),
    );

    const validationError = Option.getOrThrow(failure as Option.Option<ValidationError>);
    expect(validationError.issues).toEqual([expect.stringContaining("include: ")]);
    expect(validationError.issues[0]).toContain("array");

    // 「パースに失敗」ではなく「読めない設定」として、作り直しを促すこと
    const failureValue = toZikuFailure(validationError);
    expect(failureValue.reason).toMatchObject({ kind: "ConfigInvalid", path: ZIKU_CONFIG_FILE });
    expect(failureValue.message).toBe(`Failed to read ${ZIKU_CONFIG_FILE}`);
    expect(failureValue.hint).toContain("include: ");
    expect(failureValue.hint).toContain("ziku init");
  });
});

describe("saveZikuConfig", () => {
  beforeEach(() => {
    vol.reset();
  });

  it("コンテンツをファイルとして保存できる", async () => {
    vol.fromJSON({ "/project/.ziku": null });

    const content =
      '{\n  "source": { "owner": "test", "repo": "test" },\n  "include": [".github/**"]\n}\n';
    await saveZikuConfig(absPath("/project"), content);

    const saved = vol.readFileSync("/project/.ziku/ziku.jsonc", "utf8") as string;
    expect(saved).toBe(content);
  });

  it(".ziku ディレクトリが存在しなくても保存できる", async () => {
    vol.fromJSON({ "/project": null });

    const content = '{ "source": { "owner": "a", "repo": "b" }, "include": [] }';
    await saveZikuConfig(absPath("/project"), content);

    const saved = vol.readFileSync("/project/.ziku/ziku.jsonc", "utf8") as string;
    expect(saved).toBe(content);
  });
});

describe("zikuConfigExists", () => {
  beforeEach(() => {
    vol.reset();
  });

  it("ファイルが存在する場合は true", () => {
    vol.fromJSON({
      "/project/.ziku/ziku.jsonc": "{}",
    });
    expect(zikuConfigExists(absPath("/project"))).toBe(true);
  });

  it("ファイルが存在しない場合は false", () => {
    vol.fromJSON({});
    expect(zikuConfigExists(absPath("/project"))).toBe(false);
  });
});

describe("generateZikuJsonc", () => {
  it("include のみの設定を生成できる", () => {
    const result = generateZikuJsonc({
      include: globPatterns([".github/**"]),
      exclude: [],
    });

    const parsed = JSON.parse(result);
    expect(parsed.include).toEqual([".github/**"]);
    expect(parsed.exclude).toBeUndefined();
    expect(parsed.$schema).toBeDefined();
    // source は含まれない（lock.json に移動済み）
    expect(parsed.source).toBeUndefined();
  });

  it("exclude が指定されている場合は含まれる", () => {
    const result = generateZikuJsonc({
      include: globPatterns([".github/**"]),
      exclude: globPatterns(["*.secret"]),
    });

    const parsed = JSON.parse(result);
    expect(parsed.exclude).toEqual(["*.secret"]);
  });

  it("整形された JSON を生成する（2スペースインデント + 末尾改行）", () => {
    const result = generateZikuJsonc({
      include: [],
      exclude: [],
    });

    expect(result).toContain("\n");
    expect(result).toContain("  ");
    expect(result.endsWith("\n")).toBe(true);
  });
});

describe("addIncludePattern", () => {
  it("新しいパターンを include に追加できる", () => {
    const raw = '{\n  "source": { "owner": "a", "repo": "b" },\n  "include": [".github/**"]\n}\n';
    const result = addIncludePattern(raw, globPatterns(["docs/**"]));

    const parsed = JSON.parse(result);
    expect(parsed.include).toContain(".github/**");
    expect(parsed.include).toContain("docs/**");
  });

  it("既に存在するパターンは追加しない", () => {
    const raw = '{\n  "source": { "owner": "a", "repo": "b" },\n  "include": [".github/**"]\n}\n';
    const result = addIncludePattern(raw, globPatterns([".github/**"]));

    expect(result).toBe(raw);
  });

  it("複数パターンを一度に追加できる", () => {
    const raw = '{\n  "source": { "owner": "a", "repo": "b" },\n  "include": []\n}\n';
    const result = addIncludePattern(raw, globPatterns(["a/**", "b/**"]));

    const parsed = JSON.parse(result);
    expect(parsed.include).toEqual(["a/**", "b/**"]);
  });
});

describe("withConfigTracked", () => {
  it("ziku.jsonc を追跡対象として include 末尾に追加する", () => {
    const result = withConfigTracked(globPatterns([".claude/**", ".mcp.json"]));
    expect(result).toEqual([".claude/**", ".mcp.json", ZIKU_CONFIG_FILE]);
  });

  it("既に ziku.jsonc が含まれていれば重複追加しない", () => {
    const input = globPatterns([".claude/**"]).concat(pathAsPattern(ZIKU_CONFIG_FILE));
    const result = withConfigTracked(input);
    expect(result).toEqual(input);
    // 重複しないこと
    expect(result.filter((p) => p === pathAsPattern(ZIKU_CONFIG_FILE))).toHaveLength(1);
  });

  it("空配列でも ziku.jsonc だけは追跡対象になる", () => {
    expect(withConfigTracked([])).toEqual([ZIKU_CONFIG_FILE]);
  });

  it("元の配列を破壊しない（イミュータブル）", () => {
    const input = globPatterns([".claude/**"]);
    withConfigTracked(input);
    expect(input).toEqual([".claude/**"]);
  });
});

describe("classifySyncPath", () => {
  it("ziku.jsonc だけを zikuConfig 種別として扱う", () => {
    expect(classifySyncPath(ZIKU_CONFIG_FILE)).toEqual({
      kind: "zikuConfig",
      path: ZIKU_CONFIG_FILE,
    });
    expect(isZikuConfigPath(ZIKU_CONFIG_FILE)).toBe(true);
  });

  it("同じ `.ziku/` 配下でも lock.json は通常の同期ファイル扱い", () => {
    // lock.json はテンプレート取得元 source を持つローカル専用ファイルで、同期対象ではない。
    // 種別判定がディレクトリではなくパス単位であることを固定する。
    expect(classifySyncPath(repoRelPath(".ziku/lock.json"))).toEqual({
      kind: "syncedFile",
      path: ".ziku/lock.json",
    });
    expect(isZikuConfigPath(repoRelPath(".ziku/lock.json"))).toBe(false);
  });

  it("通常のファイルは syncedFile 種別", () => {
    expect(classifySyncPath(repoRelPath(".claude/rules/foo.md")).kind).toBe("syncedFile");
    expect(isZikuConfigPath(repoRelPath(".claude/rules/foo.md"))).toBe(false);
  });
});

describe("withoutConfigTracked", () => {
  it("常に追跡されるパスだけを取り除く", () => {
    expect(
      withoutConfigTracked([
        ...globPatterns([".claude/**"]),
        pathAsPattern(ZIKU_CONFIG_FILE),
        ...globPatterns([".ziku/lock.json"]),
      ]),
    ).toEqual([".claude/**", ".ziku/lock.json"]);
  });

  it("withConfigTracked と往復すると元の include に戻る", () => {
    const include = globPatterns([".claude/**", ".mcp.json"]);
    expect(withoutConfigTracked(withConfigTracked(include))).toEqual(include);
  });
});

describe("alwaysTrackedPathsIn", () => {
  beforeEach(() => {
    vol.reset();
  });

  it("実在する常時追跡パスを返す", () => {
    vol.fromJSON({ [`/project/${ZIKU_CONFIG_FILE}`]: "{}" });
    expect(alwaysTrackedPathsIn(absPath("/project"))).toEqual([ZIKU_CONFIG_FILE]);
  });

  it("実在しなければ返さない（走査に存在しないファイルを混ぜない）", () => {
    vol.fromJSON({ "/project/.claude/rules/foo.md": "x" });
    expect(alwaysTrackedPathsIn(absPath("/project"))).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// lock.ts
// ---------------------------------------------------------------------------

describe("loadLock", () => {
  beforeEach(() => {
    vol.reset();
  });

  const runLoad = (dir: string): Promise<LockState> => Effect.runPromise(loadLock(absPath(dir)));
  const loadFailure = async (dir: string): Promise<unknown> => {
    const exit = await Effect.runPromiseExit(loadLock(absPath(dir)));
    return Exit.isFailure(exit) ? Cause.failureOption(exit.cause) : undefined;
  };

  it("ベース未確定 (sync: pending) のロックを読み込める", async () => {
    const lock = {
      version: "1.0.0",
      installedAt: "2024-01-01T00:00:00+09:00",
      source: { kind: "github", owner: "tktcorporation", repo: ".github" },
      sync: "pending",
    };

    vol.fromJSON({
      "/project/.ziku/lock.json": JSON.stringify(lock),
    });

    expect(await runLoad("/project")).toEqual(lock);
  });

  it("ベース確定済み (sync: synced) のロックを読み込める", async () => {
    const lock = {
      version: "1.0.0",
      installedAt: "2024-01-01T00:00:00+09:00",
      source: { kind: "github", owner: "tktcorporation", repo: ".github" },
      sync: "synced",
      base: { hashes: { "file.txt": "sha256hash" }, ref: "abc123def" },
    };

    vol.fromJSON({
      "/project/.ziku/lock.json": JSON.stringify(lock),
    });

    const result = await runLoad("/project");
    expect(baseCommitSha(result)).toBe("abc123def");
    expect(baseHashesOf(result)).toEqual({ "file.txt": "sha256hash" });
  });

  it("コンフリクト解決待ち (sync: merging) のロックを読み込める", async () => {
    const lock = {
      version: "1.0.0",
      installedAt: "2024-01-01T00:00:00+09:00",
      source: { kind: "github", owner: "tktcorporation", repo: ".github" },
      sync: "merging",
      base: { hashes: {}, ref: "abc123" },
      merge: {
        conflicts: ["file1.txt"],
        nextBase: { hashes: { "file1.txt": "hash1" }, ref: "def456" },
      },
    };

    vol.fromJSON({
      "/project/.ziku/lock.json": JSON.stringify(lock),
    });

    const result = await runLoad("/project");
    expect(result.sync).toBe("merging");
    if (result.sync !== "merging") throw new Error("expected merging lock");
    expect(result.merge.conflicts).toEqual(["file1.txt"]);
    expect(result.merge.nextBase.hashes).toEqual({ "file1.txt": "hash1" });
  });

  it("ローカルソースのロックにコミット SHA があれば ValidationError", async () => {
    vol.fromJSON({
      "/project/.ziku/lock.json": JSON.stringify({
        version: "1.0.0",
        installedAt: "2024-01-01T00:00:00+09:00",
        source: { kind: "local", path: "/tpl" },
        sync: "synced",
        base: { hashes: {}, ref: "abc123" },
      }),
    });

    expect(await loadFailure("/project")).toMatchObject(
      Option.some(expect.objectContaining({ _tag: "ValidationError" })),
    );
  });

  it("解決待ちのコンフリクトが空配列のロックは受け付けない", async () => {
    vol.fromJSON({
      "/project/.ziku/lock.json": JSON.stringify({
        version: "1.0.0",
        installedAt: "2024-01-01T00:00:00+09:00",
        source: { kind: "local", path: "/tpl" },
        sync: "merging",
        base: { hashes: {} },
        merge: { conflicts: [], nextBase: { hashes: {} } },
      }),
    });

    expect(await loadFailure("/project")).toMatchObject(
      Option.some(expect.objectContaining({ _tag: "ValidationError" })),
    );
  });

  it("ファイルが存在しない場合は FileNotFoundError", async () => {
    vol.fromJSON({});
    expect(await loadFailure("/project")).toMatchObject(
      Option.some(expect.objectContaining({ _tag: "FileNotFoundError" })),
    );
  });

  it("不正な JSON の場合は ParseError", async () => {
    vol.fromJSON({
      "/project/.ziku/lock.json": "{ invalid json }",
    });
    expect(await loadFailure("/project")).toMatchObject(
      Option.some(expect.objectContaining({ _tag: "ParseError" })),
    );
  });

  it("スキーマに合わない場合は ValidationError (version が欠けている)", async () => {
    vol.fromJSON({
      "/project/.ziku/lock.json": JSON.stringify({
        installedAt: "2024-01-01T00:00:00+09:00",
        source: { kind: "local", path: "/tpl" },
        sync: "pending",
      }),
    });
    expect(await loadFailure("/project")).toMatchObject(
      Option.some(expect.objectContaining({ _tag: "ValidationError" })),
    );
  });

  it("installedAt が不正な datetime 形式の場合は ValidationError", async () => {
    vol.fromJSON({
      "/project/.ziku/lock.json": JSON.stringify({
        version: "1.0.0",
        installedAt: "invalid-date",
        source: { kind: "local", path: "/tpl" },
        sync: "pending",
      }),
    });
    expect(await loadFailure("/project")).toMatchObject(
      Option.some(expect.objectContaining({ _tag: "ValidationError" })),
    );
  });

  it("同期状態をトップレベルに持つロックは、不在ではなく検証失敗として作り直しを促す", async () => {
    vol.fromJSON({
      "/project/.ziku/lock.json": JSON.stringify({
        version: "1.0.0",
        installedAt: "2024-01-01T00:00:00+09:00",
        source: { owner: "tktcorporation", repo: ".github" },
        baseRef: "abc123",
        baseHashes: { "file.txt": "hash" },
      }),
    });

    const failure = await loadFailure("/project");
    expect(failure).toMatchObject(
      Option.some(expect.objectContaining({ _tag: "ValidationError", path: LOCK_FILE })),
    );

    // 「見つからない」ではなく検証失敗として分類され、作り直しを促すこと
    const validationError = Option.getOrThrow(failure as Option.Option<ValidationError>);
    const failureValue = toZikuFailure(validationError);
    expect(failureValue.reason).toMatchObject({ kind: "ConfigInvalid", path: LOCK_FILE });
    expect(failureValue.message).toContain(LOCK_FILE);
    expect(failureValue.hint).toContain("cannot read");
    expect(failureValue.hint).toContain("ziku init");
  });
});

describe("saveLock", () => {
  beforeEach(() => {
    vol.reset();
  });

  const lock: LockState = {
    version: "1.0.0",
    installedAt: "2024-01-01T00:00:00+09:00",
    source: { kind: "github", owner: "test", repo: ".ziku" },
    sync: "pending",
  };

  it("ロックを JSON ファイルとして保存できる", async () => {
    vol.fromJSON({ "/project/.ziku": null });

    await saveLock(absPath("/project"), lock);

    const saved = vol.readFileSync("/project/.ziku/lock.json", "utf8");
    expect(JSON.parse(saved as string)).toEqual(lock);
  });

  it("保存される JSON は整形されている（2スペースインデント + 末尾改行）", async () => {
    vol.fromJSON({ "/project/.ziku": null });

    await saveLock(absPath("/project"), lock);

    const saved = vol.readFileSync("/project/.ziku/lock.json", "utf8") as string;
    expect(saved).toContain("\n");
    expect(saved).toContain("  ");
    expect(saved.endsWith("\n")).toBe(true);
  });

  it("既存ファイルを上書きできる", async () => {
    vol.fromJSON({
      "/project/.ziku/lock.json": JSON.stringify({
        version: "0.0.1",
        installedAt: "2024-01-01T00:00:00+00:00",
      }),
    });

    const newLock = markSynced(lock, {
      hashes: hashMap({ "a.txt": "h" }),
      commitSha: commitSha("newref"),
    });

    await saveLock(absPath("/project"), newLock);

    const saved = vol.readFileSync("/project/.ziku/lock.json", "utf8");
    expect(JSON.parse(saved as string)).toEqual(newLock);
  });

  it(".ziku ディレクトリが存在しなくても保存できる", async () => {
    vol.fromJSON({ "/project": null });

    await saveLock(absPath("/project"), lock);

    const saved = vol.readFileSync("/project/.ziku/lock.json", "utf8");
    expect(JSON.parse(saved as string)).toEqual(lock);
  });
});

// ---------------------------------------------------------------------------
// 定数のエクスポート確認
// ---------------------------------------------------------------------------

describe("exported constants", () => {
  it("ZIKU_CONFIG_FILE は正しいパス", () => {
    expect(ZIKU_CONFIG_FILE).toBe(".ziku/ziku.jsonc");
  });

  it("LOCK_FILE は正しいパス", () => {
    expect(LOCK_FILE).toBe(".ziku/lock.json");
  });
});
