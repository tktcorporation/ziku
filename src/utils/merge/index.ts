/**
 * 3-way マージモジュール。
 *
 * 背景: pull/push 時にベース・ローカル・テンプレートの3バージョンを比較し、
 * ファイルの分類とマージを行う。ファイル形式（JSON/TOML/YAML/テキスト）に
 * 応じた最適なマージ戦略を選択する。
 *
 * 構造:
 *   types.ts           - 型定義・branded types
 *   classify.ts        - ハッシュ比較によるファイル分類
 *   structured-merge.ts - JSON/TOML/YAML のキーレベルマージ
 *   text-merge.ts      - 行レベルの diff/patch マージ
 *   three-way-merge.ts - 形式に応じたマージ戦略のディスパッチャ
 *   file-detection.ts  - ファイル形式の判定と構造検証
 */
export type {
  BaseContent,
  ClassifyOptions,
  ConflictDetail,
  FileClassification,
  LocalContent,
  MergeResult,
  TemplateContent,
  ThreeWayMergeParams,
} from "./types";
export { asBaseContent, asLocalContent, asTemplateContent } from "./types";
export { classifyFiles } from "./classify";
export { mergeJsonContent, mergeTomlContent, mergeYamlContent } from "./structured-merge";
export { hasConflictMarkers } from "./text-merge";
export { threeWayMerge } from "./three-way-merge";
