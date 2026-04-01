import { describe, expect, it } from "vitest";
import { getAllIncludePatterns, getModuleByName } from "../index";

const sampleModules = [
  {
    name: "A",
    description: "Module A",
    include: ["a.txt", "a.json"],
  },
  { name: "B", description: "Module B", include: ["b.txt"] },
  { name: "C", description: "Module C", include: ["c.txt"] },
];

describe("getModuleByName", () => {
  it("name でモジュールを取得できる", () => {
    const result = getModuleByName("A", sampleModules);
    expect(result?.name).toBe("A");
  });

  it("存在しない name の場合は undefined を返す", () => {
    const result = getModuleByName("nonexistent", sampleModules);
    expect(result).toBeUndefined();
  });

  it("空のモジュールリストから取得すると undefined を返す", () => {
    const result = getModuleByName("A", []);
    expect(result).toBeUndefined();
  });
});

describe("getAllIncludePatterns", () => {
  it("全モジュールの include パターンを取得する", () => {
    const patterns = getAllIncludePatterns(sampleModules);
    expect(patterns).toEqual(["a.txt", "a.json", "b.txt", "c.txt"]);
  });

  it("空のモジュールリストの場合は空配列を返す", () => {
    const patterns = getAllIncludePatterns([]);
    expect(patterns).toEqual([]);
  });

  it("include が空のモジュールを含む場合も動作する", () => {
    const customModules = [
      { name: "A", description: "A", include: ["a.txt"] },
      { name: "B", description: "B", include: [] },
    ];

    const patterns = getAllIncludePatterns(customModules);
    expect(patterns).toEqual(["a.txt"]);
  });
});
