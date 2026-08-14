import { describe, expect, it } from "vitest";
import { graphemeWidth, stringWidth, toGraphemes, truncateToWidth } from "../text-width";

/** ZWJ で結合された家族の絵文字。8 コードユニット・1 書記素クラスタ・2 カラム。 */
const zwjFamily = "\u{1F468}\u{200D}\u{1F469}\u{200D}\u{1F467}";
/** 基底文字 + 結合アキュートアクセント。2 コードユニット・1 書記素クラスタ・1 カラム。 */
const combiningAccent = "e\u0301";

describe("text-width", () => {
  describe("stringWidth", () => {
    it("ASCII は 1 文字 1 カラム", () => {
      expect(stringWidth("hello")).toBe(5);
    });

    it("空文字は 0 カラム", () => {
      expect(stringWidth("")).toBe(0);
    });

    it("全角のかな・漢字は 1 文字 2 カラム", () => {
      expect(stringWidth("あいう")).toBe(6);
      expect(stringWidth("漢字")).toBe(4);
    });

    it("全角形の英数字は 2 カラム", () => {
      expect(stringWidth("ＡＢ")).toBe(4);
    });

    it("絵文字は 2 カラム", () => {
      expect(stringWidth("\u{1F600}")).toBe(2);
    });

    it("ZWJ 絵文字はコードユニット数によらず 2 カラム", () => {
      expect(zwjFamily.length).toBe(8);
      expect(stringWidth(zwjFamily)).toBe(2);
    });

    it("国旗の絵文字は 2 カラム", () => {
      expect(stringWidth("\u{1F1EF}\u{1F1F5}")).toBe(2);
    });

    it("異体字セレクタで絵文字表示になる記号は 2 カラム", () => {
      expect(stringWidth("\u2714\uFE0F")).toBe(2);
    });

    it("結合文字は基底文字の幅に含まれる", () => {
      expect(stringWidth(combiningAccent)).toBe(1);
      expect(stringWidth(`a${combiningAccent}b`)).toBe(3);
    });

    it("ASCII と全角の混在を合算する", () => {
      expect(stringWidth("a あ b")).toBe(6);
    });

    it("全角の範囲表より後ろのコードポイントは 1 カラム", () => {
      expect(stringWidth("\u{10FFFD}")).toBe(1);
    });

    it("TAB はカラムを進めるので 0 にはならない", () => {
      expect(stringWidth("\t")).toBeGreaterThan(0);
      expect(stringWidth("a\tb")).toBeGreaterThan(stringWidth("ab"));
    });

    it("TAB はタブストップ間隔の 8 カラムとして数える", () => {
      expect(stringWidth("\t")).toBe(8);
      expect(stringWidth("\t\t")).toBe(16);
      expect(stringWidth("a\tb")).toBe(10);
    });
  });

  describe("graphemeWidth", () => {
    it("結合文字だけのクラスタは 0 カラム", () => {
      expect(graphemeWidth("\u0301")).toBe(0);
    });

    it("ゼロ幅接合子だけのクラスタは 0 カラム", () => {
      expect(graphemeWidth("\u200D")).toBe(0);
    });

    it("TAB 以外の制御文字は 0 カラム", () => {
      expect(graphemeWidth("\u0000")).toBe(0);
      expect(graphemeWidth("\u0007")).toBe(0);
      expect(graphemeWidth("\n")).toBe(0);
    });

    it("TAB はタブストップ間隔の 8 カラム", () => {
      expect(graphemeWidth("\t")).toBe(8);
    });
  });

  describe("toGraphemes", () => {
    it("ZWJ 絵文字を 1 つのクラスタとして扱う", () => {
      expect(toGraphemes(`${zwjFamily}ab`)).toEqual([zwjFamily, "a", "b"]);
    });

    it("結合文字を基底文字と同じクラスタに含める", () => {
      expect(toGraphemes(`${combiningAccent}x`)).toEqual([combiningAccent, "x"]);
    });
  });

  describe("truncateToWidth", () => {
    it("収まる文字列はそのまま返す", () => {
      expect(truncateToWidth("abc", 5)).toBe("abc");
    });

    it("ASCII をカラム数で切り詰める", () => {
      expect(truncateToWidth("abcdef", 3)).toBe("abc");
    });

    it("全角文字は 2 カラムとして数える", () => {
      expect(truncateToWidth("あいうえお", 4)).toBe("あい");
    });

    it("境界をまたぐ全角文字は落とす", () => {
      // 5 カラムの枠に 2 カラムの文字は 2 つまでしか入らない
      expect(truncateToWidth("あいうえお", 5)).toBe("あい");
    });

    it("書記素クラスタ境界で切るのでサロゲートペアが割れない", () => {
      const result = truncateToWidth(zwjFamily.repeat(3), 3);
      expect(result).toBe(zwjFamily);
    });

    it("タブインデントされた長い行を指定幅で切り詰める", () => {
      const line = `\t\t${"x".repeat(100)}`;
      const truncated = truncateToWidth(line, 40);
      expect(truncated).not.toBe(line);
      expect(stringWidth(truncated)).toBeLessThanOrEqual(40);
    });

    it("TAB 自体も切り詰めの予算を消費する", () => {
      // TAB 1 つで 8 カラム使うので、10 カラムの枠には TAB + ASCII 2 文字しか入らない
      expect(truncateToWidth("\tabcdef", 10)).toBe("\tab");
    });

    it("maxWidth が 0 以下なら空文字を返す", () => {
      expect(truncateToWidth("abc", 0)).toBe("");
      expect(truncateToWidth("abc", -1)).toBe("");
    });
  });
});
