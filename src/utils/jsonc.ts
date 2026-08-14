/**
 * jsonc-parser への唯一の入口。
 *
 * jsonc-parser の `parse` は不正な入力でも例外を投げない。エラー回復して部分的な値を返し、
 * 診断は第 2 引数へ渡した配列に積む。戻り値だけを見ると、閉じ括弧を失ったファイルでも
 * 「読めた」ことになり、その部分的な値を土台に元テキストを部分編集すると壊れた内容が
 * そのまま書き出される。診断を見るかどうかを呼び出し側の任意にすると、この誤用が
 * 入り放題になる。
 *
 * そのため素の `parse` はここだけが呼び、外からは診断を見ないと値を取り出せない
 * {@link parseJsonc} だけを見せる。`jsonc-parser` を直接 import することは
 * `.ast-grep/rules/no-raw-jsonc-parser.yml` が禁止するので、テキスト編集用の
 * `modify` / `applyEdits` もここから再輸出する。
 */
import { type ParseError as JsoncDiagnostic, parse, printParseErrorCode } from "jsonc-parser";
import { match } from "ts-pattern";

export { applyEdits, modify } from "jsonc-parser";

/**
 * ziku が読み書きする JSONC 方言。
 *
 * 末尾カンマを許すのは、人が手で書く設定ファイル（`.ziku/ziku.jsonc`、
 * `.claude/settings.json` 等）に普通に現れるため。方言を 1 箇所で決めることで、
 * ある入口が読めた内容を別の入口が「壊れている」と判定するずれが起きない。
 */
const JSONC_DIALECT = { allowTrailingComma: true } as const;

/**
 * JSONC を読んだ結果。
 *
 * 「読めなかった」を値の欠如（`undefined` / `null`）ではなく別ケースとして表すのは、
 * エラー回復が壊れた入力に対しても部分的な値を返すため。値の有無で判定すると、
 * 壊れたファイルが「読めた」側に紛れ込む。
 */
export type JsoncDocument =
  /** 構文が通った。`value` は JSONC が表す値そのもの（オブジェクトとは限らない）。 */
  | { readonly kind: "parsed"; readonly value: unknown }
  /** 構文が壊れている。`detail` は最初の破綻を行・桁で示した 1 行。 */
  | { readonly kind: "unparsable"; readonly detail: string };

/**
 * JSONC を読み、構文の破綻を値として返す。
 *
 * 部分的な値が欲しい場面でも `unparsable` を握り潰さないこと。壊れた入力から回復された
 * 値は「元の内容の一部」であって「元の内容」ではないので、それを土台に書き戻すと
 * 回復できなかった分が消える。
 */
export function parseJsonc(content: string): JsoncDocument {
  const diagnostics: JsoncDiagnostic[] = [];
  const value: unknown = parse(content, diagnostics, JSONC_DIALECT);

  // 2 件目以降は最初の破綻から派生した連鎖なので、直すべき箇所である先頭だけを見せる。
  const first = diagnostics[0];
  return first === undefined
    ? { kind: "parsed", value }
    : { kind: "unparsable", detail: describeDiagnostic(first, content) };
}

/**
 * 構文が通るかだけを判定する。
 *
 * 値を使わず妥当性だけが欲しい入口（マージ結果が構造を壊していないかの検査）用。
 */
export function isParsableJsonc(content: string): boolean {
  return match(parseJsonc(content))
    .with({ kind: "parsed" }, () => true)
    .with({ kind: "unparsable" }, () => false)
    .exhaustive();
}

/**
 * 診断を、エディタで開ける位置つきの 1 行に落とす。
 *
 * 診断が持つのはエラーコードと文字オフセットだけなので、行・桁へ直して示す。
 * オフセットのままだと、ユーザーは壊れた箇所へ辿り着けない。
 */
function describeDiagnostic(diagnostic: JsoncDiagnostic, content: string): string {
  const linesBefore = content.slice(0, diagnostic.offset).split("\n");
  const line = linesBefore.length;
  const column = (linesBefore.at(-1)?.length ?? 0) + 1;
  return `${printParseErrorCode(diagnostic.error)} at line ${line}, column ${column}`;
}
