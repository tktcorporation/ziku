/**
 * テキストの「見た目に出ない形」— 改行コードと BOM — の検出・正規化・復元。
 *
 * 行単位のマージは `\n` で行を切る。CRLF のファイルをそのまま渡すと各行末に `\r` が残り、
 * 片側が LF・片側が CRLF なら全行が異なる行として扱われてファイル全体が衝突する。BOM も
 * 同じで、片側だけ BOM 付きなら 1 行目が常に差分になる。どちらも「内容が変わった」ことを
 * 意味しないので、マージの内部では取り除き、出力時に元の形へ戻す。
 *
 * 適用範囲はマージ処理の内部だけ。ハッシュ比較では正規化しない。改行コードや BOM が違う
 * ファイルはバイト列として実際に違うので、差分として検出されるのが正しい。
 */

/** BOM（U+FEFF）。ファイル先頭に置かれたときだけエンコーディングの目印として扱う。 */
const BOM = "\uFEFF";

/** 改行コードの種類。lone CR（Classic Mac OS）は現役の対象が無いので扱わない。 */
export type Eol = "lf" | "crlf";

/**
 * 内容が持っていた形。マージ結果へ戻すときの基準になる。
 */
export interface TextShape {
  readonly eol: Eol;
  /** 先頭に BOM があったか。 */
  readonly bom: boolean;
}

/**
 * 内容から改行コードと BOM の有無を読み取る。
 *
 * 改行コードが混在している場合は多数派を採る（同数なら LF）。マージは行を並べ替えるので、
 * どの行がどの改行コードだったかを結果の行へ対応付けることはできない。ファイル全体で
 * 1 つに揃えるほかなく、そのとき変更が最も少ないのが多数派の側になる。
 *
 * 内容が空なら LF・BOM 無しを返す。形を読み取る材料が無いときの既定なので、他に材料を持つ
 * 呼び出し側はそちらを先に見る（`src/utils/merge/three-way-merge.ts`）。
 */
export function detectTextShape(content: string): TextShape {
  const total = countOccurrences(content, "\n");
  const crlf = countOccurrences(content, "\r\n");
  return { eol: crlf > total - crlf ? "crlf" : "lf", bom: content.startsWith(BOM) };
}

/**
 * 先頭の BOM を取り除く。
 *
 * 剥がすのは先頭の 1 つだけ。途中に現れる U+FEFF はゼロ幅スペースとして意味を持つ文字なので、
 * 内容の一部として残す。
 */
export function stripBom(content: string): string {
  return content.startsWith(BOM) ? content.slice(BOM.length) : content;
}

/** マージ処理が扱う形（BOM 無し・LF）へ揃える。 */
export function normalizeText(content: string): string {
  return stripBom(content).replaceAll("\r\n", "\n");
}

/**
 * 正規化済みの内容を、指定された形へ戻す。
 *
 * 入力に CRLF や BOM が残っていても二重化しないよう、先に正規化してから適用する。
 */
export function applyTextShape(content: string, shape: TextShape): string {
  const normalized = normalizeText(content);
  const withEol = shape.eol === "crlf" ? normalized.replaceAll("\n", "\r\n") : normalized;
  return shape.bom ? BOM + withEol : withEol;
}

/** 重なりのない出現回数を数える。 */
function countOccurrences(haystack: string, needle: string): number {
  let count = 0;
  let index = haystack.indexOf(needle);
  while (index !== -1) {
    count++;
    index = haystack.indexOf(needle, index + needle.length);
  }
  return count;
}
