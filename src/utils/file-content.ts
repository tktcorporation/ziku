/**
 * ファイル内容をテキストとバイナリに分けて扱う。
 *
 * 同期対象は設定ファイル群が中心だが、`.ziku/ziku.jsonc` の include にアイコン・フォント・
 * 画像が入る運用は普通に起こる。内容を無条件で utf-8 文字列として読むと、不正バイトが
 * U+FFFD へ潰れて別々のバイナリが同じ文字列になり、ハッシュ比較でも差分として現れず、
 * テンプレートへ送るときには壊れたバイト列が載る。
 *
 * ここでは「バイト列を読む」「種別を判定する」「string 型のチャネルへ載せる」の 3 つだけを
 * 提供し、種別ごとの扱い（マージするか・diff を出すか）は利用側が決める。
 */
import { readFile } from "node:fs/promises";
import { P, match } from "ts-pattern";
import type { FileDiff } from "../modules/schemas";

/**
 * NUL。テキストエンコーディングの本文には現れないため、バイナリの目印になる。
 *
 * バイト列では 0x00、utf-8 でも latin1 でもデコード結果は U+0000 で、両者は一対一に対応する。
 * このため「内容全体に NUL があるか」はバイト列で見ても文字列で見ても必ず同じ答えになり、
 * 判定をバイト列側（{@link isBinaryBytes}）と文字列側（{@link isBinaryTransportText}）へ
 * 分けて置いても食い違わない。
 */
const NUL_BYTE = 0;
const NUL_CHAR = "\u0000";

/**
 * 読み込んだファイル 1 つ分の内容。
 *
 * 種別をタグに載せるのは、下流（マージ・ハッシュ・diff 表示・push）が種別を意識せずに
 * 内容へ触れられないようにするため。`string` 1 本で表すと、行分割やパースといった
 * テキスト前提の処理がバイナリにもそのまま適用できてしまう。
 */
export type FileContent =
  | { readonly kind: "text"; readonly content: string }
  | { readonly kind: "binary"; readonly bytes: Buffer };

/**
 * NUL を含むかでバイナリかを判定する。
 *
 * git と同じヒューリスティック。UTF-8 / UTF-16 のテキスト本文に NUL は現れず、実行ファイル・
 * 画像・フォントにはほぼ必ず含まれるため、内容全体を解析しなくても実用的な精度が出る。
 *
 * 走査するのは内容全体で、先頭 N バイトの窓は置かない。窓を置くと、同じ内容をバイト列で見る
 * ここと文字列で見る {@link isBinaryTransportText} が別の位置までしか読まなくなる。utf-8 の
 * マルチバイト文字を含む内容ではバイト位置と文字位置がずれるので、窓の外にある NUL を
 * 一方だけが見つけ、テキストとしてデコードした内容がバイナリとして latin1 で符号化される
 * （U+00FF を超える文字が下位 1 バイトへ潰れる）。全走査でも最初の NUL で打ち切れるうえ、
 * 同期対象は設定ファイル群なので、揃わない判定を抱えるより全体を見るほうが安い。
 */
export function isBinaryBytes(bytes: Uint8Array): boolean {
  return bytes.includes(NUL_BYTE);
}

/**
 * バイト列を種別付きの内容へ変換する。
 *
 * テキストとして扱うのは「NUL を含まず、utf-8 としてデコードと再エンコードを往復しても
 * 元のバイト列に戻る」内容だけ。往復を確かめるのは、Shift_JIS / EUC-JP / latin1 のように
 * NUL を持たない非 utf-8 の内容が、デコード時だけ通り抜けてしまうため。そうした内容を
 * テキストとして流すと、不正バイトが U+FFFD へ潰れた状態でテンプレートへ届き、さらに
 * ハッシュはバイト列で比較されるのでローカルとテンプレートが永久に一致せず、そのファイルは
 * 毎回 push 候補に出続ける。バイナリとして扱えばマージ対象から外れ、バイト列のまま運ばれて
 * 内容が保たれる。
 *
 * 往復の検査は内容全体をデコードして再エンコードする。同期対象は設定ファイル群で、この規模なら
 * 走査コストより誤判定の代償のほうが大きい。
 */
export function classifyBytes(bytes: Buffer): FileContent {
  if (isBinaryBytes(bytes)) return { kind: "binary", bytes };

  const content = bytes.toString("utf-8");
  return Buffer.from(content, "utf-8").equals(bytes)
    ? { kind: "text", content }
    : { kind: "binary", bytes };
}

/** ファイルをバイト列として読み、種別を判定する。 */
export async function readFileContent(path: string): Promise<FileContent> {
  return classifyBytes(await readFile(path));
}

// ─── string 型のチャネルへ載せるための可逆エンコード ───

/**
 * バイナリを string として運ぶときのエンコーディング。
 *
 * latin1 はバイト値 0x00-0xFF とコードポイント U+0000-U+00FF の一対一対応なので、
 * デコードとエンコードを往復しても元のバイト列に戻る。utf-8 で往復すると不正バイトが
 * U+FFFD へ潰れて戻せない。
 */
const BINARY_TRANSPORT_ENCODING = "latin1";

/**
 * バイナリを string チャネルへ載せるときに先頭へ置く目印。
 *
 * NUL を持たないバイナリ（Shift_JIS のように utf-8 として往復できない内容）は、載せた文字列を
 * いくら眺めてもテキストと区別できない。latin1 の "café" と utf-8 の "café" は同じ文字列に
 * なるので、内容からの推測はどちらかを必ず壊す。種別を内容の外へ出し、載せた側が付けた目印を
 * 読む形にすれば、判定はエンコードとデコードで必ず一致する。
 *
 * U+FFFF を使うのは、latin1 で載せた内容が U+0000-U+00FF にしか収まらず目印と衝突しない
 * （剥がす位置が一意に決まる）ため。Unicode の noncharacter なのでテキストの先頭にも現れない。
 */
const BINARY_TRANSPORT_MARKER = "\uFFFF";

/**
 * 内容を string 型のチャネル（`FileDiff` の内容、push するファイル内容）へ載せる。
 *
 * 差分の型（`src/modules/schemas.ts` の `FileDiff`）が内容を `string` で持つため、
 * バイナリもいったん string を経由する。テキストは utf-8 デコードした文字列そのもの、バイナリは
 * {@link BINARY_TRANSPORT_MARKER} に続けてバイト保存できる latin1 文字列になる。両者は
 * {@link isBinaryTransportText} で見分けられ、{@link transportTextToBytes} で元のバイト列へ戻せる。
 */
export function toTransportText(content: FileContent): string {
  return content.kind === "text"
    ? content.content
    : BINARY_TRANSPORT_MARKER + content.bytes.toString(BINARY_TRANSPORT_ENCODING);
}

/**
 * string 型のチャネルに載っている内容がバイナリ由来かを判定する。
 *
 * {@link toTransportText} が付けた目印を読む。目印が無くても NUL を含む内容はバイナリとして扱う。
 * テキストと判定される内容に NUL は含まれない（{@link classifyBytes}）ので、このモジュールを
 * 経由せずに組み立てられた内容にも同じ基準が効く。
 *
 * 走査単位は {@link isBinaryBytes} と揃えて内容全体を見る。
 */
export function isBinaryTransportText(text: string): boolean {
  return text.startsWith(BINARY_TRANSPORT_MARKER) || text.includes(NUL_CHAR);
}

/**
 * string 型のチャネルの内容を、元のバイト列へ戻す。
 *
 * テンプレートへ送る内容は最終的にバイト列になる（GitHub API の base64 は入力のバイト列を
 * そのまま符号化する）。バイナリを utf-8 として符号化すると、latin1 で載せた 1 文字が
 * 2 バイトへ膨らんで別のファイルになるため、載せたときと同じエンコーディングで戻す。
 */
export function transportTextToBytes(text: string): Buffer {
  if (text.startsWith(BINARY_TRANSPORT_MARKER)) {
    return Buffer.from(text.slice(BINARY_TRANSPORT_MARKER.length), BINARY_TRANSPORT_ENCODING);
  }
  return Buffer.from(text, isBinaryTransportText(text) ? BINARY_TRANSPORT_ENCODING : "utf-8");
}

/**
 * 差分 1 件がバイナリを扱っているか。
 *
 * どちらか一方でもバイナリなら、行単位の差分は成立しない（テキストだった側が全行削除・
 * 全行追加として並ぶだけになる）。同じ判定を diff の生成側と表示側へ書き分けると、片方だけが
 * バイナリと認識して内容を並べ始めるので、内容の種別を知っているこのモジュールに 1 本置く。
 */
export function isBinaryFileDiff(fileDiff: FileDiff): boolean {
  return match(fileDiff)
    .with({ type: "added" }, (f) => isBinaryTransportText(f.localContent))
    .with({ type: "deleted" }, (f) => isBinaryTransportText(f.templateContent))
    .with(
      { type: P.union("modified", "unchanged") },
      (f) => isBinaryTransportText(f.localContent) || isBinaryTransportText(f.templateContent),
    )
    .exhaustive();
}
