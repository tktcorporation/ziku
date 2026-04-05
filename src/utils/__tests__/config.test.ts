import { vol } from "memfs";
import { beforeEach, describe, expect, it, vi } from "vitest";

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

  it("正常な .ziku/ziku.jsonc を読み込める", async () => {
    const config = {
      source: { owner: "tktcorporation", repo: ".github", ref: "main" },
      include: [".github/**"],
    };

    vol.fromJSON({
      "/project/.ziku/ziku.jsonc": JSON.stringify(config),
    });

    const result = await loadZikuConfig("/project");
    expect(result.config).toEqual(config);
    expect(typeof result.rawContent).toBe("string");
  });

  it("$schema と exclude を含む設定を読み込める", async () => {
    const config = {
      $schema: "https://example.com/schema.json",
      source: { owner: "tktcorporation", repo: ".github" },
      include: [".github/**"],
      exclude: ["*.secret"],
    };

    vol.fromJSON({
      "/project/.ziku/ziku.jsonc": JSON.stringify(config),
    });

    const result = await loadZikuConfig("/project");
    expect(result.config.$schema).toBe("https://example.com/schema.json");
    expect(result.config.exclude).toEqual(["*.secret"]);
  });

  it("JSONC (コメント付き) を読み込める", async () => {
    const jsonc = `{
  // source repository
  "source": { "owner": "tktcorporation", "repo": ".github" },
  "include": [".github/**"]
}`;

    vol.fromJSON({
      "/project/.ziku/ziku.jsonc": jsonc,
    });

    const result = await loadZikuConfig("/project");
    expect(result.config.source.owner).toBe("tktcorporation");
    expect(result.rawContent).toBe(jsonc);
  });

  it("ファイルが存在しない場合はエラー", async () => {
    vol.fromJSON({});
    await expect(loadZikuConfig("/project")).rejects.toThrow();
  });

  it("不正な JSON の場合はエラー", async () => {
    vol.fromJSON({
      "/project/.ziku/ziku.jsonc": "{ invalid json }",
    });
    await expect(loadZikuConfig("/project")).rejects.toThrow();
  });

  it("スキーマに合わない場合はエラー (source が欠けている)", async () => {
    vol.fromJSON({
      "/project/.ziku/ziku.jsonc": JSON.stringify({
        include: [".github/**"],
      }),
    });
    await expect(loadZikuConfig("/project")).rejects.toThrow();
  });

  it("スキーマに合わない場合はエラー (include が欠けている)", async () => {
    vol.fromJSON({
      "/project/.ziku/ziku.jsonc": JSON.stringify({
        source: { owner: "test", repo: "test" },
      }),
    });
    await expect(loadZikuConfig("/project")).rejects.toThrow();
  });
});

describe("saveZikuConfig", () => {
  beforeEach(() => {
    vol.reset();
  });

  it("コンテンツをファイルとして保存できる", async () => {
    vol.fromJSON({ "/project/.ziku": null });

    const content = '{\n  "source": { "owner": "test", "repo": "test" },\n  "include": [".github/**"]\n}\n';
    await saveZikuConfig("/project", content);

    const saved = vol.readFileSync("/project/.ziku/ziku.jsonc", "utf8") as string;
    expect(saved).toBe(content);
  });

  it(".ziku ディレクトリが存在しなくても保存できる", async () => {
    vol.fromJSON({ "/project": null });

    const content = '{ "source": { "owner": "a", "repo": "b" }, "include": [] }';
    await saveZikuConfig("/project", content);

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
    expect(zikuConfigExists("/project")).toBe(true);
  });

  it("ファイルが存在しない場合は false", () => {
    vol.fromJSON({});
    expect(zikuConfigExists("/project")).toBe(false);
  });
});

describe("generateZikuJsonc", () => {
  it("source と include のみの設定を生成できる", () => {
    const result = generateZikuJsonc({
      source: { owner: "tktcorporation", repo: ".github" },
      include: [".github/**"],
      exclude: [],
    });

    const parsed = JSON.parse(result);
    expect(parsed.source).toEqual({ owner: "tktcorporation", repo: ".github" });
    expect(parsed.include).toEqual([".github/**"]);
    expect(parsed.exclude).toBeUndefined();
    expect(parsed.$schema).toBeDefined();
  });

  it("exclude が指定されている場合は含まれる", () => {
    const result = generateZikuJsonc({
      source: { owner: "tktcorporation", repo: ".github" },
      include: [".github/**"],
      exclude: ["*.secret"],
    });

    const parsed = JSON.parse(result);
    expect(parsed.exclude).toEqual(["*.secret"]);
  });

  it("整形された JSON を生成する（2スペースインデント + 末尾改行）", () => {
    const result = generateZikuJsonc({
      source: { owner: "a", repo: "b" },
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
    const result = addIncludePattern(raw, ["docs/**"]);

    const parsed = JSON.parse(result);
    expect(parsed.include).toContain(".github/**");
    expect(parsed.include).toContain("docs/**");
  });

  it("既に存在するパターンは追加しない", () => {
    const raw = '{\n  "source": { "owner": "a", "repo": "b" },\n  "include": [".github/**"]\n}\n';
    const result = addIncludePattern(raw, [".github/**"]);

    expect(result).toBe(raw);
  });

  it("複数パターンを一度に追加できる", () => {
    const raw = '{\n  "source": { "owner": "a", "repo": "b" },\n  "include": []\n}\n';
    const result = addIncludePattern(raw, ["a/**", "b/**"]);

    const parsed = JSON.parse(result);
    expect(parsed.include).toEqual(["a/**", "b/**"]);
  });
});

// ---------------------------------------------------------------------------
// lock.ts
// ---------------------------------------------------------------------------

describe("loadLock", () => {
  beforeEach(() => {
    vol.reset();
  });

  it("正常な .ziku/lock.json を読み込める", async () => {
    const lock = {
      version: "1.0.0",
      installedAt: "2024-01-01T00:00:00+09:00",
    };

    vol.fromJSON({
      "/project/.ziku/lock.json": JSON.stringify(lock),
    });

    const result = await loadLock("/project");
    expect(result).toEqual(lock);
  });

  it("baseRef と baseHashes を含むロックを読み込める", async () => {
    const lock = {
      version: "1.0.0",
      installedAt: "2024-01-01T00:00:00+09:00",
      baseRef: "abc123def",
      baseHashes: { "file.txt": "sha256hash" },
    };

    vol.fromJSON({
      "/project/.ziku/lock.json": JSON.stringify(lock),
    });

    const result = await loadLock("/project");
    expect(result.baseRef).toBe("abc123def");
    expect(result.baseHashes).toEqual({ "file.txt": "sha256hash" });
  });

  it("pendingMerge を含むロックを読み込める", async () => {
    const lock = {
      version: "1.0.0",
      installedAt: "2024-01-01T00:00:00+09:00",
      pendingMerge: {
        conflicts: ["file1.txt"],
        templateHashes: { "file1.txt": "hash1" },
        latestRef: "def456",
      },
    };

    vol.fromJSON({
      "/project/.ziku/lock.json": JSON.stringify(lock),
    });

    const result = await loadLock("/project");
    expect(result.pendingMerge?.conflicts).toEqual(["file1.txt"]);
    expect(result.pendingMerge?.latestRef).toBe("def456");
  });

  it("ファイルが存在しない場合はエラー", async () => {
    vol.fromJSON({});
    await expect(loadLock("/project")).rejects.toThrow();
  });

  it("不正な JSON の場合はエラー", async () => {
    vol.fromJSON({
      "/project/.ziku/lock.json": "{ invalid json }",
    });
    await expect(loadLock("/project")).rejects.toThrow();
  });

  it("スキーマに合わない場合はエラー (version が欠けている)", async () => {
    vol.fromJSON({
      "/project/.ziku/lock.json": JSON.stringify({
        installedAt: "2024-01-01T00:00:00+09:00",
      }),
    });
    await expect(loadLock("/project")).rejects.toThrow();
  });

  it("installedAt が不正な datetime 形式の場合はエラー", async () => {
    vol.fromJSON({
      "/project/.ziku/lock.json": JSON.stringify({
        version: "1.0.0",
        installedAt: "invalid-date",
      }),
    });
    await expect(loadLock("/project")).rejects.toThrow();
  });
});

describe("saveLock", () => {
  beforeEach(() => {
    vol.reset();
  });

  it("ロックを JSON ファイルとして保存できる", async () => {
    vol.fromJSON({ "/project/.ziku": null });

    const lock = {
      version: "1.0.0",
      installedAt: "2024-01-01T00:00:00+09:00",
    };

    await saveLock("/project", lock);

    const saved = vol.readFileSync("/project/.ziku/lock.json", "utf8");
    expect(JSON.parse(saved as string)).toEqual(lock);
  });

  it("保存される JSON は整形されている（2スペースインデント + 末尾改行）", async () => {
    vol.fromJSON({ "/project/.ziku": null });

    const lock = {
      version: "1.0.0",
      installedAt: "2024-01-01T00:00:00+09:00",
    };

    await saveLock("/project", lock);

    const saved = vol.readFileSync("/project/.ziku/lock.json", "utf8") as string;
    expect(saved).toContain("\n");
    expect(saved).toContain("  ");
    expect(saved.endsWith("\n")).toBe(true);
  });

  it("既存ファイルを上書きできる", async () => {
    vol.fromJSON({
      "/project/.ziku/lock.json": JSON.stringify({ version: "0.0.1", installedAt: "2024-01-01T00:00:00+00:00" }),
    });

    const newLock = {
      version: "2.0.0",
      installedAt: "2024-06-01T00:00:00+09:00",
      baseRef: "newref",
    };

    await saveLock("/project", newLock);

    const saved = vol.readFileSync("/project/.ziku/lock.json", "utf8");
    expect(JSON.parse(saved as string)).toEqual(newLock);
  });

  it(".ziku ディレクトリが存在しなくても保存できる", async () => {
    vol.fromJSON({ "/project": null });

    const lock = {
      version: "1.0.0",
      installedAt: "2024-01-01T00:00:00+09:00",
    };

    await saveLock("/project", lock);

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
