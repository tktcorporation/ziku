import { describe, expect, it } from "vitest";
import { applyTextShape, detectTextShape, normalizeText, stripBom } from "../text-shape";

const BOM = "\uFEFF";

describe("text-shape", () => {
  describe("detectTextShape", () => {
    it("LF だけの内容は lf", () => {
      expect(detectTextShape("a\nb\n")).toEqual({ eol: "lf", bom: false });
    });

    it("CRLF だけの内容は crlf", () => {
      expect(detectTextShape("a\r\nb\r\n")).toEqual({ eol: "crlf", bom: false });
    });

    it("改行が無い内容は lf", () => {
      expect(detectTextShape("single line")).toEqual({ eol: "lf", bom: false });
    });

    it("混在は多数派を採る", () => {
      expect(detectTextShape("a\r\nb\r\nc\n").eol).toBe("crlf");
      expect(detectTextShape("a\r\nb\nc\n").eol).toBe("lf");
    });

    it("同数なら lf", () => {
      expect(detectTextShape("a\r\nb\n").eol).toBe("lf");
    });

    it("先頭の BOM を検出する", () => {
      expect(detectTextShape(`${BOM}a\n`)).toEqual({ eol: "lf", bom: true });
    });

    it("途中の U+FEFF は BOM として扱わない", () => {
      expect(detectTextShape(`a${BOM}b\n`).bom).toBe(false);
    });
  });

  describe("normalizeText", () => {
    it("CRLF を LF へ揃える", () => {
      expect(normalizeText("a\r\nb\r\n")).toBe("a\nb\n");
    });

    it("先頭の BOM を剥がす", () => {
      expect(normalizeText(`${BOM}a\n`)).toBe("a\n");
    });

    it("途中の U+FEFF は内容として残す", () => {
      expect(normalizeText(`a${BOM}b`)).toBe(`a${BOM}b`);
    });

    it("lone CR は内容として残す", () => {
      expect(normalizeText("a\rb")).toBe("a\rb");
    });
  });

  describe("applyTextShape", () => {
    it("crlf を指定すると全ての改行が CRLF になる", () => {
      expect(applyTextShape("a\nb\n", { eol: "crlf", bom: false })).toBe("a\r\nb\r\n");
    });

    it("bom を指定すると先頭に BOM が付く", () => {
      expect(applyTextShape("a\n", { eol: "lf", bom: true })).toBe(`${BOM}a\n`);
    });

    it("既に CRLF や BOM を持つ内容へ適用しても二重化しない", () => {
      expect(applyTextShape(`${BOM}a\r\nb\r\n`, { eol: "crlf", bom: true })).toBe(
        `${BOM}a\r\nb\r\n`,
      );
    });

    it("検出した形を適用すると元へ戻る", () => {
      const original = `${BOM}a\r\nb\r\n`;
      expect(applyTextShape(normalizeText(original), detectTextShape(original))).toBe(original);
    });
  });

  describe("stripBom", () => {
    it("先頭の BOM は 1 つだけ剥がす", () => {
      expect(stripBom(`${BOM}${BOM}a`)).toBe(`${BOM}a`);
    });
  });
});
