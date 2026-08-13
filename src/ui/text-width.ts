/**
 * 端末の表示幅（カラム数）を数えるユーティリティ。
 *
 * `String#length` は UTF-16 コードユニット数であり、端末が消費するカラム数とは一致しない。
 * 全角文字は 1 コードユニットで 2 カラム、ZWJ 絵文字は 8 コードユニットで 2 カラム、
 * 結合文字は 1 コードユニットで 0 カラムを占める。TUI の桁揃えと切り詰めはカラム数を
 * 基準にしないと、行が端末幅で折り返されて描画行数の前提が崩れる。
 *
 * 制御シーケンス（ANSI エスケープ）は扱わない。除去してから渡すこと。
 */

/**
 * 書記素クラスタ（ユーザーが 1 文字と認識する単位）で分割する。
 *
 * サロゲートペアや結合文字列の途中で切ると孤立サロゲートや宙に浮いた結合文字が
 * 出力に残るため、切り詰めは必ずこの境界で行う。
 */
const graphemeSegmenter = new Intl.Segmenter(undefined, { granularity: "grapheme" });

/**
 * 2 カラムを占めるコードポイントの範囲。
 *
 * Unicode の East Asian Width が Wide / Fullwidth のブロックと、端末が全角相当で描く
 * 絵文字ブロックを列挙する。JavaScript の正規表現は East_Asian_Width プロパティを
 * 参照できないため、範囲表で代替する。
 *
 * `isWide` が昇順であることを前提に早期リターンするので、並び順を崩さないこと。
 */
const wideRanges: readonly (readonly [number, number])[] = [
  [0x1100, 0x115f], // ハングル字母（初声）
  [0x2329, 0x232a], // 〈 〉
  [0x2e80, 0x303e], // CJK 部首補助 〜 CJK の記号（全角スペースを含む）
  [0x3041, 0x33ff], // かな・ハングル互換字母 〜 CJK 互換用文字
  [0x3400, 0x4dbf], // CJK 統合漢字拡張 A
  [0x4e00, 0x9fff], // CJK 統合漢字
  [0xa000, 0xa4cf], // イ文字
  [0xa960, 0xa97f], // ハングル字母拡張 A
  [0xac00, 0xd7a3], // ハングル音節文字
  [0xf900, 0xfaff], // CJK 互換漢字
  [0xfe10, 0xfe19], // 縦書き用の句読点
  [0xfe30, 0xfe6f], // CJK 互換形・小字形
  [0xff00, 0xff60], // 全角 ASCII・全角記号
  [0xffe0, 0xffe6], // 全角の通貨記号
  [0x16fe0, 0x16fe4], // 表意文字用の記号
  [0x17000, 0x18cff], // 西夏文字・契丹小字
  [0x1b000, 0x1b2ff], // 仮名補助 〜 小篆
  [0x1f004, 0x1f004], // 🀄
  [0x1f0cf, 0x1f0cf], // 🃏
  [0x1f18e, 0x1f18e], // 🆎
  [0x1f191, 0x1f19a], // 🆑 〜 🆚
  [0x1f1e6, 0x1f1ff], // 地域表示記号（2 つで 1 つの国旗クラスタになる）
  [0x1f200, 0x1f2ff], // 囲み表意文字補助
  [0x1f300, 0x1f64f], // その他の記号と絵文字・顔文字
  [0x1f680, 0x1f6ff], // 交通と地図の記号
  [0x1f7e0, 0x1f7eb], // 色付きの図形
  [0x1f900, 0x1f9ff], // 補助記号と絵文字
  [0x1fa70, 0x1faff], // 記号と絵文字拡張 A
  [0x20000, 0x3fffd], // CJK 統合漢字拡張 B 以降
];

/**
 * 幅 0 のコードポイント。
 *
 * Mn / Me は結合文字で前の文字に重ねて描かれ、Cf は書式制御文字（ZWJ・異体字セレクタ）で
 * それ自体は描かれない。Cc は制御文字で、端末はカラムを進めない。
 */
const zeroWidthPattern = /^[\p{Mn}\p{Me}\p{Cf}\p{Cc}]$/u;

/**
 * 異体字セレクタ-16。直前の文字を絵文字表示に切り替える指示で、
 * 単体では幅 1 の記号（✔ など）でも絵文字として 2 カラムで描かれる。
 */
const emojiPresentationSelector = "\uFE0F";

function isWide(codePoint: number): boolean {
  for (const [start, end] of wideRanges) {
    if (codePoint < start) return false;
    if (codePoint <= end) return true;
  }
  return false;
}

/** 文字列を書記素クラスタの配列に分割する。 */
export function toGraphemes(text: string): string[] {
  return [...graphemeSegmenter.segment(text)].map((s) => s.segment);
}

/**
 * 書記素クラスタ 1 つ分の表示カラム数を返す。
 *
 * クラスタは全体で 1 つの字形として描かれるため、構成コードポイントの最大幅を
 * クラスタの幅とする。ZWJ 絵文字（👨‍👩‍👧）は全角絵文字を複数含むが描画は 2 カラムに収まり、
 * 結合文字列（e + U+0301）は基底文字の 1 カラムに収まる。
 */
export function graphemeWidth(cluster: string): number {
  if (cluster.includes(emojiPresentationSelector)) return 2;

  let width = 0;
  for (const char of cluster) {
    if (zeroWidthPattern.test(char)) continue;
    width = Math.max(width, isWide(char.codePointAt(0) ?? 0) ? 2 : 1);
  }
  return width;
}

/** 文字列の表示カラム数を返す。 */
export function stringWidth(text: string): number {
  let width = 0;
  for (const { segment } of graphemeSegmenter.segment(text)) {
    width += graphemeWidth(segment);
  }
  return width;
}

/**
 * 表示カラム数が `maxWidth` を超えないところまで切り詰める。
 *
 * 切り詰めは書記素クラスタ境界で行うため、サロゲートペアは割れない。
 * 全角文字が境界をまたぐ場合はその文字ごと落とすので、結果の幅は `maxWidth` 未満になりうる。
 */
export function truncateToWidth(text: string, maxWidth: number): string {
  if (maxWidth <= 0) return "";

  let result = "";
  let width = 0;
  for (const cluster of toGraphemes(text)) {
    const clusterWidth = graphemeWidth(cluster);
    if (width + clusterWidth > maxWidth) break;
    result += cluster;
    width += clusterWidth;
  }
  return result;
}
