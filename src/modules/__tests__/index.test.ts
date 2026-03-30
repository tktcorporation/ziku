import { describe, expect, it } from "vitest";
import {
  defaultModules,
  getAllPatterns,
  getModuleById,
  getPatternsByModuleIds,
  modules,
} from "../index";

describe("defaultModules", () => {
  it("定義されたモジュールを持つ", () => {
    expect(defaultModules.length).toBeGreaterThan(0);
  });

  it("ルートモジュール (.) を含む", () => {
    const rootModule = defaultModules.find((m) => m.id === ".");
    expect(rootModule).toBeDefined();
    expect(rootModule?.name).toBe("ルート設定");
  });

  it(".devcontainer モジュールを含む", () => {
    const devcontainerModule = defaultModules.find((m) => m.id === ".devcontainer");
    expect(devcontainerModule).toBeDefined();
    expect(devcontainerModule?.patterns.length).toBeGreaterThan(0);
  });

  it(".github モジュールを含む", () => {
    const githubModule = defaultModules.find((m) => m.id === ".github");
    expect(githubModule).toBeDefined();
  });

  it(".claude モジュールを含む", () => {
    const claudeModule = defaultModules.find((m) => m.id === ".claude");
    expect(claudeModule).toBeDefined();
  });

  it("全モジュールが必須フィールドを持つ", () => {
    for (const mod of defaultModules) {
      expect(mod.id).toBeDefined();
      expect(mod.name).toBeDefined();
      expect(mod.description).toBeDefined();
      expect(mod.patterns).toBeDefined();
      expect(Array.isArray(mod.patterns)).toBe(true);
    }
  });
});

describe("modules (alias)", () => {
  it("defaultModules と同じ参照を持つ", () => {
    expect(modules).toBe(defaultModules);
  });
});

describe("getModuleById", () => {
  it("ID でデフォルトモジュールを取得できる", () => {
    const result = getModuleById(".");
    expect(result?.id).toBe(".");
    expect(result?.name).toBe("ルート設定");
  });

  it("存在しない ID の場合は undefined を返す", () => {
    const result = getModuleById("nonexistent");
    expect(result).toBeUndefined();
  });

  it("カスタムモジュールリストから取得できる", () => {
    const customModules = [
      { id: "custom", name: "Custom", description: "Custom module", patterns: ["*.custom"] },
    ];

    const result = getModuleById("custom", customModules);
    expect(result?.id).toBe("custom");
  });

  it("カスタムリストに存在しない場合は undefined を返す", () => {
    const customModules = [
      { id: "custom", name: "Custom", description: "Custom module", patterns: [] },
    ];

    const result = getModuleById(".", customModules);
    expect(result).toBeUndefined();
  });
});

describe("getAllPatterns", () => {
  it("デフォルトモジュールの全パターンを取得する", () => {
    const patterns = getAllPatterns();

    expect(patterns.length).toBeGreaterThan(0);
    // デフォルトモジュールのパターンが含まれていることを確認
    expect(patterns).toContain(".mcp.json");
  });

  it("カスタムモジュールリストからパターンを取得できる", () => {
    const customModules = [
      { id: "a", name: "A", description: "A", patterns: ["a.txt", "a.json"] },
      { id: "b", name: "B", description: "B", patterns: ["b.txt"] },
    ];

    const patterns = getAllPatterns(customModules);

    expect(patterns).toEqual(["a.txt", "a.json", "b.txt"]);
  });

  it("空のモジュールリストの場合は空配列を返す", () => {
    const patterns = getAllPatterns([]);
    expect(patterns).toEqual([]);
  });

  it("パターンのないモジュールを含む場合も動作する", () => {
    const customModules = [
      { id: "a", name: "A", description: "A", patterns: ["a.txt"] },
      { id: "b", name: "B", description: "B", patterns: [] },
    ];

    const patterns = getAllPatterns(customModules);

    expect(patterns).toEqual(["a.txt"]);
  });
});

describe("getPatternsByModuleIds", () => {
  it("指定したモジュール ID のパターンのみを返す", () => {
    const customModules = [
      { id: "a", name: "A", description: "A", patterns: ["a.txt"] },
      { id: "b", name: "B", description: "B", patterns: ["b.txt"] },
      { id: "c", name: "C", description: "C", patterns: ["c.txt"] },
    ];

    const patterns = getPatternsByModuleIds(["a", "c"], customModules);

    expect(patterns).toEqual(["a.txt", "c.txt"]);
  });

  it("デフォルトモジュールから取得できる", () => {
    const patterns = getPatternsByModuleIds(["."]);

    expect(patterns).toContain(".mcp.json");
    expect(patterns).toContain(".mise.toml");
  });

  it("存在しないモジュール ID は無視する", () => {
    const customModules = [
      { id: "a", name: "A", description: "A", patterns: ["a.txt"] },
      { id: "b", name: "B", description: "B", patterns: ["b.txt"] },
    ];

    const patterns = getPatternsByModuleIds(["a", "nonexistent"], customModules);

    expect(patterns).toEqual(["a.txt"]);
  });

  it("空のモジュール ID リストの場合は空配列を返す", () => {
    const patterns = getPatternsByModuleIds([]);
    expect(patterns).toEqual([]);
  });

  it("全モジュール ID を指定すると全パターンを返す", () => {
    const customModules = [
      { id: "a", name: "A", description: "A", patterns: ["a.txt"] },
      { id: "b", name: "B", description: "B", patterns: ["b.txt"] },
    ];

    const patterns = getPatternsByModuleIds(["a", "b"], customModules);

    expect(patterns).toEqual(["a.txt", "b.txt"]);
  });
});
