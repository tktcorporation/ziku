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
 * バイナリ判定で走査する先頭バイト数。
 *
 * git の `xdiff-interface.c` の `FIRST_FEW_BYTES`（8000）と同じ。ファイル全体を走査しても
 * 判定精度はほとんど変わらず、大きなアセットで無駄が出る。git と同じ値にしておけば、
 * ziku が「バイナリ」と呼ぶファイルの集合が `git diff` の表示と食い違わない。
 */
const BINARY_SNIFF_BYTES = 8000;

/** NUL バイト。テキストエンコーディングの本文には現れないため、バイナリの目印になる。 */
const NUL = 0;

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
 * 先頭 {@link BINARY_SNIFF_BYTES} バイトに NUL が含まれるかでバイナリかを判定する。
 *
 * git と同じヒューリスティック。UTF-8 / UTF-16 のテキスト本文に NUL は現れず、実行ファイル・
 * 画像・フォントにはほぼ必ず含まれるため、内容全体を解析しなくても実用的な精度が出る。
 * 判定を外すのは「NUL を含まない小さなバイナリ」で、その場合はテキストとして扱われる
 * （git も同じ範囲で外す）。
 */
export function isBinaryBytes(bytes: Uint8Array): boolean {
  const limit = Math.min(bytes.length, BINARY_SNIFF_BYTES);
  for (let i = 0; i < limit; i++) {
    if (bytes[i] === NUL) return true;
  }
  return false;
}

/** バイト列を種別付きの内容へ変換する。テキストは utf-8 としてデコードする。 */
export function classifyBytes(bytes: Buffer): FileContent {
  return isBinaryBytes(bytes)
    ? { kind: "binary", bytes }
    : { kind: "text", content: bytes.toString("utf-8") };
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
 * 内容を string 型のチャネル（`FileDiff` の内容、push するファイル内容）へ載せる。
 *
 * 差分の型（`src/modules/schemas.ts` の `FileDiff`）が内容を `string` で持つため、
 * バイナリもいったん string を経由する。テキストは utf-8 デコードした文字列、バイナリは
 * バイト保存できる latin1 文字列になる。両者は {@link isBinaryTransportText} で見分けられ、
 * {@link transportTextToBytes} で元のバイト列へ戻せる。
 */
export function toTransportText(content: FileContent): string {
  return content.kind === "text"
    ? content.content
    : content.bytes.toString(BINARY_TRANSPORT_ENCODING);
}

/**
 * string 型のチャネルに載っている内容がバイナリ由来かを判定する。
 *
 * {@link toTransportText} が latin1 で載せたバイナリは NUL がそのまま U+0000 の文字として
 * 残るので、バイト列と同じ基準（先頭 {@link BINARY_SNIFF_BYTES} 文字に NUL があるか）で
 * 判定できる。テキストとして読まれた内容に U+0000 は現れない。
 */
export function isBinaryTransportText(text: string): boolean {
  const limit = Math.min(text.length, BINARY_SNIFF_BYTES);
  for (let i = 0; i < limit; i++) {
    if (text.codePointAt(i) === NUL) return true;
  }
  return false;
}

/**
 * string 型のチャネルの内容を、元のバイト列へ戻す。
 *
 * テンプレートへ送る内容は最終的にバイト列になる（GitHub API の base64 は入力のバイト列を
 * そのまま符号化する）。バイナリを utf-8 として符号化すると、latin1 で載せた 1 文字が
 * 2 バイトへ膨らんで別のファイルになるため、載せたときと同じエンコーディングで戻す。
 */
export function transportTextToBytes(text: string): Buffer {
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
