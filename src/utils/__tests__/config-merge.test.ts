import { vol } from "memfs";
import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("node:fs", async () => (await import("memfs")).fs);
vi.mock("node:fs/promises", async () => (await import("memfs")).fs.promises);

const { absPath, globPatterns, repoRelPaths } = await import("../../__tests__/brands");
const {
  mergeConfigPatterns,
  computeMergedZikuConfig,
  computeScopedZikuConfig,
  analyzeConfigDrift,
  findLocalOnlyPatternsForPaths,
} = await import("../config-merge");
const { parse: parseJsonc } = await import("jsonc-parser");

describe("mergeConfigPatterns（要素レベル加法マージ＝和集合）", () => {
  it("ローカルとテンプレ双方の追加を保持する", () => {
    const result = mergeConfigPatterns({
      local: { include: globPatterns([".claude/**", ".eslintrc.json"]), exclude: [] },
      template: { include: globPatterns([".claude/**", ".github/**"]), exclude: [] },
    });
    expect(result.include).toEqual([".claude/**", ".eslintrc.json", ".github/**"]);
  });

  it("削除は伝播しない（片側に無いパターンも結果に残る）", () => {
    // ローカルが .old/** を持たなくても、テンプレにあれば結果に残る（和集合）。
    const result = mergeConfigPatterns({
      local: { include: globPatterns([".claude/**"]), exclude: [] },
      template: { include: globPatterns([".claude/**", ".old/**"]), exclude: [] },
    });
    expect(result.include).toEqual([".claude/**", ".old/**"]);
  });

  it("exclude も独立に和集合でマージする", () => {
    const result = mergeConfigPatterns({
      local: { include: [], exclude: globPatterns(["a", "b"]) },
      template: { include: [], exclude: globPatterns(["a", "c"]) },
    });
    expect(result.exclude).toEqual(["a", "b", "c"]);
  });

  it("出現順を保つ（ローカル優先 → テンプレ追加分）", () => {
    const result = mergeConfigPatterns({
      local: { include: globPatterns(["L1", "shared"]), exclude: [] },
      template: { include: globPatterns(["shared", "T1"]), exclude: [] },
    });
    expect(result.include).toEqual(["L1", "shared", "T1"]);
  });

  it("重複を除去する", () => {
    const result = mergeConfigPatterns({
      local: { include: globPatterns([".claude/**", ".claude/**"]), exclude: [] },
      template: { include: globPatterns([".claude/**"]), exclude: [] },
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
      targetDir: absPath("/local"),
      templateDir: absPath("/template"),
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
      targetDir: absPath("/local"),
      templateDir: absPath("/template"),
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
      targetDir: absPath("/local"),
      templateDir: absPath("/template"),
    });
    const parsed = JSON.parse(merged);
    expect(parsed.include).toEqual([".claude/**"]);
  });

  it("ローカルのコメントと ziku が読まないキーを残す", async () => {
    // 拡張子が .jsonc なのは注釈を書けるようにするため。作り直すと同期のたびに消える。
    vol.fromJSON({
      "/local/.ziku/ziku.jsonc": [
        "{",
        "  // ルールだけ同期する",
        '  "include": [".claude/**"],',
        '  "$comment": "keep me"',
        "}",
        "",
      ].join("\n"),
      "/template/.ziku/ziku.jsonc": JSON.stringify({ include: [".github/**"] }, null, 2),
    });

    const merged = await computeMergedZikuConfig({
      targetDir: absPath("/local"),
      templateDir: absPath("/template"),
    });

    expect(merged).toContain("// ルールだけ同期する");
    expect(merged).toContain('"$comment": "keep me"');
    expect(parseJsonc(merged).include).toEqual([".claude/**", ".github/**"]);
  });

  it("取り込むパターンが無ければ元の内容をそのまま返す", async () => {
    // 同じ値でも書き直すと利用者の書式が同期のたびに変わる。
    const raw = ["{", "  // keep", '  "include": [".claude/**"]', "}", ""].join("\n");
    vol.fromJSON({
      "/local/.ziku/ziku.jsonc": raw,
      "/template/.ziku/ziku.jsonc": JSON.stringify({ include: [".claude/**"] }, null, 2),
    });

    expect(
      await computeMergedZikuConfig({
        targetDir: absPath("/local"),
        templateDir: absPath("/template"),
      }),
    ).toBe(raw);
  });
});

describe("computeScopedZikuConfig（テンプレ側の内容 + 明示した追加分だけ）", () => {
  beforeEach(() => {
    vol.reset();
  });

  it("テンプレートのコメントを残したままパターンを足す", async () => {
    // 送り先はテンプレートで、ローカルへは書き戻さない。作り直すと 1 回の push で
    // そのテンプレートを使う全利用者から注釈が消える。
    vol.fromJSON({
      "/template/.ziku/ziku.jsonc": [
        "{",
        "  // 共通ルール",
        '  "include": [".claude/**"]',
        "}",
        "",
      ].join("\n"),
    });

    const merged = await computeScopedZikuConfig({
      templateDir: absPath("/template"),
      additionalIncludes: globPatterns([".mcp.json"]),
    });

    expect(merged).toContain("// 共通ルール");
    expect(parseJsonc(merged).include).toEqual([".mcp.json", ".claude/**"]);
  });
});

describe("analyzeConfigDrift（union 観点の実差分判定）", () => {
  beforeEach(() => {
    vol.reset();
  });

  const write = (local: string[], template: string[]) =>
    vol.fromJSON({
      "/local/.ziku/ziku.jsonc": JSON.stringify({ include: local }, null, 2),
      "/template/.ziku/ziku.jsonc": JSON.stringify({ include: template }, null, 2),
    });

  it("完全一致なら pull も push も不要", async () => {
    write([".a/**"], [".a/**"]);
    expect(await analyzeConfigDrift(absPath("/local"), absPath("/template"))).toEqual({
      pullRelevant: false,
      pushRelevant: false,
    });
  });

  it("テンプレに追加分がある → pullRelevant", async () => {
    write([".a/**"], [".a/**", ".b/**"]);
    const d = await analyzeConfigDrift(absPath("/local"), absPath("/template"));
    expect(d.pullRelevant).toBe(true);
    expect(d.pushRelevant).toBe(false);
  });

  it("ローカルに追加分がある → pushRelevant", async () => {
    write([".a/**", ".b/**"], [".a/**"]);
    const d = await analyzeConfigDrift(absPath("/local"), absPath("/template"));
    expect(d.pullRelevant).toBe(false);
    expect(d.pushRelevant).toBe(true);
  });

  it("テンプレ側だけがパターン削除（ローカルが保持）→ pull 不要・push のみ（no-op ループにならない）", async () => {
    // local=[a,b], template=[a]（b を削除）。union=[a,b]==local → pull 不要。
    // union≠template → push 観点では「ローカルに余分」= pushRelevant。
    write([".a/**", ".b/**"], [".a/**"]);
    const d = await analyzeConfigDrift(absPath("/local"), absPath("/template"));
    expect(d.pullRelevant).toBe(false);
  });
});

describe("findLocalOnlyPatternsForPaths（#90: 事前追跡パターンの関連性スコープ計算）", () => {
  beforeEach(() => {
    vol.reset();
  });

  const write = (local: string[], template: string[]) =>
    vol.fromJSON({
      "/local/.ziku/ziku.jsonc": JSON.stringify({ include: local }, null, 2),
      "/template/.ziku/ziku.jsonc": JSON.stringify({ include: template }, null, 2),
    });

  it("push されるパスと一致するローカル限定パターンだけを返す", async () => {
    write([".github/**", ".claude/skills/new-skill/SKILL.md"], [".github/**"]);

    const result = await findLocalOnlyPatternsForPaths({
      targetDir: absPath("/local"),
      templateDir: absPath("/template"),
      paths: repoRelPaths([".claude/skills/new-skill/SKILL.md"]),
    });
    expect(result).toEqual([".claude/skills/new-skill/SKILL.md"]);
  });

  it("push されるパスに無関係なローカル限定パターンは含めない（leak しない）", async () => {
    write(
      [".github/**", ".claude/skills/new-skill/SKILL.md", ".claude/rules/unrelated.md"],
      [".github/**"],
    );

    const result = await findLocalOnlyPatternsForPaths({
      targetDir: absPath("/local"),
      templateDir: absPath("/template"),
      paths: repoRelPaths([".claude/skills/new-skill/SKILL.md"]),
    });
    expect(result).toEqual([".claude/skills/new-skill/SKILL.md"]);
    expect(result).not.toContain(".claude/rules/unrelated.md");
  });

  it("テンプレに既にあるパターンは対象外", async () => {
    write([".github/**", "already-synced.md"], [".github/**", "already-synced.md"]);

    const result = await findLocalOnlyPatternsForPaths({
      targetDir: absPath("/local"),
      templateDir: absPath("/template"),
      paths: repoRelPaths(["already-synced.md"]),
    });
    expect(result).toEqual([]);
  });

  it("paths が空なら空を返す", async () => {
    write([".github/**", "new-file.md"], [".github/**"]);

    const result = await findLocalOnlyPatternsForPaths({
      targetDir: absPath("/local"),
      templateDir: absPath("/template"),
      paths: [],
    });
    expect(result).toEqual([]);
  });
});
