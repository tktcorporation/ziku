/**
 * 3-way マージモジュール。
 *
 * 背景: pull/push 時にベース・ローカル・テンプレートの3バージョンを比較し、
 * ファイルの分類とマージを行う。全ファイル形式で node-diff3 による
 * 行レベルの 3-way マージを使用し、コンフリクト時はマーカーを挿入する。
 *
 * 構造:
 *   types.ts           - 型定義・branded types・マージ結果の判定
 *   classify.ts        - ハッシュ比較によるファイル分類
 *   conflict-markers.ts- コンフリクトマーカーの生成と検出
 *   text-merge.ts      - 行レベルの 3-way マージ（node-diff3）
 *   three-way-merge.ts - マージのエントリポイント
 *   file-detection.ts  - ファイル形式の判定と構造検証
 */
export type {
  BaseContent,
  ClassifyOptions,
  ConflictedContent,
  ConflictRegion,
  ConflictRegions,
  FileClassification,
  LocalContent,
  MergedContent,
  MergeOutcome,
  TemplateContent,
  ThreeWayMergeParams,
} from "./types";
export { asBaseContent, asLocalContent, asTemplateContent, classifyMergeOutcome } from "./types";
export { classifyFiles } from "./classify";
export { findConflictRegions } from "./conflict-markers";
export { threeWayMerge } from "./three-way-merge";
export {
  readFileSafe,
  writeFileEnsureDir,
  mergeOneFile,
  downloadBaseForMerge,
} from "./conflict-io";
export type { MergeOneFileInput, MergeOneFileOutput } from "./conflict-io";
