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
  /** init 時の ziku CLI バージョン（例: "1.0.0"）。デバッグ・互換性判断に使用 */
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

// ────────────────────────────────────────────────────────────────
// AggregateReport (`ziku aggregate` の出力) — テンプレート側で実行し、
// owner 配下の利用リポジトリを横断して未同期差分を棚卸しした JSON レポート。
// 後段の AI エージェント等が読む外部契約なので、形をここ 1 箇所にまとめる。
// ────────────────────────────────────────────────────────────────

/**
 * テンプレートへ未還元のファイルの理由。
 * `classifyFiles` の分類カテゴリ（`src/utils/merge/types.ts` の `FileClassification`）に対応する:
 * localOnly（ローカルのみ変更）/ deletedLocally（ローカルで削除）。
 */
export const pendingPushReasonSchema = z.enum(["localOnly", "deletedLocally"]);
export type PendingPushReason = z.infer<typeof pendingPushReasonSchema>;

/**
 * 利用リポジトリへ未配布のファイルの理由。
 * `classifyFiles` の分類カテゴリに対応する:
 * autoUpdate（テンプレートのみ更新）/ newFiles（テンプレートで新規追加）/ deletedFiles（テンプレートで削除）。
 */
export const pendingPullReasonSchema = z.enum(["autoUpdate", "newFiles", "deletedFiles"]);
export type PendingPullReason = z.infer<typeof pendingPullReasonSchema>;

export const pendingPushEntrySchema = z.object({
  path: z.string(),
  reason: pendingPushReasonSchema,
  /**
   * 対象パスへの最終コミット日時（ISO 8601）。
   * `since` フィルタ指定時のみ GitHub API から取得して設定される。
   */
  lastCommittedAt: z.string().optional(),
});
export type PendingPushEntry = z.infer<typeof pendingPushEntrySchema>;

export const pendingPullEntrySchema = z.object({
  path: z.string(),
  reason: pendingPullReasonSchema,
});
export type PendingPullEntry = z.infer<typeof pendingPullEntrySchema>;

export const conflictEntrySchema = z.object({
  path: z.string(),
  /** pendingPushEntrySchema と同じく、`since` フィルタ指定時のみ設定される */
  lastCommittedAt: z.string().optional(),
});
export type ConflictEntry = z.infer<typeof conflictEntrySchema>;

export const aggregateRepositoryReportSchema = z.object({
  owner: z.string(),
  repo: z.string(),
  defaultBranch: z.string(),
  /**
   * このリポジトリの解決済み commit SHA。
   * 後段のエージェントがこの SHA でファイル内容を決定的に取得できるようにするため必須。
   */
  ref: z.string(),
  /** lock.json の baseRef。未設定（3-way マージのベース情報がない）なら省略される */
  baseRef: z.string().optional(),
  pendingPush: z.array(pendingPushEntrySchema),
  pendingPull: z.array(pendingPullEntrySchema),
  conflicts: z.array(conflictEntrySchema),
});
export type AggregateRepositoryReport = z.infer<typeof aggregateRepositoryReportSchema>;

export const skippedRepositorySchema = z.object({
  owner: z.string(),
  repo: z.string(),
  /** 処理できなかった理由（lock.json の取得失敗・パース失敗・スキーマ不一致など） */
  reason: z.string(),
});
export type SkippedRepository = z.infer<typeof skippedRepositorySchema>;

export const aggregateSummarySchema = z.object({
  /** 集約対象になったリポジトリ総数（skipped・ziku 未導入・別テンプレート利用は含まない） */
  totalRepositories: z.number().int().nonnegative(),
  /** pendingPush が 1 件以上あるリポジトリ数 */
  repositoriesWithPendingPush: z.number().int().nonnegative(),
  /** pendingPush ファイルの総数 */
  pendingPushFiles: z.number().int().nonnegative(),
  /** conflict ファイルの総数 */
  conflictFiles: z.number().int().nonnegative(),
  /**
   * このテンプレートの利用リポジトリと判定されたが、`--since` フィルタにより
   * `repositories` から除かれた件数。`--since` 未指定時は常に 0。
   *
   * `totalRepositories: 0` は「レポートに repositories が 0 件」を意味するだけで
   * 「このテンプレートを使っているリポジトリが無い」ことの証明にはならない。
   * この値が 0 でなければ、利用リポジトリは見つかったが変更が `--since` より
   * 古かっただけと判別できる。
   */
  excludedBySince: z.number().int().nonnegative(),
});
export type AggregateSummary = z.infer<typeof aggregateSummarySchema>;

export const aggregateReportSchema = z.object({
  template: z.object({
    owner: z.string(),
    repo: z.string(),
    /** 比較に使ったテンプレートリポジトリの commit SHA */
    ref: z.string(),
  }),
  generatedAt: z.string().datetime({ offset: true }),
  repositories: z.array(aggregateRepositoryReportSchema),
  skipped: z.array(skippedRepositorySchema),
  summary: aggregateSummarySchema,
});
export type AggregateReport = z.infer<typeof aggregateReportSchema>;
