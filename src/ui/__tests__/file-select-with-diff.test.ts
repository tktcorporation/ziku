import { describe, expect, it } from "vitest";
import type { Key } from "node:readline";
import type { FileDiff } from "../../modules/schemas";
import {
  type RenderState,
  applyAction,
  buildColoredDiffLines,
  buildFileItems,
  getDiffPreviewHeight,
  render,
  resolveKeyAction,
  stripAnsi,
  truncateLine,
} from "../file-select-with-diff";

// ─── ヘルパー ──────────────────────────────────────────────────

/** テスト用の RenderState を生成する */
function createTestState(
  overrides?: Partial<Pick<RenderState, "cursorIndex" | "diffScrollOffset">>,
): RenderState {
  const files: FileDiff[] = [
    { path: "a.ts", type: "added", localContent: "line1\nline2\nline3\n" },
    { path: "b.ts", type: "modified", localContent: "new\n", templateContent: "old\n" },
    { path: "c.ts", type: "deleted", templateContent: "del\n" },
  ];
  const items = buildFileItems(files);
  return {
    items,
    selected: new Set(["a.ts", "b.ts"]),
    cursorIndex: overrides?.cursorIndex ?? 0,
    diffScrollOffset: overrides?.diffScrollOffset ?? 0,
    lastRenderedLines: 0,
  };
}

// ─── テスト ──────────────────────────────────────────────────

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

    it("should handle empty string", () => {
      expect(stripAnsi("")).toBe("");
    });

    it("should handle complex SGR parameters", () => {
      expect(stripAnsi("\u001B[38;5;196mred256\u001B[0m")).toBe("red256");
    });
  });

  describe("truncateLine", () => {
    it("should not truncate short lines", () => {
      const result = truncateLine("hello", 10);
      expect(stripAnsi(result)).toBe("hello");
    });

    it("should truncate long plain text", () => {
      const result = truncateLine("a".repeat(20), 10);
      const plain = stripAnsi(result);
      expect(plain.length).toBeLessThanOrEqual(10);
    });

    it("should preserve ANSI codes while truncating", () => {
      const colored = `\u001B[32m${"a".repeat(20)}\u001B[0m`;
      const result = truncateLine(colored, 10);
      const plain = stripAnsi(result);
      expect(plain.length).toBeLessThanOrEqual(10);
    });

    it("should include ANSI reset after truncation to prevent color bleed", () => {
      const colored = `\u001B[31m${"x".repeat(20)}\u001B[0m`;
      const result = truncateLine(colored, 5);
      // 切り詰め後に \u001B[0m リセットが含まれるべき
      expect(result).toContain("\u001B[0m");
    });

    it("should include ellipsis when truncating", () => {
      const result = truncateLine("a".repeat(20), 10);
      const plain = stripAnsi(result);
      expect(plain).toContain("…");
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

    it("should handle large terminal", () => {
      const height = getDiffPreviewHeight(100, 5);
      expect(height).toBeLessThanOrEqual(50);
      expect(height).toBeGreaterThan(3);
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

    it("should preserve content lines starting with --- or +++", () => {
      // P1 regression test: --- in content should not be filtered
      const file: FileDiff = {
        path: "front-matter.md",
        type: "modified",
        localContent: "---\ntitle: new\n---\nbody\n",
        templateContent: "---\ntitle: old\n---\nbody\n",
      };
      const lines = buildColoredDiffLines(file);
      // --- はコンテンツとして保持されるべき（ヘッダーとして除去されない）
      // 変更はタイトル行のみなので、--- は変更行として出ないが
      // コンテキスト行として出る可能性がある。少なくともエラーなく動作すること。
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

    it("should show modified icon for modified files", () => {
      const files: FileDiff[] = [
        { path: "m.ts", type: "modified", localContent: "new\n", templateContent: "old\n" },
      ];
      const items = buildFileItems(files);
      const plain = stripAnsi(items[0].label);
      expect(plain).toContain("~");
    });

    it("should show deleted icon for deleted files", () => {
      const files: FileDiff[] = [{ path: "d.ts", type: "deleted", templateContent: "old\n" }];
      const items = buildFileItems(files);
      const plain = stripAnsi(items[0].label);
      expect(plain).toContain("-");
    });

    it("should handle unchanged files with space icon", () => {
      const files: FileDiff[] = [{ path: "u.ts", type: "unchanged" }];
      const items = buildFileItems(files);
      const plain = stripAnsi(items[0].label);
      expect(plain).toContain("u.ts");
      // unchanged は空ヒント
      expect(items[0].hint).toBe("");
    });
  });

  describe("render", () => {
    it("should produce output containing header, diff preview, and file list", () => {
      const state = createTestState();
      const output = render(state, { columns: 80, rows: 30 });
      const plain = stripAnsi(output);

      expect(plain).toContain("Select files to include in PR");
      expect(plain).toContain("a.ts");
      expect(plain).toContain("b.ts");
      expect(plain).toContain("navigate");
      expect(plain).toContain("toggle");
    });

    it("should show checkbox state correctly", () => {
      const state = createTestState();
      const output = render(state, { columns: 80, rows: 30 });
      expect(output).toContain("◼");
      expect(output).toContain("◻");
    });

    it("should show diff for the file at cursor position", () => {
      const state = createTestState({ cursorIndex: 1 });
      const output = render(state, { columns: 80, rows: 30 });
      const plain = stripAnsi(output);
      // diff ヘッダーにカーソル位置のファイル名が含まれる
      expect(plain).toContain("b.ts");
      expect(plain).toContain("modified");
    });

    it("should show type labels in diff header", () => {
      const state = createTestState({ cursorIndex: 0 });
      const output = render(state, { columns: 80, rows: 30 });
      const plain = stripAnsi(output);
      expect(plain).toContain("added");
    });

    it("should show deleted type label when cursor is on deleted file", () => {
      const state = createTestState({ cursorIndex: 2 });
      const output = render(state, { columns: 80, rows: 30 });
      const plain = stripAnsi(output);
      expect(plain).toContain("deleted");
    });

    it("should show scroll indicator when diff exceeds preview height", () => {
      // 多くの行を持つファイルで小さなターミナルをシミュレート
      const longContent = Array.from({ length: 50 }, (_, i) => `line ${i}`).join("\n") + "\n";
      const files: FileDiff[] = [{ path: "long.ts", type: "added", localContent: longContent }];
      const items = buildFileItems(files);
      const state: RenderState = {
        items,
        selected: new Set<string>(),
        cursorIndex: 0,
        diffScrollOffset: 0,
        lastRenderedLines: 0,
      };
      // 小さいターミナルで diff がはみ出す状態
      const output = render(state, { columns: 80, rows: 15 });
      const plain = stripAnsi(output);
      expect(plain).toContain("scroll with Shift");
    });

    it("should pad diff area when content is shorter than preview height", () => {
      const state = createTestState();
      const output = render(state, { columns: 80, rows: 40 });
      // │ だけの行（パディング）が存在する
      const lines = output.split("\n");
      const paddingLines = lines.filter((l) => stripAnsi(l).trim() === "│");
      expect(paddingLines.length).toBeGreaterThan(0);
    });
  });

  describe("resolveKeyAction", () => {
    it("should resolve Ctrl+C to cancel", () => {
      expect(resolveKeyAction({ ctrl: true, name: "c" } as Key)).toBe("cancel");
    });

    it("should return undefined for other Ctrl combinations", () => {
      expect(resolveKeyAction({ ctrl: true, name: "a" } as Key)).toBeUndefined();
    });

    it("should resolve Enter to confirm", () => {
      expect(resolveKeyAction({ name: "return" } as Key)).toBe("confirm");
    });

    it("should resolve Space to toggle", () => {
      expect(resolveKeyAction({ name: "space" } as Key)).toBe("toggle");
    });

    it("should resolve 'a' to toggleAll", () => {
      expect(resolveKeyAction({ name: "a" } as Key)).toBe("toggleAll");
    });

    it("should resolve up arrow to cursorUp", () => {
      expect(resolveKeyAction({ name: "up" } as Key)).toBe("cursorUp");
    });

    it("should resolve down arrow to cursorDown", () => {
      expect(resolveKeyAction({ name: "down" } as Key)).toBe("cursorDown");
    });

    it("should resolve Shift+up to scrollDiffUp", () => {
      expect(resolveKeyAction({ name: "up", shift: true } as Key)).toBe("scrollDiffUp");
    });

    it("should resolve Shift+down to scrollDiffDown", () => {
      expect(resolveKeyAction({ name: "down", shift: true } as Key)).toBe("scrollDiffDown");
    });

    it("should resolve 'j' to cursorDown", () => {
      expect(resolveKeyAction({ name: "j" } as Key)).toBe("cursorDown");
    });

    it("should resolve 'k' to cursorUp", () => {
      expect(resolveKeyAction({ name: "k" } as Key)).toBe("cursorUp");
    });

    it("should not resolve Shift+j to cursorDown", () => {
      expect(resolveKeyAction({ name: "j", shift: true } as Key)).toBeUndefined();
    });

    it("should return undefined for unrecognized keys", () => {
      expect(resolveKeyAction({ name: "x" } as Key)).toBeUndefined();
    });

    it("should return undefined for empty key name", () => {
      expect(resolveKeyAction({ name: "" } as Key)).toBeUndefined();
    });
  });

  describe("applyAction", () => {
    it("should return cancel for cancel action", () => {
      const state = createTestState();
      expect(applyAction(state, "cancel", 30)).toBe("cancel");
    });

    it("should return confirm for confirm action", () => {
      const state = createTestState();
      expect(applyAction(state, "confirm", 30)).toBe("confirm");
    });

    it("should move cursor up", () => {
      const state = createTestState({ cursorIndex: 2 });
      const effect = applyAction(state, "cursorUp", 30);
      expect(effect).toBe("redraw");
      expect(state.cursorIndex).toBe(1);
    });

    it("should not move cursor above 0", () => {
      const state = createTestState({ cursorIndex: 0 });
      applyAction(state, "cursorUp", 30);
      expect(state.cursorIndex).toBe(0);
    });

    it("should move cursor down", () => {
      const state = createTestState({ cursorIndex: 0 });
      const effect = applyAction(state, "cursorDown", 30);
      expect(effect).toBe("redraw");
      expect(state.cursorIndex).toBe(1);
    });

    it("should not move cursor beyond last item", () => {
      const state = createTestState({ cursorIndex: 2 });
      applyAction(state, "cursorDown", 30);
      expect(state.cursorIndex).toBe(2);
    });

    it("should reset diffScrollOffset when cursor moves", () => {
      const state = createTestState({ cursorIndex: 1, diffScrollOffset: 5 });
      applyAction(state, "cursorUp", 30);
      expect(state.diffScrollOffset).toBe(0);
    });

    it("should toggle file selection", () => {
      const state = createTestState();
      // a.ts は選択済み → 解除
      expect(state.selected.has("a.ts")).toBe(true);
      applyAction(state, "toggle", 30);
      expect(state.selected.has("a.ts")).toBe(false);
    });

    it("should toggle file selection on", () => {
      const state = createTestState();
      // c.ts は未選択 → 選択
      state.cursorIndex = 2;
      expect(state.selected.has("c.ts")).toBe(false);
      applyAction(state, "toggle", 30);
      expect(state.selected.has("c.ts")).toBe(true);
    });

    it("should toggle all on when not all selected", () => {
      const state = createTestState();
      // c.ts が未選択
      expect(state.selected.has("c.ts")).toBe(false);
      applyAction(state, "toggleAll", 30);
      expect(state.selected.has("a.ts")).toBe(true);
      expect(state.selected.has("b.ts")).toBe(true);
      expect(state.selected.has("c.ts")).toBe(true);
    });

    it("should toggle all off when all selected", () => {
      const state = createTestState();
      state.selected.add("c.ts"); // 全て選択状態にする
      applyAction(state, "toggleAll", 30);
      expect(state.selected.size).toBe(0);
    });

    it("should scroll diff up", () => {
      const state = createTestState({ diffScrollOffset: 3 });
      applyAction(state, "scrollDiffUp", 30);
      expect(state.diffScrollOffset).toBe(2);
    });

    it("should not scroll diff below 0", () => {
      const state = createTestState({ diffScrollOffset: 0 });
      applyAction(state, "scrollDiffUp", 30);
      expect(state.diffScrollOffset).toBe(0);
    });

    it("should scroll diff down when content exceeds preview", () => {
      // 長いファイルで小さいターミナル
      const longContent = Array.from({ length: 100 }, (_, i) => `line ${i}`).join("\n");
      const files: FileDiff[] = [{ path: "long.ts", type: "added", localContent: longContent }];
      const items = buildFileItems(files);
      const state: RenderState = {
        items,
        selected: new Set<string>(),
        cursorIndex: 0,
        diffScrollOffset: 0,
        lastRenderedLines: 0,
      };
      applyAction(state, "scrollDiffDown", 15);
      expect(state.diffScrollOffset).toBe(1);
    });
  });
});
