import { Effect } from "effect";
import { type ParseError, parse as jsoncParse } from "jsonc-parser";
import * as TOML from "smol-toml";
import * as YAML from "yaml";

export function isJsonFile(filePath: string): boolean {
  const lower = filePath.toLowerCase();
  return lower.endsWith(".json") || lower.endsWith(".jsonc");
}

export function isTomlFile(filePath: string): boolean {
  return filePath.toLowerCase().endsWith(".toml");
}

export function isYamlFile(filePath: string): boolean {
  const lower = filePath.toLowerCase();
  return lower.endsWith(".yml") || lower.endsWith(".yaml");
}

/**
 * 構造ファイル（JSON/TOML/YAML）のマージ結果をパースして妥当性を検証する。
 *
 * 背景: テキストベースの diff/patch は行レベルでマージするため、
 * fuzz factor でパッチが「成功」しても、TOML のセクション重複や
 * YAML のインデント崩れ等、構造的に壊れた出力を生むことがある。
 * パース失敗時はコンフリクトマーカーにフォールバックすることで、
 * 壊れたファイルの生成を防ぐ。
 */
export function validateStructuredContent(content: string, filePath: string): boolean {
  if (isJsonFile(filePath)) return isParsable(() => isValidJsonc(content));
  if (isTomlFile(filePath)) {
    return isParsable(() => {
      TOML.parse(content);
      return true;
    });
  }
  if (isYamlFile(filePath)) {
    return isParsable(() => {
      YAML.parse(content);
      return true;
    });
  }
  return true;
}

/**
 * パーサの呼び出しを妥当性の boolean に落とす。
 *
 * パーサが例外を投げた場合は「壊れている」側に倒す。マージ結果の妥当性判定は
 * 安全側（コンフリクトマーカーへのフォールバック）に振れても壊れたファイルを
 * 書き出さないが、逆に倒すと壊れた内容がそのまま確定してしまう。
 */
function isParsable(parse: () => boolean): boolean {
  return Effect.runSync(Effect.try(parse).pipe(Effect.orElseSucceed(() => false)));
}

/**
 * JSON / JSONC として構文が通るかを判定する。
 *
 * jsonc-parser の parse は不正入力でも例外を投げず、渡された配列へ ParseError を
 * 積む設計。例外の有無ではなく errors の長さで判定しないと、どんな入力でも
 * 「妥当」になる。
 *
 * 末尾カンマを許容するのは、JSONC 方言で書かれた設定ファイル（`.ziku/ziku.jsonc`、
 * `.claude/settings.json` 等）を壊れていると誤判定しないため。ここでの目的は
 * 「行レベルマージが構造を壊していないか」の検出であり、方言の厳格な検査ではない。
 */
function isValidJsonc(content: string): boolean {
  const errors: ParseError[] = [];
  jsoncParse(content, errors, { allowTrailingComma: true });
  return errors.length === 0;
}
