/**
 * 構文が壊れた `ziku.jsonc` を読んだときの振る舞い。
 *
 * jsonc-parser のエラー回復は、閉じ括弧を失ったテキストからでも部分的な値を返す。
 * その値を「読めた」と受け取ると、書き戻す入口では壊れたテキストの部分編集になり、
 * 読み取る入口ではテンプレートが定めた範囲が静かに縮む。入口ごとに何をするかを
 * ここで固定する。
 */
import { Cause, Effect, Exit, Option } from "effect";
import { vol } from "memfs";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { ScopedZikuConfig } from "../config-merge";

vi.mock("node:fs", async () => (await import("memfs")).fs);
vi.mock("node:fs/promises", async () => (await import("memfs")).fs.promises);

const { absPath, globPatterns, repoRelPaths } = await import("../../__tests__/brands");
const { withPatterns, generateZikuJsonc } = await import("../ziku-config");
const {
  analyzeConfigDrift,
  computeMergedZikuConfig,
  computeScopedZikuConfig,
  findLocalOnlyPatternsForPaths,
} = await import("../config-merge");
const { loadTemplateConfig } = await import("../template-config");
const { resolveSyncScope } = await import("../sync-scope");
const { generateReadme } = await import("../readme");
const { parseJsonc } = await import("../jsonc");

/**
 * テンプレートに `ziku.jsonc` がある前提のケースで、組み立てた内容を取り出す。
 * 足す先が無いケース（`NoTemplateConfig`）は別のテストが扱う。
 */
function scopedContent(result: ScopedZikuConfig): string {
  if (result._tag !== "Scoped") throw new Error(`expected Scoped, got ${result._tag}`);
  return result.content;
}

/** 閉じ括弧を失ったテンプレートの `ziku.jsonc`。回復すると `{ include: [...] }` が取れる。 */
const BROKEN_CONFIG = '{\n  // template config\n  "include": [".claude/**",\n}\n';

const VALID_CONFIG = JSON.stringify({ include: [".claude/**"] }, null, 2);

describe("withPatterns（壊れた内容は編集せず作り直す）", () => {
  const patterns = { include: globPatterns([".claude/**", ".github/**"]), exclude: [] };

  it("構文が壊れていれば部分編集せず generateZikuJsonc で作り直す", () => {
    const result = withPatterns(BROKEN_CONFIG, patterns);

    expect(result).toBe(generateZikuJsonc(patterns));
    // 壊れた元テキストの断片が残っていない = modify / applyEdits を通っていない
    expect(result).not.toContain("// template config");
  });

  it("作り直した内容は有効な jsonc としてパースできる", () => {
    const result = withPatterns(BROKEN_CONFIG, patterns);

    expect(parseJsonc(result)).toEqual({
      kind: "parsed",
      value: expect.objectContaining({ include: [".claude/**", ".github/**"] }),
    });
  });

  it("構文が通る内容は作り直さず、注釈を残したまま部分編集する", () => {
    const raw = '{\n  // template config\n  "include": [".claude/**"]\n}\n';
    const result = withPatterns(raw, patterns);

    expect(result).toContain("// template config");
    expect(parseJsonc(result)).toMatchObject({ kind: "parsed" });
  });
});

describe("readConfigAt 経由の入口（テンプレートが壊れていれば中断する）", () => {
  beforeEach(() => {
    vol.reset();
  });

  const writeBrokenTemplate = (): void => {
    vol.fromJSON({
      "/local/.ziku/ziku.jsonc": VALID_CONFIG,
      "/template/.ziku/ziku.jsonc": BROKEN_CONFIG,
    });
  };

  const expectConfigUnparsable = async (run: () => Promise<unknown>): Promise<void> => {
    await expect(run()).rejects.toMatchObject({
      _tag: "ZikuFailure",
      reason: { kind: "ConfigUnparsable", path: "/template/.ziku/ziku.jsonc" },
    });
  };

  it("push の自動 include（computeScopedZikuConfig）は壊れたテンプレートへ書き戻さない", async () => {
    writeBrokenTemplate();

    await expectConfigUnparsable(() =>
      computeScopedZikuConfig({
        templateDir: absPath("/template"),
        additionalIncludes: globPatterns([".github/**"]),
      }),
    );
  });

  it("union マージ（computeMergedZikuConfig）も同じく中断する", async () => {
    writeBrokenTemplate();

    await expectConfigUnparsable(() =>
      computeMergedZikuConfig({
        targetDir: absPath("/local"),
        templateDir: absPath("/template"),
      }),
    );
  });

  it("drift 判定（analyzeConfigDrift）も同じく中断する", async () => {
    writeBrokenTemplate();

    await expectConfigUnparsable(() =>
      analyzeConfigDrift(absPath("/local"), absPath("/template"), undefined),
    );
  });

  it("スコープ計算（findLocalOnlyPatternsForPaths）も同じく中断する", async () => {
    writeBrokenTemplate();

    await expectConfigUnparsable(() =>
      findLocalOnlyPatternsForPaths({
        targetDir: absPath("/local"),
        templateDir: absPath("/template"),
        paths: repoRelPaths([".github/workflows/ci.yml"]),
      }),
    );
  });

  it("壊れた箇所を行・桁で示す", async () => {
    writeBrokenTemplate();

    await expect(
      computeScopedZikuConfig({
        templateDir: absPath("/template"),
        additionalIncludes: globPatterns([".github/**"]),
      }),
    ).rejects.toMatchObject({ hint: expect.stringContaining("line 4, column") });
  });

  it("テンプレートが壊れていなければ通常どおりマージする", async () => {
    vol.fromJSON({
      "/local/.ziku/ziku.jsonc": VALID_CONFIG,
      "/template/.ziku/ziku.jsonc": VALID_CONFIG,
    });

    const merged = scopedContent(
      await computeScopedZikuConfig({
        templateDir: absPath("/template"),
        additionalIncludes: globPatterns([".github/**"]),
      }),
    );
    expect(parseJsonc(merged)).toMatchObject({
      kind: "parsed",
      value: { include: [".claude/**", ".github/**"] },
    });
  });
});

describe("loadTemplateConfig（壊れていればパターン無しではなく失敗を返す）", () => {
  beforeEach(() => {
    vol.reset();
  });

  const failureOf = async (dir: string): Promise<unknown> => {
    const exit = await Effect.runPromiseExit(loadTemplateConfig(absPath(dir)));
    return Exit.isFailure(exit) ? Cause.failureOption(exit.cause) : undefined;
  };

  it("構文が壊れていれば ParseError を返す（回復した部分的な include を採らない）", async () => {
    vol.fromJSON({ "/template/.ziku/ziku.jsonc": BROKEN_CONFIG });

    expect(await failureOf("/template")).toMatchObject(
      Option.some(
        expect.objectContaining({ _tag: "ParseError", path: "/template/.ziku/ziku.jsonc" }),
      ),
    );
  });

  it("ファイルが無い場合は TemplateNotConfiguredError のまま（壊れているとは別の失敗）", async () => {
    vol.fromJSON({ "/template/README.md": "" });

    expect(await failureOf("/template")).toMatchObject(
      Option.some(expect.objectContaining({ _tag: "TemplateNotConfiguredError" })),
    );
  });
});

describe("走査範囲の解決（壊れていれば範囲を空へ潰さず中断する）", () => {
  beforeEach(() => {
    vol.reset();
  });

  it("テンプレートが壊れていれば ConfigUnparsable として中断する", async () => {
    vol.fromJSON({
      "/local/.ziku/ziku.jsonc": VALID_CONFIG,
      "/template/.ziku/ziku.jsonc": BROKEN_CONFIG,
    });

    // 空のパターンへ潰すと「テンプレートは何も同期対象と定めていない」が走査範囲になり、
    // テンプレートが追跡しているファイルが差分に現れないまま同期済みと報告される。
    await expect(
      resolveSyncScope({
        targetDir: absPath("/local"),
        templateDir: absPath("/template"),
        include: globPatterns([".claude/**"]),
        exclude: [],
        basePatterns: undefined,
      }),
    ).rejects.toMatchObject({
      _tag: "ZikuFailure",
      reason: { kind: "ConfigUnparsable", path: "/template/.ziku/ziku.jsonc" },
    });
  });

  it("テンプレートに ziku.jsonc が無ければローカルのパターンだけで範囲を組む", async () => {
    vol.fromJSON({
      "/local/.ziku/ziku.jsonc": VALID_CONFIG,
      "/template/README.md": "",
    });

    const { scope, newInclude } = await resolveSyncScope({
      targetDir: absPath("/local"),
      templateDir: absPath("/template"),
      include: globPatterns([".claude/**"]),
      exclude: [],
      basePatterns: undefined,
    });

    expect(scope.declared.include).toEqual([".claude/**"]);
    expect(newInclude).toEqual([]);
  });
});

describe("README 生成（壊れていればマーカー間を書き換えない）", () => {
  beforeEach(() => {
    vol.reset();
  });

  it("回復した部分的な include で短いファイル一覧を書き出さない", async () => {
    vol.fromJSON({
      "/project/README.md": "# P\n\n<!-- FILES:START -->\nOld content\n<!-- FILES:END -->\n",
      "/project/.ziku/ziku.jsonc": BROKEN_CONFIG,
    });

    const result = await generateReadme({
      readmePath: "/project/README.md",
      configDir: "/project",
    });

    expect(result.updated).toBe(false);
    expect(result.content).toContain("Old content");
    expect(result.content).not.toContain(".claude/**");
  });
});
