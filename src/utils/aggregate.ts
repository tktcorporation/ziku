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
  getRepoDefaultBranch,
  listOwnerRepos,
  resolveLatestCommitSha,
} from "./github";
import type { OwnerRepoInfo } from "./github";
import { LOCK_FILE } from "./lock";
import type { FileClassification } from "./merge/types";
import { analyzeConfigDrift, applyConfigDrift } from "./config-merge";
import { mergePatterns } from "./patterns";
import { analyzeSync } from "./sync-analysis";
import type { SyncHashes } from "./sync-analysis";
import { acquireTempTemplate, buildTemplateSource } from "./template";
import {
  registerTempDirEffect,
  removeTempDirEffect,
  unregisterTempDirEffect,
} from "./temp-tracker";
import { loadZikuConfig, withConfigTracked } from "./ziku-config";

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
 * 2. 各候補の `.ziku/lock.json` を読んで対象テンプレートを指しているものだけを残し、
 *    残ったものだけ commit SHA を解決してその ref で lock.json を読み直す
 *    （{@link evaluateCandidate}）。以降のリポジトリ内容ダウンロードも同じ ref を使うため、
 *    lock.json の読み取りとダウンロードが必ず同じコミットのスナップショットになる
 * 3. 残った各リポジトリについて、テンプレートとの内容差分をハッシュ比較で分類する
 * 4. `since` 指定時は pendingPush/conflicts の最終コミット日時でリポジトリ単位に絞り込む
 */
export function aggregateTemplateUsage(
  options: AggregateOptions,
): Effect.Effect<AggregateReport, GitHubApiError | TemplateError> {
  const { template, includeArchived, since } = options;
  const searchOwner = options.searchOwner ?? template.owner;
  const concurrency = options.concurrency ?? DEFAULT_CONCURRENCY;
  const explicitTmpBaseDir = options.tmpBaseDir;
  const tmpBaseDir = explicitTmpBaseDir ?? defaultTmpBaseDir();

  return Effect.scoped(
    Effect.gen(function* () {
      // 呼び出し側が tmpBaseDir を明示指定しなかった場合のみ、この関数が生成した既定の
      // 一時ディレクトリを Scope クローズ時に削除する。テスト・利用者が明示指定した
      // ディレクトリは呼び出し側が管理しているため、ここでは削除しない。
      if (explicitTmpBaseDir === undefined) {
        yield* registerTempDirEffect(tmpBaseDir);
        yield* Effect.addFinalizer(() =>
          unregisterTempDirEffect(tmpBaseDir).pipe(
            Effect.zipRight(removeTempDirEffect(tmpBaseDir)),
          ),
        );
      }

      const allRepos = yield* listOwnerRepos(searchOwner, { includeArchived });

      const templateRef = template.ref ?? (yield* resolveTemplateRef(template));

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
              // sanitizeLabel は owner/repo の記号をすべて "_" に潰すため、異なる候補が
              // 同じテンポラリラベルに衝突しうる（#8）。候補配列内の位置を label に
              // 付与し、衝突しても一意になるようにする。
              acceptedCandidates.map((candidate, candidateIndex) => ({
                candidate,
                candidateIndex,
              })),
              ({ candidate, candidateIndex }) =>
                processCandidate({
                  templateDir: templateSnapshot.dir,
                  templateInclude: templateSnapshot.include,
                  templateExclude: templateSnapshot.exclude,
                  candidate,
                  candidateIndex,
                  tmpBaseDir,
                  since,
                  concurrency,
                }),
              { concurrency },
            );

      const repositories: AggregateRepositoryReport[] = [];
      const skippedFromProcessing: SkippedRepository[] = [];
      let excludedBySince = 0;
      for (const outcome of outcomes) {
        if (outcome._tag === "ok") repositories.push(outcome.report);
        else if (outcome._tag === "skipped") skippedFromProcessing.push(outcome.skip);
        // "filteredBySince" は since 条件を満たさなかったリポジトリで、意図的に repositories
        // からは除くが、件数は summary.excludedBySince に残す（buildReport 参照）。
        else excludedBySince += 1;
      }

      return buildReport(
        template,
        templateRef,
        repositories,
        [...skippedFromEvaluation, ...skippedFromProcessing],
        excludedBySince,
      );
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
 * 既定ブランチは `getRepoDefaultBranch` で直接取得する（`GET /repos/{owner}/{repo}`）。
 * `listOwnerRepos` の列挙結果から owner/repo 一致で defaultBranch を引く方法だと、
 * `--owner`（searchOwner）がテンプレートと別 owner を指す場合や、テンプレートが
 * アーカイブ済みで列挙結果に含まれない場合に defaultBranch が引けず、
 * `resolveLatestCommitSha` の既定値 `"main"` にフォールバックしてしまう
 * （`master` / `develop` を既定ブランチにしているテンプレートで失敗する）。
 *
 * `resolveLatestCommitSha` は 404・ネットワークエラーいずれも `undefined` を返し例外を
 * 投げないため、"解決できなかった" ことを検知するには戻り値チェックが必要。
 * テンプレート側の基準 commit が定まらないとレポート全体の `template.ref` が
 * 埋められず後段のエージェントが決定的にファイルを取得できないため、ここでは
 * 個別リポジトリと違って fatal 扱いにし、aggregate 全体を失敗させる。
 */
function resolveTemplateRef(
  template: AggregateTemplateRepo,
): Effect.Effect<string, GitHubApiError> {
  return Effect.gen(function* () {
    const defaultBranch = yield* getRepoDefaultBranch(template.owner, template.repo);
    const ref = yield* Effect.tryPromise({
      try: () => resolveLatestCommitSha(template.owner, template.repo, defaultBranch),
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

/**
 * lock.json 読み込み・検証まで完了し、以降の差分処理に進むリポジトリ。
 *
 * `ref` は `.ziku/lock.json` の取得とリポジトリ内容のダウンロードの両方に使う
 * 同一の commit SHA（{@link resolveCandidateRef} 参照）。processCandidate で
 * 改めて解決し直さないことで、スキャン中に対象リポジトリの既定ブランチが
 * 進んでも 2 つの読み取りが同じコミットを指すことを保証する。
 */
interface AcceptedCandidate {
  readonly repoInfo: OwnerRepoInfo;
  readonly lock: LockState;
  readonly ref: string;
}

/** {@link resolveCandidateRef} の結果を表す判別 union */
type CandidateRefResolution =
  | { readonly _tag: "resolved"; readonly ref: string }
  | { readonly _tag: "failed"; readonly reason: string };

/**
 * 候補リポジトリの比較用 commit SHA を解決する。
 *
 * `.ziku/lock.json` の取得とリポジトリ内容のダウンロードを同じ ref に固定するために使う。
 * `resolveLatestCommitSha` は 404・ネットワークエラーいずれも例外を投げず `undefined` を
 * 返すため、両方のケースを区別せず `failed` として扱う。
 */
function resolveCandidateRef(candidate: OwnerRepoInfo): Effect.Effect<CandidateRefResolution> {
  return Effect.gen(function* () {
    const refResult = yield* Effect.either(
      Effect.tryPromise({
        try: () => resolveLatestCommitSha(candidate.owner, candidate.repo, candidate.defaultBranch),
        catch: toMessage,
      }),
    );
    if (Either.isLeft(refResult)) {
      return {
        _tag: "failed" as const,
        reason: `Failed to resolve the latest commit SHA: ${refResult.left}`,
      };
    }
    if (refResult.right === undefined) {
      return { _tag: "failed" as const, reason: "Could not resolve the latest commit SHA" };
    }
    return { _tag: "resolved" as const, ref: refResult.right };
  });
}

/**
 * 候補リポジトリの `.ziku/lock.json` を取得・検証し、対象テンプレートの
 * 利用リポジトリかどうかを判定する。
 *
 * 判定は 2 段階で行う。まず ref を固定せず lock.json を読んで利用リポジトリかどうかを
 * ふるいにかけ、通ったものだけ commit SHA を解決して同じ ref で lock.json を読み直す。
 *
 * この順序にする理由は 2 つ。
 *
 * - SHA 解決の失敗を、ziku を使っていないリポジトリにまで `skipped` として出さない。
 *   owner 配下には空リポジトリや無関係なリポジトリが多数あり、先に SHA を解決すると
 *   そのすべてが理由付きで `skipped` に並んでレポートが読めなくなる
 * - 候補全件に SHA 解決の API 呼び出しを打たない。ふるいを通るのは利用リポジトリだけ
 *
 * 読み直しの結果を採用するのは、リポジトリ内容のダウンロードと同じコミットに固定するため。
 * ふるい用の 1 回目とリポジトリ内容が別コミットになると、更新後のファイルを更新前の
 * `baseHashes` と突き合わせて実在しない差分を報告する。
 *
 * - lock.json が無い（404 = ziku 未導入）、`lock.source` がローカルパス形式、
 *   対象テンプレート以外を指す場合は `excluded` として静かに除外する。
 *   「対象外」であって「処理に失敗した」わけではないため `skipped` には積まない
 * - lock.json fetch 自体の失敗（レート制限・権限不足）、JSON パース失敗、スキーマ検証失敗、
 *   および利用リポジトリと分かった後の SHA 解決失敗は、個別リポジトリの事情として
 *   `skipped` に理由付きで積み、他リポジトリの処理は続行する
 */
function evaluateCandidate(
  template: AggregateTemplateRepo,
  candidate: OwnerRepoInfo,
): Effect.Effect<CandidateEvaluation> {
  return Effect.gen(function* () {
    const screening = yield* readCandidateLock(template, candidate, undefined);
    if (screening._tag !== "usable") return screening;

    const refResolution = yield* resolveCandidateRef(candidate);
    if (refResolution._tag === "failed") {
      return skippedEvaluation(candidate, refResolution.reason);
    }
    const ref = refResolution.ref;

    // 固定した ref で読み直したものを採用する。ふるい用の読み取りとの間に
    // 対象リポジトリが ziku を外した場合は、そのコミット時点では利用リポジトリではない。
    const pinned = yield* readCandidateLock(template, candidate, ref);
    if (pinned._tag !== "usable") return pinned;

    return {
      _tag: "accepted" as const,
      candidate: { repoInfo: candidate, lock: pinned.lock, ref },
    };
  });
}

/** {@link readCandidateLock} の結果。`usable` は「対象テンプレートの利用リポジトリだった」 */
type LockReadResult =
  | { readonly _tag: "usable"; readonly lock: LockState }
  | { readonly _tag: "excluded" }
  | { readonly _tag: "skipped"; readonly skip: SkippedRepository };

/**
 * 候補リポジトリの `.ziku/lock.json` を取得・検証し、対象テンプレートを指しているか判定する。
 * `ref` を省略すると既定ブランチの先頭を読む。
 */
function readCandidateLock(
  template: AggregateTemplateRepo,
  candidate: OwnerRepoInfo,
  ref: string | undefined,
): Effect.Effect<LockReadResult> {
  return Effect.gen(function* () {
    const fetched = yield* Effect.either(
      fetchRepoTextFile(candidate.owner, candidate.repo, LOCK_FILE, ref),
    );
    if (Either.isLeft(fetched)) {
      return skippedEvaluation(candidate, `Failed to fetch lock.json: ${fetched.left.message}`);
    }
    if (Option.isNone(fetched.right)) return { _tag: "excluded" as const };

    const rawLock = fetched.right.value;
    const parsedJson = yield* Effect.either(
      Effect.try({
        try: () => JSON.parse(rawLock) as unknown,
        catch: toMessage,
      }),
    );
    if (Either.isLeft(parsedJson)) {
      return skippedEvaluation(candidate, `Failed to parse lock.json as JSON: ${parsedJson.left}`);
    }

    const parsedLock = lockSchema.safeParse(parsedJson.right);
    if (!parsedLock.success) {
      return skippedEvaluation(
        candidate,
        `lock.json failed schema validation: ${parsedLock.error.message}`,
      );
    }

    const lock = parsedLock.data;
    // ローカルパス source（`{ path }`）は owner 配下探索の対象外。
    // 別のテンプレートを指しているものも対象外。
    if (!isGitHubSource(lock.source) || !isSameRepo(lock.source, template)) {
      return { _tag: "excluded" as const };
    }

    // テンプレートの特定リビジョンに固定している利用リポジトリは、このスキャンの
    // 比較基準（既定ブランチの先頭、または呼び出し側が指定した ref）とは別の系列を
    // 追っている。そのまま比較すると、追随していないだけの差分が未同期として並ぶ。
    // 対象外だが「見つかったのに比較しなかった」ことは伝える必要があるため、
    // 黙って除外せず理由付きで残す。
    if (lock.source.ref !== undefined && lock.source.ref !== template.ref) {
      return skippedEvaluation(
        candidate,
        `Pinned to template ref "${lock.source.ref}", which differs from the revision this scan compares against (${template.ref ?? "the template's default branch"})`,
      );
    }
    return { _tag: "usable" as const, lock };
  });
}

function skippedEvaluation(
  candidate: OwnerRepoInfo,
  reason: string,
): { readonly _tag: "skipped"; readonly skip: SkippedRepository } {
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
  /** 候補配列内の位置。テンポラリラベルの一意性確保に使う（#8） */
  readonly candidateIndex: number;
  readonly tmpBaseDir: string;
  readonly since: string | undefined;
  /**
   * `since` 指定時、変更ファイルごとのコミット日時取得（`attachLastCommittedAt`）を
   * 同時に何件まで並列実行するか。`aggregateTemplateUsage` の `concurrency` オプションを
   * そのまま渡す（新しいノブを増やさない）。
   */
  readonly concurrency: number;
}

/**
 * 1 つの利用リポジトリについて、テンプレートとの内容差分を分類しレポート化する。
 *
 * 利用リポジトリのテンポラリディレクトリは `Effect.scoped` に閉じ込め、この関数を
 * 抜ける時点で必ず削除する（候補数分のテンポラリが同時に残り続けるのを防ぐため、
 * リポジトリ 1 件ごとに閉じる設計）。テンプレート側のテンポラリは全リポジトリで
 * 共有するため、この Scope には含めない。
 *
 * commit SHA は `candidate.ref`（`evaluateCandidate` が lock.json 取得前に解決済み）を
 * そのまま使い、ここでは解決し直さない。ここで改めて解決すると、lock.json を読んだ
 * 時点と内容をダウンロードする時点で対象リポジトリの既定ブランチが進んでいた場合に
 * 別コミットを見てしまい、新しいファイルと古い baseHashes を突き合わせて実在しない
 * conflict/pending を報告する原因になる。
 */
function processCandidate(opts: ProcessCandidateOptions): Effect.Effect<ProcessOutcome> {
  const {
    templateDir,
    templateInclude,
    templateExclude,
    candidate,
    candidateIndex,
    tmpBaseDir,
    since,
    concurrency,
  } = opts;
  const { repoInfo, lock, ref } = candidate;

  return Effect.gen(function* () {
    const classificationResult = yield* Effect.either(
      Effect.scoped(
        classifyAgainstTemplate({
          templateDir,
          templateInclude,
          templateExclude,
          repoInfo,
          ref,
          candidateIndex,
          tmpBaseDir,
          baseHashes: lock.baseHashes ?? {},
        }),
      ),
    );
    if (Either.isLeft(classificationResult)) {
      return processSkipped(
        repoInfo,
        `Failed to classify the diff against the template: ${classificationResult.left}`,
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
      const pushResult = yield* attachLastCommittedAt(repoInfo, ref, pendingPush, concurrency);
      const conflictResult = yield* attachLastCommittedAt(repoInfo, ref, conflicts, concurrency);
      pendingPush = pushResult.entries;
      conflicts = conflictResult.entries;

      // コミット日時の取得が 1 件でも失敗した場合、「該当ファイルの変更が無い」
      // （getLastCommitDate が正常に Option.none() を返すケース）と「レート制限等で
      // 判定不能」を区別できない。判定不能なリポジトリを filteredBySince（=「同期済み」の
      // 意味）として静かに結果から落とすと、レポートを見た利用者が「0 件 = 全部同期済み」
      // と誤読するため、理由付きで skipped に積み aggregate 全体は継続する。
      if (pushResult.anyFetchFailed || conflictResult.anyFetchFailed) {
        return processSkipped(
          repoInfo,
          "Could not determine the --since filter because fetching the commit date failed for some files",
        );
      }

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
  /** 候補配列内の位置。テンポラリラベルの一意性確保に使う（#8） */
  readonly candidateIndex: number;
  readonly tmpBaseDir: string;
  readonly baseHashes: Record<string, string>;
}

/**
 * 利用リポジトリをテンポラリへ取得し、取得済みのテンプレートと {@link analyzeSync} で
 * 3-way ハッシュ比較して分類する。`Effect.scoped` で包んで呼び出すこと
 * （Scope クローズ時にテンポラリが削除される）。
 */
function classifyAgainstTemplate(
  opts: ClassifyAgainstTemplateOptions,
): Effect.Effect<FileClassification, string, Scope.Scope> {
  const {
    templateDir,
    templateInclude,
    templateExclude,
    repoInfo,
    ref,
    candidateIndex,
    tmpBaseDir,
    baseHashes,
  } = opts;
  // sanitizeLabel は記号を "_" に潰すだけなので、owner/repo が違っても衝突しうる
  // （例: "foo.bar" と "foo_bar"）。candidateIndex を付与して一意性を保証する。
  const label = `${sanitizeLabel(`${repoInfo.owner}-${repoInfo.repo}`)}-${candidateIndex}`;

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

    // `.ziku/ziku.jsonc` 自体を同期対象に含める（init/pull/push/status と同じ扱い）。
    // これを省くと、baseHashes には載っているのに local/template どちらのハッシュにも
    // 載らず、全リポジトリで一律に deletedFiles（誤った pendingPull）として報告される。
    // ハッシュ比較の手順は analyzeSync（SSOT）に委ね、hashFiles を手書きで 2 回呼ぶ
    // 複製をしない。
    const { classification, hashes } = yield* Effect.tryPromise({
      try: () =>
        analyzeSync({
          targetDir: repoDir,
          templateDir,
          baseHashes,
          include: withConfigTracked(include),
          exclude,
        }),
      catch: toMessage,
    });

    // `ziku.jsonc` は加法 union で同期されるため、生の 3-way 分類のままだと
    // 「利用側がパターンを 1 つ削っただけ」が push 相当の差分に見える。レポートを読んだ
    // エージェントがテンプレートからそのパターンを消すと、全利用リポジトリへ波及する。
    // status と同じ補正を通す。
    const drift = yield* Effect.tryPromise({
      try: () => analyzeConfigDrift(repoDir, templateDir),
      catch: toMessage,
    });

    return refineDeletedFiles(applyConfigDrift(classification, drift), hashes);
  });
}

/**
 * `deletedFiles`（テンプレート側で削除されたファイル）を、利用リポジトリ側の状態で
 * 3 つに切り分ける。
 *
 * `classifyFiles` の `deletedFiles` 分岐は base と template の有無だけで判定し、
 * local を見ない。pull は該当ファイルを利用者に確認してから消すのでそれで足りるが、
 * aggregate のレポートは人ではなく後段のエージェントが読む。切り分けずに
 * `pendingPull` へ流すと、次の 2 つが「削除を配布せよ」と読める。
 *
 * - 利用リポジトリ側で編集済み: 双方が変更した状態なので `conflicts` に回す。
 *   削除として扱うと、その利用リポジトリにしか無い編集が黙って捨てられる
 * - 利用リポジトリ側でも削除済み: 既に一致しているので、何も保留していない
 */
function refineDeletedFiles(
  classification: FileClassification,
  hashes: SyncHashes,
): FileClassification {
  const propagatableDeletions: string[] = [];
  const editedAgainstDeletion: string[] = [];

  for (const path of classification.deletedFiles) {
    const local = hashes.localHashes[path];
    if (local === undefined) continue; // 双方で削除済み。保留は無い
    if (local === hashes.baseHashes[path]) propagatableDeletions.push(path);
    else editedAgainstDeletion.push(path);
  }

  return {
    ...classification,
    deletedFiles: propagatableDeletions,
    conflicts: [...classification.conflicts, ...editedAgainstDeletion],
  };
}

/**
 * テンポラリディレクトリ名に使えない文字を潰す（owner/repo に記号が含まれる場合の保険）。
 * 記号が異なる owner/repo の組が同じ結果に潰れうるため、呼び出し側で
 * candidateIndex 等を付与して一意性を確保すること（このヘルパー単体では保証しない）。
 */
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
 * GitHub API から受け取ったコミット日時 (ISO 8601) を UTC 表記へ正規化する。
 *
 * `--since` はコマンド層 (`normalizeSince`) で UTC へ正規化済みだが、GitHub の
 * commit API が返す日時はオフセット付き（例: `+09:00`）の場合がある。
 * `newestCommittedAt` / since 比較は文字列の辞書順に依存するため、両者を
 * 同じ UTC 表記に揃えないと最大値判定・比較が壊れる。
 */
function normalizeCommitDateToUtc(date: string): string {
  const parsed = new Date(date);
  // GitHub の commit API が非 ISO 8601 な日時を返すことは通常無いが、パース不能な
  // 値で例外を起こさないよう、その場合は正規化を諦めて元の文字列を返す。
  return Number.isNaN(parsed.getTime()) ? date : parsed.toISOString();
}

/** {@link attachLastCommittedAt} の結果 */
interface AttachLastCommittedAtResult<T> {
  readonly entries: (T & { readonly lastCommittedAt: string | undefined })[];
  /**
   * 1 件でも `getLastCommitDate` が失敗（レート制限・権限不足等）した場合 true。
   * 呼び出し側はこれを使い、「該当ファイルの変更履歴が無い」（成功して
   * `Option.none()`）と「取得できず判定不能」（失敗）を区別できる。
   */
  readonly anyFetchFailed: boolean;
}

/**
 * 各エントリに最終コミット日時を付与する。
 *
 * `getLastCommitDate` の成功時 `Option.none()`（そのファイルのコミット履歴が無いという
 * 正常系）と失敗（レート制限など）を区別し、`anyFetchFailed` に集計する。これを区別
 * しないと、失敗したリポジトリを「変更なし」と誤判定して `since` フィルタが静かに
 * 取りこぼす（呼び出し側 `processCandidate` が `anyFetchFailed` を見て `skipped` に
 * 振り分ける）。
 *
 * 変更ファイル 1 件ごとに直列で呼ぶと差分の多いリポジトリほど遅くなり、レート制限にも
 * 当たりやすくなる。`concurrency` で並列実行し、呼び出し元（`aggregateTemplateUsage`）の
 * 並列度設定に揃える。
 */
function attachLastCommittedAt<T extends { readonly path: string }>(
  repoInfo: OwnerRepoInfo,
  ref: string,
  entries: readonly T[],
  concurrency: number,
): Effect.Effect<AttachLastCommittedAtResult<T>> {
  return Effect.gen(function* () {
    const results = yield* Effect.forEach(
      entries,
      (entry) =>
        getLastCommitDate(repoInfo.owner, repoInfo.repo, entry.path, ref).pipe(
          Effect.map((opt) => ({
            entry: {
              ...entry,
              lastCommittedAt: Option.match(opt, {
                onNone: () => undefined,
                onSome: normalizeCommitDateToUtc,
              }),
            },
            fetchFailed: false,
          })),
          Effect.catchAll(() =>
            Effect.succeed({ entry: { ...entry, lastCommittedAt: undefined }, fetchFailed: true }),
          ),
        ),
      { concurrency },
    );
    return {
      entries: results.map((r) => r.entry),
      anyFetchFailed: results.some((r) => r.fetchFailed),
    };
  });
}

/**
 * エントリ群の中で最も新しい lastCommittedAt を返す。
 * {@link attachLastCommittedAt} が UTC へ正規化済みの前提で、ISO 8601 文字列を
 * 辞書順比較する（同じ表記に揃っていれば辞書順が時系列順と一致する）。
 */
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
  excludedBySince: number,
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
      excludedBySince,
    },
  };
}
