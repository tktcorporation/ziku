import { match } from "ts-pattern";
import { z } from "zod";
import type { ConflictedContent, MergedContent } from "../utils/merge";
import type { SyncPath } from "../utils/ziku-config";

// ────────────────────────────────────────────────────────────────
// Branded Types — 同じ string に載る別種の値を型で分ける
//
// ここに定義するのは「実際に取り違えが起きている／起きうる」値だけに限る。使われない
// brand を増やすと、変換関数だけが増えて型の意味は増えない。
// 値を作る変換は `src/utils/paths.ts`（パス 3 種）と、それぞれの値が外の世界から
// 入ってくる場所（`src/utils/hash.ts` のハッシュ計算、GitHub API のレスポンス）に集約する。
// ────────────────────────────────────────────────────────────────

/**
 * ファイルシステム上の絶対パス。プロジェクトルートやテンプレートの展開先を指す。
 *
 * ziku が扱うパスは「同期の基点となるディレクトリ」と「その中の 1 ファイルを指す相対パス」の
 * 2 系統あり、どちらも同じ `string` に載る。相対パスを基点の引数へ渡しても実行時エラーには
 * ならず、カレントディレクトリ基準で解決された別の場所を読み書きする。基点は
 * ハッシュ計算・差分検出・書き込みの全経路が共有するため、1 箇所の取り違えが同期対象
 * 全体へ波及する。
 */
export const absPathSchema = z.string().min(1).brand<"AbsPath">();
export type AbsPath = z.infer<typeof absPathSchema>;

/**
 * 同期の基点ディレクトリからの相対パス（posix 区切り。例: `.claude/rules/x.md`）。
 *
 * ローカルとテンプレートという 2 つの基点の下で同じファイルを指す共通の鍵になる。
 * ハッシュマップのキー、差分と分類結果の要素、lock に記録するコンフリクト一覧が
 * すべてこの型で、基点そのもの（{@link AbsPath}）や glob パターン
 * （{@link GlobPattern}）と混ざるとファイルが見つからない・照合が空になるという形で
 * 失敗する。
 */
export const repoRelPathSchema = z.string().min(1).brand<"RepoRelPath">();
export type RepoRelPath = z.infer<typeof repoRelPathSchema>;

/**
 * `.ziku/ziku.jsonc` の include / exclude に書く、同期対象を表す glob パターン。
 *
 * リテラルなファイルパス（`.ziku/ziku.jsonc` や、push が未追跡ファイルを追記したときの
 * 個別パス）も正当な値として許容する。1 ファイルだけを追跡したい利用者に glob を強制する
 * 理由が無いため。
 *
 * それでも {@link RepoRelPath} と同じ型にはしない。同一視すると「パターンとパスが一致するか」
 * の判定が文字列比較に退化し、`.claude/rules/*.md` を `ziku track` した利用者が
 * `ziku push --files .claude/rules/a.md` を実行しても関連パターン無しと判定され、
 * パターンがテンプレートへ伝播しない。パスとの照合は `src/utils/paths.ts` の
 * `selectPatternsMatchingPaths` を通し、glob として解決する。
 *
 * 空文字列も弾かない。パターンの妥当性は glob エンジンが決めることで、ここで長さを検査すると
 * `ziku.jsonc` を読むだけの経路（テンプレート側の設定を覗く処理を含む）が例外で止まる。
 * 何にも一致しないパターンは走査結果が空になるだけで、同期の結果を壊さない。
 */
export const globPatternSchema = z.string().brand<"GlobPattern">();
export type GlobPattern = z.infer<typeof globPatternSchema>;

/**
 * ファイル内容の SHA-256 ハッシュ。
 *
 * 「前回の同期時点から内容が変わったか」だけを判定するための値で、内容を復元する力も、
 * テンプレートリポジトリの履歴を指す力も持たない。lock のベースには内容ハッシュ
 * （パスごと）とコミット SHA（ツリー全体で 1 つ）が並んで載るため、同じ `string` のままだと
 * ベースツリーの取得に内容ハッシュを渡すような取り違えが型では止まらない。
 */
export const contentHashSchema = z.string().brand<"ContentHash">();
export type ContentHash = z.infer<typeof contentHashSchema>;

/**
 * テンプレートリポジトリのコミット SHA。
 *
 * 3-way マージのベースツリーを取り直すための座標で、{@link ContentHash} と同じ 40 桁前後の
 * 16 進文字列に見えるが指すものが違う。GitHub API に渡す ref であり、ローカルソースでは
 * そもそも存在しない。
 */
export const commitShaSchema = z.string().brand<"CommitSha">();
export type CommitSha = z.infer<typeof commitShaSchema>;

/**
 * GitHub Contents API がファイルの更新・削除時に要求する blob SHA。
 *
 * 「そのパスの現在の中身」を指す楽観ロックの鍵で、リポジトリごとに GitHub が採番する。
 * ziku が計算する {@link ContentHash} とは算出方法（git の blob ヘッダ付き SHA-1）も
 * 用途も別で、取り違えると API が 409 を返すか、意図しない内容を上書きする。
 */
export const blobShaSchema = z.string().brand<"BlobSha">();
export type BlobSha = z.infer<typeof blobShaSchema>;

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

/**
 * ファイル操作結果。
 *
 * `path` を brand 付きにするのは、この値が「何を書いたか」の照合鍵として使われるため
 * （`src/commands/init-plan.ts` の `planLockBaseHashes` はテンプレートの走査結果と突き合わせる）。
 * 素の `string` だと表現のずれた 1 件が「書いていない」と読まれ、init が書いたファイルの
 * 同期ベースが lock に載らないまま、次の pull でそのファイルがコンフリクトになる。
 */
export const fileOperationResultSchema = z.object({
  action: fileActionSchema,
  path: repoRelPathSchema,
});
export type FileOperationResult = z.infer<typeof fileOperationResultSchema>;

// ────────────────────────────────────────────────────────────────
// ZikuConfig (.ziku/ziku.jsonc) — パターン定義のみ
// テンプレート側・ユーザー側で同一フォーマット。
// source（どこから同期するか）は lock.json に分離。
// ────────────────────────────────────────────────────────────────

export const zikuConfigSchema = z.object({
  $schema: z.string().optional(),
  include: z.array(globPatternSchema),
  exclude: z.array(globPatternSchema).optional(),
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
  z.object({ kind: z.literal("commit"), sha: commitShaSchema }),
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
  /**
   * `ref` 省略時の取得先を、GitHub へ問い合わせられないときに決めるための既定ブランチ名。
   *
   * `ref` と役割が違う。`ref` は「このテンプレートはこの ref を追う」というユーザーの指定で、
   * ここは「問い合わせた結果こうだった」という控え。`ref` を埋めてしまうと既定ブランチの
   * 改名に追随できなくなるので、取得先の決定は毎回 GitHub への問い合わせを先に試し、
   * 引けたときはその結果でここを更新する。控えを使うのは引けなかったときだけ。
   *
   * 控えが要る理由: GitHub REST は未認証で 60 リクエスト/時しかなく、既定ブランチを引く
   * 呼び出しだけでクォータを使い切ることがある。テンプレート本体の取得（tarball）は
   * クォータを消費しないので、控えがあれば取得も差分も成立する。控え無しで止めると、
   * 待てば直る失敗で pull / push / diff / status の全部が使えなくなる。
   *
   * 控えの名前が改名で古くなっていた場合は取得が 404 で失敗する。誤ったブランチのツリーを
   * 掴んで差分を出すより、取得できなかったことを見せるほうが行動が決まる。
   */
  defaultBranch: z.string().optional(),
});

export const localSourceSchema = z.object({
  kind: z.literal("local"),
  /** ローカルテンプレートディレクトリの絶対パス */
  path: absPathSchema,
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

/**
 * パス → 内容ハッシュ。ファイル全体を保持せずに「変更されたか」を判定するための写像。
 *
 * 同じ形の写像がリポジトリ内に 3 つある（パス → 内容ハッシュ / パス → blob SHA /
 * パス → ファイル内容）。値の brand が違うので、blob SHA の写像やファイル内容の写像を
 * ベースのハッシュとして渡すとコンパイルエラーになる。
 */
const hashMapSchema = z.record(repoRelPathSchema, contentHashSchema);
export type HashMap = z.infer<typeof hashMapSchema>;

/**
 * 解決待ちのコンフリクト 1 件。
 *
 * `reason` は自動マージがそのファイルを確定できなかった経路で、`pull --continue` が
 * 「解決したか」を何で確かめるかを決める。
 *
 * | reason     | 自動マージの結末                       | ローカルのファイル       | 解決の確かめ方             |
 * | ---------- | -------------------------------------- | ------------------------ | -------------------------- |
 * | `markers`  | 3-way マージが衝突した                 | マーカー入りで書かれた   | マーカーが消えたか         |
 * | `noBase`   | 共通祖先が無く自動マージを試みていない | 触れていない             | ユーザーがどちらを残すか   |
 * | `binary`   | 行という単位が無く比べていない         | 触れていない             | ユーザーがどちらを残すか   |
 *
 * `noBase` と `binary` はローカルに何も書いていないため、マーカーが無いことは解決の証拠に
 * ならない。マーカーの有無だけで確定させると、テンプレート側の変更を取り込まないまま
 * ベースだけが前進し、テンプレートの変更が黙って消える。
 */
const pendingConflictSchema = z.discriminatedUnion("reason", [
  z.object({ path: repoRelPathSchema, reason: z.literal("markers") }),
  z.object({ path: repoRelPathSchema, reason: z.literal("noBase") }),
  z.object({ path: repoRelPathSchema, reason: z.literal("binary") }),
]);
export type PendingConflict = z.infer<typeof pendingConflictSchema>;

/**
 * 自動マージを試みなかったために解決待ちになったもの。
 *
 * ローカルのファイルには何も書かれていないので、ディスクを読んでも解決したかどうかは
 * 判定できない。`pull --continue` はこの集合についてユーザーへ問い合わせる。
 */
export type UnmergedConflict = Extract<PendingConflict, { reason: "noBase" | "binary" }>;

/**
 * コンフリクト解決待ちの一覧。
 *
 * 空配列は「解決待ちだが対象がゼロ」という、先へ進めようのない状態を意味してしまう。
 * 非空タプルで表現して型として作れなくする。
 */
const pendingConflictsSchema = z.tuple([pendingConflictSchema], pendingConflictSchema);
export type PendingConflicts = z.infer<typeof pendingConflictsSchema>;

/**
 * GitHub ソースの同期ベース。
 *
 * `ref` は「`hashes` を取ったツリーを再取得できるコミット SHA」。ブランチ名やタグではなく、
 * `downloadBaseForMerge` がその時点のツリーを取り直すために使う。
 *
 * `hashes` と `ref` は同じツリーから導かなければならない。別のツリーの SHA を載せると、
 * コンフリクト時に取り寄せる共通祖先が `hashes` の指す内容とずれ、既に取り込み済みの
 * テンプレート変更が「テンプレート側の新しい変更」として再びマージに載る。
 *
 * GitHub API に到達できず SHA を確定できないまま同期が進むことがあるため optional で、
 * その場合 3-way マージはベース無しの 2-way へ縮退する。ずれた SHA を載せるくらいなら
 * 落とすのが正しい（縮退なら解決の選択がユーザーへ渡るだけで済む）。
 */
const gitHubSyncBaseSchema = z.object({
  hashes: hashMapSchema,
  ref: commitShaSchema.optional(),
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
  /** 解決待ちのファイルと、自動マージが確定できなかった経路。 */
  conflicts: pendingConflictsSchema,
  /** 全解決後にベースとして確定する到達点。 */
  nextBase: gitHubSyncBaseSchema,
});

const localPendingMergeSchema = z.object({
  conflicts: pendingConflictsSchema,
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
  /**
   * `hashes` を取ったツリーのコミット SHA。GitHub ソースのときだけ lock に載る。
   *
   * 別のツリーの SHA を載せてはならない理由は `gitHubSyncBaseSchema` の `ref` を参照。
   * 確定できないなら省く（3-way が 2-way へ縮退する）。
   */
  readonly commitSha?: CommitSha | undefined;
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
export function baseCommitSha(lock: LockState): CommitSha | undefined {
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
 * GitHub から引けた既定ブランチ名を lock の取得元へ控える。
 *
 * 控えの用途と、`source.ref` を埋めない理由は `gitHubSourceSchema.defaultBranch` を参照。
 * 更新の起点をここ 1 箇所にすることで、控えが「最後に GitHub から引けた名前」以外の値に
 * なる経路を作らない。引けなかったとき（`undefined`）は控えを残したまま素通しする。控えは
 * まさにその場面で取得先を決めるための値なので、引けないことを理由に消してはならない。
 *
 * lock を書き出すコマンド（pull / push）はこの戻り値を持ち回るので、既定ブランチが改名された
 * 場合も一度 GitHub へ到達できた時点で控えが追随する。ローカルソースは既定ブランチを持たない
 * ので素通しする。
 */
export function withRecordedDefaultBranch(
  lock: LockState,
  defaultBranch: string | undefined,
): LockState {
  if (defaultBranch === undefined) return lock;

  return match(lock)
    .with({ source: { kind: "local" } }, (l): LockState => l)
    .with(
      { source: { kind: "github" } },
      (l): LockState => ({ ...l, source: { ...l.source, defaultBranch } }),
    )
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
  conflicts: PendingConflicts,
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
  z.object({ path: repoRelPathSchema, type: z.literal("added"), localContent: z.string() }),
  z.object({ path: repoRelPathSchema, type: z.literal("deleted"), templateContent: z.string() }),
  z.object({
    path: repoRelPathSchema,
    type: z.literal("modified"),
    localContent: z.string(),
    templateContent: z.string(),
  }),
  z.object({
    path: repoRelPathSchema,
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

// ────────────────────────────────────────────────────────────────
// テンプレートへ送る内容 — 送信ペイロードが受け取れる値を型で絞る
// ────────────────────────────────────────────────────────────────

/**
 * テンプレートへ送るファイル内容。PR の本文にも、ローカルテンプレートへの書き込みにも
 * この型しか渡らない。
 *
 * 送るものは 2 系統ある。ユーザーがローカルに書いた内容（および ziku が組み立てた
 * `ziku.jsonc` の和集合）と、3-way マージの結果。前者はユーザー自身のテキストなので
 * ziku が中身を選り分ける立場にない。後者は ziku が生成したものなので、コンフリクト
 * マーカーを含んだままテンプレートへ配ってしまう事故が起こりうる。
 *
 * そこでマージ結果の入口を {@link mergedAsPushContent} だけに絞り、その引数を
 * `MergedContent`（マーカー非混入が検証済み）に限定する。マーカー入りと確定した
 * `ConflictedContent` は、この型へ変換する手段が無いので送信対象へ入れられない。
 */
const pushContentSchema = z.string().brand<"PushContent">();
export type PushContent = z.infer<typeof pushContentSchema>;

/**
 * マージ結果のブランドを弾く。素の `string` と、マージと無関係なブランド付き文字列は通す。
 *
 * `MergedContent` / `ConflictedContent` はどちらも `string` の部分型なので、引数を
 * `string` にすると 3-way マージの結果がそのまま {@link asPushContent} を通ってしまう。
 * この条件型を交差させることで、マージ由来の内容を渡した呼び出しだけが型エラーになる。
 */
type NotMergeOutput<T> = T extends MergedContent | ConflictedContent ? never : T;

/**
 * ローカルに実在する内容（ユーザーが書いたファイル・ziku が組み立てた設定）を送る。
 *
 * 3-way マージの結果は受け取らない。クリーンと判定できた内容は
 * {@link mergedAsPushContent} が、マーカー入りの内容はどこも受け付けない。
 */
export function asPushContent<T extends string>(content: T & NotMergeOutput<T>): PushContent {
  return pushContentSchema.parse(content);
}

/** 3-way マージの結果を送る。クリーンと判定された内容だけがこの経路を通れる。 */
export function mergedAsPushContent(content: MergedContent): PushContent {
  return pushContentSchema.parse(content);
}

/**
 * テンプレートから削除してよいパス。
 *
 * ziku 自身の設定ファイルはこの型を作れない。テンプレートの `ziku.jsonc` が消えると、その
 * テンプレートを使う全プロジェクトが同期対象パターンを引けなくなり、`init` / `pull` が壊れる。
 * テンプレートへ送る削除欄がこの型しか受け取らないので、削除を積む経路が増えても
 * {@link asDeletablePath} を通らずに設定ファイルを載せることはできない。
 *
 * ローカルで設定ファイルが消えている状態は push の計画に届かない。ローカルの `ziku.jsonc` は
 * コマンドの前提（`loadCommandContext` がパターンを読む）で、読めなければ push は分類より前に
 * 「設定ファイルが無い」と報告して終わる。届いたとしても送るものは無い（`sync-plan.ts` の
 * `zikuConfigActions`）ので、ここで落とす削除に利用者への通知は要らない。
 */
const deletablePathSchema = repoRelPathSchema.brand<"DeletablePath">();
export type DeletablePath = z.infer<typeof deletablePathSchema>;

/**
 * 削除としてテンプレートへ送ってよいパスか判定する。設定ファイルなら `undefined`。
 *
 * 引数がパスではなく分類結果（`src/utils/ziku-config.ts` の `SyncPath`）なのは、判定を
 * パスの見た目ではなく種別から導くため。種別が増えたときは網羅性検査がここを止めるので、
 * 新しい特別扱いのファイルを削除対象に紛れ込ませない。
 */
export function asDeletablePath(path: SyncPath): DeletablePath | undefined {
  return match(path)
    .with({ kind: "syncedFile" }, (synced) => deletablePathSchema.parse(synced.path))
    .with({ kind: "zikuConfig" }, () => undefined)
    .exhaustive();
}
