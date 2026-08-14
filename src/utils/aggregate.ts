/**
 * `ziku aggregate` の集約ロジック。
 *
 * 背景: テンプレートリポジトリ側で実行し、owner 配下のリポジトリを GitHub API で
 * 列挙して「そのテンプレートを使っているリポジトリ」を特定し、各リポジトリの
 * 未同期差分（テンプレートへ未還元 / テンプレートから未配布 / 双方が変更）を
 * 棚卸しして {@link AggregateReport} にまとめる。
 *
 * 1 リポジトリの失敗（権限不足・lock.json の破損・ダウンロード失敗・レート制限）は
 * 全体を落とさず `skipped` に積んで処理を継続する。`listOwnerRepos` 自体の失敗
 * （owner が存在しない・認証エラー）だけは全体の失敗として返る。
 */
import { tmpdir } from "node:os";
import { Effect, Either, Option } from "effect";
import type { Scope } from "effect";
import { join } from "pathe";
import { GitHubApiError, TemplateError } from "../errors";
import type {
  AggregateReport,
  AggregateRepositoryReport,
  ConflictEntry,
  LockState,
  PendingPullEntry,
  PendingPushEntry,
  SkippedRepository,
} from "../modules/schemas";
import { isGitHubSource, lockSchema } from "../modules/schemas";
import {
  fetchRepoTextFile,
  getLastCommitDate,
  listOwnerRepos,
  resolveLatestCommitSha,
} from "./github";
import type { OwnerRepoInfo } from "./github";
import { LOCK_FILE } from "./lock";
import { classifyFiles } from "./merge/classify";
import type { FileClassification } from "./merge/types";
import { mergePatterns } from "./patterns";
import { acquireTempTemplate, buildTemplateSource } from "./template";
import { hashFiles } from "./hash";
import { loadZikuConfig } from "./ziku-config";

/** aggregate の対象となるテンプレートリポジトリ */
export interface AggregateTemplateRepo {
  readonly owner: string;
  readonly repo: string;
  /**
   * 比較に使うテンプレート側の commit SHA。
   * 省略時はテンプレートリポジトリの既定ブランチの最新コミットを解決する。
   */
  readonly ref?: string;
}

export interface AggregateOptions {
  readonly template: AggregateTemplateRepo;
  /**
   * 探索する owner。省略時はテンプレートリポジトリの owner。
   * テンプレートを別 owner のリポジトリ群へ配っている場合に指定する。
   */
  readonly searchOwner?: string;
  /** true の場合アーカイブ済みリポジトリも候補に含める。既定は false */
  readonly includeArchived?: boolean;
  /**
   * 利用リポジトリ 1 件の処理（テンプレート/リポジトリ双方のダウンロード + ハッシュ計算）
   * を同時に何件まで並列実行するか。GitHub API のレート制限とテンポラリディスク使用量を
   * 抑えるため既定は 4。lock.json の存在確認（列挙候補全件への読み取り）にも同じ値を使う。
   */
  readonly concurrency?: number;
  /**
   * 指定した場合、pendingPush / conflicts の最終コミット日時（ISO 8601）が
   * この値以降であるリポジトリだけをレポートに残す。
   */
  readonly since?: string;
  /**
   * テンプレート/リポジトリのダウンロード先ベースディレクトリ。
   * 省略時は OS の一時ディレクトリ配下にランダムなサブディレクトリを使う。
   * テストで memfs 上の固定パスに向けるために公開している。
   */
  readonly tmpBaseDir?: string;
}

const DEFAULT_CONCURRENCY = 4;

/**
 * owner 配下のリポジトリを列挙し、指定テンプレートの利用リポジトリだけを
 * 対象に未同期差分レポートを組み立てる。
 *
 * 処理の流れ:
 * 1. `listOwnerRepos` で owner 配下の候補を列挙し、テンプレートリポジトリ自身を除外する
 * 2. 各候補の `.ziku/lock.json` を読み、対象テンプレートを指しているものだけを残す
 * 3. 残った各リポジトリについて、テンプレートとの内容差分をハッシュ比較で分類する
 * 4. `since` 指定時は pendingPush/conflicts の最終コミット日時でリポジトリ単位に絞り込む
 */
export function aggregateTemplateUsage(
  options: AggregateOptions,
): Effect.Effect<AggregateReport, GitHubApiError | TemplateError> {
  const { template, includeArchived, since } = options;
  const searchOwner = options.searchOwner ?? template.owner;
  const concurrency = options.concurrency ?? DEFAULT_CONCURRENCY;
  const tmpBaseDir = options.tmpBaseDir ?? defaultTmpBaseDir();

  return Effect.scoped(
    Effect.gen(function* () {
      const allRepos = yield* listOwnerRepos(searchOwner, { includeArchived });

      const templateInfo = allRepos.find((r) => isSameRepo(r, template));
      const templateRef = template.ref ?? (yield* resolveTemplateRef(template, templateInfo));

      const candidates = allRepos.filter((r) => !isSameRepo(r, template));

      const evaluations = yield* Effect.forEach(
        candidates,
        (candidate) => evaluateCandidate(template, candidate),
        { concurrency },
      );

      const acceptedCandidates: AcceptedCandidate[] = [];
      const skippedFromEvaluation: SkippedRepository[] = [];
      for (const evaluation of evaluations) {
        if (evaluation._tag === "accepted") acceptedCandidates.push(evaluation.candidate);
        else if (evaluation._tag === "skipped") skippedFromEvaluation.push(evaluation.skip);
        // "excluded" (ziku 未導入 / 別テンプレート利用 / ローカルソース) は静かに捨てる
      }

      // テンプレートは全リポジトリ共通の比較基準なので、この Scope に 1 度だけ取得して
      // 使い回す。リポジトリごとに取得すると同じ commit を候補数だけダウンロードすることになる。
      // 比較対象が 1 件も無ければ取得自体が不要なので、候補の確定後に取りに行く。
      const templateSnapshot =
        acceptedCandidates.length === 0
          ? undefined
          : yield* acquireTemplateSnapshot(tmpBaseDir, template, templateRef);

      const outcomes =
        templateSnapshot === undefined
          ? []
          : yield* Effect.forEach(
              acceptedCandidates,
              (candidate) =>
                processCandidate({
                  templateDir: templateSnapshot.dir,
                  templateInclude: templateSnapshot.include,
                  templateExclude: templateSnapshot.exclude,
                  candidate,
                  tmpBaseDir,
                  since,
                }),
              { concurrency },
            );

      const repositories: AggregateRepositoryReport[] = [];
      const skippedFromProcessing: SkippedRepository[] = [];
      for (const outcome of outcomes) {
        if (outcome._tag === "ok") repositories.push(outcome.report);
        else if (outcome._tag === "skipped") skippedFromProcessing.push(outcome.skip);
        // "filteredBySince" は since 条件を満たさなかったリポジトリで、意図的に結果から除く
      }

      return buildReport(template, templateRef, repositories, [
        ...skippedFromEvaluation,
        ...skippedFromProcessing,
      ]);
    }),
  );
}

// ────────────────────────────────────────────────────────────────
// 内部ヘルパー
// ────────────────────────────────────────────────────────────────

/** owner/repo は GitHub 上で大文字小文字を区別しないため、比較は正規化してから行う */
function isSameRepo(
  a: { readonly owner: string; readonly repo: string },
  b: { readonly owner: string; readonly repo: string },
): boolean {
  return (
    a.owner.toLowerCase() === b.owner.toLowerCase() && a.repo.toLowerCase() === b.repo.toLowerCase()
  );
}

function defaultTmpBaseDir(): string {
  return join(tmpdir(), `ziku-aggregate-${Date.now()}-${Math.random().toString(36).slice(2)}`);
}

/** Effect.tryPromise / Effect.try の catch で、失敗理由を人間が読めるメッセージ文字列に正規化する */
function toMessage(e: unknown): string {
  return e instanceof Error ? e.message : String(e);
}

/**
 * テンプレートリポジトリ自身の比較用 commit SHA を解決する。
 *
 * `resolveLatestCommitSha` は 404・ネットワークエラーいずれも `undefined` を返し例外を
 * 投げないため、"解決できなかった" ことを検知するには戻り値チェックが必要。
 * テンプレート側の基準 commit が定まらないとレポート全体の `template.ref` が
 * 埋められず後段のエージェントが決定的にファイルを取得できないため、ここでは
 * 個別リポジトリと違って fatal 扱いにし、aggregate 全体を失敗させる。
 */
function resolveTemplateRef(
  template: AggregateTemplateRepo,
  templateInfo: OwnerRepoInfo | undefined,
): Effect.Effect<string, GitHubApiError> {
  return Effect.gen(function* () {
    const ref = yield* Effect.tryPromise({
      try: () => resolveLatestCommitSha(template.owner, template.repo, templateInfo?.defaultBranch),
      catch: (e) => new GitHubApiError({ message: toMessage(e) }),
    });
    if (ref === undefined) {
      return yield* Effect.fail(
        new GitHubApiError({
          message: `Could not resolve latest commit SHA for template repository ${template.owner}/${template.repo}`,
        }),
      );
    }
    return ref;
  });
}

/** 全利用リポジトリの比較基準として 1 度だけ取得したテンプレートの内容 */
interface TemplateSnapshot {
  readonly dir: string;
  readonly include: string[];
  readonly exclude: string[];
}

/**
 * テンプレートを指定 commit でテンポラリへ取得し、その追跡パターンを読み出す。
 *
 * 取得失敗は個別リポジトリの失敗と違い、全リポジトリの比較基準が失われることを意味する。
 * `skipped` に丸めると全件が同じ理由で skipped になり原因が埋もれるため、全体を失敗させる。
 */
function acquireTemplateSnapshot(
  tmpBaseDir: string,
  template: AggregateTemplateRepo,
  templateRef: string,
): Effect.Effect<TemplateSnapshot, TemplateError, Scope.Scope> {
  return Effect.gen(function* () {
    const dir = yield* acquireTempTemplate(
      tmpBaseDir,
      buildTemplateSource({ owner: template.owner, repo: template.repo, ref: templateRef }),
      "aggregate-template",
    );
    const loaded = yield* Effect.tryPromise({
      try: () => loadZikuConfig(dir),
      catch: (e) => new TemplateError({ message: "Failed to load template ziku.jsonc", cause: e }),
    });
    return { dir, include: loaded.config.include, exclude: loaded.config.exclude ?? [] };
  });
}

/** lock.json を評価した結果、そのリポジトリを対象に含めるかどうかを表す判別 union */
type CandidateEvaluation =
  | { readonly _tag: "accepted"; readonly candidate: AcceptedCandidate }
  | { readonly _tag: "excluded" }
  | { readonly _tag: "skipped"; readonly skip: SkippedRepository };

/** lock.json 読み込み・検証まで完了し、以降の差分処理に進むリポジトリ */
interface AcceptedCandidate {
  readonly repoInfo: OwnerRepoInfo;
  readonly lock: LockState;
}

/**
 * 候補リポジトリの `.ziku/lock.json` を取得・検証し、対象テンプレートの
 * 利用リポジトリかどうかを判定する。
 *
 * - 404（ziku 未導入）は `excluded` として静かに除外する。owner 配下の大半は
 *   ziku を使っていない無関係なリポジトリであり、これを `skipped` に積むと
 *   レポートがノイズだらけになるため。
 * - `lock.source` がローカルパス形式、または対象テンプレート以外を指す場合も
 *   `excluded`。こちらも「対象外」であって「処理に失敗した」わけではないため、
 *   `skipped` には積まない。
 * - fetch 自体の失敗（レート制限・権限不足）、JSON パース失敗、スキーマ検証失敗は
 *   個別リポジトリの事情として `skipped` に理由付きで積み、他リポジトリの処理は続行する。
 */
function evaluateCandidate(
  template: AggregateTemplateRepo,
  candidate: OwnerRepoInfo,
): Effect.Effect<CandidateEvaluation> {
  return Effect.gen(function* () {
    const fetched = yield* Effect.either(
      fetchRepoTextFile(candidate.owner, candidate.repo, LOCK_FILE),
    );
    if (Either.isLeft(fetched)) {
      return skippedEvaluation(
        candidate,
        `lock.json の取得に失敗しました: ${fetched.left.message}`,
      );
    }
    if (Option.isNone(fetched.right)) {
      return { _tag: "excluded" as const };
    }

    const rawLock = fetched.right.value;
    const parsedJson = yield* Effect.either(
      Effect.try({
        try: () => JSON.parse(rawLock) as unknown,
        catch: toMessage,
      }),
    );
    if (Either.isLeft(parsedJson)) {
      return skippedEvaluation(
        candidate,
        `lock.json の JSON パースに失敗しました: ${parsedJson.left}`,
      );
    }

    const parsedLock = lockSchema.safeParse(parsedJson.right);
    if (!parsedLock.success) {
      return skippedEvaluation(
        candidate,
        `lock.json のスキーマ検証に失敗しました: ${parsedLock.error.message}`,
      );
    }

    const lock = parsedLock.data;
    if (!isGitHubSource(lock.source)) {
      // ローカルパス source（`{ path }`）は owner 配下探索の対象外
      return { _tag: "excluded" as const };
    }
    if (!isSameRepo(lock.source, template)) {
      // 別のテンプレートリポジトリを利用している
      return { _tag: "excluded" as const };
    }

    return { _tag: "accepted" as const, candidate: { repoInfo: candidate, lock } };
  });
}

function skippedEvaluation(candidate: OwnerRepoInfo, reason: string): CandidateEvaluation {
  return { _tag: "skipped", skip: { owner: candidate.owner, repo: candidate.repo, reason } };
}

/** 1 リポジトリ分の差分処理を終えた結果 */
type ProcessOutcome =
  | { readonly _tag: "ok"; readonly report: AggregateRepositoryReport }
  | { readonly _tag: "skipped"; readonly skip: SkippedRepository }
  | { readonly _tag: "filteredBySince" };

interface ProcessCandidateOptions {
  readonly templateDir: string;
  readonly templateInclude: string[];
  readonly templateExclude: string[];
  readonly candidate: AcceptedCandidate;
  readonly tmpBaseDir: string;
  readonly since: string | undefined;
}

/**
 * 1 つの利用リポジトリについて、テンプレートとの内容差分を分類しレポート化する。
 *
 * 利用リポジトリのテンポラリディレクトリは `Effect.scoped` に閉じ込め、この関数を
 * 抜ける時点で必ず削除する（候補数分のテンポラリが同時に残り続けるのを防ぐため、
 * リポジトリ 1 件ごとに閉じる設計）。テンプレート側のテンポラリは全リポジトリで
 * 共有するため、この Scope には含めない。
 */
function processCandidate(opts: ProcessCandidateOptions): Effect.Effect<ProcessOutcome> {
  const { templateDir, templateInclude, templateExclude, candidate, tmpBaseDir, since } = opts;
  const { repoInfo, lock } = candidate;

  return Effect.gen(function* () {
    const refResult = yield* Effect.either(
      Effect.tryPromise({
        try: () => resolveLatestCommitSha(repoInfo.owner, repoInfo.repo, repoInfo.defaultBranch),
        catch: toMessage,
      }),
    );
    if (Either.isLeft(refResult)) {
      return processSkipped(repoInfo, `最新コミット SHA の解決に失敗しました: ${refResult.left}`);
    }
    if (refResult.right === undefined) {
      return processSkipped(repoInfo, "最新コミット SHA を解決できませんでした");
    }
    const ref = refResult.right;

    const classificationResult = yield* Effect.either(
      Effect.scoped(
        classifyAgainstTemplate({
          templateDir,
          templateInclude,
          templateExclude,
          repoInfo,
          ref,
          tmpBaseDir,
          baseHashes: lock.baseHashes ?? {},
        }),
      ),
    );
    if (Either.isLeft(classificationResult)) {
      return processSkipped(
        repoInfo,
        `テンプレート差分の分類に失敗しました: ${classificationResult.left}`,
      );
    }
    const classification = classificationResult.right;

    let pendingPush = toPendingPushEntries(classification);
    let conflicts = toConflictEntries(classification);
    const pendingPull = toPendingPullEntries(classification);

    if (since !== undefined) {
      // pendingPull はテンプレート側発の変更（テンプレートの更新を配布するだけ）であり、
      // 「利用リポジトリ側でいつ変更されたか」という since フィルタの関心事に該当しない。
      // 対象を pendingPush/conflicts だけに絞ることで、この関数の GitHub API 呼び出し回数を
      // 増やさない。
      pendingPush = yield* attachLastCommittedAt(repoInfo, ref, pendingPush);
      conflicts = yield* attachLastCommittedAt(repoInfo, ref, conflicts);

      const newest = newestCommittedAt([...pendingPush, ...conflicts]);
      if (newest === undefined || newest < since) {
        return { _tag: "filteredBySince" };
      }
    }

    return {
      _tag: "ok",
      report: {
        owner: repoInfo.owner,
        repo: repoInfo.repo,
        defaultBranch: repoInfo.defaultBranch,
        ref,
        baseRef: lock.baseRef,
        pendingPush,
        pendingPull,
        conflicts,
      },
    };
  });
}

function processSkipped(repoInfo: OwnerRepoInfo, reason: string): ProcessOutcome {
  return { _tag: "skipped", skip: { owner: repoInfo.owner, repo: repoInfo.repo, reason } };
}

interface ClassifyAgainstTemplateOptions {
  readonly templateDir: string;
  readonly templateInclude: string[];
  readonly templateExclude: string[];
  readonly repoInfo: OwnerRepoInfo;
  readonly ref: string;
  readonly tmpBaseDir: string;
  readonly baseHashes: Record<string, string>;
}

/**
 * 利用リポジトリをテンポラリへ取得し、取得済みのテンプレートとハッシュ比較で分類する。
 * `Effect.scoped` で包んで呼び出すこと（Scope クローズ時にテンポラリが削除される）。
 */
function classifyAgainstTemplate(
  opts: ClassifyAgainstTemplateOptions,
): Effect.Effect<FileClassification, string, Scope.Scope> {
  const { templateDir, templateInclude, templateExclude, repoInfo, ref, tmpBaseDir, baseHashes } =
    opts;
  const label = sanitizeLabel(`${repoInfo.owner}-${repoInfo.repo}`);

  return Effect.gen(function* () {
    const repoDir = yield* acquireTempTemplate(
      tmpBaseDir,
      buildTemplateSource({ owner: repoInfo.owner, repo: repoInfo.repo, ref }),
      `${label}-repo`,
    ).pipe(Effect.mapError(toMessage));

    const repoConfig = yield* Effect.tryPromise({
      try: () => loadZikuConfig(repoDir),
      catch: toMessage,
    });

    // 利用リポジトリ側だけが `ziku track` で追加した include パターンを取りこぼさない
    // ため、テンプレート側のパターンと和集合を取る（どちらか一方だけを使うと、
    // もう一方だけが追跡しているファイルの差分が分類対象から漏れる）。
    const include = mergePatterns(templateInclude, repoConfig.config.include);
    const exclude = mergePatterns(templateExclude, repoConfig.config.exclude ?? []);

    const localHashes = yield* Effect.tryPromise({
      try: () => hashFiles(repoDir, include, exclude),
      catch: toMessage,
    });
    const templateHashes = yield* Effect.tryPromise({
      try: () => hashFiles(templateDir, include, exclude),
      catch: toMessage,
    });

    return classifyFiles({ baseHashes, localHashes, templateHashes });
  });
}

/** テンポラリディレクトリ名に使えない文字を潰す（owner/repo に記号が含まれる場合の保険） */
function sanitizeLabel(label: string): string {
  return label.replaceAll(/[^a-zA-Z0-9_-]/g, "_");
}

function toPendingPushEntries(c: FileClassification): PendingPushEntry[] {
  return [
    ...c.localOnly.map((path): PendingPushEntry => ({ path, reason: "localOnly" })),
    ...c.deletedLocally.map((path): PendingPushEntry => ({ path, reason: "deletedLocally" })),
  ];
}

function toPendingPullEntries(c: FileClassification): PendingPullEntry[] {
  return [
    ...c.autoUpdate.map((path): PendingPullEntry => ({ path, reason: "autoUpdate" })),
    ...c.newFiles.map((path): PendingPullEntry => ({ path, reason: "newFiles" })),
    ...c.deletedFiles.map((path): PendingPullEntry => ({ path, reason: "deletedFiles" })),
  ];
}

function toConflictEntries(c: FileClassification): ConflictEntry[] {
  return c.conflicts.map((path): ConflictEntry => ({ path }));
}

/**
 * 各エントリに最終コミット日時を付与する。
 *
 * `getLastCommitDate` の失敗（レート制限など）はエントリ単位で `lastCommittedAt` を
 * 未設定のままにするだけに留め、リポジトリ全体を `skipped` にはしない。日時は
 * `since` フィルタの補助情報であり、取得できないことがレポート自体の価値を
 * 損なうものではないため。
 */
function attachLastCommittedAt<T extends { readonly path: string }>(
  repoInfo: OwnerRepoInfo,
  ref: string,
  entries: readonly T[],
): Effect.Effect<T[]> {
  return Effect.forEach(entries, (entry) =>
    getLastCommitDate(repoInfo.owner, repoInfo.repo, entry.path, ref).pipe(
      Effect.map((opt) => ({ ...entry, lastCommittedAt: Option.getOrUndefined(opt) })),
      Effect.catchAll(() => Effect.succeed({ ...entry, lastCommittedAt: undefined })),
    ),
  );
}

/** エントリ群の中で最も新しい lastCommittedAt を返す。ISO 8601 文字列は辞書順比較で時系列順になる */
function newestCommittedAt(
  entries: readonly { readonly lastCommittedAt?: string }[],
): string | undefined {
  const dates = entries.map((e) => e.lastCommittedAt).filter((d): d is string => d !== undefined);
  if (dates.length === 0) return undefined;
  return dates.reduce((max, d) => (d > max ? d : max));
}

function buildReport(
  template: AggregateTemplateRepo,
  templateRef: string,
  repositories: AggregateRepositoryReport[],
  skipped: SkippedRepository[],
): AggregateReport {
  return {
    template: { owner: template.owner, repo: template.repo, ref: templateRef },
    generatedAt: new Date().toISOString(),
    repositories,
    skipped,
    summary: {
      totalRepositories: repositories.length,
      repositoriesWithPendingPush: repositories.filter((r) => r.pendingPush.length > 0).length,
      pendingPushFiles: repositories.reduce((sum, r) => sum + r.pendingPush.length, 0),
      conflictFiles: repositories.reduce((sum, r) => sum + r.conflicts.length, 0),
    },
  };
}
