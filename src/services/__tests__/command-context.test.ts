import { describe, expect, it } from "vitest";
import { migrateLockConfigBaseHash } from "../command-context";
import { hashContent } from "../../utils/hash";
import { ZIKU_CONFIG_FILE } from "../../utils/ziku-config";
import type { LockState } from "../../modules/schemas";

const baseLock: LockState = {
  version: "0.1.0",
  installedAt: "2024-01-01T00:00:00.000Z",
  source: { owner: "o", repo: "r" },
};

describe("migrateLockConfigBaseHash（旧 lock の ziku.jsonc base バックフィル）", () => {
  const localContent = JSON.stringify({ include: [".claude/**"] }, null, 2);

  it("baseHashes に ziku.jsonc が無い旧 lock はローカル内容のハッシュで補完する", () => {
    const lock: LockState = { ...baseLock, baseHashes: { ".claude/rules.md": "abc" } };
    const result = migrateLockConfigBaseHash(lock, localContent);

    expect(result.baseHashes?.[ZIKU_CONFIG_FILE]).toBe(hashContent(localContent));
    // 既存エントリは保持
    expect(result.baseHashes?.[".claude/rules.md"]).toBe("abc");
  });

  it("補完後の base はローカルハッシュと一致する（base==local → conflict を避ける）", () => {
    const lock: LockState = { ...baseLock, baseHashes: {} };
    const result = migrateLockConfigBaseHash(lock, localContent);
    expect(result.baseHashes?.[ZIKU_CONFIG_FILE]).toBe(hashContent(localContent));
  });

  it("既に ziku.jsonc の base がある lock は変更しない（同一オブジェクトを返す）", () => {
    const lock: LockState = {
      ...baseLock,
      baseHashes: { [ZIKU_CONFIG_FILE]: "existing" },
    };
    const result = migrateLockConfigBaseHash(lock, localContent);
    expect(result).toBe(lock);
    expect(result.baseHashes?.[ZIKU_CONFIG_FILE]).toBe("existing");
  });

  it("baseHashes が未定義の退化 lock は対象外（既存挙動を保つ）", () => {
    const lock: LockState = { ...baseLock };
    const result = migrateLockConfigBaseHash(lock, localContent);
    expect(result).toBe(lock);
    expect(result.baseHashes).toBeUndefined();
  });
});
