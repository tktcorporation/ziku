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
const { loadConfig, saveConfig } = await import("../config");

describe("loadConfig", () => {
  beforeEach(() => {
    vol.reset();
  });

  it("正常な .devenv.json を読み込める", async () => {
    const config = {
      version: "1.0.0",
      installedAt: "2024-01-01T00:00:00+09:00",
      modules: [".devcontainer", ".github"],
      source: {
        owner: "tktcorporation",
        repo: ".github",
        ref: "main",
      },
    };

    vol.fromJSON({
      "/project/.devenv.json": JSON.stringify(config),
    });

    const result = await loadConfig("/project");

    expect(result).toEqual(config);
  });

  it("excludePatterns を含む設定を読み込める", async () => {
    const config = {
      version: "1.0.0",
      installedAt: "2024-01-01T00:00:00+09:00",
      modules: [".devcontainer"],
      source: {
        owner: "tktcorporation",
        repo: ".github",
      },
      excludePatterns: ["*.local", ".env"],
    };

    vol.fromJSON({
      "/project/.devenv.json": JSON.stringify(config),
    });

    const result = await loadConfig("/project");

    expect(result.excludePatterns).toEqual(["*.local", ".env"]);
  });

  it("ファイルが存在しない場合はエラー", async () => {
    vol.fromJSON({});

    await expect(loadConfig("/project")).rejects.toThrow();
  });

  it("不正な JSON の場合はエラー", async () => {
    vol.fromJSON({
      "/project/.devenv.json": "{ invalid json }",
    });

    await expect(loadConfig("/project")).rejects.toThrow();
  });

  it("スキーマに合わない場合はエラー", async () => {
    vol.fromJSON({
      "/project/.devenv.json": JSON.stringify({
        version: "1.0.0",
        // installedAt が欠けている
        modules: [],
        source: { owner: "test", repo: "test" },
      }),
    });

    await expect(loadConfig("/project")).rejects.toThrow();
  });

  it("installedAt が不正な datetime 形式の場合はエラー", async () => {
    vol.fromJSON({
      "/project/.devenv.json": JSON.stringify({
        version: "1.0.0",
        installedAt: "invalid-date",
        modules: [],
        source: { owner: "test", repo: "test" },
      }),
    });

    await expect(loadConfig("/project")).rejects.toThrow();
  });
});

describe("saveConfig", () => {
  beforeEach(() => {
    vol.reset();
  });

  it("設定を JSON ファイルとして保存できる", async () => {
    vol.fromJSON({
      "/project": null, // ディレクトリを作成
    });

    const config = {
      version: "1.0.0",
      installedAt: "2024-01-01T00:00:00+09:00",
      modules: [".devcontainer", ".github"],
      source: {
        owner: "tktcorporation",
        repo: ".github",
        ref: "main",
      },
    };

    await saveConfig("/project", config);

    const saved = vol.readFileSync("/project/.devenv.json", "utf8");
    expect(JSON.parse(saved as string)).toEqual(config);
  });

  it("保存される JSON は整形されている（2スペースインデント）", async () => {
    vol.fromJSON({
      "/project": null,
    });

    const config = {
      version: "1.0.0",
      installedAt: "2024-01-01T00:00:00+09:00",
      modules: [".devcontainer"],
      source: {
        owner: "tktcorporation",
        repo: ".github",
      },
    };

    await saveConfig("/project", config);

    const saved = vol.readFileSync("/project/.devenv.json", "utf8") as string;

    // 整形されていることを確認
    expect(saved).toContain("\n");
    expect(saved).toContain("  "); // 2スペースインデント
    // 末尾に改行があることを確認
    expect(saved.endsWith("\n")).toBe(true);
  });

  it("既存ファイルを上書きできる", async () => {
    vol.fromJSON({
      "/project/.devenv.json": JSON.stringify({ old: "data" }),
    });

    const newConfig = {
      version: "2.0.0",
      installedAt: "2024-06-01T00:00:00+09:00",
      modules: [".claude"],
      source: {
        owner: "tktcorporation",
        repo: ".github",
      },
    };

    await saveConfig("/project", newConfig);

    const saved = vol.readFileSync("/project/.devenv.json", "utf8");
    expect(JSON.parse(saved as string)).toEqual(newConfig);
  });
});
