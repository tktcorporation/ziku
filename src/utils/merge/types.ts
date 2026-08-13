import { z } from "zod/v4";

// ---- Branded types: base/local/template の取り違えをコンパイル時に検出 ----

/**
 * 3-way マージにおけるベース（共通祖先）のファイル内容。
 *
 * 背景: threeWayMerge の引数は全て string だが、base/local/template を
 * 入れ違えるとサイレントに誤った結果を返す（#148 で発生）。
 * Zod brand で型レベルで区別し、取り違えをコンパイルエラーにする。
 */
const BaseContent = z.string().brand("BaseContent");
export type BaseContent = z.infer<typeof BaseContent>;

/** ローカル側（ユーザー）のファイル内容。コンフリクト時に優先される側。 */
const LocalContent = z.string().brand("LocalContent");
export type LocalContent = z.infer<typeof LocalContent>;

/** テンプレート側のファイル内容。ローカルに適用される変更の源。 */
const TemplateContent = z.string().brand("TemplateContent");
export type TemplateContent = z.infer<typeof TemplateContent>;

/** string を BaseContent にブランドする */
export function asBaseContent(s: string): BaseContent {
  return BaseContent.parse(s);
}

/** string を LocalContent にブランドする */
export function asLocalContent(s: string): LocalContent {
  return LocalContent.parse(s);
}

/** string を TemplateContent にブランドする */
export function asTemplateContent(s: string): TemplateContent {
  return TemplateContent.parse(s);
}

/** 3-way マージの結果 */
export interface MergeResult {
  /** マージ後のファイル内容 */
  content: string;
  /** コンフリクトマーカーが含まれるか */
  hasConflicts: boolean;
}

/**
 * ファイル分類結果。
 * pull/push 時に base/local/template のハッシュを比較し、
 * 各ファイルの処理方法を決定するために使用する。
 */
export interface FileClassification {
  /** テンプレートのみ更新 → 自動上書き */
  autoUpdate: string[];
  /** ローカルのみ変更 → スキップ（ローカル保持） */
  localOnly: string[];
  /**
   * 両側の変更が衝突 → ユーザーの判断が必要。
   *
   * 内容の衝突（両側が同じ箇所を異なる内容に変更）に加え、片側の削除ともう片側の
   * 変更が衝突する delete/modify も両方向とも含む。後者ではテンプレート側または
   * ローカル側にファイルが存在しない。
   */
  conflicts: string[];
  /** テンプレートに新規追加 → そのまま追加 */
  newFiles: string[];
  /**
   * テンプレートで削除され、ローカルは base から変更していない → ユーザーに確認して削除。
   *
   * ローカルが base から変更されている場合は削除するとその編集が失われるため、
   * ここではなく conflicts に入る。
   */
  deletedFiles: string[];
  /** ローカルで削除（base と template にあるがローカルにない）→ push で削除可能 */
  deletedLocally: string[];
  /** 変更なし → スキップ */
  unchanged: string[];
}

export interface ClassifyOptions {
  baseHashes: Record<string, string>;
  localHashes: Record<string, string>;
  templateHashes: Record<string, string>;
}

/**
 * 3-way マージの入力パラメータ。
 *
 * 背景: base/local/template の3つの文字列は全て string 型で、位置引数だと
 * 入れ違いがコンパイルエラーにならない。named parameters + branded types で
 * 意図を明示し、取り違えをコンパイルエラーにする。
 */
export interface ThreeWayMergeParams {
  /** 共通祖先（ベース）の内容 */
  base: BaseContent;
  /** ローカル側の内容（コンフリクトマーカーの LOCAL 側に表示される） */
  local: LocalContent;
  /** テンプレート側の内容（ローカルに適用される変更の源） */
  template: TemplateContent;
  /** ファイルパス（構造ファイルのマージ後バリデーションに使用） */
  filePath?: string;
}
