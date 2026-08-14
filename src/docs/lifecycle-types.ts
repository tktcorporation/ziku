/**
 * ライフサイクルメタデータの型定義と共有定数。
 *
 * 背景: lifecycle.ts と各コマンドファイル間の循環依存を防ぐため、
 * 型と定数をこのファイルに分離している。
 * - commands/*.ts → lifecycle-types.ts（型 + 定数）
 * - lifecycle.ts → commands/*.ts（ライフサイクルオブジェクト）
 */

/**
 * ファイルが存在する場所。
 *
 * - `"local"`: コマンドを実行しているディレクトリ（ユーザープロジェクト。
 *   `aggregate` の場合はテンプレートリポジトリ自身のローカルチェックアウト）
 * - `"template"`: fetch/clone 済みのテンプレートリポジトリ
 * - `"remote"`: ローカルに取得せず GitHub API 経由でのみ読む複数のリポジトリ
 *   （`aggregate` が owner 配下の利用リポジトリを横断的に読む場合など）
 */
export type Location = "template" | "local" | "remote";

/** ファイル操作の種類 */
export type Op = "read" | "create" | "update";

/** 1 つのファイル操作 */
export interface FileOp {
  /** ファイルパス（定数参照 or リテラル） */
  readonly file: string;
  /** ファイルが存在する場所 */
  readonly location: Location;
  /** 操作の種類 */
  readonly op: Op;
  /** 補足説明 */
  readonly note: string;
}

/**
 * そのコマンドを実行する役割。
 *
 * ファイル操作の内容からは導出できない。読み取り専用のコマンドでも
 * テンプレート著者向けのものがあり、書き込みの有無と役割は対応しない。
 */
export type Audience = "Template author" | "Template user";

/** 1 つのコマンドのライフサイクル */
export interface CommandLifecycle {
  /** コマンド名（表示用） */
  readonly name: string;
  /** コマンドの説明 */
  readonly description: string;
  /** このコマンドを実行する役割 */
  readonly audience: Audience;
  /** ファイル操作のリスト */
  readonly ops: readonly FileOp[];
  /**
   * ドキュメントの「補足」セクションに出力される注記。
   *
   * コマンド実装の近くに置くことで、動作変更時に更新漏れを防ぐ。
   * 各要素は Markdown テキストとして出力される。
   */
  readonly notes?: readonly string[];
}

/**
 * 同期対象ファイル群を表すラベル。
 *
 * 実際のファイルパスではなく、ドキュメント生成時に使う概念的な表現。
 * MODULES_FILE, ZIKU_CONFIG_FILE, LOCK_FILE と同列の定数として扱う。
 */
export const SYNCED_FILES = "synced files";
