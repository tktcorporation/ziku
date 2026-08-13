import { describe, expect, it } from "vitest";
import type { FileDiff } from "../../modules/schemas";
import { generateUnifiedDiff } from "../diff";

describe("diff", () => {
  describe("generateUnifiedDiff", () => {
    it("added タイプのファイルで unified diff を生成する", () => {
      const fileDiff: FileDiff = {
        path: "new-file.txt",
        type: "added",
        localContent: "line1\nline2\nline3\n",
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

    it("deleted タイプはテンプレート側の内容が全行削除される patch を返す", () => {
      const fileDiff: FileDiff = {
        path: "deleted-file.txt",
        type: "deleted",
        templateContent: "first\nsecond\n",
      };

      const result = generateUnifiedDiff(fileDiff);

      expect(result).toContain("--- deleted-file.txt");
      expect(result).toContain("-first");
      expect(result).toContain("-second");
      // ローカルには存在しないので追加行は出ない
      expect(result.split("\n").some((l) => l.startsWith("+") && !l.startsWith("+++"))).toBe(false);
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
      };

      const result = generateUnifiedDiff(fileDiff);

      expect(result).toContain("--- empty-file.txt");
      expect(result).toContain("+++ empty-file.txt");
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

    it("文脈行は git と同じ 3 行になる", () => {
      // 前後に十分な行を置き、中央 1 行だけを変更する
      const templateLines = Array.from({ length: 21 }, (_, i) => `line${i}`);
      const localLines = [...templateLines];
      localLines[10] = "changed";

      const fileDiff: FileDiff = {
        path: "context.txt",
        type: "modified",
        templateContent: `${templateLines.join("\n")}\n`,
        localContent: `${localLines.join("\n")}\n`,
      };

      const contextLines = generateUnifiedDiff(fileDiff)
        .split("\n")
        .filter((l) => l.startsWith(" "));

      // 変更行の前後に 3 行ずつ
      expect(contextLines).toEqual([" line7", " line8", " line9", " line11", " line12", " line13"]);
    });
  });
});
