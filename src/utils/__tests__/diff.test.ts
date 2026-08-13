import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "pathe";
import { afterEach, describe, expect, it } from "vitest";
import type { FileDiff } from "../../modules/schemas";
import { detectDiff, generateUnifiedDiff } from "../diff";

/** バイナリの内容を差分の string チャネルへ載せた形（バイト保存の latin1）。 */
function asDiffContent(bytes: number[]): string {
  return Buffer.from(bytes).toString("latin1");
}

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
  describe("generateUnifiedDiff - バイナリ", () => {
    it("バイナリの変更は内容を出さず 1 行で示す", () => {
      const fileDiff: FileDiff = {
        path: "assets/icon.png",
        type: "modified",
        templateContent: asDiffContent([0x89, 0x50, 0x4e, 0x47, 0x00, 0x01]),
        localContent: asDiffContent([0x89, 0x50, 0x4e, 0x47, 0x00, 0x02]),
      };

      const result = generateUnifiedDiff(fileDiff);

      expect(result).toBe(
        "Binary files template/assets/icon.png and local/assets/icon.png differ\n",
      );
      expect(result).not.toContain("\u0000");
      expect(result).not.toContain("@@");
    });

    it("ローカルにだけあるバイナリは追加として 1 行で示す", () => {
      const fileDiff: FileDiff = {
        path: "assets/font.woff2",
        type: "added",
        localContent: asDiffContent([0x77, 0x4f, 0x46, 0x32, 0x00]),
      };

      expect(generateUnifiedDiff(fileDiff)).toBe(
        "Binary files /dev/null and local/assets/font.woff2 differ\n",
      );
    });

    it("テンプレートにだけあるバイナリは削除として 1 行で示す", () => {
      const fileDiff: FileDiff = {
        path: "assets/font.woff2",
        type: "deleted",
        templateContent: asDiffContent([0x77, 0x4f, 0x46, 0x32, 0x00]),
      };

      expect(generateUnifiedDiff(fileDiff)).toBe(
        "Binary files template/assets/font.woff2 and /dev/null differ\n",
      );
    });

    it("内容が同じバイナリには差分を出さない", () => {
      const content = asDiffContent([0x00, 0x01, 0x02]);
      const fileDiff: FileDiff = {
        path: "assets/icon.png",
        type: "unchanged",
        templateContent: content,
        localContent: content,
      };

      expect(generateUnifiedDiff(fileDiff)).toBe("");
    });
  });
  describe("detectDiff - バイナリ", () => {
    const tempDirs: string[] = [];

    afterEach(async () => {
      for (const dir of tempDirs) await rm(dir, { recursive: true, force: true });
      tempDirs.length = 0;
    });

    async function dirs(): Promise<{ targetDir: string; templateDir: string }> {
      const root = await mkdtemp(join(tmpdir(), "ziku-test-diff-binary-"));
      tempDirs.push(root);
      const targetDir = join(root, "local");
      const templateDir = join(root, "template");
      await mkdir(targetDir, { recursive: true });
      await mkdir(templateDir, { recursive: true });
      return { targetDir, templateDir };
    }

    const patterns = { include: ["**"], exclude: [] };

    it("内容の違うバイナリを modified として検出する", async () => {
      const { targetDir, templateDir } = await dirs();
      // utf-8 デコードを挟むと、どちらの不正バイトも U+FFFD へ潰れて同じ内容に見える
      await writeFile(join(targetDir, "icon.png"), Buffer.from([0x00, 0xff, 0x41]));
      await writeFile(join(templateDir, "icon.png"), Buffer.from([0x00, 0xfe, 0x41]));

      const result = await detectDiff({ targetDir, templateDir, patterns });

      expect(result.files.map((f) => [f.path, f.type])).toEqual([["icon.png", "modified"]]);
      expect(generateUnifiedDiff(result.files[0])).toBe(
        "Binary files template/icon.png and local/icon.png differ\n",
      );
    });

    it("同一バイト列のバイナリは unchanged として検出する", async () => {
      const { targetDir, templateDir } = await dirs();
      const bytes = Buffer.from([0x00, 0xff, 0x41]);
      await writeFile(join(targetDir, "icon.png"), bytes);
      await writeFile(join(templateDir, "icon.png"), bytes);

      const result = await detectDiff({ targetDir, templateDir, patterns });

      expect(result.files.map((f) => [f.path, f.type])).toEqual([["icon.png", "unchanged"]]);
    });
  });
});
