/**
 * 3-way マージモジュール。
 *
 * 背景: pull/push 時にベース・ローカル・テンプレートの3バージョンを比較し、
 * ファイルの分類とマージを行う。全ファイル形式で node-diff3 による
 * 行レベルの 3-way マージを使用し、コンフリクト時はマーカーを挿入する。
 *
 * 構造:
 *   types.ts           - 型定義・branded types
 *   classify.ts        - ハッシュ比較によるファイル分類
 *   text-merge.ts      - 行レベルの 3-way マージ（node-diff3）
 *   three-way-merge.ts - マージのエントリポイント
 *   file-detection.ts  - ファイル形式の判定と構造検証
 */
export type {
  BaseContent,
  ClassifyOptions,
  FileClassification,
  LocalContent,
  MergeResult,
  TemplateContent,
  ThreeWayMergeParams,
} from "./types";
export { asBaseContent, asLocalContent, asTemplateContent } from "./types";
export { classifyFiles } from "./classify";
export { hasConflictMarkers } from "./text-merge";
export { threeWayMerge } from "./three-way-merge";
export {
  readFileOrEmpty,
  writeFileEnsureDir,
  mergeOneFile,
  downloadBaseForMerge,
} from "./conflict-io";
export type { MergeOneFileInput, MergeOneFileOutput } from "./conflict-io";
