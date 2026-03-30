import { parse as jsoncParse } from "jsonc-parser";
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
  if (isJsonFile(filePath)) {
    try {
      const result = jsoncParse(content);
      return result != null;
    } catch {
      return false;
    }
  }
  if (isTomlFile(filePath)) {
    try {
      TOML.parse(content);
      return true;
    } catch {
      return false;
    }
  }
  if (isYamlFile(filePath)) {
    try {
      YAML.parse(content);
      return true;
    } catch {
      return false;
    }
  }
  return true;
}
