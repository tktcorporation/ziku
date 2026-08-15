/**
 * スキーマ違反の `ziku.jsonc` を読んだときの振る舞い。
 *
 * 構文は通るが ziku の設定として解釈できない内容（`"include": "a"` のような型違い）は、
 * 読む入口がどこであっても構文エラーではなくスキーマ違反として報告する。構文エラーとして
 * 報告すると、利用者は壊れていない JSONC の中で存在しない構文ミスを探すことになる。
 *
 * 入口ごとに失敗の運び方（Effect のエラーチャネル / throw）は違うので、そこから先の型では
 * 揃っていることを示せない。分類が 1 箇所（`readZikuConfig`）に閉じていることを、
 * 各入口の報告内容で固定する。
 */
import { Cause, Effect, Exit, Option } from "effect";
import { vol } from "memfs";
import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("node:fs", async () => (await import("memfs")).fs);
vi.mock("node:fs/promises", async () => (await import("memfs")).fs.promises);

const { absPath, globPatterns } = await import("../../__tests__/brands");
const { loadZikuConfig, ZIKU_CONFIG_FILE } = await import("../ziku-config");
const { computeScopedZikuConfig } = await import("../config-merge");
const { loadTemplateConfig } = await import("../template-config");
const { resolveSyncScope } = await import("../sync-scope");

/** 構文としては読めるが、include が配列ではないテンプレートの `ziku.jsonc`。 */
const INVALID_CONFIG = '{\n  // template config\n  "include": "a"\n}\n';

const VALID_CONFIG = JSON.stringify({ include: [".claude/**"] }, null, 2);

const TEMPLATE_CONFIG_PATH = "/template/.ziku/ziku.jsonc";

/** テンプレートだけがスキーマ違反の状態を作る。 */
function writeInvalidTemplate(): void {
  vol.fromJSON({
    "/local/.ziku/ziku.jsonc": VALID_CONFIG,
    [TEMPLATE_CONFIG_PATH]: INVALID_CONFIG,
  });
}

/** 失敗として報告された `ZikuFailure` を、どのキーが問題かまで含めて確かめる。 */
async function expectConfigInvalid(run: () => Promise<unknown>): Promise<void> {
  await expect(run()).rejects.toMatchObject({
    _tag: "ZikuFailure",
    reason: {
      kind: "ConfigInvalid",
      path: TEMPLATE_CONFIG_PATH,
      issues: [expect.stringContaining("include: ")],
    },
    message: `Failed to read ${TEMPLATE_CONFIG_PATH}`,
  });
}

describe("スキーマ違反の ziku.jsonc（構文エラーではなく検証失敗として報告する）", () => {
  beforeEach(() => {
    vol.reset();
  });

  it("走査範囲の解決（resolveSyncScope）は ConfigInvalid として中断する", async () => {
    writeInvalidTemplate();

    await expectConfigInvalid(() =>
      resolveSyncScope({
        targetDir: absPath("/local"),
        templateDir: absPath("/template"),
        include: globPatterns([".claude/**"]),
        exclude: [],
      }),
    );
  });

  it("union マージ経路（computeScopedZikuConfig）も同じ分類で中断する", async () => {
    writeInvalidTemplate();

    await expectConfigInvalid(() =>
      computeScopedZikuConfig({
        templateDir: absPath("/template"),
        additionalIncludes: globPatterns([".github/**"]),
      }),
    );
  });

  it("テンプレート設定の読み込み（loadTemplateConfig）は ValidationError を返す", async () => {
    vol.fromJSON({ [TEMPLATE_CONFIG_PATH]: INVALID_CONFIG });

    const exit = await Effect.runPromiseExit(loadTemplateConfig(absPath("/template")));
    const failure = Exit.isFailure(exit) ? Cause.failureOption(exit.cause) : undefined;

    expect(failure).toMatchObject(
      Option.some(
        expect.objectContaining({
          _tag: "ValidationError",
          path: TEMPLATE_CONFIG_PATH,
          issues: [expect.stringContaining("include: ")],
        }),
      ),
    );
  });

  it("ローカル設定の読み込み（loadZikuConfig）も ValidationError を返す", async () => {
    vol.fromJSON({ "/local/.ziku/ziku.jsonc": INVALID_CONFIG });

    const exit = await Effect.runPromiseExit(loadZikuConfig(absPath("/local")));
    const failure = Exit.isFailure(exit) ? Cause.failureOption(exit.cause) : undefined;

    expect(failure).toMatchObject(
      Option.some(
        expect.objectContaining({
          _tag: "ValidationError",
          path: ZIKU_CONFIG_FILE,
          issues: [expect.stringContaining("include: ")],
        }),
      ),
    );
  });

  it("スキーマ違反を構文の破綻として報告しない（行・桁の案内を出さない）", async () => {
    writeInvalidTemplate();

    await expect(
      resolveSyncScope({
        targetDir: absPath("/local"),
        templateDir: absPath("/template"),
        include: globPatterns([".claude/**"]),
        exclude: [],
      }),
    ).rejects.toMatchObject({
      reason: { kind: "ConfigInvalid" },
      hint: expect.not.stringContaining("column"),
    });
  });
});
