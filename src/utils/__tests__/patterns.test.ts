import { describe, expect, it } from "vitest";
import {
  mergePatterns,
  matchesPatterns,
  getModulePatterns,
} from "../patterns";

describe("mergePatterns", () => {
  it("複数の配列をマージする", () => {
    const result = mergePatterns(["a", "b"], ["c", "d"]);

    expect(result).toEqual(["a", "b", "c", "d"]);
  });

  it("重複を排除する", () => {
    const result = mergePatterns(["a", "b"], ["b", "c"]);

    expect(result).toEqual(["a", "b", "c"]);
  });

  it("空配列を処理できる", () => {
    const result = mergePatterns([], ["a", "b"], []);

    expect(result).toEqual(["a", "b"]);
  });

  it("3つ以上の配列をマージできる", () => {
    const result = mergePatterns(["a"], ["b"], ["c"], ["d"]);

    expect(result).toEqual(["a", "b", "c", "d"]);
  });

  it("引数なしの場合は空配列を返す", () => {
    const result = mergePatterns();

    expect(result).toEqual([]);
  });
});

describe("getModulePatterns", () => {
  it("モジュールリストから include パターンを取得する", () => {
    const modules = [
      { name: "A", description: "Module A", include: ["*.json", "*.ts"] },
      { name: "B", description: "Module B", include: ["*.md"] },
    ];

    const result = getModulePatterns(modules);

    expect(result.include).toEqual(["*.json", "*.ts", "*.md"]);
  });

  it("モジュールリストから exclude パターンを取得する", () => {
    const modules = [
      { name: "A", description: "Module A", include: ["*.json"], exclude: ["*.local"] },
      { name: "B", description: "Module B", include: ["*.md"] },
    ];

    const result = getModulePatterns(modules);

    expect(result.exclude).toEqual(["*.local"]);
  });

  it("exclude がないモジュールは空配列として扱う", () => {
    const modules = [
      { name: "A", description: "Module A", include: ["*.json"] },
    ];

    const result = getModulePatterns(modules);

    expect(result.exclude).toEqual([]);
  });

  it("空のモジュールリストの場合は空配列を返す", () => {
    const result = getModulePatterns([]);

    expect(result.include).toEqual([]);
    expect(result.exclude).toEqual([]);
  });
});

describe("matchesPatterns", () => {
  it("完全一致するファイルを検出する", () => {
    expect(matchesPatterns("file.txt", ["file.txt"])).toBe(true);
  });

  it("マッチしない場合は false を返す", () => {
    expect(matchesPatterns("file.txt", ["other.txt"])).toBe(false);
  });

  it("複数パターンのいずれかにマッチする場合は true", () => {
    expect(matchesPatterns("file.txt", ["other.txt", "file.txt"])).toBe(true);
  });

  it("空のパターン配列の場合は false", () => {
    expect(matchesPatterns("file.txt", [])).toBe(false);
  });
});

// resolvePatterns と compareDirectories は実際のファイルシステムに依存するため、
// 統合テストとしてテストするか、別途モックを用意する必要があります。
// ここでは純粋関数のみをテストしています。
