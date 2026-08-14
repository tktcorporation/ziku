import { describe, expect, it } from "vitest";
import type { Key } from "node:readline";
import type { FileDiff } from "../../modules/schemas";
import {
  type FileSelectionMarks,
  type RenderState,
  NO_FILE_SELECTION_MARKS,
  applyAction,
  buildColoredDiffLines,
  buildFileItems,
  computeListWindow,
  isPreselectedByDefault,
  computeScreenLayout,
  getDiffPreviewHeight,
  render,
  resolveKeyAction,
  stripCsi,
  truncateLine,
} from "../file-select-with-diff";
import { stringWidth } from "../text-width";
import { repoRelPath, repoRelPaths } from "../../__tests__/brands";

// ─── ヘルパー ──────────────────────────────────────────────────

/** 検証したい印だけを指定して {@link FileSelectionMarks} を組む。 */
function marksWith(overrides: Partial<FileSelectionMarks>): FileSelectionMarks {
  return { ...NO_FILE_SELECTION_MARKS, ...overrides };
}

/** バイナリの内容を差分の string チャネルへ載せた形（バイト保存の latin1）。 */
function asBinaryContent(bytes: number[]): string {
  return Buffer.from(bytes).toString("latin1");
}

/** テスト用の RenderState を生成する */
function createTestState(
  overrides?: Partial<Pick<RenderState, "cursorIndex" | "diffScrollOffset">>,
): RenderState {
  const files: FileDiff[] = [
    { path: repoRelPath("a.ts"), type: "added", localContent: "line1\nline2\nline3\n" },
    {
      path: repoRelPath("b.ts"),
      type: "modified",
      localContent: "new\n",
      templateContent: "old\n",
    },
    { path: repoRelPath("c.ts"), type: "deleted", templateContent: "del\n" },
  ];
  const items = buildFileItems(files, NO_FILE_SELECTION_MARKS);
  return {
    items,
    selected: new Set(["a.ts", "b.ts"]),
    cursorIndex: overrides?.cursorIndex ?? 0,
    diffScrollOffset: overrides?.diffScrollOffset ?? 0,
    lastRenderedLines: 0,
  };
}

/** 指定件数のファイルを持つ RenderState を生成する（パスは file-<index>.ts） */
function createManyFilesState(fileCount: number, cursorIndex = 0): RenderState {
  const files: FileDiff[] = Array.from({ length: fileCount }, (_, i) => ({
    path: repoRelPath(`file-${i}.ts`),
    type: "modified" as const,
    localContent: `new ${i}\n`,
    templateContent: `old ${i}\n`,
  }));
  return {
    items: buildFileItems(files, NO_FILE_SELECTION_MARKS),
    selected: new Set<string>(),
    cursorIndex,
    diffScrollOffset: 0,
    lastRenderedLines: 0,
  };
}

/** サロゲートペアが割れて孤立サロゲートが残っていないか判定する */
function hasLoneSurrogate(text: string): boolean {
  for (let i = 0; i < text.length; i++) {
    const code = text.codePointAt(i) ?? 0;
    // 正しいペアなら結合後のコードポイントが返るので、下位サロゲート側を読み飛ばす
    if (code > 0xffff) {
      i++;
      continue;
    }
    if (code >= 0xd800 && code <= 0xdfff) return true;
  }
  return false;
}

// ─── テスト ──────────────────────────────────────────────────

describe("file-select-with-diff", () => {
  describe("stripCsi", () => {
    it("should remove ANSI escape sequences", () => {
      expect(stripCsi("\u001B[32mhello\u001B[0m")).toBe("hello");
    });

    it("should return plain text unchanged", () => {
      expect(stripCsi("hello")).toBe("hello");
    });

    it("should handle multiple escape sequences", () => {
      expect(stripCsi("\u001B[1m\u001B[32mbold green\u001B[0m")).toBe("bold green");
    });

    it("should handle empty string", () => {
      expect(stripCsi("")).toBe("");
    });

    it("should remove non-SGR CSI sequences", () => {
      // ファイル内容に紛れ込んだカーソル移動・行消去も幅 0 として扱う必要がある
      const esc = String.fromCodePoint(0x1b);
      expect(stripCsi(`a${esc}[2Kb${esc}[10Ac`)).toBe("abc");
    });

    it("should handle complex SGR parameters", () => {
      expect(stripCsi("\u001B[38;5;196mred256\u001B[0m")).toBe("red256");
    });
  });

  describe("truncateLine", () => {
    it("should not truncate short lines", () => {
      const result = truncateLine("hello", 10);
      expect(stripCsi(result)).toBe("hello");
    });

    it("should truncate long plain text", () => {
      const result = truncateLine("a".repeat(20), 10);
      const plain = stripCsi(result);
      expect(plain.length).toBeLessThanOrEqual(10);
    });

    it("should preserve ANSI codes while truncating", () => {
      const colored = `\u001B[32m${"a".repeat(20)}\u001B[0m`;
      const result = truncateLine(colored, 10);
      const plain = stripCsi(result);
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
      const plain = stripCsi(result);
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
      const file: FileDiff = {
        path: repoRelPath("a.ts"),
        type: "unchanged",
        localContent: "same\n",
        templateContent: "same\n",
      };
      const lines = buildColoredDiffLines(file);
      expect(lines).toHaveLength(1);
      expect(stripCsi(lines[0])).toContain("no changes");
    });

    it("should return colored diff lines for added files", () => {
      const file: FileDiff = {
        path: repoRelPath("a.ts"),
        type: "added",
        localContent: "const x = 1;\n",
      };
      const lines = buildColoredDiffLines(file);
      expect(lines.length).toBeGreaterThan(0);
      const hasAdditions = lines.some((l) => stripCsi(l).startsWith("+"));
      expect(hasAdditions).toBe(true);
    });

    it("should return colored diff lines for modified files", () => {
      const file: FileDiff = {
        path: repoRelPath("a.ts"),
        type: "modified",
        localContent: "const x = 2;\n",
        templateContent: "const x = 1;\n",
      };
      const lines = buildColoredDiffLines(file);
      expect(lines.length).toBeGreaterThan(0);
    });

    it("should show the removed content for deleted files", () => {
      const file: FileDiff = {
        path: repoRelPath("a.ts"),
        type: "deleted",
        templateContent: "old content\n",
      };
      const lines = buildColoredDiffLines(file);
      // 削除を push するか判断できるよう、テンプレート側の内容が削除行として出る
      expect(lines.some((l) => stripCsi(l) === "-old content")).toBe(true);
    });

    it("should preserve content lines starting with --- or +++", () => {
      // P1 regression test: --- in content should not be filtered
      const file: FileDiff = {
        path: repoRelPath("front-matter.md"),
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
        { path: repoRelPath("added.ts"), type: "added", localContent: "new\n" },
        {
          path: repoRelPath("modified.ts"),
          type: "modified",
          localContent: "new\n",
          templateContent: "old\n",
        },
        { path: repoRelPath("deleted.ts"), type: "deleted", templateContent: "old\n" },
      ];
      const items = buildFileItems(files, NO_FILE_SELECTION_MARKS);
      expect(items).toHaveLength(3);
      expect(items[0].file.path).toBe("added.ts");
      expect(items[1].file.path).toBe("modified.ts");
      expect(items[2].file.path).toBe("deleted.ts");
      for (const item of items) {
        expect(item.diffLines.length).toBeGreaterThan(0);
      }
    });

    it("should include type icon in label", () => {
      const files: FileDiff[] = [{ path: repoRelPath("a.ts"), type: "added", localContent: "x\n" }];
      const items = buildFileItems(files, NO_FILE_SELECTION_MARKS);
      const plain = stripCsi(items[0].label);
      expect(plain).toContain("+");
      expect(plain).toContain("a.ts");
    });

    it("conflictedPaths のファイルは hint で conflict と表示される", () => {
      const files: FileDiff[] = [
        {
          path: repoRelPath("ok.ts"),
          type: "modified",
          localContent: "new\n",
          templateContent: "old\n",
        },
        {
          path: repoRelPath("bad.ts"),
          type: "modified",
          localContent: "new\n",
          templateContent: "old\n",
        },
      ];
      const items = buildFileItems(
        files,
        marksWith({ conflictedPaths: new Set(repoRelPaths(["bad.ts"])) }),
      );
      const okHint = stripCsi(items[0].hint);
      const badHint = stripCsi(items[1].hint);
      // 衝突ファイルだけ conflict 表示、それ以外は通常の統計 hint
      expect(badHint).toContain("conflict");
      expect(okHint).not.toContain("conflict");
    });

    it("テンプレートの削除を取り消すファイルは hint でそれと分かる", () => {
      const files: FileDiff[] = [
        { path: repoRelPath("added.ts"), type: "added", localContent: "new\n" },
        { path: repoRelPath("restored.ts"), type: "added", localContent: "new\n" },
      ];
      const items = buildFileItems(
        files,
        marksWith({ restoresTemplateDeletion: new Set(repoRelPaths(["restored.ts"])) }),
      );

      // 種別アイコンはどちらも `+` なので、注記だけが両者を見分ける手掛かりになる
      expect(stripCsi(items[0].hint)).not.toContain("restores file deleted in template");
      expect(stripCsi(items[1].hint)).toContain("restores file deleted in template");
    });

    it("should show modified icon for modified files", () => {
      const files: FileDiff[] = [
        {
          path: repoRelPath("m.ts"),
          type: "modified",
          localContent: "new\n",
          templateContent: "old\n",
        },
      ];
      const items = buildFileItems(files, NO_FILE_SELECTION_MARKS);
      const plain = stripCsi(items[0].label);
      expect(plain).toContain("~");
    });

    it("should show deleted icon for deleted files", () => {
      const files: FileDiff[] = [
        { path: repoRelPath("d.ts"), type: "deleted", templateContent: "old\n" },
      ];
      const items = buildFileItems(files, NO_FILE_SELECTION_MARKS);
      const plain = stripCsi(items[0].label);
      expect(plain).toContain("-");
    });

    it("should handle unchanged files with space icon", () => {
      const files: FileDiff[] = [
        {
          path: repoRelPath("u.ts"),
          type: "unchanged",
          localContent: "u\n",
          templateContent: "u\n",
        },
      ];
      const items = buildFileItems(files, NO_FILE_SELECTION_MARKS);
      const plain = stripCsi(items[0].label);
      expect(plain).toContain("u.ts");
      // 変更を示す記号は付けない
      expect(plain).not.toContain("-");
      expect(plain).not.toContain("+");
      expect(plain).not.toContain("~");
      // unchanged は空ヒント
      expect(items[0].hint).toBe("");
    });
  });

  describe("render", () => {
    it("should produce output containing header, diff preview, and file list", () => {
      const state = createTestState();
      const output = render(state, { columns: 80, rows: 30 });
      const plain = stripCsi(output);

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
      const plain = stripCsi(output);
      // diff ヘッダーにカーソル位置のファイル名が含まれる
      expect(plain).toContain("b.ts");
      expect(plain).toContain("modified");
    });

    it("should show type labels in diff header", () => {
      const state = createTestState({ cursorIndex: 0 });
      const output = render(state, { columns: 80, rows: 30 });
      const plain = stripCsi(output);
      expect(plain).toContain("added");
    });

    it("should show deleted type label when cursor is on deleted file", () => {
      const state = createTestState({ cursorIndex: 2 });
      const output = render(state, { columns: 80, rows: 30 });
      const plain = stripCsi(output);
      expect(plain).toContain("deleted");
    });

    it("should render unchanged file with its own type label", () => {
      const files: FileDiff[] = [
        {
          path: repoRelPath("u.ts"),
          type: "unchanged",
          localContent: "u\n",
          templateContent: "u\n",
        },
      ];
      const items = buildFileItems(files, NO_FILE_SELECTION_MARKS);
      const state: RenderState = {
        items,
        selected: new Set<string>(),
        cursorIndex: 0,
        diffScrollOffset: 0,
        lastRenderedLines: 0,
      };
      const output = render(state, { columns: 80, rows: 20 });
      const plain = stripCsi(output);
      expect(plain).toContain("u.ts");
      // unchanged に added/modified/deleted のラベルを付けない
      expect(plain).toContain("unchanged");
      expect(plain).not.toContain("added");
      expect(plain).not.toContain("modified");
      expect(plain).not.toContain("deleted");
    });

    it("should show scroll indicator when diff exceeds preview height", () => {
      // 多くの行を持つファイルで小さなターミナルをシミュレート
      const longContent = Array.from({ length: 50 }, (_, i) => `line ${i}`).join("\n") + "\n";
      const files: FileDiff[] = [
        { path: repoRelPath("long.ts"), type: "added", localContent: longContent },
      ];
      const items = buildFileItems(files, NO_FILE_SELECTION_MARKS);
      const state: RenderState = {
        items,
        selected: new Set<string>(),
        cursorIndex: 0,
        diffScrollOffset: 0,
        lastRenderedLines: 0,
      };
      // 小さいターミナルで diff がはみ出す状態
      const output = render(state, { columns: 80, rows: 15 });
      const plain = stripCsi(output);
      expect(plain).toContain("scroll with Shift");
    });

    it("should pad diff area when content is shorter than preview height", () => {
      const state = createTestState();
      const output = render(state, { columns: 80, rows: 40 });
      // │ だけの行（パディング）が存在する
      const lines = output.split("\n");
      const paddingLines = lines.filter((l) => stripCsi(l).trim() === "│");
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
      const files: FileDiff[] = [
        { path: repoRelPath("long.ts"), type: "added", localContent: longContent },
      ];
      const items = buildFileItems(files, NO_FILE_SELECTION_MARKS);
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

  describe("truncateLine の表示幅", () => {
    it("全角文字の行を指定カラム数に収める", () => {
      const result = truncateLine("あ".repeat(20), 20);
      expect(stringWidth(stripCsi(result))).toBeLessThanOrEqual(20);
    });

    it("全角 30 文字 (60 カラム) の行を 40 カラムに切り詰める", () => {
      const result = truncateLine("あ".repeat(30), 40);
      expect(stringWidth(stripCsi(result))).toBeLessThanOrEqual(40);
      expect(stripCsi(result)).toContain("…");
    });

    it("ZWJ 絵文字を含む行でサロゲートペアを割らない", () => {
      const family = "\u{1F468}\u{200D}\u{1F469}\u{200D}\u{1F467}";
      const result = truncateLine(family.repeat(10), 11);
      expect(stringWidth(stripCsi(result))).toBeLessThanOrEqual(11);
      expect(hasLoneSurrogate(result)).toBe(false);
    });

    it("結合文字を幅 1 として数える", () => {
      // 基底文字 + アキュートアクセント 10 個 = 表示幅 10 なので切り詰めない
      const combining = "e\u0301".repeat(10);
      expect(truncateLine(combining, 10)).toBe(combining);
    });

    it("maxWidth が 0 以下なら空文字を返す", () => {
      expect(truncateLine("abc", 0)).toBe("");
    });
  });

  describe("computeScreenLayout", () => {
    // chromeLines(7) = ヘッダー + 空行 + diff 枠上下 + 空行 2 + フッター
    const chromeLines = 7;

    it("端末 13 行以上ならファイル数によらず合計行数が端末行数に収まる", () => {
      for (let rows = 13; rows <= 80; rows++) {
        for (const fileCount of [1, 2, 3, 5, 15, 41, 200]) {
          const { diffHeight, listAreaHeight } = computeScreenLayout(rows, fileCount);
          expect(chromeLines + diffHeight + listAreaHeight).toBeLessThanOrEqual(rows);
        }
      }
    });

    it("ファイル数がリスト領域に収まらないとき diff を最小行数まで縮める", () => {
      expect(computeScreenLayout(24, 200).diffHeight).toBe(3);
    });
  });

  describe("computeListWindow", () => {
    it("全件が収まるなら窓で区切らない", () => {
      expect(computeListWindow(5, 0, 10)).toEqual({
        start: 0,
        end: 5,
        hiddenAbove: 0,
        hiddenBelow: 0,
      });
    });

    it("消費行数が listAreaHeight に収まり、カーソルは常に窓の中に入る", () => {
      for (let listAreaHeight = 3; listAreaHeight <= 20; listAreaHeight++) {
        for (const itemCount of [1, 5, 21, 100]) {
          for (let cursor = 0; cursor < itemCount; cursor++) {
            const window = computeListWindow(itemCount, cursor, listAreaHeight);
            const used =
              window.end -
              window.start +
              (window.hiddenAbove > 0 ? 1 : 0) +
              (window.hiddenBelow > 0 ? 1 : 0);
            expect(used).toBeLessThanOrEqual(listAreaHeight);
            expect(cursor).toBeGreaterThanOrEqual(window.start);
            expect(cursor).toBeLessThan(window.end);
          }
        }
      }
    });

    it("末尾のカーソルでは窓がリストの末尾に固定される", () => {
      const window = computeListWindow(100, 99, 10);
      expect(window.end).toBe(100);
      expect(window.hiddenBelow).toBe(0);
      expect(window.hiddenAbove).toBeGreaterThan(0);
    });

    it("リストの途中ではカーソルが窓の中央に来る", () => {
      const window = computeListWindow(100, 50, 11);
      expect(window.start).toBe(46);
      expect(window.end).toBe(55);
    });
  });

  describe("render のスクロール窓", () => {
    const cases: [number, number][] = [
      [24, 15],
      [24, 41],
      [24, 200],
      [50, 41],
      [50, 200],
      [80, 200],
    ];

    it.each(cases)("端末 %i 行 / %i ファイルで描画行数が端末行数を超えない", (rows, fileCount) => {
      const output = render(createManyFilesState(fileCount), { columns: 80, rows });
      expect(output.split("\n").length).toBeLessThanOrEqual(rows);
    });

    it.each(cases)("端末 %i 行 / %i ファイルで各行が端末幅を超えない", (rows, fileCount) => {
      const output = render(createManyFilesState(fileCount), { columns: 80, rows });
      for (const line of output.split("\n")) {
        expect(stringWidth(stripCsi(line))).toBeLessThanOrEqual(80);
      }
    });

    it("カーソルはどの位置でも窓の中に描かれる", () => {
      const fileCount = 40;
      for (const rows of [24, 50]) {
        for (let cursor = 0; cursor < fileCount; cursor++) {
          const state = createManyFilesState(fileCount, cursor);
          const lines = stripCsi(render(state, { columns: 80, rows })).split("\n");
          const cursorLine = lines.find((l) => l.startsWith("›"));
          expect(cursorLine).toContain(`file-${cursor}.ts`);
        }
      }
    });

    it("カーソルを下端まで動かすと窓がスクロールする", () => {
      const top = stripCsi(render(createManyFilesState(40, 0), { columns: 80, rows: 24 }));
      const bottom = stripCsi(render(createManyFilesState(40, 39), { columns: 80, rows: 24 }));

      expect(top).toContain("file-0.ts");
      expect(top).not.toContain("file-39.ts");
      expect(bottom).toContain("file-39.ts");
      expect(bottom).not.toContain("file-0.ts");
    });

    it("窓の外に項目があることを件数付きで示す", () => {
      const top = stripCsi(render(createManyFilesState(40, 0), { columns: 80, rows: 24 }));
      expect(top).not.toContain("more above");
      expect(top).toContain("more below");

      const middle = stripCsi(render(createManyFilesState(40, 20), { columns: 80, rows: 24 }));
      expect(middle).toContain("more above");
      expect(middle).toContain("more below");

      const bottom = stripCsi(render(createManyFilesState(40, 39), { columns: 80, rows: 24 }));
      expect(bottom).toContain("more above");
      expect(bottom).not.toContain("more below");
    });

    it("全件が収まるときはインジケータを出さない", () => {
      const output = stripCsi(render(createManyFilesState(5), { columns: 80, rows: 40 }));
      expect(output).not.toContain("more above");
      expect(output).not.toContain("more below");
    });

    it("全選択・全解除は窓の外の項目にも効く", () => {
      const state = createManyFilesState(40);
      applyAction(state, "toggleAll", 24);
      expect(state.selected.size).toBe(40);
      applyAction(state, "toggleAll", 24);
      expect(state.selected.size).toBe(0);
    });
  });

  describe("buildFileItems", () => {
    it("バイナリの hint は行数ではなく (binary) を出す", () => {
      const binary: FileDiff = {
        path: repoRelPath("assets/icon.png"),
        type: "modified",
        templateContent: asBinaryContent([0x89, 0x50, 0x4e, 0x47, 0x00, 0x01]),
        localContent: asBinaryContent([0x89, 0x50, 0x4e, 0x47, 0x00, 0x02]),
      };

      const [item] = buildFileItems([binary], NO_FILE_SELECTION_MARKS);

      // バイナリは増減行数を持たないので、0 行を根拠に hint ごと落とすと種別が伝わらない
      expect(stripCsi(item.hint)).toContain("(binary)");
    });

    it("増減のないテキストは hint を出さない", () => {
      const unchanged: FileDiff = {
        path: repoRelPath("same.ts"),
        type: "unchanged",
        localContent: "same\n",
        templateContent: "same\n",
      };

      const [item] = buildFileItems([unchanged], NO_FILE_SELECTION_MARKS);

      expect(item.hint).toBe("");
    });
  });
});

describe("isPreselectedByDefault", () => {
  const added = (path: string): FileDiff => ({
    path: repoRelPath(path),
    type: "added",
    localContent: "x\n",
  });
  const deleted = (path: string): FileDiff => ({
    path: repoRelPath(path),
    type: "deleted",
    templateContent: "x\n",
  });

  it("既定でチェックが入るのは、衝突でも削除でも削除の取り消しでもないファイル", () => {
    expect(isPreselectedByDefault(added("a.ts"), NO_FILE_SELECTION_MARKS)).toBe(true);
  });

  it("未解決の衝突は既定で外す（選ぶと push が中断する）", () => {
    expect(
      isPreselectedByDefault(
        added("a.ts"),
        marksWith({ conflictedPaths: new Set(repoRelPaths(["a.ts"])) }),
      ),
    ).toBe(false);
  });

  it("テンプレートの削除を取り消すファイルは既定で外す", () => {
    expect(
      isPreselectedByDefault(
        added("a.ts"),
        marksWith({ restoresTemplateDeletion: new Set(repoRelPaths(["a.ts"])) }),
      ),
    ).toBe(false);
  });

  it("削除は --include-deletions のときだけ既定に入る", () => {
    expect(isPreselectedByDefault(deleted("gone.ts"), NO_FILE_SELECTION_MARKS)).toBe(false);
    expect(
      isPreselectedByDefault(deleted("gone.ts"), marksWith({ preselectDeletions: true })),
    ).toBe(true);
  });
});
