import { readFileSync, readdirSync } from "node:fs";
import { join, relative } from "pathe";
import { describe, expect, it } from "vitest";
import { isParsableJsonc, parseJsonc } from "../jsonc";

describe("parseJsonc", () => {
  it("構文が通れば値を返す", () => {
    expect(parseJsonc('{ "include": [".claude/**"] }')).toEqual({
      kind: "parsed",
      value: { include: [".claude/**"] },
    });
  });

  it("注釈と末尾カンマを許容する（利用者が手で書く JSONC 方言）", () => {
    expect(parseJsonc('{\n  // patterns\n  "include": [".claude/**",],\n}')).toEqual({
      kind: "parsed",
      value: { include: [".claude/**"] },
    });
  });

  it("回復できる壊れ方でも unparsable として返す（部分的な値を渡さない）", () => {
    // 素の parse なら { include: [".claude/**"] } が返る入力。
    const result = parseJsonc('{\n  "include": [".claude/**",\n}\n');

    expect(result.kind).toBe("unparsable");
  });

  it("最初の破綻だけを行・桁で示す", () => {
    const result = parseJsonc('{\n  "include": [".claude/**",\n}\n');

    expect(result).toEqual({ kind: "unparsable", detail: expect.stringContaining("line 3") });
  });

  it("オブジェクトでない値も parsed として返す（形の判定は呼び出し側の責務）", () => {
    expect(parseJsonc('"just a string"')).toEqual({ kind: "parsed", value: "just a string" });
  });
});

describe("isParsableJsonc", () => {
  it.each([
    ['{ "a": 1 }', true],
    ["{ /* comment */ }", true],
    ["{ [ }", false],
    ["", false],
  ])("%s → %s", (content, expected) => {
    expect(isParsableJsonc(content)).toBe(expected);
  });
});

/**
 * 素の `parse` の誤用は、呼び出し側のレビューでは見つけにくい（診断を渡さない呼び出しは
 * 型としては正しく、壊れた入力でだけ挙動が変わる）。入口を 1 つに保つことをここで検査し、
 * 新しい呼び出し側が jsonc-parser を直接使い始めたら CI で落とす。
 */
describe("jsonc-parser の入口は src/utils/jsonc.ts だけ", () => {
  const SRC = join(process.cwd(), "src");
  const ENTRY_POINT = "utils/jsonc.ts";

  const sourceFiles = (dir: string): string[] =>
    readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
      const full = join(dir, entry.name);
      if (entry.isDirectory()) return entry.name === "__tests__" ? [] : sourceFiles(full);
      return entry.name.endsWith(".ts") && !entry.name.endsWith(".test.ts") ? [full] : [];
    });

  it("他のモジュールは jsonc-parser を import しない", () => {
    const importers = sourceFiles(SRC)
      .filter((file) => /from\s+["']jsonc-parser["']/.test(readFileSync(file, "utf-8")))
      .map((file) => relative(SRC, file));

    expect(importers).toEqual([ENTRY_POINT]);
  });
});
