import { vol } from "memfs";
import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("node:fs", async () => (await import("memfs")).fs);
vi.mock("node:fs/promises", async () => (await import("memfs")).fs.promises);

const { mergeConfigPatterns, computeMergedZikuConfig } = await import("../config-merge");

describe("mergeConfigPatterns（要素レベル 3-way マージ）", () => {
  it("base あり: 両者の追加を保持する", () => {
    const result = mergeConfigPatterns({
      base: { include: [".claude/**"], exclude: [] },
      local: { include: [".claude/**", ".eslintrc.json"], exclude: [] },
      template: { include: [".claude/**", ".github/**"], exclude: [] },
    });
    expect(result.include).toEqual([".claude/**", ".eslintrc.json", ".github/**"]);
  });

  it("base あり: ローカルが削除したパターンは結果から消える（削除の伝播）", () => {
    const result = mergeConfigPatterns({
      base: { include: [".claude/**", ".old/**"], exclude: [] },
      local: { include: [".claude/**"], exclude: [] }, // .old/** を削除
      template: { include: [".claude/**", ".old/**"], exclude: [] },
    });
    expect(result.include).toEqual([".claude/**"]);
  });

  it("base あり: テンプレが削除したパターンも結果から消える", () => {
    const result = mergeConfigPatterns({
      base: { include: [".claude/**", ".old/**"], exclude: [] },
      local: { include: [".claude/**", ".old/**"], exclude: [] },
      template: { include: [".claude/**"], exclude: [] }, // .old/** を削除
    });
    expect(result.include).toEqual([".claude/**"]);
  });

  it("base あり: 片方が削除しても他方が追加し直していれば残す扱いにはしない（削除優先）", () => {
    // base にある .x を local が削除、template は維持 → 削除が勝つ
    const result = mergeConfigPatterns({
      base: { include: [".x"], exclude: [] },
      local: { include: [], exclude: [] },
      template: { include: [".x"], exclude: [] },
    });
    expect(result.include).toEqual([]);
  });

  it("base なし: local と template の和集合（削除は伝播しない）", () => {
    const result = mergeConfigPatterns({
      base: undefined,
      local: { include: [".claude/**", ".eslintrc.json"], exclude: [] },
      template: { include: [".claude/**", ".github/**"], exclude: [] },
    });
    expect(result.include).toEqual([".claude/**", ".eslintrc.json", ".github/**"]);
  });

  it("exclude も独立にマージする", () => {
    const result = mergeConfigPatterns({
      base: { include: [], exclude: ["a"] },
      local: { include: [], exclude: ["a", "b"] },
      template: { include: [], exclude: ["a", "c"] },
    });
    expect(result.exclude).toEqual(["a", "b", "c"]);
  });

  it("出現順を保つ（base → 追加分の順）", () => {
    const result = mergeConfigPatterns({
      base: { include: ["1", "2"], exclude: [] },
      local: { include: ["1", "2", "L"], exclude: [] },
      template: { include: ["1", "2", "T"], exclude: [] },
    });
    expect(result.include).toEqual(["1", "2", "L", "T"]);
  });
});

describe("computeMergedZikuConfig（ファイル読み込み + マージ）", () => {
  beforeEach(() => {
    vol.reset();
  });

  it("移行: track 追加済みローカル（base = 履歴テンプレ）の追加を保持する", async () => {
    // 旧テンプレ（履歴 base）には .eslintrc が無い。ローカルは track で追加済み。
    vol.fromJSON({
      "/base/.ziku/ziku.jsonc": JSON.stringify({ include: [".claude/**"] }, null, 2),
      "/local/.ziku/ziku.jsonc": JSON.stringify(
        { include: [".claude/**", ".eslintrc.json"] },
        null,
        2,
      ),
      "/template/.ziku/ziku.jsonc": JSON.stringify({ include: [".claude/**"] }, null, 2),
    });

    const merged = await computeMergedZikuConfig({
      targetDir: "/local",
      templateDir: "/template",
      baseTemplateDir: "/base",
    });
    const parsed = JSON.parse(merged);
    // track 追加が保持される（消えない・テンプレへ伝播できる）
    expect(parsed.include).toContain(".eslintrc.json");
    expect(parsed.include).toContain(".claude/**");
  });

  it("base 無し（baseTemplateDir undefined）は和集合にフォールバックする", async () => {
    vol.fromJSON({
      "/local/.ziku/ziku.jsonc": JSON.stringify(
        { include: [".claude/**", ".eslintrc.json"] },
        null,
        2,
      ),
      "/template/.ziku/ziku.jsonc": JSON.stringify(
        { include: [".claude/**", ".github/**"] },
        null,
        2,
      ),
    });

    const merged = await computeMergedZikuConfig({
      targetDir: "/local",
      templateDir: "/template",
      baseTemplateDir: undefined,
    });
    const parsed = JSON.parse(merged);
    expect(parsed.include).toEqual([".claude/**", ".eslintrc.json", ".github/**"]);
  });

  it("base あり: テンプレ側の削除がローカルへ伝播する（完全 3-way）", async () => {
    vol.fromJSON({
      "/base/.ziku/ziku.jsonc": JSON.stringify({ include: [".claude/**", ".old/**"] }, null, 2),
      "/local/.ziku/ziku.jsonc": JSON.stringify({ include: [".claude/**", ".old/**"] }, null, 2),
      "/template/.ziku/ziku.jsonc": JSON.stringify({ include: [".claude/**"] }, null, 2),
    });

    const merged = await computeMergedZikuConfig({
      targetDir: "/local",
      templateDir: "/template",
      baseTemplateDir: "/base",
    });
    const parsed = JSON.parse(merged);
    expect(parsed.include).toEqual([".claude/**"]);
  });
});
