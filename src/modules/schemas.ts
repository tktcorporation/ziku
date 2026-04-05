import { z } from "zod";

// ────────────────────────────────────────────────────────────────
// Branded Types - より厳密な型定義
// ────────────────────────────────────────────────────────────────

/** 非負整数（行数カウント用） */
export const nonNegativeIntSchema = z.number().int().nonnegative().brand<"NonNegativeInt">();
export type NonNegativeInt = z.infer<typeof nonNegativeIntSchema>;

/** ファイルパス */
export const filePathSchema = z.string().min(1).brand<"FilePath">();
export type FilePath = z.infer<typeof filePathSchema>;

// ────────────────────────────────────────────────────────────────
// Core Schemas
// ────────────────────────────────────────────────────────────────

// 上書き戦略
export const overwriteStrategySchema = z.enum(["overwrite", "skip", "prompt"]);
export type OverwriteStrategy = z.infer<typeof overwriteStrategySchema>;

// ファイル操作のアクション種別
export const fileActionSchema = z.enum([
  "copied", // テンプレートからコピー（新規）
  "created", // 生成されたコンテンツで作成（新規）
  "overwritten", // 上書き
  "skipped", // スキップ
  "skipped_ignored", // gitignore対象ファイルがローカルに既存のためスキップ
]);
export type FileAction = z.infer<typeof fileActionSchema>;

// ファイル操作結果
export const fileOperationResultSchema = z.object({
  action: fileActionSchema,
  path: z.string(),
});
export type FileOperationResult = z.infer<typeof fileOperationResultSchema>;

// ────────────────────────────────────────────────────────────────
// ZikuConfig (.ziku/ziku.jsonc) — パターン定義のみ
// テンプレート側・ユーザー側で同一フォーマット。
// source（どこから同期するか）は lock.json に分離。
// ────────────────────────────────────────────────────────────────

export const zikuConfigSchema = z.object({
  $schema: z.string().optional(),
  include: z.array(z.string()),
  exclude: z.array(z.string()).optional(),
});

export type ZikuConfig = z.infer<typeof zikuConfigSchema>;

// ────────────────────────────────────────────────────────────────
// TemplateSource — テンプレートの取得元
// lock.json の source フィールドで使用。
// ────────────────────────────────────────────────────────────────

export const templateSourceSchema = z.union([
  z.object({
    owner: z.string(),
    repo: z.string(),
    ref: z.string().optional(),
  }),
  z.object({
    /** ローカルテンプレートディレクトリの絶対パス */
    path: z.string(),
  }),
]);

export type TemplateSource = z.infer<typeof templateSourceSchema>;

/** source がローカルパスかどうか判定する */
export function isLocalSource(source: TemplateSource): source is { path: string } {
  return "path" in source;
}

/** source が GitHub リポジトリかどうか判定する */
export function isGitHubSource(
  source: TemplateSource,
): source is { owner: string; repo: string; ref?: string } {
  return "owner" in source;
}

// ────────────────────────────────────────────────────────────────
// LockState (.ziku/lock.json) — 機械管理: 同期状態 + ソース情報
// ────────────────────────────────────────────────────────────────

export const lockSchema = z.object({
  version: z.string(),
  installedAt: z.string().datetime({ offset: true }),
  /**
   * テンプレートの取得元。
   * init 時に設定され、pull/push/diff で参照される。
   */
  source: templateSourceSchema,
  /**
   * init/pull 時点のテンプレートリポジトリのコミット SHA。
   * pull 時に baseRef〜最新間の差分を取得し、3-way merge のベースとして使用する。
   */
  baseRef: z.string().optional(),
  /**
   * init/pull 時点の各ファイルの SHA-256 ハッシュ（パス → ハッシュ）。
   * ローカル変更の検出に使用する。ファイル全体のコピーを保持せずに
   * 「ユーザーが変更したか」を判定できるようにするため。
   */
  baseHashes: z.record(z.string(), z.string()).optional(),
  /**
   * pull 中のコンフリクト解決待ち状態。
   *
   * 背景: `ziku pull` でコンフリクトが発生した場合、ユーザーが手動解決してから
   * `ziku pull --continue` を実行するまでの間、この状態が保持される。
   * `ziku push` はこのフィールドが存在する間ブロックされる。
   * 解決完了後 `ziku pull --continue` により削除される。
   */
  pendingMerge: z
    .object({
      /** コンフリクトマーカーを確認すべきファイルパス一覧 */
      conflicts: z.array(z.string()),
      /** pull 対象のテンプレートハッシュ（解決後の baseHashes として適用） */
      templateHashes: z.record(z.string(), z.string()),
      /** pull 対象の最新コミット SHA（解決後の baseRef として適用） */
      latestRef: z.string().optional(),
    })
    .optional(),
});

export type LockState = z.infer<typeof lockSchema>;

// 差分タイプ
export const diffTypeSchema = z.enum([
  "added", // ローカルで新規追加（テンプレートにはない）
  "modified", // 変更あり
  "deleted", // ローカルで削除（テンプレートにはある）
  "unchanged", // 変更なし
]);
export type DiffType = z.infer<typeof diffTypeSchema>;

// ファイル差分
export const fileDiffSchema = z.object({
  path: z.string(),
  type: diffTypeSchema,
  localContent: z.string().optional(),
  templateContent: z.string().optional(),
});
export type FileDiff = z.infer<typeof fileDiffSchema>;

// 差分結果
export const diffResultSchema = z.object({
  files: z.array(fileDiffSchema),
  summary: z.object({
    added: z.number(),
    modified: z.number(),
    deleted: z.number(),
    unchanged: z.number(),
  }),
});
export type DiffResult = z.infer<typeof diffResultSchema>;

// PR 結果
export const prResultSchema = z.object({
  url: z.string(),
  number: z.number(),
  branch: z.string(),
});
export type PrResult = z.infer<typeof prResultSchema>;
