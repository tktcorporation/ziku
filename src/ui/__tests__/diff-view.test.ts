import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("@clack/prompts", () => ({
  log: { step: vi.fn(), message: vi.fn(), info: vi.fn() },
}));

// picocolors は TTY 以外では色を付けないため、色の付き方を検証できるよう
// 装飾をタグに置き換える。ハイライト範囲の検査に使う。
vi.mock("picocolors", () => ({
  default: {
    red: (s: string) => `<red>${s}</red>`,
    green: (s: string) => `<green>${s}</green>`,
    yellow: (s: string) => `<yellow>${s}</yellow>`,
    cyan: (s: string) => `<cyan>${s}</cyan>`,
    dim: (s: string) => `<dim>${s}</dim>`,
    bold: (s: string) => `<bold>${s}</bold>`,
    black: (s: string) => s,
    white: (s: string) => s,
    bgRed: (s: string) => `<bg>${s}</bg>`,
    bgGreen: (s: string) => `<bg>${s}</bg>`,
  },
}));

import * as p from "@clack/prompts";
import type { FileDiff } from "../../modules/schemas";
import {
  applyWordDiffAndColorize,
  calculateDiffStats,
  formatStats,
  getFileLabel,
  renderFileDiff,
} from "../diff-view";
import { repoRelPath } from "../../__tests__/brands";

/** 背景色（word diff のハイライト）が付いた部分だけを連結して返す */
function highlighted(line: string): string {
  return [...line.matchAll(/<bg>(.*?)<\/bg>/g)].map((m) => m[1]).join("");
}

/** バイナリの内容を差分の string チャネルへ載せた形（バイト保存の latin1）。 */
function asDiffContent(bytes: number[]): string {
  return Buffer.from(bytes).toString("latin1");
}

describe("diff-view", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  describe("calculateDiffStats", () => {
    it("should return zeros for unchanged", () => {
      const file: FileDiff = {
        path: repoRelPath("a.ts"),
        type: "unchanged",
        localContent: "same\n",
        templateContent: "same\n",
      };
      expect(calculateDiffStats(file)).toEqual({
        kind: "text",
        additions: 0,
        deletions: 0,
      });
    });

    it("should count lines for added files", () => {
      const file: FileDiff = {
        path: repoRelPath("a.ts"),
        type: "added",
        localContent: "line1\nline2\nline3",
      };
      expect(calculateDiffStats(file)).toEqual({
        kind: "text",
        additions: 3,
        deletions: 0,
      });
    });

    it("should count lines for added files with trailing newline", () => {
      const file: FileDiff = {
        path: repoRelPath("a.ts"),
        type: "added",
        localContent: "line1\nline2\nline3\n",
      };
      // 末尾改行があっても 3行（以前は split("\n").length で 4 を返していた）
      expect(calculateDiffStats(file)).toEqual({
        kind: "text",
        additions: 3,
        deletions: 0,
      });
    });

    it("should count lines for deleted files", () => {
      const file: FileDiff = {
        path: repoRelPath("a.ts"),
        type: "deleted",
        templateContent: "line1\nline2",
      };
      expect(calculateDiffStats(file)).toEqual({
        kind: "text",
        additions: 0,
        deletions: 2,
      });
    });

    it("should count lines for deleted files with trailing newline", () => {
      const file: FileDiff = {
        path: repoRelPath("a.ts"),
        type: "deleted",
        templateContent: "line1\nline2\n",
      };
      expect(calculateDiffStats(file)).toEqual({
        kind: "text",
        additions: 0,
        deletions: 2,
      });
    });

    it("should compute stats for modified files using unified diff", () => {
      const file: FileDiff = {
        path: repoRelPath("a.ts"),
        type: "modified",
        localContent: "hello world",
        templateContent: "hello",
      };
      const stats = calculateDiffStats(file);
      expect(stats.additions).toBeGreaterThan(0);
    });

    it("should count actual changed lines for modified files, not line count difference", () => {
      // 200行のファイルが50行のテンプレートと比較される場合、
      // 行数差（150）ではなく実際の変更行数を返すべき
      const templateLines = Array.from({ length: 50 }, (_, i) => `line ${i + 1}`).join("\n");
      const localLines = Array.from({ length: 50 }, (_, i) => {
        // 3行だけ変更
        if (i === 5) return "modified line 6";
        if (i === 10) return "modified line 11";
        if (i === 20) return "modified line 21";
        return `line ${i + 1}`;
      }).join("\n");

      const file: FileDiff = {
        path: repoRelPath("big-file.ts"),
        type: "modified",
        localContent: localLines,
        templateContent: templateLines,
      };
      const stats = calculateDiffStats(file);
      // 3行変更 → additions: 3, deletions: 3（各行の置換）
      expect(stats.additions).toBe(3);
      expect(stats.deletions).toBe(3);
    });

    it("should not show +150 for a file with 150 more lines but same content pattern", () => {
      // ユーザーが報告したバグケース: formatFileStat が行数差で計算していた
      const templateContent = '{\n  "name": "dev"\n}\n';
      const localContent = '{\n  "name": "dev",\n  "settings": {\n    "key": "value"\n  }\n}\n';

      const file: FileDiff = {
        path: repoRelPath(".devcontainer/devcontainer.json"),
        type: "modified",
        localContent,
        templateContent,
      };
      const stats = calculateDiffStats(file);
      // 行数差は 3 (6-3) だが、実際の変更行数で計算されるべき
      // additions !== localLines - templateLines
      expect(stats.additions).toBeLessThanOrEqual(5);
      expect(stats.deletions).toBeLessThanOrEqual(5);
    });

    it("should report zero lines for an empty added file", () => {
      const file: FileDiff = {
        path: repoRelPath("a.ts"),
        type: "added",
        localContent: "",
      };
      expect(calculateDiffStats(file)).toEqual({
        kind: "text",
        additions: 0,
        deletions: 0,
      });
    });

    it("should report zero lines for an empty deleted file", () => {
      const file: FileDiff = {
        path: repoRelPath("a.ts"),
        type: "deleted",
        templateContent: "",
      };
      expect(calculateDiffStats(file)).toEqual({
        kind: "text",
        additions: 0,
        deletions: 0,
      });
    });

    it("should handle single line content without newline", () => {
      const file: FileDiff = {
        path: repoRelPath("a.ts"),
        type: "added",
        localContent: "single line",
      };
      expect(calculateDiffStats(file)).toEqual({
        kind: "text",
        additions: 1,
        deletions: 0,
      });
    });

    it("should handle empty string content", () => {
      const file: FileDiff = {
        path: repoRelPath("a.ts"),
        type: "added",
        localContent: "",
      };
      expect(calculateDiffStats(file)).toEqual({
        kind: "text",
        additions: 0,
        deletions: 0,
      });
    });

    it("should handle content that is only a newline", () => {
      const file: FileDiff = {
        path: repoRelPath("a.ts"),
        type: "added",
        localContent: "\n",
      };
      // "\n" は空行1つ → しかし実質的に空ファイル
      expect(calculateDiffStats(file)).toEqual({
        kind: "text",
        additions: 0,
        deletions: 0,
      });
    });

    it("should count content lines starting with --- as deletions", () => {
      // front matter 区切りの削除。ヘッダー行と取り違えるとカウントから漏れる
      const file: FileDiff = {
        path: repoRelPath("rule.md"),
        type: "modified",
        templateContent: "---\ntitle: a\n---\nbody\n",
        localContent: "title: a\nbody\n",
      };
      expect(calculateDiffStats(file)).toEqual({
        kind: "text",
        additions: 0,
        deletions: 2,
      });
    });

    it("should count content lines starting with --- as additions", () => {
      const file: FileDiff = {
        path: repoRelPath("rule.md"),
        type: "modified",
        templateContent: "title: a\nbody\n",
        localContent: "---\ntitle: a\n---\nbody\n",
      };
      expect(calculateDiffStats(file)).toEqual({
        kind: "text",
        additions: 2,
        deletions: 0,
      });
    });
  });

  describe("applyWordDiffAndColorize", () => {
    it("should pair removals and additions by position within a block", () => {
      const result = applyWordDiffAndColorize([
        "-const a = 1;",
        "-const b = 2;",
        "-const c = 3;",
        "+const a = 10;",
        "+const b = 20;",
        "+const c = 30;",
      ]);

      expect(result).toHaveLength(6);
      // unified diff の並び（削除行が先、追加行が後）を保つ
      expect(result.slice(0, 3).every((l) => l.startsWith("<red>-</red>"))).toBe(true);
      expect(result.slice(3).every((l) => l.startsWith("<green>+</green>"))).toBe(true);

      // 位置で対応するので、ハイライトされるのは値の部分だけ。
      // 無関係な行同士が組になると行全体がハイライトされる。
      for (const line of result) {
        expect(highlighted(line)).toMatch(/^[0-9;]+$/);
      }
    });

    it("should leave unpaired lines without word diff highlight", () => {
      const result = applyWordDiffAndColorize([
        "-alpha 1",
        "-beta 2",
        "+alpha 10",
        "+beta 20",
        "+gamma 30",
      ]);

      expect(result).toHaveLength(5);
      expect(highlighted(result[0])).not.toBe("");
      expect(highlighted(result[1])).not.toBe("");
      // 対応する削除行を持たない追加行は通常色
      expect(result[4]).toBe("<green>+gamma 30</green>");
    });

    it("should not pair lines separated by a context line", () => {
      const result = applyWordDiffAndColorize(["-old", " context", "+new"]);

      expect(result[0]).toBe("<red>-old</red>");
      expect(result[1]).toBe(" context");
      expect(result[2]).toBe("<green>+new</green>");
    });

    it("should colorize hunk headers", () => {
      const result = applyWordDiffAndColorize(["@@ -1,3 +1,3 @@"]);
      expect(result[0]).toBe("<cyan>@@ -1,3 +1,3 @@</cyan>");
    });

    it("should treat content lines starting with --- as deletions", () => {
      const result = applyWordDiffAndColorize(["---", "+++"]);
      // ヘッダー（タブ区切り）ではないので、置換ブロックとして扱われる
      expect(result[0]).toContain("<red>-</red>");
      expect(result[1]).toContain("<green>+</green>");
    });

    it("should keep diff headers unstyled", () => {
      const header = "--- path/to/file\ttemplate";
      expect(applyWordDiffAndColorize([header])).toEqual([header]);
    });
  });

  describe("formatStats", () => {
    it("should format additions only", () => {
      const result = formatStats({ kind: "text", additions: 5, deletions: 0 });
      expect(result).toContain("+5");
    });

    it("should format deletions only", () => {
      const result = formatStats({ kind: "text", additions: 0, deletions: 3 });
      expect(result).toContain("-3");
    });

    it("should format both additions and deletions", () => {
      const result = formatStats({ kind: "text", additions: 3, deletions: 2 });
      expect(result).toContain("+3");
      expect(result).toContain("-2");
    });

    it("should return no changes for zero stats", () => {
      const result = formatStats({ kind: "text", additions: 0, deletions: 0 });
      expect(result).toContain("no changes");
    });
  });

  describe("getFileLabel", () => {
    it("should include path and stats for added file", () => {
      const file: FileDiff = {
        path: repoRelPath("test.ts"),
        type: "added",
        localContent: "hello",
      };
      const label = getFileLabel(file);
      expect(label).toContain("test.ts");
    });

    it("should include path for modified file", () => {
      const file: FileDiff = {
        path: repoRelPath("mod.ts"),
        type: "modified",
        localContent: "new",
        templateContent: "old",
      };
      const label = getFileLabel(file);
      expect(label).toContain("mod.ts");
    });

    it("should not mark unchanged files with the deleted icon", () => {
      const file: FileDiff = {
        path: repoRelPath("same.ts"),
        type: "unchanged",
        localContent: "x\n",
        templateContent: "x\n",
      };
      const label = getFileLabel(file);
      expect(label).toContain("same.ts");
      expect(label).not.toContain("<red>");
    });
  });

  describe("renderFileDiff", () => {
    it("should display header for unchanged files without diff", () => {
      const file: FileDiff = {
        path: repoRelPath("a.ts"),
        type: "unchanged",
        localContent: "same\n",
        templateContent: "same\n",
      };
      renderFileDiff(file);
      expect(p.log.step).toHaveBeenCalledTimes(1);
      // unchanged files should not show diff content
      expect(p.log.message).not.toHaveBeenCalled();
    });

    it("should label unchanged files as unchanged, not deleted", () => {
      const file: FileDiff = {
        path: repoRelPath("a.ts"),
        type: "unchanged",
        localContent: "same\n",
        templateContent: "same\n",
      };
      renderFileDiff(file);
      const header = vi.mocked(p.log.step).mock.calls[0][0];
      expect(header).toContain("unchanged");
      expect(header).not.toContain("deleted");
    });

    it("should display diff content for deleted files", () => {
      const file: FileDiff = {
        path: repoRelPath("gone.ts"),
        type: "deleted",
        templateContent: "const x = 1;\n",
      };
      renderFileDiff(file);
      expect(p.log.step).toHaveBeenCalledTimes(1);
      const body = vi.mocked(p.log.message).mock.calls[0][0];
      expect(body).toContain("const x = 1;");
    });

    it("should display diff content for added files", () => {
      const file: FileDiff = {
        path: repoRelPath("new.ts"),
        type: "added",
        localContent: "const x = 1;",
      };
      renderFileDiff(file);
      expect(p.log.step).toHaveBeenCalledTimes(1);
      expect(p.log.message).toHaveBeenCalledTimes(1);
    });

    it("should display diff content for modified files", () => {
      const file: FileDiff = {
        path: repoRelPath("mod.ts"),
        type: "modified",
        localContent: "const x = 2;",
        templateContent: "const x = 1;",
      };
      renderFileDiff(file);
      expect(p.log.step).toHaveBeenCalledTimes(1);
      expect(p.log.message).toHaveBeenCalledTimes(1);
    });
  });
  describe("バイナリ", () => {
    const binaryFile: FileDiff = {
      path: repoRelPath("assets/icon.png"),
      type: "modified",
      templateContent: asDiffContent([0x89, 0x50, 0x4e, 0x47, 0x00, 0x01]),
      localContent: asDiffContent([0x89, 0x50, 0x4e, 0x47, 0x00, 0x02]),
    };

    it("行数ではなくバイナリであることを統計として返す", () => {
      expect(calculateDiffStats(binaryFile)).toEqual({
        kind: "binary",
        additions: 0,
        deletions: 0,
      });
    });

    it("統計の表示は行数ではなく binary と出す", () => {
      expect(formatStats(calculateDiffStats(binaryFile))).toContain("binary");
    });

    it("ファイル選択のラベルに内容が出ない", () => {
      const label = getFileLabel(binaryFile);
      expect(label).toContain("assets/icon.png");
      expect(label).toContain("binary");
      expect(label).not.toContain("\u0000");
    });

    it("diff 表示に内容が出ず、差分がある事実だけを出す", () => {
      renderFileDiff(binaryFile);

      const rendered = vi.mocked(p.log.message).mock.calls[0][0] as string;
      expect(rendered).toContain("Binary files");
      expect(rendered).not.toContain("\u0000");
      expect(rendered).not.toContain("PNG");
    });
  });
});
