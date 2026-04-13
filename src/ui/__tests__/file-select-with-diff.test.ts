import { describe, expect, it } from "vitest";
import type { FileDiff } from "../../modules/schemas";
import {
  buildColoredDiffLines,
  buildFileItems,
  getDiffPreviewHeight,
  render,
  stripAnsi,
  truncateLine,
} from "../file-select-with-diff";

describe("file-select-with-diff", () => {
  describe("stripAnsi", () => {
    it("should remove ANSI escape sequences", () => {
      expect(stripAnsi("\u001B[32mhello\u001B[0m")).toBe("hello");
    });

    it("should return plain text unchanged", () => {
      expect(stripAnsi("hello")).toBe("hello");
    });

    it("should handle multiple escape sequences", () => {
      expect(stripAnsi("\u001B[1m\u001B[32mbold green\u001B[0m")).toBe("bold green");
    });
  });

  describe("truncateLine", () => {
    it("should not truncate short lines", () => {
      expect(truncateLine("hello", 10)).toBe("hello");
    });

    it("should truncate long plain text", () => {
      const result = truncateLine("a".repeat(20), 10);
      const plain = stripAnsi(result);
      expect(plain.length).toBeLessThanOrEqual(10);
    });

    it("should preserve ANSI codes while truncating", () => {
      const colored = `\u001B[32m${"a".repeat(20)}\u001B[0m`;
      const result = truncateLine(colored, 10);
      // 結果にはANSIコードが含まれるが、可視文字は10以下
      const plain = stripAnsi(result);
      expect(plain.length).toBeLessThanOrEqual(10);
    });
  });

  describe("getDiffPreviewHeight", () => {
    it("should return minimum 3 lines for small terminals", () => {
      expect(getDiffPreviewHeight(10, 5)).toBeGreaterThanOrEqual(3);
    });

    it("should not exceed 50% of terminal height", () => {
      const height = getDiffPreviewHeight(40, 2);
      expect(height).toBeLessThanOrEqual(20);
    });

    it("should account for file count in available space", () => {
      const heightFew = getDiffPreviewHeight(30, 3);
      const heightMany = getDiffPreviewHeight(30, 15);
      expect(heightFew).toBeGreaterThanOrEqual(heightMany);
    });
  });

  describe("buildColoredDiffLines", () => {
    it("should return no-changes message for unchanged files", () => {
      const file: FileDiff = { path: "a.ts", type: "unchanged" };
      const lines = buildColoredDiffLines(file);
      expect(lines).toHaveLength(1);
      expect(stripAnsi(lines[0])).toContain("no changes");
    });

    it("should return colored diff lines for added files", () => {
      const file: FileDiff = {
        path: "a.ts",
        type: "added",
        localContent: "const x = 1;\n",
      };
      const lines = buildColoredDiffLines(file);
      expect(lines.length).toBeGreaterThan(0);
      // added ファイルは + 行を含むはず
      const hasAdditions = lines.some((l) => stripAnsi(l).startsWith("+"));
      expect(hasAdditions).toBe(true);
    });

    it("should return colored diff lines for modified files", () => {
      const file: FileDiff = {
        path: "a.ts",
        type: "modified",
        localContent: "const x = 2;\n",
        templateContent: "const x = 1;\n",
      };
      const lines = buildColoredDiffLines(file);
      expect(lines.length).toBeGreaterThan(0);
    });

    it("should return no-diff message for deleted files without diff", () => {
      const file: FileDiff = {
        path: "a.ts",
        type: "deleted",
        templateContent: "old content\n",
      };
      const lines = buildColoredDiffLines(file);
      expect(lines.length).toBeGreaterThan(0);
    });
  });

  describe("buildFileItems", () => {
    it("should create items with labels and hints for each file", () => {
      const files: FileDiff[] = [
        { path: "added.ts", type: "added", localContent: "new\n" },
        { path: "modified.ts", type: "modified", localContent: "new\n", templateContent: "old\n" },
        { path: "deleted.ts", type: "deleted", templateContent: "old\n" },
      ];
      const items = buildFileItems(files);
      expect(items).toHaveLength(3);
      expect(items[0].file.path).toBe("added.ts");
      expect(items[1].file.path).toBe("modified.ts");
      expect(items[2].file.path).toBe("deleted.ts");
      // 全アイテムに diffLines が生成されている
      for (const item of items) {
        expect(item.diffLines.length).toBeGreaterThan(0);
      }
    });

    it("should include type icon in label", () => {
      const files: FileDiff[] = [{ path: "a.ts", type: "added", localContent: "x\n" }];
      const items = buildFileItems(files);
      const plain = stripAnsi(items[0].label);
      expect(plain).toContain("+");
      expect(plain).toContain("a.ts");
    });
  });

  describe("render", () => {
    it("should produce output containing header, diff preview, and file list", () => {
      const files: FileDiff[] = [
        { path: "a.ts", type: "added", localContent: "hello\n" },
        { path: "b.ts", type: "modified", localContent: "new\n", templateContent: "old\n" },
      ];
      const items = buildFileItems(files);
      const state = {
        items,
        selected: new Set(["a.ts"]),
        cursorIndex: 0,
        diffScrollOffset: 0,
        lastRenderedLines: 0,
      };
      const output = render(state, { columns: 80, rows: 30 });
      const plain = stripAnsi(output);

      // ヘッダー
      expect(plain).toContain("Select files to include in PR");
      // diff パス
      expect(plain).toContain("a.ts");
      // ファイルリスト
      expect(plain).toContain("b.ts");
      // フッター
      expect(plain).toContain("navigate");
      expect(plain).toContain("toggle");
    });

    it("should show checkbox state correctly", () => {
      const files: FileDiff[] = [
        { path: "selected.ts", type: "added", localContent: "x\n" },
        { path: "unselected.ts", type: "added", localContent: "y\n" },
      ];
      const items = buildFileItems(files);
      const state = {
        items,
        selected: new Set(["selected.ts"]),
        cursorIndex: 0,
        diffScrollOffset: 0,
        lastRenderedLines: 0,
      };
      const output = render(state, { columns: 80, rows: 30 });

      // selected は ◼ を含む
      expect(output).toContain("◼");
      // unselected は ◻ を含む
      expect(output).toContain("◻");
    });

    it("should show cursor indicator on current item", () => {
      const files: FileDiff[] = [
        { path: "a.ts", type: "added", localContent: "x\n" },
        { path: "b.ts", type: "added", localContent: "y\n" },
      ];
      const items = buildFileItems(files);
      const state = {
        items,
        selected: new Set<string>(),
        cursorIndex: 1,
        diffScrollOffset: 0,
        lastRenderedLines: 0,
      };
      const output = render(state, { columns: 80, rows: 30 });

      // カーソル位置のファイルの diff が表示される
      expect(output).toContain("b.ts");
    });
  });
});
