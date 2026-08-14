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
 *   conflict-io.ts     - ファイル I/O・ベースツリー取得・コンフリクト解決ループ
 */
export type {
  BaseContent,
  ClassifyOptions,
  ConflictedContent,
  ConflictRegion,
  ConflictRegions,
  FileClassification,
  FileMergeOutcome,
  LocalContent,
  MergedContent,
  MergeOutcome,
  TemplateContent,
  ThreeWayMergeParams,
} from "./types";
export { asBaseContent, asLocalContent, asTemplateContent, classifyMergeOutcome } from "./types";
export { classifyFiles } from "./classify";
export type { GeneratedMarkerSize } from "./conflict-markers";
export {
  MIN_MARKER_LENGTH,
  UNKNOWN_MARKER_SIZE,
  findConflictRegions,
  knownMarkerSize,
} from "./conflict-markers";
export { threeWayMerge } from "./three-way-merge";
export {
  readFileSafe,
  writeFileEnsureDir,
  mergeOneFile,
  mergeConflictFiles,
  downloadBaseForMerge,
} from "./conflict-io";
export type {
  MergeBaseSource,
  MergeConflictFilesInput,
  MergeOneFileInput,
  MergeOneFileOutput,
} from "./conflict-io";
