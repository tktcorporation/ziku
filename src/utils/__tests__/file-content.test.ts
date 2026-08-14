import { describe, expect, it } from "vitest";
import {
  classifyBytes,
  isBinaryBytes,
  isBinaryTransportText,
  toTransportText,
  transportTextToBytes,
} from "../file-content";

/**
 * UTF-8 の日本語（1 文字 3 バイト）の後ろに NUL を置いたバイト列。
 *
 * NUL のバイト位置は文字位置の 3 倍になるので、バイト単位と文字単位で走査範囲を切ると
 * 片方だけが NUL を見つける状況を作れる。
 */
function japaneseWithNulAfter(charCount: number): Buffer {
  return Buffer.concat([
    Buffer.from("あ".repeat(charCount), "utf-8"),
    Buffer.from([0x00]),
    Buffer.from("い", "utf-8"),
  ]);
}

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

    it("内容の後ろのほうにある NUL も見つける", () => {
      const bytes = Buffer.concat([Buffer.alloc(30_000, 0x61), Buffer.from([0x00])]);
      expect(isBinaryBytes(bytes)).toBe(true);
    });
  });

  describe("バイト列と string チャネルで判定が揃う", () => {
    // NUL のバイト位置（12000）と文字位置（4000）が離れている内容。判定の走査単位が
    // バイトと文字で食い違うと、テキストとして読んだ内容がバイナリとして符号化される。
    const bytes = japaneseWithNulAfter(4000);

    it("NUL がバイト 8000〜24000 にある UTF-8 の日本語ファイルはどちらでもバイナリ", () => {
      expect(isBinaryBytes(bytes)).toBe(true);
      expect(classifyBytes(bytes).kind).toBe("binary");
      expect(isBinaryTransportText(toTransportText(classifyBytes(bytes)))).toBe(true);
    });

    it("その内容は string チャネルを往復しても元のバイト列に戻る", () => {
      expect(transportTextToBytes(toTransportText(classifyBytes(bytes))).equals(bytes)).toBe(true);
    });
  });

  describe("utf-8 として往復できない内容", () => {
    // Shift_JIS の「日本語」。NUL を含まないが utf-8 として不正なので、デコードすると
    // U+FFFD へ潰れて元のバイト列に戻らない。
    const shiftJis = Buffer.from([0x93, 0xfa, 0x96, 0x7b, 0x8c, 0xea, 0x0a]);
    // EUC-JP の「日本語」。latin1 としては普通の文字に見えるが utf-8 としては不正。
    const eucJp = Buffer.from([0xc6, 0xfc, 0xcb, 0xdc, 0xb8, 0xec, 0x0a]);

    it.each([
      ["Shift_JIS", shiftJis],
      ["EUC-JP", eucJp],
    ])("%s の内容はテキストとして扱わない", (_name, bytes) => {
      expect(isBinaryBytes(bytes)).toBe(false);
      expect(classifyBytes(bytes).kind).toBe("binary");
    });

    it.each([
      ["Shift_JIS", shiftJis],
      ["EUC-JP", eucJp],
    ])("%s の内容は string チャネルを往復しても保たれる", (_name, bytes) => {
      const transport = toTransportText(classifyBytes(bytes));
      expect(isBinaryTransportText(transport)).toBe(true);
      expect(transportTextToBytes(transport).equals(bytes)).toBe(true);
    });

    it("内容の違う非 utf-8 ファイルは string チャネル上でも別の値になる", () => {
      expect(toTransportText(classifyBytes(shiftJis))).not.toBe(
        toTransportText(classifyBytes(eucJp)),
      );
    });
  });

  describe("通常の UTF-8 テキストはテキストのまま扱う", () => {
    it.each([
      ["ASCII", "plain text\nwith newline\n"],
      ["日本語", "# タイトル\n本文です\n"],
      ["U+00FF 以下のアクセント付き文字", "café naïve\n"],
      ["正規の内容としての U+FFFD", "replacement: �\n"],
    ])("%s はテキストとして扱い、往復しても保たれる", (_name, text) => {
      const bytes = Buffer.from(text, "utf-8");
      const content = classifyBytes(bytes);

      expect(content).toEqual({ kind: "text", content: text });
      const transport = toTransportText(content);
      expect(isBinaryTransportText(transport)).toBe(false);
      expect(transportTextToBytes(transport).equals(bytes)).toBe(true);
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

    it("目印と同じ文字で始まるテキストもバイト列のまま戻る", () => {
      // U+FFFF はバイナリを載せるときの目印。内容がこの文字で始まると種別が曖昧になるので、
      // classifyBytes がバイト列として運ぶ側へ倒す。
      const bytes = Buffer.from("￿title\n", "utf-8");
      const restored = transportTextToBytes(toTransportText(classifyBytes(bytes)));
      expect(restored.equals(bytes)).toBe(true);
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
