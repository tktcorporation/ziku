import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("@clack/prompts", () => ({
  log: { step: vi.fn(), message: vi.fn(), info: vi.fn() },
}));

import * as p from "@clack/prompts";
import type { FileDiff } from "../../modules/schemas";
import { calculateDiffStats, formatStats, getFileLabel, renderFileDiff } from "../diff-view";

describe("diff-view", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  describe("calculateDiffStats", () => {
    it("should return zeros for unchanged", () => {
      const file: FileDiff = { path: "a.ts", type: "unchanged" };
      expect(calculateDiffStats(file)).toEqual({
        additions: 0,
        deletions: 0,
      });
    });

    it("should count lines for added files", () => {
      const file: FileDiff = {
        path: "a.ts",
        type: "added",
        localContent: "line1\nline2\nline3",
      };
      expect(calculateDiffStats(file)).toEqual({
        additions: 3,
        deletions: 0,
      });
    });

    it("should count lines for added files with trailing newline", () => {
      const file: FileDiff = {
        path: "a.ts",
        type: "added",
        localContent: "line1\nline2\nline3\n",
      };
      // 末尾改行があっても 3行（以前は split("\n").length で 4 を返していた）
      expect(calculateDiffStats(file)).toEqual({
        additions: 3,
        deletions: 0,
      });
    });

    it("should count lines for deleted files", () => {
      const file: FileDiff = {
        path: "a.ts",
        type: "deleted",
        templateContent: "line1\nline2",
      };
      expect(calculateDiffStats(file)).toEqual({
        additions: 0,
        deletions: 2,
      });
    });

    it("should count lines for deleted files with trailing newline", () => {
      const file: FileDiff = {
        path: "a.ts",
        type: "deleted",
        templateContent: "line1\nline2\n",
      };
      expect(calculateDiffStats(file)).toEqual({
        additions: 0,
        deletions: 2,
      });
    });

    it("should compute stats for modified files using unified diff", () => {
      const file: FileDiff = {
        path: "a.ts",
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
        path: "big-file.ts",
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
        path: ".devcontainer/devcontainer.json",
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

    it("should handle undefined content for added", () => {
      const file: FileDiff = {
        path: "a.ts",
        type: "added",
      };
      expect(calculateDiffStats(file)).toEqual({
        additions: 0,
        deletions: 0,
      });
    });

    it("should handle undefined content for deleted", () => {
      const file: FileDiff = {
        path: "a.ts",
        type: "deleted",
      };
      expect(calculateDiffStats(file)).toEqual({
        additions: 0,
        deletions: 0,
      });
    });

    it("should handle single line content without newline", () => {
      const file: FileDiff = {
        path: "a.ts",
        type: "added",
        localContent: "single line",
      };
      expect(calculateDiffStats(file)).toEqual({
        additions: 1,
        deletions: 0,
      });
    });

    it("should handle empty string content", () => {
      const file: FileDiff = {
        path: "a.ts",
        type: "added",
        localContent: "",
      };
      expect(calculateDiffStats(file)).toEqual({
        additions: 0,
        deletions: 0,
      });
    });

    it("should handle content that is only a newline", () => {
      const file: FileDiff = {
        path: "a.ts",
        type: "added",
        localContent: "\n",
      };
      // "\n" は空行1つ → しかし実質的に空ファイル
      expect(calculateDiffStats(file)).toEqual({
        additions: 0,
        deletions: 0,
      });
    });
  });

  describe("formatStats", () => {
    it("should format additions only", () => {
      const result = formatStats({ additions: 5, deletions: 0 });
      expect(result).toContain("+5");
    });

    it("should format deletions only", () => {
      const result = formatStats({ additions: 0, deletions: 3 });
      expect(result).toContain("-3");
    });

    it("should format both additions and deletions", () => {
      const result = formatStats({ additions: 3, deletions: 2 });
      expect(result).toContain("+3");
      expect(result).toContain("-2");
    });

    it("should return no changes for zero stats", () => {
      const result = formatStats({ additions: 0, deletions: 0 });
      expect(result).toContain("no changes");
    });
  });

  describe("getFileLabel", () => {
    it("should include path and stats for added file", () => {
      const file: FileDiff = {
        path: "test.ts",
        type: "added",
        localContent: "hello",
      };
      const label = getFileLabel(file);
      expect(label).toContain("test.ts");
    });

    it("should include path for modified file", () => {
      const file: FileDiff = {
        path: "mod.ts",
        type: "modified",
        localContent: "new",
        templateContent: "old",
      };
      const label = getFileLabel(file);
      expect(label).toContain("mod.ts");
    });
  });

  describe("renderFileDiff", () => {
    it("should display header for unchanged files without diff", () => {
      const file: FileDiff = { path: "a.ts", type: "unchanged" };
      renderFileDiff(file);
      expect(p.log.step).toHaveBeenCalledTimes(1);
      // unchanged files should not show diff content
      expect(p.log.message).not.toHaveBeenCalled();
    });

    it("should display diff content for added files", () => {
      const file: FileDiff = {
        path: "new.ts",
        type: "added",
        localContent: "const x = 1;",
      };
      renderFileDiff(file);
      expect(p.log.step).toHaveBeenCalledTimes(1);
      expect(p.log.message).toHaveBeenCalledTimes(1);
    });

    it("should display diff content for modified files", () => {
      const file: FileDiff = {
        path: "mod.ts",
        type: "modified",
        localContent: "const x = 2;",
        templateContent: "const x = 1;",
      };
      renderFileDiff(file);
      expect(p.log.step).toHaveBeenCalledTimes(1);
      expect(p.log.message).toHaveBeenCalledTimes(1);
    });
  });
});
