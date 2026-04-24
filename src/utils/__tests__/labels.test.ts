import { Effect, Exit } from "effect";
import { describe, expect, it } from "vitest";
import type { ZikuConfig } from "../../modules/schemas";
import {
  UnknownLabelError,
  mergeLabelDefinitions,
  parseLabelsFlag,
  resolveLabeledPatterns,
} from "../labels";

const baseConfig: ZikuConfig = {
  include: ["README.md", ".mcp.json"],
  exclude: ["*.secret"],
  labels: {
    docs: {
      include: ["docs/**", "README.md"],
      exclude: ["docs/internal/**"],
    },
    ci: {
      include: [".github/workflows/**"],
    },
    devcontainer: {
      include: [".devcontainer/**"],
    },
  },
};

describe("resolveLabeledPatterns", () => {
  it("ラベルフィルタ未指定時はトップレベル + 全ラベルの合集合を返す", async () => {
    const result = await Effect.runPromise(resolveLabeledPatterns(baseConfig));

    expect(result.include).toEqual(
      expect.arrayContaining([
        "README.md",
        ".mcp.json",
        "docs/**",
        ".github/workflows/**",
        ".devcontainer/**",
      ]),
    );
    expect(result.exclude).toEqual(expect.arrayContaining(["*.secret", "docs/internal/**"]));
  });

  it("--labels docs 指定時はトップレベル + docs のみ", async () => {
    const result = await Effect.runPromise(
      resolveLabeledPatterns(baseConfig, { include: ["docs"] }),
    );

    expect(result.include).toEqual(expect.arrayContaining(["README.md", ".mcp.json", "docs/**"]));
    expect(result.include).not.toContain(".github/workflows/**");
    expect(result.include).not.toContain(".devcontainer/**");
    expect(result.exclude).toEqual(expect.arrayContaining(["*.secret", "docs/internal/**"]));
  });

  it("複数ラベル指定は OR マッチで合集合", async () => {
    const result = await Effect.runPromise(
      resolveLabeledPatterns(baseConfig, { include: ["docs", "ci"] }),
    );

    expect(result.include).toEqual(expect.arrayContaining(["docs/**", ".github/workflows/**"]));
    expect(result.include).not.toContain(".devcontainer/**");
  });

  it("同じパターンが複数ソースに現れても重複排除される", async () => {
    const result = await Effect.runPromise(
      resolveLabeledPatterns(baseConfig, { include: ["docs"] }),
    );

    const readmeCount = result.include.filter((p) => p === "README.md").length;
    expect(readmeCount).toBe(1);
  });

  it("--skip-labels で指定したラベルは除外される", async () => {
    const result = await Effect.runPromise(
      resolveLabeledPatterns(baseConfig, { skip: ["devcontainer"] }),
    );

    expect(result.include).toEqual(expect.arrayContaining(["docs/**", ".github/workflows/**"]));
    expect(result.include).not.toContain(".devcontainer/**");
  });

  it("--labels と --skip-labels の両方指定時は include 後に skip を差し引く", async () => {
    const result = await Effect.runPromise(
      resolveLabeledPatterns(baseConfig, { include: ["docs", "ci"], skip: ["ci"] }),
    );

    expect(result.include).toContain("docs/**");
    expect(result.include).not.toContain(".github/workflows/**");
  });

  it("未知のラベルを include 指定した場合は UnknownLabelError", async () => {
    const exit = await Effect.runPromiseExit(
      resolveLabeledPatterns(baseConfig, { include: ["docs", "unknown"] }),
    );

    expect(Exit.isFailure(exit)).toBe(true);
    if (Exit.isFailure(exit)) {
      const error = exit.cause._tag === "Fail" ? exit.cause.error : null;
      expect(error).toBeInstanceOf(UnknownLabelError);
      if (error instanceof UnknownLabelError) {
        expect(error.unknown).toEqual(["unknown"]);
        expect(error.available).toEqual(["docs", "ci", "devcontainer"]);
      }
    }
  });

  it("未知のラベルを skip 指定した場合も UnknownLabelError", async () => {
    const exit = await Effect.runPromiseExit(
      resolveLabeledPatterns(baseConfig, { skip: ["unknown"] }),
    );

    expect(Exit.isFailure(exit)).toBe(true);
  });

  it("labels が未定義の config でもトップレベル include/exclude を返す", async () => {
    const result = await Effect.runPromise(
      resolveLabeledPatterns({ include: ["*.md"], exclude: ["node_modules/**"] }),
    );

    expect(result.include).toEqual(["*.md"]);
    expect(result.exclude).toEqual(["node_modules/**"]);
  });

  it("labels 未定義時にフィルタを渡すと UnknownLabelError", async () => {
    const exit = await Effect.runPromiseExit(
      resolveLabeledPatterns({ include: ["*.md"] }, { include: ["nonexistent"] }),
    );

    expect(Exit.isFailure(exit)).toBe(true);
  });

  it("exclude が未定義のラベル定義でも正しくマージされる", async () => {
    const config: ZikuConfig = {
      include: [],
      labels: {
        ci: { include: [".github/**"] },
      },
    };

    const result = await Effect.runPromise(resolveLabeledPatterns(config, { include: ["ci"] }));
    expect(result.include).toEqual([".github/**"]);
    expect(result.exclude).toEqual([]);
  });
});

describe("parseLabelsFlag", () => {
  it("カンマ区切り文字列を配列にパースする", () => {
    expect(parseLabelsFlag("docs,ci")).toEqual(["docs", "ci"]);
  });

  it("空白をトリムする", () => {
    expect(parseLabelsFlag(" docs , ci ")).toEqual(["docs", "ci"]);
  });

  it("空要素を除外する", () => {
    expect(parseLabelsFlag("docs,,ci,")).toEqual(["docs", "ci"]);
  });

  it("undefined は undefined を返す", () => {
    expect(parseLabelsFlag(undefined)).toBeUndefined();
  });

  it("空文字列は undefined を返す", () => {
    expect(parseLabelsFlag("")).toBeUndefined();
    expect(parseLabelsFlag("   ")).toBeUndefined();
  });

  it("単一ラベルもパースできる", () => {
    expect(parseLabelsFlag("docs")).toEqual(["docs"]);
  });
});

describe("mergeLabelDefinitions", () => {
  it("テンプレートにしかないラベルはローカルに追加される", () => {
    const result = mergeLabelDefinitions(
      { docs: { include: ["docs/**"] } },
      { docs: { include: ["docs/**"] }, ci: { include: [".github/**"] } },
    );

    expect(result.merged?.ci).toEqual({ include: [".github/**"] });
    expect(result.addedLabels).toEqual(["ci"]);
  });

  it("両方にあるラベルは include/exclude のみマージ（既存パターンは保持）", () => {
    const result = mergeLabelDefinitions(
      { docs: { include: ["docs/**"] } },
      { docs: { include: ["docs/**", "CHANGELOG.md"] } },
    );

    expect(result.merged?.docs?.include).toEqual(["docs/**", "CHANGELOG.md"]);
    expect(result.addedPatterns).toBe(1);
  });

  it("ローカルのラベル名はテンプレートと同名でも定義を維持する", () => {
    const result = mergeLabelDefinitions(
      { docs: { include: ["local-docs/**"] } },
      { docs: { include: ["template-docs/**"] } },
    );

    // ローカルのパターンは保持され、テンプレートのパターンが追加される
    expect(result.merged?.docs?.include).toContain("local-docs/**");
    expect(result.merged?.docs?.include).toContain("template-docs/**");
  });

  it("テンプレートのラベルが空ならローカルはそのまま返る", () => {
    const local = { docs: { include: ["docs/**"] } };
    const result = mergeLabelDefinitions(local, undefined);

    expect(result.merged).toBe(local);
    expect(result.addedLabels).toEqual([]);
    expect(result.addedPatterns).toBe(0);
  });

  it("ローカル未定義 + テンプレートあり → テンプレートの定義が採用される", () => {
    const result = mergeLabelDefinitions(undefined, {
      ci: { include: [".github/**"] },
    });

    expect(result.merged?.ci).toEqual({ include: [".github/**"] });
    expect(result.addedLabels).toEqual(["ci"]);
  });

  it("exclude も正しくマージされる", () => {
    const result = mergeLabelDefinitions(
      { docs: { include: ["docs/**"], exclude: ["docs/secret/**"] } },
      { docs: { include: ["docs/**"], exclude: ["docs/internal/**"] } },
    );

    expect(result.merged?.docs?.exclude).toEqual(["docs/secret/**", "docs/internal/**"]);
  });

  it("既存ラベルへの exclude 追加だけでも addedPatterns に計上される", () => {
    // 回帰: addedPatterns が include 追加のみを見ていたため、
    // テンプレートが exclude だけ追加した場合に呼び出し側で「変更なし」と
    // 誤判定され、merged の exclude が保存されないバグがあった。
    const result = mergeLabelDefinitions(
      { docs: { include: ["docs/**"] } },
      { docs: { include: ["docs/**"], exclude: ["docs/private/**"] } },
    );

    expect(result.merged?.docs?.exclude).toEqual(["docs/private/**"]);
    expect(result.addedPatterns).toBe(1);
  });

  it("新規ラベルの exclude も addedPatterns に計上される", () => {
    const result = mergeLabelDefinitions(undefined, {
      ci: { include: [".github/**"], exclude: [".github/secret/**"] },
    });

    expect(result.merged?.ci?.exclude).toEqual([".github/secret/**"]);
    expect(result.addedPatterns).toBe(2);
  });
});
