import { match } from "ts-pattern";
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

/**
 * テンプレートを取得する git ref。
 *
 * giget の `gh:owner/repo#<ref>` 記法では、ブランチ名・タグ名・コミット SHA が同じ位置に
 * 書けるため、1 本の文字列で持つと「どの種別か」が失われる。消費側の要求は種別ごとに違う。
 *
 * - ブランチを要求する: 「そのブランチの最新コミット」の解決、PR のベースブランチ指定
 *   （`repos.getBranch` はブランチ以外で 404 になる）
 * - コミット SHA を要求する: 3-way マージのベースツリー取得
 *
 * 種別を判別タグに載せることで、ブランチ名を要求する API がタグ・コミットを受け取れなくなる。
 * 種別によらず giget へ渡す文字列が必要な場面では `templateRefToString` を通す。
 */
export const templateRefSchema = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("branch"), name: z.string() }),
  z.object({ kind: z.literal("tag"), name: z.string() }),
  z.object({ kind: z.literal("commit"), sha: z.string() }),
]);

export type TemplateRef = z.infer<typeof templateRefSchema>;

/** ブランチを指す ref。ブランチ名でしか成立しない API の引数型に使う。 */
export type BranchRef = Extract<TemplateRef, { kind: "branch" }>;

/**
 * ref を giget の `gh:owner/repo#<ref>` 記法へ載せる文字列に落とす。
 *
 * giget は種別を区別せず「# の後ろの文字列」を解決するため、どの種別でも同じ位置に載る。
 * 種別ごとの分岐をここ 1 箇所に閉じることで、呼び出し側は `name` と `sha` の
 * どちらを読むかを判断せずに済む。
 */
export function templateRefToString(ref: TemplateRef): string {
  return match(ref)
    .with({ kind: "branch" }, (r) => r.name)
    .with({ kind: "tag" }, (r) => r.name)
    .with({ kind: "commit" }, (r) => r.sha)
    .exhaustive();
}

export const gitHubSourceSchema = z.object({
  kind: z.literal("github"),
  owner: z.string(),
  repo: z.string(),
  /** 省略時はリポジトリの既定ブランチを取得する。 */
  ref: templateRefSchema.optional(),
});

export const localSourceSchema = z.object({
  kind: z.literal("local"),
  /** ローカルテンプレートディレクトリの絶対パス */
  path: z.string(),
});

export const templateSourceSchema = z.discriminatedUnion("kind", [
  gitHubSourceSchema,
  localSourceSchema,
]);

export type GitHubSource = z.infer<typeof gitHubSourceSchema>;
export type LocalSource = z.infer<typeof localSourceSchema>;
export type TemplateSource = z.infer<typeof templateSourceSchema>;

// ────────────────────────────────────────────────────────────────
// LockState (.ziku/lock.json) — 機械管理: 同期状態 + ソース情報
// ────────────────────────────────────────────────────────────────

/** パス → SHA-256 ハッシュ。ファイル全体を保持せずに「変更されたか」を判定するための写像。 */
const hashMapSchema = z.record(z.string(), z.string());
export type HashMap = z.infer<typeof hashMapSchema>;

/**
 * コンフリクト解決待ちのファイルパス。
 *
 * 空配列は「解決待ちだが対象がゼロ」という、先へ進めようのない状態を意味してしまう。
 * 非空タプルで表現して型として作れなくする。
 */
const conflictPathsSchema = z.tuple([z.string()], z.string());
export type ConflictPaths = z.infer<typeof conflictPathsSchema>;

/**
 * GitHub ソースの同期ベース。
 *
 * `ref` は「ベースツリーを再取得できるコミット SHA」。ブランチ名やタグではなく、
 * `downloadBaseForMerge` がその時点のツリーを取り直すために使う。
 * GitHub API に到達できず SHA を確定できないまま同期が進むことがあるため optional で、
 * その場合 3-way マージはベース無しの 2-way へ縮退する。
 */
const gitHubSyncBaseSchema = z.object({
  hashes: hashMapSchema,
  ref: z.string().optional(),
});

/**
 * ローカルソースの同期ベース。
 *
 * コミット SHA を持たない。ローカルディレクトリには過去のツリーを再取得する手段が無く、
 * SHA を記録しても参照側が黙って無視するだけになるから。
 *
 * `ref` を単に省くのではなく「常に未定義」として明示するのは、TypeScript が union を
 * 相手にしたオブジェクトリテラルの余剰プロパティを見逃すため。宣言しておくと
 * `{ hashes, ref: "sha" }` が型としても実行時の検証としても弾かれる。
 */
const localSyncBaseSchema = z.object({
  hashes: hashMapSchema,
  ref: z.undefined().optional(),
});

export type GitHubSyncBase = z.infer<typeof gitHubSyncBaseSchema>;
export type LocalSyncBase = z.infer<typeof localSyncBaseSchema>;
export type SyncBase = GitHubSyncBase | LocalSyncBase;

const gitHubPendingMergeSchema = z.object({
  /** コンフリクトマーカーの解消を確認すべきファイル。 */
  conflicts: conflictPathsSchema,
  /** 全解決後にベースとして確定する到達点。 */
  nextBase: gitHubSyncBaseSchema,
});

const localPendingMergeSchema = z.object({
  conflicts: conflictPathsSchema,
  nextBase: localSyncBaseSchema,
});

const lockIdentityShape = {
  /** init 時の ziku CLI バージョン（例: "1.0.0"）。デバッグ・互換性判断に使用 */
  version: z.string(),
  installedAt: z.string().datetime({ offset: true }),
};

/**
 * `.ziku/lock.json` の内容。「テンプレートの取得元」と「同期がどこまで進んでいるか」を持つ。
 *
 * ソース種別（github / local）× 同期状態（pending / synced / merging）の直積を、
 * 6 つの形として列挙する。直積を潰して optional フィールドの組み合わせにすると、
 * 次の意味を成さない状態が表現できてしまう。
 *
 * | 表現できなくした状態                         | なぜ不正か                                   |
 * | -------------------------------------------- | -------------------------------------------- |
 * | ローカルソース + コミット SHA                | 過去のツリーを再取得する術が無く参照されない |
 * | ベースのコミット SHA だけあってハッシュ無し  | ベースツリーはあるが比較基準が無い           |
 * | コンフリクト解決待ちなのにベース無し         | 中断状態なのにマージの共通祖先が無い         |
 * | 解決待ちのコンフリクトが 0 件                | 「解決待ちだが対象ゼロ」で先へ進めない       |
 *
 * 同期状態の意味:
 *
 * - `pending`: init 直後でベースのハッシュが未確定。全テンプレートファイルが新規扱いになる
 * - `synced`: ベース確定済み。pull/push はこのベースとの 3-way 比較で判断する
 * - `merging`: pull のコンフリクトをユーザーが手で解決している最中。`push` はブロックされ、
 *   `pull --continue` だけが `merge.nextBase` をベースへ確定して `synced` に戻せる
 *
 * 状態遷移は `markSynced` / `markMerging` / `resolveMerge` だけが行う。スプレッドで直接
 * 組み立てると、遷移前の状態のフィールドが残ったまま書き出せてしまうため。
 */
export const lockSchema = z.union([
  z.object({ ...lockIdentityShape, source: gitHubSourceSchema, sync: z.literal("pending") }),
  z.object({
    ...lockIdentityShape,
    source: gitHubSourceSchema,
    sync: z.literal("synced"),
    base: gitHubSyncBaseSchema,
  }),
  z.object({
    ...lockIdentityShape,
    source: gitHubSourceSchema,
    sync: z.literal("merging"),
    base: gitHubSyncBaseSchema,
    merge: gitHubPendingMergeSchema,
  }),
  z.object({ ...lockIdentityShape, source: localSourceSchema, sync: z.literal("pending") }),
  z.object({
    ...lockIdentityShape,
    source: localSourceSchema,
    sync: z.literal("synced"),
    base: localSyncBaseSchema,
  }),
  z.object({
    ...lockIdentityShape,
    source: localSourceSchema,
    sync: z.literal("merging"),
    base: localSyncBaseSchema,
    merge: localPendingMergeSchema,
  }),
]);

export type LockState = z.infer<typeof lockSchema>;

/**
 * 通常の pull が扱える lock。
 *
 * `merging` を含まないことで「コンフリクトマーカーを残したまま `ziku pull` を再実行し、
 * マーカーが入れ子になる」経路を型で塞ぐ。中断状態から前へ進める手段は
 * `pull --continue` だけになる。
 */
export type ResumableLockState = Exclude<LockState, { sync: "merging" }>;

/** `pull --continue` だけが扱う、コンフリクト解決待ちの lock。 */
export type MergingLockState = Extract<LockState, { sync: "merging" }>;

/**
 * 同期の到達点。「そのとき各ファイルがどんな内容だったか」と、GitHub ソースなら
 * 「テンプレートリポジトリのどのコミットだったか」。
 *
 * ソース種別に依らない入力として受け取り、lock へ載せる段階で種別に合った形へ落とす
 * （ローカルソースでは `commitSha` を捨てる）。
 */
export interface SyncPoint {
  readonly hashes: HashMap;
  /** GitHub ソースのときだけ lock に載る。 */
  readonly commitSha?: string | undefined;
}

function gitHubBaseOf(at: SyncPoint): GitHubSyncBase {
  return {
    hashes: at.hashes,
    ...(at.commitSha !== undefined ? { ref: at.commitSha } : {}),
  };
}

/**
 * lock が比較基準にしているハッシュ。
 *
 * `pending` は「ベース未確定」なので空写像を返す。呼び出し側はそのまま分類処理へ渡せる
 * （全ファイルが新規として分類される）。
 */
export function baseHashesOf(lock: LockState): HashMap {
  return lock.sync === "pending" ? {} : lock.base.hashes;
}

/**
 * lock が記録しているベースツリーのコミット SHA。
 *
 * GitHub ソースかつベース確定済みのときだけ存在する。表示と 3-way マージのベース取得に使う。
 */
export function baseCommitSha(lock: LockState): string | undefined {
  return match(lock)
    .with({ source: { kind: "github" }, sync: "pending" }, () => undefined)
    .with({ source: { kind: "github" } }, (l) => l.base.ref)
    .with({ source: { kind: "local" } }, () => undefined)
    .exhaustive();
}

/** init 直後の lock。ベース未確定の `pending` として作る。 */
export function createPendingLock(params: {
  version: string;
  installedAt: string;
  source: TemplateSource;
}): ResumableLockState {
  return match(params.source)
    .with({ kind: "github" }, (source) => ({
      version: params.version,
      installedAt: params.installedAt,
      source,
      sync: "pending" as const,
    }))
    .with({ kind: "local" }, (source) => ({
      version: params.version,
      installedAt: params.installedAt,
      source,
      sync: "pending" as const,
    }))
    .exhaustive();
}

/**
 * ベースを `at` に確定して `synced` へ遷移させる。
 *
 * ソース種別に合わないフィールドはここで落ちるため、ローカルソースの lock に
 * コミット SHA が載ることはない。
 */
export function markSynced(lock: LockState, at: SyncPoint): ResumableLockState {
  return match(lock)
    .with({ source: { kind: "github" } }, (l) => ({
      version: l.version,
      installedAt: l.installedAt,
      source: l.source,
      sync: "synced" as const,
      base: gitHubBaseOf(at),
    }))
    .with({ source: { kind: "local" } }, (l) => ({
      version: l.version,
      installedAt: l.installedAt,
      source: l.source,
      sync: "synced" as const,
      base: { hashes: at.hashes },
    }))
    .exhaustive();
}

/**
 * コンフリクト解決待ちの `merging` へ遷移させる。
 *
 * `base` には「このマージで共通祖先として使ったベース」を残す。`pending`（ベース未確定）
 * からマージに入った場合は、空のベースを使ったという事実をそのまま記録する。
 * `next` は全解決後にベースとして確定する到達点で、`resolveMerge` がそれを適用する。
 *
 * 引数の型が `merging` を除くため、中断中の lock から二重にマージを開始できない。
 */
export function markMerging(
  lock: ResumableLockState,
  next: SyncPoint,
  conflicts: ConflictPaths,
): MergingLockState {
  return match(lock)
    .with({ source: { kind: "github" } }, (l) => ({
      version: l.version,
      installedAt: l.installedAt,
      source: l.source,
      sync: "merging" as const,
      base: l.sync === "pending" ? { hashes: {} } : l.base,
      merge: { conflicts, nextBase: gitHubBaseOf(next) },
    }))
    .with({ source: { kind: "local" } }, (l) => ({
      version: l.version,
      installedAt: l.installedAt,
      source: l.source,
      sync: "merging" as const,
      base: l.sync === "pending" ? { hashes: {} } : l.base,
      merge: { conflicts, nextBase: { hashes: next.hashes } },
    }))
    .exhaustive();
}

/**
 * 解決待ちだったベースを確定して `synced` へ戻す。
 *
 * 戻り値の型に `merge` が無いため、確定後にコンフリクト情報が残ることはない。
 */
export function resolveMerge(lock: MergingLockState): ResumableLockState {
  return match(lock)
    .with({ source: { kind: "github" } }, (l) => ({
      version: l.version,
      installedAt: l.installedAt,
      source: l.source,
      sync: "synced" as const,
      base: l.merge.nextBase,
    }))
    .with({ source: { kind: "local" } }, (l) => ({
      version: l.version,
      installedAt: l.installedAt,
      source: l.source,
      sync: "synced" as const,
      base: l.merge.nextBase,
    }))
    .exhaustive();
}

// 差分タイプ
export const diffTypeSchema = z.enum([
  "added", // ローカルで新規追加（テンプレートにはない）
  "modified", // 変更あり
  "deleted", // ローカルで削除（テンプレートにはある）
  "unchanged", // 変更なし
]);
export type DiffType = z.infer<typeof diffTypeSchema>;

/**
 * ローカルとテンプレートを突き合わせた 1 ファイル分の差分。
 *
 * 種別ごとに、どちら側の内容が存在するかが決まっている。
 *
 * | 種別        | 存在する内容                    | その状況                             |
 * | ----------- | ------------------------------- | ------------------------------------ |
 * | `added`     | `localContent`                  | ローカルにだけあり、テンプレに無い   |
 * | `deleted`   | `templateContent`               | テンプレにだけあり、ローカルに無い   |
 * | `modified`  | `localContent`/`templateContent` | 両方にあり、内容が異なる            |
 * | `unchanged` | `localContent`/`templateContent` | 両方にあり、内容が同じ              |
 *
 * この対応を種別と独立した optional フィールドで表すと、「ローカルにしか無いはずの
 * `added` にテンプレの内容が載る」「両側にあるはずの `modified` で片側が欠ける」といった
 * 起こりえない組み合わせが作れてしまう。そうなると内容を読む側は欠損に備えるしかなく、
 * `?? ""` で空文字列に潰す。空文字列は「中身が空のファイル」と区別できないため、
 * テンプレ側を空とみなした patch や、行数 0 という嘘の統計がそのまま表示に出る。
 * 判別 union にすると、存在しない内容へのアクセスがコンパイルエラーになり、
 * フォールバックを書く余地自体が無くなる。
 *
 * 存在しない側のフィールドは「常に undefined」としても宣言しない。宣言すると union 全体で
 * `diff.templateContent` が読めてしまい、種別で絞り込まずに `?? ""` を書く経路が復活する。
 * 内容を読むには `match(diff).with({ type: ... })` で種別を絞る必要がある。
 */
export const fileDiffSchema = z.discriminatedUnion("type", [
  z.object({ path: z.string(), type: z.literal("added"), localContent: z.string() }),
  z.object({ path: z.string(), type: z.literal("deleted"), templateContent: z.string() }),
  z.object({
    path: z.string(),
    type: z.literal("modified"),
    localContent: z.string(),
    templateContent: z.string(),
  }),
  z.object({
    path: z.string(),
    type: z.literal("unchanged"),
    localContent: z.string(),
    templateContent: z.string(),
  }),
]);
export type FileDiff = z.infer<typeof fileDiffSchema>;

/**
 * ローカルとテンプレート全体の差分。
 *
 * 種別ごとの件数は `files` から数えれば必ず出るため、フィールドとしては持たない。
 * 集計値を併置すると `files` を絞り込んだ側と集計側が食い違い、「push 対象は 0 件なのに
 * 変更ありと判定される」ような不整合が作れる。件数が要る場所では `summarizeDiff` を呼ぶ。
 */
export const diffResultSchema = z.object({
  files: z.array(fileDiffSchema),
});
export type DiffResult = z.infer<typeof diffResultSchema>;

/** 差分種別ごとのファイル数。`summarizeDiff` が `files` から導出する。 */
export type DiffSummary = Readonly<Record<DiffType, number>>;

/**
 * 差分の種別ごとの件数を数える。
 *
 * 種別をそのままキーにするので、`DiffType` に種別が増えたときは初期値の
 * `Record<DiffType, number>` が不足キーとしてコンパイルエラーになる。
 */
export function summarizeDiff(files: readonly FileDiff[]): DiffSummary {
  const counts: Record<DiffType, number> = { added: 0, modified: 0, deleted: 0, unchanged: 0 };
  for (const file of files) counts[file.type]++;
  return counts;
}

// PR 結果
export const prResultSchema = z.object({
  url: z.string(),
  number: z.number(),
  branch: z.string(),
});
export type PrResult = z.infer<typeof prResultSchema>;
