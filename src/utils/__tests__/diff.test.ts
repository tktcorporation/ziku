import { describe, expect, it } from "vitest";
import type { FileDiff } from "../../modules/schemas";
import { colorizeUnifiedDiff, generateUnifiedDiff } from "../diff";

describe("diff", () => {
  describe("generateUnifiedDiff", () => {
    it("added タイプのファイルで unified diff を生成する", () => {
      const fileDiff: FileDiff = {
        path: "new-file.txt",
        type: "added",
        localContent: "line1\nline2\nline3\n",
        templateContent: undefined,
      };

      const result = generateUnifiedDiff(fileDiff);

      expect(result).toContain("--- new-file.txt");
      expect(result).toContain("+++ new-file.txt");
      expect(result).toContain("+line1");
      expect(result).toContain("+line2");
      expect(result).toContain("+line3");
    });

    it("modified タイプのファイルで unified diff を生成する", () => {
      const fileDiff: FileDiff = {
        path: "existing-file.txt",
        type: "modified",
        localContent: "line1\nmodified line\nline3\n",
        templateContent: "line1\noriginal line\nline3\n",
      };

      const result = generateUnifiedDiff(fileDiff);

      expect(result).toContain("--- existing-file.txt");
      expect(result).toContain("+++ existing-file.txt");
      expect(result).toContain("-original line");
      expect(result).toContain("+modified line");
    });

    it("deleted タイプのファイルでは空文字列を返す", () => {
      const fileDiff: FileDiff = {
        path: "deleted-file.txt",
        type: "deleted",
        localContent: undefined,
        templateContent: "content\n",
      };

      const result = generateUnifiedDiff(fileDiff);

      expect(result).toBe("");
    });

    it("unchanged タイプのファイルでは空文字列を返す", () => {
      const fileDiff: FileDiff = {
        path: "unchanged-file.txt",
        type: "unchanged",
        localContent: "same content\n",
        templateContent: "same content\n",
      };

      const result = generateUnifiedDiff(fileDiff);

      expect(result).toBe("");
    });

    it("空のファイルを追加する場合", () => {
      const fileDiff: FileDiff = {
        path: "empty-file.txt",
        type: "added",
        localContent: "",
        templateContent: undefined,
      };

      const result = generateUnifiedDiff(fileDiff);

      expect(result).toContain("--- empty-file.txt");
      expect(result).toContain("+++ empty-file.txt");
    });

    it("内容が undefined の場合でも正しく処理する", () => {
      const fileDiff: FileDiff = {
        path: "file.txt",
        type: "added",
        localContent: undefined,
        templateContent: undefined,
      };

      const result = generateUnifiedDiff(fileDiff);

      // エラーなく空の diff が生成される
      expect(result).toContain("--- file.txt");
    });

    it("複数行の変更を含む diff を生成する", () => {
      const fileDiff: FileDiff = {
        path: "config.json",
        type: "modified",
        localContent: `{
  "name": "new-name",
  "version": "2.0.0",
  "description": "updated"
}`,
        templateContent: `{
  "name": "old-name",
  "version": "1.0.0",
  "description": "original"
}`,
      };

      const result = generateUnifiedDiff(fileDiff);

      expect(result).toContain('-  "name": "old-name"');
      expect(result).toContain('+  "name": "new-name"');
      expect(result).toContain('-  "version": "1.0.0"');
      expect(result).toContain('+  "version": "2.0.0"');
    });
  });

  describe("colorizeUnifiedDiff", () => {
    it("追加行を緑色にする", () => {
      const diff = "+added line";

      const result = colorizeUnifiedDiff(diff);

      expect(result).toBe("\x1b[32m+added line\x1b[0m");
    });

    it("削除行を赤色にする", () => {
      const diff = "-removed line";

      const result = colorizeUnifiedDiff(diff);

      expect(result).toBe("\x1b[31m-removed line\x1b[0m");
    });

    it("ハンク行をシアン色にする", () => {
      const diff = "@@ -1,3 +1,4 @@";

      const result = colorizeUnifiedDiff(diff);

      expect(result).toBe("\x1b[36m@@ -1,3 +1,4 @@\x1b[0m");
    });

    it("ヘッダー行をボールドにする", () => {
      const diff = "--- file.txt\n+++ file.txt";

      const result = colorizeUnifiedDiff(diff);

      expect(result).toContain("\x1b[1m--- file.txt\x1b[0m");
      expect(result).toContain("\x1b[1m+++ file.txt\x1b[0m");
    });

    it("コンテキスト行はそのまま", () => {
      const diff = " unchanged line";

      const result = colorizeUnifiedDiff(diff);

      expect(result).toBe(" unchanged line");
    });

    it("複数行の diff を正しくカラー化する", () => {
      const diff = `--- file.txt
+++ file.txt
@@ -1,3 +1,3 @@
 line1
-old line
+new line
 line3`;

      const result = colorizeUnifiedDiff(diff);

      const lines = result.split("\n");
      expect(lines[0]).toBe("\x1b[1m--- file.txt\x1b[0m");
      expect(lines[1]).toBe("\x1b[1m+++ file.txt\x1b[0m");
      expect(lines[2]).toBe("\x1b[36m@@ -1,3 +1,3 @@\x1b[0m");
      expect(lines[3]).toBe(" line1");
      expect(lines[4]).toBe("\x1b[31m-old line\x1b[0m");
      expect(lines[5]).toBe("\x1b[32m+new line\x1b[0m");
      expect(lines[6]).toBe(" line3");
    });

    it("空の diff を処理する", () => {
      const result = colorizeUnifiedDiff("");

      expect(result).toBe("");
    });
  });
});
