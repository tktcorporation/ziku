import { describe, expect, it } from "vitest";
import { flattenModules, getModulesFilePath, loadModulesFile, modulesFileExists } from "../index";

// Re-export が正しく動作していることを確認するスモークテスト
describe("modules/index re-exports", () => {
  it("全ての公開関数が re-export されている", () => {
    expect(typeof flattenModules).toBe("function");
    expect(typeof getModulesFilePath).toBe("function");
    expect(typeof loadModulesFile).toBe("function");
    expect(typeof modulesFileExists).toBe("function");
  });
});
