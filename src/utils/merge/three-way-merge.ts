import { isJsonFile, isTomlFile, isYamlFile } from "./file-detection";
import { mergeJsonContent, mergeTomlContent, mergeYamlContent } from "./structured-merge";
import { textThreeWayMerge } from "./text-merge";
import type { MergeResult, ThreeWayMergeParams } from "./types";

/**
 * ファイルパスに応じた最適な 3-way マージを実行する。
 *
 * 背景: ファイルの種類によって最適なマージ戦略が異なる。
 * JSON/JSONC はキーレベルの構造マージが可能で、コンフリクトマーカーで
 * ファイル構造を壊さずにマージできる。テキストファイルは hunk 単位の
 * マーカーで精度を上げる。
 *
 * result の内容は local をベースにし、template 側の変更を適用したもの。
 * コンフリクト時は local 側の値が保持される。
 */
export function threeWayMerge({
  base,
  local,
  template,
  filePath,
}: ThreeWayMergeParams): MergeResult {
  // ローカルとテンプレートが同一なら即座に返す
  if (String(local) === String(template)) {
    return { content: local, hasConflicts: false, conflictDetails: [] };
  }

  // ファイル拡張子で構造マージを試みる。
  // コンフリクトなしで成功した場合のみ構造マージ結果を返す。
  // コンフリクトがある場合、パースに失敗した場合はテキストマージにフォールバックする。
  if (filePath && isJsonFile(filePath)) {
    const jsonResult = mergeJsonContent(base, local, template);
    // JSON 構造マージは値レベルでしか差分を検出しないため、
    // JSONC コメントやフォーマットのみの変更を見落とす。
    // マージ結果がローカルと同一の場合、テンプレート側の変更（コメント等）が
    // 反映されていない可能性があるため、テキストマージにフォールバックする。
    if (jsonResult !== null && !jsonResult.hasConflicts && jsonResult.content !== String(local)) {
      return jsonResult;
    }
  }

  if (filePath && isTomlFile(filePath)) {
    const tomlResult = mergeTomlContent(base, local, template);
    if (tomlResult !== null && !tomlResult.hasConflicts) {
      return tomlResult;
    }
  }

  if (filePath && isYamlFile(filePath)) {
    const yamlResult = mergeYamlContent(base, local, template);
    if (yamlResult !== null && !yamlResult.hasConflicts) {
      return yamlResult;
    }
  }

  return textThreeWayMerge(base, local, template, filePath);
}
