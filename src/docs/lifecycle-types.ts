/**
 * ライフサイクルメタデータの型定義と共有定数。
 *
 * 背景: lifecycle.ts と各コマンドファイル間の循環依存を防ぐため、
 * 型と定数をこのファイルに分離している。
 * - commands/*.ts → lifecycle-types.ts（型 + 定数）
 * - lifecycle.ts → commands/*.ts（ライフサイクルオブジェクト）
 */

/** ファイルが存在する場所 */
export type Location = "template" | "local";

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

/** 1 つのコマンドのライフサイクル */
export interface CommandLifecycle {
  /** コマンド名（表示用） */
  readonly name: string;
  /** コマンドの説明 */
  readonly description: string;
  /** ファイル操作のリスト */
  readonly ops: readonly FileOp[];
}

/**
 * 同期対象ファイル群を表すラベル。
 *
 * 実際のファイルパスではなく、ドキュメント生成時に使う概念的な表現。
 * MODULES_FILE, ZIKU_CONFIG_FILE, LOCK_FILE と同列の定数として扱う。
 */
export const SYNCED_FILES = "synced files";
