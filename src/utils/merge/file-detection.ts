import { Effect } from "effect";
import * as TOML from "smol-toml";
import * as YAML from "yaml";
import { isParsableJsonc } from "../jsonc";

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
  if (isJsonFile(filePath)) return isParsableJsonc(content);
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
