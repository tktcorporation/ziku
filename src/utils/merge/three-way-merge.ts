import { textThreeWayMerge } from "./text-merge";
import type { MergeResult, ThreeWayMergeParams } from "./types";

/**
 * 3-way マージを実行する。
 *
 * 背景: 以前は JSON/TOML/YAML を構造マージ（キーレベル）で処理し、
 * フォールバックとしてテキストマージを使う2段構えだった。
 * しかし構造マージとテキストマージの分岐は設計を複雑にし、
 * conflictDetails がテキストマージで常に空になる等の不整合を生んでいた。
 * node-diff3 の行レベル 3-way マージは git merge-file と同等の
 * コンフリクト検出を行うため、全ファイル形式で統一的に処理できる。
 *
 * result の内容は local をベースにし、template 側の変更を適用したもの。
 * コンフリクト時はコンフリクトマーカーが挿入される。
 */
export function threeWayMerge({
  base,
  local,
  template,
  filePath,
}: ThreeWayMergeParams): MergeResult {
  // ローカルとテンプレートが同一なら即座に返す
  if (String(local) === String(template)) {
    return { content: local, hasConflicts: false };
  }

  return textThreeWayMerge(base, local, template, filePath);
}
