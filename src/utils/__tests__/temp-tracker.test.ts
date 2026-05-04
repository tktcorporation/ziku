import { vol } from "memfs";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("node:fs", async () => {
  const memfs = await import("memfs");
  return memfs.fs;
});

const { registerTempDir, unregisterTempDir, _resetForTest, _getTrackedCountForTest } =
  await import("../temp-tracker");

describe("temp-tracker", () => {
  beforeEach(() => {
    vol.reset();
    _resetForTest();
  });

  afterEach(() => {
    _resetForTest();
  });

  it("register と unregister でカウントが増減する", () => {
    expect(_getTrackedCountForTest()).toBe(0);
    registerTempDir("/tmp/a");
    expect(_getTrackedCountForTest()).toBe(1);
    registerTempDir("/tmp/b");
    expect(_getTrackedCountForTest()).toBe(2);
    unregisterTempDir("/tmp/a");
    expect(_getTrackedCountForTest()).toBe(1);
    unregisterTempDir("/tmp/b");
    expect(_getTrackedCountForTest()).toBe(0);
  });

  it("同じパスを複数回 register しても重複しない", () => {
    registerTempDir("/tmp/a");
    registerTempDir("/tmp/a");
    expect(_getTrackedCountForTest()).toBe(1);
  });

  it("'exit' イベントで登録済みディレクトリを削除する", () => {
    vol.fromJSON({
      "/tmp/ziku-temp/file.txt": "content",
    });
    expect(vol.existsSync("/tmp/ziku-temp")).toBe(true);

    registerTempDir("/tmp/ziku-temp");

    // 'exit' イベントを発火させる (registerTempDir 初回時にハンドラがインストール済み)
    process.emit("exit", 0);

    expect(vol.existsSync("/tmp/ziku-temp")).toBe(false);
    expect(_getTrackedCountForTest()).toBe(0);
  });

  it("unregister 済みのディレクトリは exit 時に削除されない", () => {
    vol.fromJSON({
      "/tmp/keep-me/file.txt": "content",
    });

    registerTempDir("/tmp/keep-me");
    unregisterTempDir("/tmp/keep-me");

    process.emit("exit", 0);

    expect(vol.existsSync("/tmp/keep-me")).toBe(true);
  });

  it("存在しないディレクトリの cleanup はエラーにならない", () => {
    registerTempDir("/tmp/does-not-exist");
    expect(() => process.emit("exit", 0)).not.toThrow();
  });
});
