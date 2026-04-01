import { describe, expect, it } from "vitest";
import { getModuleByName } from "../index";

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
