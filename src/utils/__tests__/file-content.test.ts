import { describe, expect, it } from "vitest";
import {
  classifyBytes,
  isBinaryBytes,
  isBinaryTransportText,
  toTransportText,
  transportTextToBytes,
} from "../file-content";

describe("file-content", () => {
  describe("isBinaryBytes", () => {
    it("NUL を含まないバイト列はテキスト", () => {
      expect(isBinaryBytes(Buffer.from("plain text\nwith newline\n", "utf-8"))).toBe(false);
    });

    it("マルチバイト文字だけのバイト列はテキスト", () => {
      expect(isBinaryBytes(Buffer.from("日本語のテキスト", "utf-8"))).toBe(false);
    });

    it("NUL を含むバイト列はバイナリ", () => {
      expect(isBinaryBytes(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x00, 0x1a]))).toBe(true);
    });

    it("空のバイト列はテキスト", () => {
      expect(isBinaryBytes(Buffer.alloc(0))).toBe(false);
    });

    it("走査範囲より後ろにある NUL は見ない（git と同じ先頭 8000 バイトの判定）", () => {
      const bytes = Buffer.concat([Buffer.alloc(8000, 0x61), Buffer.from([0x00])]);
      expect(isBinaryBytes(bytes)).toBe(false);
    });

    it("走査範囲の末尾にある NUL は見つける", () => {
      const bytes = Buffer.concat([Buffer.alloc(7999, 0x61), Buffer.from([0x00])]);
      expect(isBinaryBytes(bytes)).toBe(true);
    });
  });

  describe("classifyBytes", () => {
    it("テキストは utf-8 でデコードした内容を持つ", () => {
      const content = classifyBytes(Buffer.from("こんにちは", "utf-8"));
      expect(content).toEqual({ kind: "text", content: "こんにちは" });
    });

    it("バイナリはバイト列のまま持つ", () => {
      const bytes = Buffer.from([0xff, 0xfe, 0x00, 0x41]);
      const content = classifyBytes(bytes);
      expect(content.kind).toBe("binary");
      if (content.kind === "binary") {
        expect(content.bytes.equals(bytes)).toBe(true);
      }
    });
  });

  describe("string チャネルの往復", () => {
    it("テキストは utf-8 のバイト列へ戻る", () => {
      const text = "# タイトル\n本文\n";
      const restored = transportTextToBytes(toTransportText({ kind: "text", content: text }));
      expect(restored.equals(Buffer.from(text, "utf-8"))).toBe(true);
    });

    it("バイナリは元のバイト列へ戻る", () => {
      // utf-8 として解釈できないバイトを含める（不正バイトが U+FFFD へ潰れないことの確認）
      const bytes = Buffer.from([0x00, 0xff, 0xfe, 0x80, 0x41, 0xc3]);
      const restored = transportTextToBytes(toTransportText({ kind: "binary", bytes }));
      expect(restored.equals(bytes)).toBe(true);
    });

    it("内容の違うバイナリは string チャネル上でも別の値になる", () => {
      const a = toTransportText({ kind: "binary", bytes: Buffer.from([0x00, 0x80]) });
      const b = toTransportText({ kind: "binary", bytes: Buffer.from([0x00, 0x81]) });
      expect(a).not.toBe(b);
    });

    it("チャネル上の内容からバイナリかどうかを判別できる", () => {
      expect(isBinaryTransportText(toTransportText({ kind: "text", content: "hello" }))).toBe(
        false,
      );
      expect(
        isBinaryTransportText(
          toTransportText({ kind: "binary", bytes: Buffer.from([0x00, 0x01]) }),
        ),
      ).toBe(true);
    });
  });
});
