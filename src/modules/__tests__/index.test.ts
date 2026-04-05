import { describe, expect, it } from "vitest";
import {
  addIncludePattern,
  getModulesFilePath,
  loadPatternsFile,
  loadTemplateModulesFile,
  modulesFileExists,
} from "../index";

// Re-export が正しく動作していることを確認するスモークテスト
describe("modules/index re-exports", () => {
  it("全ての公開関数が re-export されている", () => {
    expect(typeof addIncludePattern).toBe("function");
    expect(typeof getModulesFilePath).toBe("function");
    expect(typeof loadPatternsFile).toBe("function");
    expect(typeof loadTemplateModulesFile).toBe("function");
    expect(typeof modulesFileExists).toBe("function");
  });
});
