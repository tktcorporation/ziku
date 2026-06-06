import { vol } from "memfs";
import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("node:fs", async () => (await import("memfs")).fs);
vi.mock("node:fs/promises", async () => (await import("memfs")).fs.promises);

const { mergeConfigPatterns, computeMergedZikuConfig } = await import("../config-merge");

describe("mergeConfigPatterns（要素レベル加法マージ＝和集合）", () => {
  it("ローカルとテンプレ双方の追加を保持する", () => {
    const result = mergeConfigPatterns({
      local: { include: [".claude/**", ".eslintrc.json"], exclude: [] },
      template: { include: [".claude/**", ".github/**"], exclude: [] },
    });
    expect(result.include).toEqual([".claude/**", ".eslintrc.json", ".github/**"]);
  });

  it("削除は伝播しない（片側に無いパターンも結果に残る）", () => {
    // ローカルが .old/** を持たなくても、テンプレにあれば結果に残る（和集合）。
    const result = mergeConfigPatterns({
      local: { include: [".claude/**"], exclude: [] },
      template: { include: [".claude/**", ".old/**"], exclude: [] },
    });
    expect(result.include).toEqual([".claude/**", ".old/**"]);
  });

  it("exclude も独立に和集合でマージする", () => {
    const result = mergeConfigPatterns({
      local: { include: [], exclude: ["a", "b"] },
      template: { include: [], exclude: ["a", "c"] },
    });
    expect(result.exclude).toEqual(["a", "b", "c"]);
  });

  it("出現順を保つ（ローカル優先 → テンプレ追加分）", () => {
    const result = mergeConfigPatterns({
      local: { include: ["L1", "shared"], exclude: [] },
      template: { include: ["shared", "T1"], exclude: [] },
    });
    expect(result.include).toEqual(["L1", "shared", "T1"]);
  });

  it("重複を除去する", () => {
    const result = mergeConfigPatterns({
      local: { include: [".claude/**", ".claude/**"], exclude: [] },
      template: { include: [".claude/**"], exclude: [] },
    });
    expect(result.include).toEqual([".claude/**"]);
  });
});

describe("computeMergedZikuConfig（ファイル読み込み + 和集合マージ）", () => {
  beforeEach(() => {
    vol.reset();
  });

  it("track 追加済みローカルの追加を保持し、テンプレのパターンも残す", async () => {
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
    });
    const parsed = JSON.parse(merged);
    expect(parsed.include).toEqual([".claude/**", ".eslintrc.json", ".github/**"]);
  });

  it("部分集合ローカル + テンプレ full でも、未選択パターンを削除しない（テンプレ保護）", async () => {
    // 部分集合 init + track 後に conflict 解決される状況。和集合なので
    // テンプレの未選択パターン（.devcontainer/**）は決して消えない。
    vol.fromJSON({
      "/local/.ziku/ziku.jsonc": JSON.stringify({ include: [".claude/**", ".foo"] }, null, 2),
      "/template/.ziku/ziku.jsonc": JSON.stringify(
        { include: [".claude/**", ".devcontainer/**"] },
        null,
        2,
      ),
    });

    const merged = await computeMergedZikuConfig({
      targetDir: "/local",
      templateDir: "/template",
    });
    const parsed = JSON.parse(merged);
    expect(parsed.include).toContain(".devcontainer/**"); // 未選択でも消えない
    expect(parsed.include).toContain(".foo"); // ローカルの追加も保持
    expect(parsed.include).toContain(".claude/**");
  });

  it("ローカルに ziku.jsonc が無い場合はテンプレ側のみを採用する", async () => {
    vol.fromJSON({
      "/template/.ziku/ziku.jsonc": JSON.stringify({ include: [".claude/**"] }, null, 2),
    });

    const merged = await computeMergedZikuConfig({
      targetDir: "/local",
      templateDir: "/template",
    });
    const parsed = JSON.parse(merged);
    expect(parsed.include).toEqual([".claude/**"]);
  });
});
