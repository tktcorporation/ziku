import { describe, expect, it } from "vitest";
import { globPatterns } from "../../__tests__/brands";
import { unionPatterns } from "../patterns";

describe("unionPatterns", () => {
  it("ローカルの並びを保ち、ローカルに無いパターンだけを末尾へ足す", () => {
    const result = unionPatterns(
      globPatterns([".claude/**", ".eslintrc.json"]),
      globPatterns([".claude/**", ".github/**"]),
    );

    expect(result.merged).toEqual([".claude/**", ".eslintrc.json", ".github/**"]);
    expect(result.added).toEqual([".github/**"]);
  });

  it("両側の重複を除去する（往復適用しても増えない）", () => {
    const once = unionPatterns(globPatterns([".a", ".a", ".b"]), globPatterns([".b", ".c", ".c"]));
    const twice = unionPatterns(once.merged, globPatterns([".b", ".c"]));

    expect(once.merged).toEqual([".a", ".b", ".c"]);
    expect(twice.merged).toEqual(once.merged);
    expect(twice.added).toEqual([]);
  });

  it("どちらの側のパターンも落とさない", () => {
    const result = unionPatterns(globPatterns([".local-only"]), globPatterns([".template-only"]));

    expect(result.merged).toEqual([".local-only", ".template-only"]);
  });

  it("片側が空でももう片側をそのまま返す", () => {
    expect(unionPatterns([], globPatterns([".a", ".b"]))).toEqual({
      merged: [".a", ".b"],
      added: [".a", ".b"],
    });
    expect(unionPatterns(globPatterns([".a"]), [])).toEqual({ merged: [".a"], added: [] });
  });
});
