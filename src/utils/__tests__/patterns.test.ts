import { describe, expect, it } from "vitest";
import {
  mergePatterns,
  filterByExcludePatterns,
  getEffectivePatterns,
  matchesPatterns,
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

describe("filterByExcludePatterns", () => {
  it("除外パターンにマッチするファイルを除外する", () => {
    const files = ["file.txt", "file.local", "config.json"];

    const result = filterByExcludePatterns(files, ["file.local"]);

    expect(result).toEqual(["file.txt", "config.json"]);
  });

  it("除外パターンが空の場合は全ファイルを返す", () => {
    const files = ["file.txt", "config.json"];

    const result = filterByExcludePatterns(files, []);

    expect(result).toEqual(files);
  });

  it("除外パターンが undefined の場合は全ファイルを返す", () => {
    const files = ["file.txt", "config.json"];

    const result = filterByExcludePatterns(files, undefined);

    expect(result).toEqual(files);
  });
});

describe("getEffectivePatterns", () => {
  it("設定がない場合はモジュールパターンをそのまま返す", () => {
    const patterns = ["*.json", "*.ts"];

    const result = getEffectivePatterns("test", patterns, undefined);

    expect(result).toEqual(["*.json", "*.ts"]);
  });

  it("excludePatterns がない設定の場合はそのまま返す", () => {
    const patterns = ["*.json", "*.ts"];
    const config = {
      version: "1.0.0",
      installedAt: "2024-01-01T00:00:00+09:00",
      modules: [],
      source: { owner: "test", repo: "test" },
    };

    const result = getEffectivePatterns("test", patterns, config);

    expect(result).toEqual(["*.json", "*.ts"]);
  });

  it("excludePatterns にマッチするパターンを除外する", () => {
    const patterns = ["config.json", "settings.local.json", "data.json"];
    const config = {
      version: "1.0.0",
      installedAt: "2024-01-01T00:00:00+09:00",
      modules: [],
      source: { owner: "test", repo: "test" },
      excludePatterns: ["settings.local.json"],
    };

    const result = getEffectivePatterns("test", patterns, config);

    expect(result).toEqual(["config.json", "data.json"]);
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
