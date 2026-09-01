/**
 * `ziku aggregate` の集約ロジック。
 *
 * 背景: テンプレートリポジトリ側で実行し、owner 配下のリポジトリを GitHub API で
 * 列挙して「そのテンプレートを使っているリポジトリ」を特定し、各リポジトリの
 * 未同期差分（テンプレートへ未還元 / テンプレートから未配布 / 双方が変更）を
 * 棚卸しして {@link AggregateReport} にまとめる。
 *
 * 1 リポジトリの失敗（権限不足・lock.json の破損・ダウンロード失敗・レート制限）は
 * 全体を落とさず `skipped` に積んで処理を継続する。owner 横断探索そのものの失敗
 * （owner が存在しない・認証エラー）とテンプレート自身の解決失敗だけは全体の失敗として返る。
 */
import { tmpdir } from "node:os";
import { Effect, Either, Equivalence, Option } from "effect";
import type { Scope } from "effect";
import { join } from "pathe";
import { match } from "ts-pattern";
import type { FileNotFoundError, ParseError, TemplateError, ValidationError } from "../errors";
import { ZikuFailure, zikuFailure } from "../errors";
import type {
  AbsPath,
  AggregateReport,
  AggregateRepositoryReport,
  CommitSha,
  ConflictEntry,
  HashMap,
  LockState,
  PendingPullEntry,
  PendingPushEntry,
  RepoRelPath,
  SkippedRepository,
  TemplateRef,
} from "../modules/schemas";
import { baseCommitSha, baseHashesOf, lockSchema, templateRefToString } from "../modules/schemas";
import { analyzeConfigDrift } from "./config-merge";
import {
  fetchRepoTextFile,
  getLastCommitDate,
  getRepoIdentity,
  listOwnerRepos,
  resolveLatestCommitSha,
  resolveSourceCommit,
} from "./github";
import type { OwnerRepoInfo, RepoIdentity } from "./github";
import { LOCK_FILE } from "./lock";
import type { FileClassification } from "./merge/types";
import type { ZikuConfigStatus } from "./merge/sync-plan";
import { withZikuConfigStatus, zikuConfigStatus } from "./merge/sync-plan";
import { absPath } from "./paths";
import { analyzeSync } from "./sync-analysis";
import type { SyncHashes } from "./sync-analysis";
import { resolveSyncScope } from "./sync-scope";
import { acquireTempTemplate, buildCommitPinnedSource } from "./template";
import {
  registerTempDirEffect,
  removeTempDirEffect,
  unregisterTempDirEffect,
} from "./temp-tracker";
import { ZIKU_CONFIG_FILE, loadZikuConfig } from "./ziku-config";

/** aggregate の対象となるテンプレートリポジトリ */
export interface AggregateTemplateRepo {
  readonly owner: string;
  readonly repo: string;
  /**
   * 比較に使うテンプレート側の commit SHA。
   * 省略時はテンプレートリポジトリの既定ブランチの最新コミットを解決する。
   */
  readonly ref?: CommitSha;
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
   * テストで memfs 上の固定パスに向けるために公開している。文字列のまま受け取り、
   * 外から入ってくる値を brand する境界としてこの関数の内側で {@link absPath} を通す。
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
): Effect.Effect<AggregateReport, ZikuFailure> {
  const { template, includeArchived, since } = options;
  const searchOwner = options.searchOwner ?? template.owner;
  const concurrency = options.concurrency ?? DEFAULT_CONCURRENCY;
  const explicitTmpBaseDir = options.tmpBaseDir;
  const tmpBaseDir = absPath(explicitTmpBaseDir ?? defaultTmpBaseDirPath());

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

      // 最終コミット日時の取得（--since 指定時）は「リポジトリごとの全差分ファイル」を相手に
      // するので、リポジトリの並列度とは別に全体で頭打ちにする。両方に concurrency を渡すと
      // 掛け算になり、指定した値の 2 乗まで同時リクエストが膨らむ。
      const commitDateLimit = yield* Effect.makeSemaphore(concurrency);

      const allRepos = yield* tryGitHub(() => listOwnerRepos(searchOwner, { includeArchived }));

      // owner/repo の正規名解決（GitHub のリネーム・移管リダイレクト経由）をキャッシュする。
      // 同じ owner/repo への同時・重複呼び出しを 1 回の GitHub API 呼び出しにまとめる
      // （{@link resolveTemplateRef} と {@link resolveCanonicalMatch} の双方から使う）。
      const resolveIdentity: ResolveRepoIdentity = yield* Effect.cachedFunction(
        ([owner, repo]: readonly [string, string]) => tryGitHub(() => getRepoIdentity(owner, repo)),
        Equivalence.tuple(Equivalence.string, Equivalence.string),
      );

      const templateRefSha = template.ref ?? (yield* resolveTemplateRef(template, resolveIdentity));

      const candidates = allRepos.filter((r) => !isSameRepo(r, template));

      const evaluations = yield* Effect.forEach(
        candidates,
        (candidate) =>
          containDefect(candidate, () =>
            evaluateCandidate(template, templateRefSha, candidate, resolveIdentity),
          ),
        { concurrency },
      );

      const { acceptedCandidates, skippedFromEvaluation } = partitionEvaluations(evaluations);

      // テンプレートは全リポジトリ共通の比較基準なので、この Scope に 1 度だけ取得して
      // 使い回す。リポジトリごとに取得すると同じ commit を候補数だけダウンロードすることになる。
      // 比較対象が 1 件も無ければ取得自体が不要なので、候補の確定後に取りに行く。
      const templateDir =
        acceptedCandidates.length === 0
          ? undefined
          : yield* acquireTemplateSnapshot(tmpBaseDir, template, templateRefSha);

      const outcomes =
        templateDir === undefined
          ? []
          : yield* Effect.forEach(
              // sanitizeLabel は owner/repo の記号をすべて "_" に潰すため、異なる候補が
              // 同じテンポラリラベルに衝突しうる。候補配列内の位置を label に付与し、
              // 衝突しても一意になるようにする。
              acceptedCandidates.map((candidate, candidateIndex) => ({
                candidate,
                candidateIndex,
              })),
              ({ candidate, candidateIndex }) =>
                containDefect(candidate.repoInfo, () =>
                  processCandidate({
                    templateDir,
                    candidate,
                    candidateIndex,
                    tmpBaseDir,
                    since,
                    commitDateLimit,
                  }),
                ),
              { concurrency },
            );

      const { repositories, skippedFromProcessing, excludedBySince } = partitionOutcomes(outcomes);

      return buildReport(
        template,
        templateRefSha,
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

/**
 * 候補の評価結果を「以降の差分処理へ進むもの」と「理由付きで報告するもの」へ振り分ける。
 *
 * `excluded`（ziku 未導入 / 別テンプレート利用 / ローカルソース）はどちらにも入れない。
 * owner 配下の大半がこれに該当し、`skipped` に積むとレポートが読めなくなる。
 */
function partitionEvaluations(evaluations: readonly CandidateEvaluation[]): {
  readonly acceptedCandidates: AcceptedCandidate[];
  readonly skippedFromEvaluation: SkippedRepository[];
} {
  const acceptedCandidates: AcceptedCandidate[] = [];
  const skippedFromEvaluation: SkippedRepository[] = [];
  for (const evaluation of evaluations) {
    match(evaluation)
      .with({ _tag: "accepted" }, (e) => acceptedCandidates.push(e.candidate))
      .with({ _tag: "skipped" }, (e) => skippedFromEvaluation.push(e.skip))
      .with({ _tag: "excluded" }, () => undefined)
      .exhaustive();
  }
  return { acceptedCandidates, skippedFromEvaluation };
}

/**
 * 差分処理の結果を、レポートへ載せるものと報告用の件数へ振り分ける。
 *
 * `filteredBySince` は `since` 条件を満たさなかったリポジトリ。`repositories` からは除くが、
 * 件数は残す。0 件の理由が「使っているリポジトリが無い」と読まれないようにするため。
 */
function partitionOutcomes(outcomes: readonly ProcessOutcome[]): {
  readonly repositories: AggregateRepositoryReport[];
  readonly skippedFromProcessing: SkippedRepository[];
  readonly excludedBySince: number;
} {
  const repositories: AggregateRepositoryReport[] = [];
  const skippedFromProcessing: SkippedRepository[] = [];
  const filteredBySince: null[] = [];
  for (const outcome of outcomes) {
    match(outcome)
      .with({ _tag: "ok" }, (o) => repositories.push(o.report))
      .with({ _tag: "skipped" }, (o) => skippedFromProcessing.push(o.skip))
      // 件数だけが要るが、カウンタを閉包で増やすと分岐の形が 1 つだけ揃わなくなる。
      // 他の 2 つと同じ「配列へ積む」に揃え、件数は長さから取る。
      .with({ _tag: "filteredBySince" }, () => filteredBySince.push(null))
      .exhaustive();
  }
  return { repositories, skippedFromProcessing, excludedBySince: filteredBySince.length };
}

/** owner/repo は GitHub 上で大文字小文字を区別しないため、比較は正規化してから行う */
function isSameRepo(
  a: { readonly owner: string; readonly repo: string },
  b: { readonly owner: string; readonly repo: string },
): boolean {
  return (
    a.owner.toLowerCase() === b.owner.toLowerCase() && a.repo.toLowerCase() === b.repo.toLowerCase()
  );
}

function defaultTmpBaseDirPath(): string {
  return join(tmpdir(), `ziku-aggregate-${Date.now()}-${Math.random().toString(36).slice(2)}`);
}

/** Effect.tryPromise / Effect.try の catch で、失敗理由を人間が読めるメッセージ文字列に正規化する */
function toMessage(e: unknown): string {
  return e instanceof Error ? e.message : String(e);
}

/**
 * `src/utils/github.ts` の Promise ベース関数を Effect へ持ち上げる。
 *
 * `classified()`（github.ts）は分類済みの失敗を `ZikuFailure` として投げ、分類できない
 * 例外はそのまま投げ直す設計になっている。ここではその区別をそのままエラーチャネルへ
 * 反映する: `ZikuFailure` は型付きの失敗として運び、それ以外（ziku 自身の不具合や想定外の
 * レスポンス形）は defect のまま運ぶ。呼び出し側が両方を一様に catch すると、ziku 自身の
 * 不具合まで「対象リポジトリ固有の問題」として `skipped` に紛れ込み、原因が埋もれる。
 */
function tryGitHub<A>(run: () => Promise<A>): Effect.Effect<A, ZikuFailure> {
  return Effect.tryPromise({ try: run, catch: (cause) => cause }).pipe(
    Effect.catchAll((cause) =>
      cause instanceof ZikuFailure ? Effect.fail(cause) : Effect.die(cause),
    ),
  );
}

/**
 * 1 リポジトリ分の処理で起きた defect を、そのリポジトリの `skipped` に閉じ込める。
 *
 * `tryGitHub` は分類できない失敗を defect のまま運ぶ（`ZikuFailure` に潰すと、行動を
 * 書けない失敗に嘘の hint が付くため）。ただしこの走査は owner 配下の全リポジトリを
 * 相手にするので、1 件の 5xx や想定外のレスポンスで全体を落とすと、他の全リポジトリの
 * 結果まで失う。ここで受け止めて `skipped` に降ろし、走査は続ける。
 *
 * 握りつぶしではない。理由文に元の内容を残し、分類済みの失敗とは別の文言にして、
 * レポートを読む側が「ziku が想定していない事態」だと分かるようにする。
 */
function containDefect<A>(
  repoInfo: OwnerRepoInfo,
  run: () => Effect.Effect<A>,
): Effect.Effect<A | { readonly _tag: "skipped"; readonly skip: SkippedRepository }> {
  return Effect.catchAllDefect(run(), (defect) =>
    Effect.succeed(
      skippedEvaluation(repoInfo, `Unexpected failure while processing: ${toMessage(defect)}`),
    ),
  );
}

/** `acquireTempTemplate` が返す `TemplateError` を `ZikuFailure` へ変換する。 */
function toTemplateFailure(e: TemplateError): ZikuFailure {
  return zikuFailure({ kind: "TemplateUnavailable", detail: e.message }, { cause: e.cause });
}

/**
 * `loadZikuConfig` が返すユーティリティ層の失敗を、`skipped` の理由文へ変換する。
 * `FileNotFoundError` 等は Effect の型付きエラーであって Error のメッセージを持たないため、
 * `toMessage` では読める文にならない。
 */
function describeConfigLoadError(e: FileNotFoundError | ParseError | ValidationError): string {
  return match(e)
    .with({ _tag: "FileNotFoundError" }, (err) => `${err.path} not found`)
    .with({ _tag: "ParseError" }, (err) => `Failed to parse ${err.path}: ${toMessage(err.cause)}`)
    .with(
      { _tag: "ValidationError" },
      (err) => `${err.path} failed schema validation: ${err.issues.join("; ")}`,
    )
    .exhaustive();
}

/**
 * owner/repo の正規名（GitHub 上のリネーム・移管リダイレクト後の表記）と既定ブランチを
 * 解決する関数の型。`aggregateTemplateUsage` が `Effect.cachedFunction` で 1 度だけ作り、
 * {@link resolveTemplateRef} と {@link resolveCanonicalMatch} の両方に渡す。
 * `Effect.cachedFunction` は同じキー（owner/repo の組）への同時呼び出しを 1 回の
 * 実行にまとめるため、同じ owner/repo を重複して GitHub API へ問い合わせない。
 */
type ResolveRepoIdentity = (
  key: readonly [owner: string, repo: string],
) => Effect.Effect<RepoIdentity, ZikuFailure>;

/**
 * テンプレートリポジトリ自身の比較用 commit SHA を解決する。
 *
 * 既定ブランチは `resolveIdentity` 経由で直接取得する（`GET /repos/{owner}/{repo}`）。
 * `listOwnerRepos` の列挙結果から owner/repo 一致で defaultBranch を引く方法だと、
 * `--owner`（searchOwner）がテンプレートと別 owner を指す場合や、テンプレートが
 * アーカイブ済みで列挙結果に含まれない場合に defaultBranch が引けない。
 *
 * テンプレート側の基準 commit が定まらないとレポート全体の `template.ref` が埋められず
 * 後段のエージェントが決定的にファイルを取得できないため、個別リポジトリと違って
 * fatal 扱いにし、aggregate 全体を失敗させる。
 *
 * `resolveIdentity` はキャッシュ経由なので、この呼び出しでテンプレートの正規名
 * （owner/repo）もキャッシュへ積まれる。この後 {@link resolveCanonicalMatch} が
 * テンプレートの正規名を必要とした場合、追加の GitHub API 呼び出しなしで再利用できる。
 */
function resolveTemplateRef(
  template: AggregateTemplateRepo,
  resolveIdentity: ResolveRepoIdentity,
): Effect.Effect<CommitSha, ZikuFailure> {
  return Effect.gen(function* () {
    const identity = yield* resolveIdentity([template.owner, template.repo]);
    const resolution = yield* Effect.promise(() =>
      resolveLatestCommitSha(template.owner, template.repo, {
        kind: "branch",
        name: identity.defaultBranch,
      }),
    );
    return yield* match(resolution)
      .with({ _tag: "Resolved" }, (r) => Effect.succeed(r.sha))
      .with({ _tag: "AuthRejected" }, (f) =>
        Effect.fail(zikuFailure({ kind: "GitHubAuthRejected", detail: f.detail })),
      )
      .with({ _tag: "Unresolved" }, (f) =>
        Effect.fail(
          zikuFailure({
            kind: "TemplateUnavailable",
            detail: `Could not resolve the latest commit SHA for template repository ${template.owner}/${template.repo}: ${f.reason}`,
          }),
        ),
      )
      .exhaustive();
  });
}

/**
 * テンプレートを指定 commit でテンポラリへ取得する。
 *
 * 取得失敗は個別リポジトリの失敗と違い、全リポジトリの比較基準が失われることを意味する。
 * `skipped` に丸めると全件が同じ理由で skipped になり原因が埋もれるため、全体を失敗させる。
 */
function acquireTemplateSnapshot(
  tmpBaseDir: AbsPath,
  template: AggregateTemplateRepo,
  templateRefSha: CommitSha,
): Effect.Effect<AbsPath, ZikuFailure, Scope.Scope> {
  return acquireTempTemplate(
    tmpBaseDir,
    buildCommitPinnedSource(
      { kind: "github", owner: template.owner, repo: template.repo },
      templateRefSha,
    ),
    "aggregate-template",
  ).pipe(Effect.mapError(toTemplateFailure));
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
  readonly ref: CommitSha;
}

/** {@link resolveCandidateRef} の結果を表す判別 union */
type CandidateRefResolution =
  | { readonly _tag: "resolved"; readonly ref: CommitSha }
  | { readonly _tag: "failed"; readonly reason: string };

/**
 * 候補リポジトリの比較用 commit SHA を解決する。
 *
 * `.ziku/lock.json` の取得とリポジトリ内容のダウンロードを同じ ref に固定するために使う。
 * `resolveLatestCommitSha` は失敗を戻り値で表すため（`Effect.promise` に例外は飛ばない）、
 * `AuthRejected` / `Unresolved` のどちらも同じ `failed` として扱う。
 */
function resolveCandidateRef(candidate: OwnerRepoInfo): Effect.Effect<CandidateRefResolution> {
  return Effect.promise(() =>
    resolveLatestCommitSha(candidate.owner, candidate.repo, {
      kind: "branch",
      name: candidate.defaultBranch,
    }),
  ).pipe(
    Effect.map((resolution) =>
      match(resolution)
        .with({ _tag: "Resolved" }, (r): CandidateRefResolution => ({
          _tag: "resolved" as const,
          ref: r.sha,
        }))
        .with({ _tag: "AuthRejected" }, (f): CandidateRefResolution => ({
          _tag: "failed" as const,
          reason: `Could not resolve the latest commit SHA: GitHub rejected the authentication token (${f.detail})`,
        }))
        .with({ _tag: "Unresolved" }, (f): CandidateRefResolution => ({
          _tag: "failed" as const,
          reason: `Could not resolve the latest commit SHA: ${f.reason}`,
        }))
        .exhaustive(),
    ),
  );
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
 * `base` ハッシュと突き合わせて実在しない差分を報告する。
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
  templateRefSha: CommitSha,
  candidate: OwnerRepoInfo,
  resolveIdentity: ResolveRepoIdentity,
): Effect.Effect<CandidateEvaluation> {
  return Effect.gen(function* () {
    const screening = yield* readCandidateLock(
      template,
      templateRefSha,
      candidate,
      undefined,
      resolveIdentity,
    );
    if (screening._tag !== "usable") return screening;

    const refResolution = yield* resolveCandidateRef(candidate);
    if (refResolution._tag === "failed") {
      return skippedEvaluation(candidate, refResolution.reason);
    }
    const ref = refResolution.ref;

    // 固定した ref で読み直したものを採用する。ふるい用の読み取りとの間に
    // 対象リポジトリが ziku を外した場合は、そのコミット時点では利用リポジトリではない。
    const pinned = yield* readCandidateLock(
      template,
      templateRefSha,
      candidate,
      ref,
      resolveIdentity,
    );
    if (pinned._tag !== "usable") return pinned;

    return {
      _tag: "accepted" as const,
      candidate: { repoInfo: candidate, lock: pinned.lock, ref },
    };
  });
}

/**
 * 利用リポジトリが固定しているテンプレートのリビジョンが、このスキャンの比較基準と
 * 同じスナップショットを指すかを確かめる。同じなら `undefined`、違えば skipped の理由文を返す。
 *
 * `lock.source.ref` はブランチ名・タグ名・SHA のいずれも取りうる（判別 union の
 * {@link TemplateRef}）。比較基準 `templateRefSha` は解決済みの SHA なので、
 * `resolveSourceCommit` で種別を問わず同じコミットへ解決してから比べる。
 */
function checkPinnedRef(
  template: AggregateTemplateRepo,
  pinnedRef: TemplateRef,
  templateRefSha: CommitSha,
): Effect.Effect<string | undefined> {
  return Effect.promise(() => resolveSourceCommit(template.owner, template.repo, pinnedRef)).pipe(
    Effect.map((resolution) =>
      match(resolution)
        .with({ _tag: "Resolved" }, (r) =>
          r.sha === templateRefSha
            ? undefined
            : `Pinned to template ref "${templateRefToString(pinnedRef)}" (${r.sha}), which is a different revision from the one this scan compares against (${templateRefSha})`,
        )
        .with(
          { _tag: "AuthRejected" },
          (f) =>
            `Pinned to template ref "${templateRefToString(pinnedRef)}", which could not be resolved to a commit in ${template.owner}/${template.repo}: ${f.detail}`,
        )
        .with(
          { _tag: "Unresolved" },
          (f) =>
            `Pinned to template ref "${templateRefToString(pinnedRef)}", which could not be resolved to a commit in ${template.owner}/${template.repo}: ${f.reason}`,
        )
        .exhaustive(),
    ),
  );
}

/** {@link readCandidateLock} の結果。`usable` は「対象テンプレートの利用リポジトリだった」 */
type LockReadResult =
  | { readonly _tag: "usable"; readonly lock: LockState }
  | { readonly _tag: "excluded" }
  | { readonly _tag: "skipped"; readonly skip: SkippedRepository };

/** {@link resolveCanonicalMatch} の結果を表す判別 union */
type CanonicalMatchResult =
  | { readonly _tag: "matched" }
  | { readonly _tag: "excluded" }
  | { readonly _tag: "skipped"; readonly reason: string };

/**
 * `lock.source` の owner/repo が文字列としてテンプレートと一致しない場合に、両者を
 * 正規名（GitHub 上のリネーム・移管リダイレクト後の表記）へ解決してから比べ直す。
 *
 * テンプレートリポジトリがリネーム・移管されると、それ以前に `ziku init` された
 * 利用リポジトリの `lock.source` には旧名が残る。GitHub は旧名でのアクセスを新名へ
 * リダイレクトするため `ziku pull` は動き続けるが、文字列比較だけでは「無関係な
 * リポジトリ」と誤判定して黙って除外してしまう。
 *
 * - `lock.source` 側の解決が 404（`GitHubTargetNotFound`）→ 別テンプレートを指している、
 *   またはテンプレートが削除済み。`excluded` として静かに除外する（対象外であって処理の失敗ではない）
 * - `lock.source` 側・テンプレート側いずれかの解決が 404 以外で失敗（レート制限・
 *   認証エラー等）→ 判定不能。`excluded` に丸めると取りこぼしが黙って報告から消えるため
 *   `skipped` に理由付きで残す
 * - 両者が解決でき、正規名が一致する → `matched`。一致しない → 別テンプレートなので `excluded`
 */
function resolveCanonicalMatch(
  template: AggregateTemplateRepo,
  source: { readonly owner: string; readonly repo: string },
  resolveIdentity: ResolveRepoIdentity,
): Effect.Effect<CanonicalMatchResult> {
  return Effect.gen(function* () {
    const sourceIdentity = yield* Effect.either(resolveIdentity([source.owner, source.repo]));
    if (Either.isLeft(sourceIdentity)) {
      if (sourceIdentity.left.reason.kind === "GitHubTargetNotFound") {
        return { _tag: "excluded" as const };
      }
      return {
        _tag: "skipped" as const,
        reason: `Could not resolve the canonical name of lock.json's template source "${source.owner}/${source.repo}" (it may have been renamed or transferred): ${sourceIdentity.left.message}`,
      };
    }

    const templateIdentity = yield* Effect.either(resolveIdentity([template.owner, template.repo]));
    if (Either.isLeft(templateIdentity)) {
      return {
        _tag: "skipped" as const,
        reason: `Could not resolve the canonical name of the template repository "${template.owner}/${template.repo}": ${templateIdentity.left.message}`,
      };
    }

    return isSameRepo(sourceIdentity.right, templateIdentity.right)
      ? { _tag: "matched" as const }
      : { _tag: "excluded" as const };
  });
}

/**
 * 候補リポジトリの `.ziku/lock.json` を取得・検証し、対象テンプレートを指しているか判定する。
 * `ref` を省略すると既定ブランチの先頭を読む。
 */
function readCandidateLock(
  template: AggregateTemplateRepo,
  templateRefSha: CommitSha,
  candidate: OwnerRepoInfo,
  ref: CommitSha | undefined,
  resolveIdentity: ResolveRepoIdentity,
): Effect.Effect<LockReadResult> {
  return Effect.gen(function* () {
    const fetched = yield* Effect.either(
      tryGitHub(() => fetchRepoTextFile(candidate.owner, candidate.repo, LOCK_FILE, ref)),
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
    // ローカルパス source は owner 配下探索の対象外。
    if (lock.source.kind !== "github") {
      return { _tag: "excluded" as const };
    }
    // 文字列としては一致しなくても、テンプレートがリネーム・移管されていて
    // `lock.source` に旧名が残っているだけの可能性がある。正規名へ解決してから
    // 判定し直す（`resolveIdentity` はキャッシュ済みなので、一致する候補が多数
    // あっても GitHub API 呼び出しは owner/repo の組ごとに 1 回で済む）。
    if (!isSameRepo(lock.source, template)) {
      const canonicalMatch = yield* resolveCanonicalMatch(template, lock.source, resolveIdentity);
      if (canonicalMatch._tag === "excluded") return { _tag: "excluded" as const };
      if (canonicalMatch._tag === "skipped") {
        return skippedEvaluation(candidate, canonicalMatch.reason);
      }
      // "matched": lock.source はテンプレートの旧名で、リネーム・移管を跨いで同一リポジトリ
      // を指している。以降はテンプレートの利用リポジトリとして扱う。
    }

    // テンプレートの特定リビジョンに固定している利用リポジトリは、このスキャンの
    // 比較基準（既定ブランチの先頭、または呼び出し側が指定した ref）とは別の系列を
    // 追っている。そのまま比較すると、追随していないだけの差分が未同期として並ぶ。
    // 対象外だが「見つかったのに比較しなかった」ことは伝える必要があるため、
    // 黙って除外せず理由付きで残す。
    if (lock.source.ref !== undefined) {
      const pinnedCheck = yield* checkPinnedRef(template, lock.source.ref, templateRefSha);
      if (pinnedCheck !== undefined) return skippedEvaluation(candidate, pinnedCheck);
    }

    // `ziku pull` の途中（衝突未解決）で止まっているリポジトリ。ファイルには衝突マーカーや
    // 未確定の解決内容が入りうる一方、base のハッシュは pull 前のまま前進していない。この状態を
    // 比較すると、中間状態が未還元の差分として統合の対象に上がる。`push` も同じ状態を
    // ブロックしている。
    if (lock.sync === "merging") {
      return skippedEvaluation(
        candidate,
        `Has unresolved merge conflicts from \`ziku pull\` (${lock.merge.conflicts.length} files); run \`ziku pull --continue\` in that repository first`,
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
  readonly templateDir: AbsPath;
  readonly candidate: AcceptedCandidate;
  /** 候補配列内の位置。テンポラリラベルの一意性確保に使う */
  readonly candidateIndex: number;
  readonly tmpBaseDir: AbsPath;
  readonly since: string | undefined;
  /**
   * `since` 指定時のコミット日時取得を全リポジトリ横断で頭打ちにするセマフォ。
   * リポジトリ側の並列度とは独立に効かせる必要があるため、数値ではなく
   * `aggregateTemplateUsage` が 1 つだけ作ったものを共有する。
   */
  readonly commitDateLimit: Effect.Semaphore;
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
 * 別コミットを見てしまい、新しいファイルと古い base ハッシュを突き合わせて実在しない
 * conflict/pending を報告する原因になる。
 */
function processCandidate(opts: ProcessCandidateOptions): Effect.Effect<ProcessOutcome> {
  const { templateDir, candidate, candidateIndex, tmpBaseDir, since, commitDateLimit } = opts;
  const { repoInfo, lock, ref } = candidate;

  return Effect.gen(function* () {
    const classificationResult = yield* Effect.either(
      Effect.scoped(
        classifyAgainstTemplate({
          templateDir,
          repoInfo,
          ref,
          candidateIndex,
          tmpBaseDir,
          baseHashes: baseHashesOf(lock),
        }),
      ),
    );
    if (Either.isLeft(classificationResult)) {
      return processSkipped(
        repoInfo,
        `Failed to classify the diff against the template: ${classificationResult.left}`,
      );
    }
    const files = classificationResult.right;

    let pendingPush = toPendingPushEntries(files);
    let conflicts = toConflictEntries(files);
    const pendingPull = toPendingPullEntries(files);

    if (since !== undefined) {
      // pendingPull はテンプレート側発の変更（テンプレートの更新を配布するだけ）であり、
      // 「利用リポジトリ側でいつ変更されたか」という since フィルタの関心事に該当しない。
      // 対象を pendingPush/conflicts だけに絞ることで、この関数の GitHub API 呼び出し回数を
      // 増やさない。
      const pushResult = yield* attachLastCommittedAt(repoInfo, ref, pendingPush, commitDateLimit);
      const conflictResult = yield* attachLastCommittedAt(
        repoInfo,
        ref,
        conflicts,
        commitDateLimit,
      );
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
        baseRef: baseCommitSha(lock),
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
  readonly templateDir: AbsPath;
  readonly repoInfo: OwnerRepoInfo;
  readonly ref: CommitSha;
  /** 候補配列内の位置。テンポラリラベルの一意性確保に使う */
  readonly candidateIndex: number;
  readonly tmpBaseDir: AbsPath;
  readonly baseHashes: HashMap;
}

/**
 * 利用リポジトリをテンポラリへ取得し、取得済みのテンプレートと {@link analyzeSync} で
 * 3-way ハッシュ比較して分類する。`Effect.scoped` で包んで呼び出すこと
 * （Scope クローズ時にテンポラリが削除される）。
 */
function classifyAgainstTemplate(
  opts: ClassifyAgainstTemplateOptions,
): Effect.Effect<FileClassification, string, Scope.Scope> {
  const { templateDir, repoInfo, ref, candidateIndex, tmpBaseDir, baseHashes } = opts;
  // sanitizeLabel は記号を "_" に潰すだけなので、owner/repo が違っても衝突しうる
  // （例: "foo.bar" と "foo_bar"）。candidateIndex を付与して一意性を保証する。
  const label = `${sanitizeLabel(`${repoInfo.owner}-${repoInfo.repo}`)}-${candidateIndex}`;

  return Effect.gen(function* () {
    const repoDir = yield* acquireTempTemplate(
      tmpBaseDir,
      buildCommitPinnedSource({ kind: "github", owner: repoInfo.owner, repo: repoInfo.repo }, ref),
      `${label}-repo`,
    ).pipe(Effect.mapError(toMessage));

    const repoConfig = yield* loadZikuConfig(repoDir).pipe(
      Effect.mapError(describeConfigLoadError),
    );

    // 追跡パターンはテンプレート側と利用リポジトリ側の和集合。resolveSyncScope が
    // テンプレートの ziku.jsonc を読み直し、利用リポジトリ側だけが `ziku track` した
    // ファイルの差分も取りこぼさないよう union を取る。
    const { scope } = yield* Effect.tryPromise({
      try: () =>
        resolveSyncScope({
          targetDir: repoDir,
          templateDir,
          include: repoConfig.config.include,
          exclude: repoConfig.config.exclude ?? [],
        }),
      catch: toMessage,
    });

    const { plan, hashes } = yield* Effect.tryPromise({
      try: () => analyzeSync({ targetDir: repoDir, templateDir, baseHashes, scope }),
      catch: toMessage,
    });

    // `.ziku/ziku.jsonc` は加法 union で同期されるため、生の 3-way 分類のままだと
    // 「利用側がパターンを 1 つ削っただけ」が push 相当の差分に見える。レポートを読んだ
    // エージェントがテンプレートからそのパターンを消すと、全利用リポジトリへ波及する。
    // status と同じ状態機械（zikuConfigStatus）を通してから、通常の追跡ファイルと同じ
    // FileClassification へ合流させる。
    const drift = yield* Effect.tryPromise({
      try: () => analyzeConfigDrift(repoDir, templateDir),
      catch: toMessage,
    });
    const configStatus = zikuConfigStatus(plan.config, drift);
    const files = withZikuConfigStatus(plan.files, configStatus);

    return finalizeClassification(files, configStatus, hashes);
  });
}

/**
 * `withZikuConfigStatus` 適用後の分類結果に、aggregate 固有の補正を 2 つ加える。
 *
 * 1. `deletedFiles`（テンプレート側で削除されたファイル）のうち、利用リポジトリ側でも
 *    既に削除済み（`hashes.localHashes` に無い）ものを外す。`classifyOneFile` は base と
 *    template の有無だけで判定し local を見ないため、「双方とも削除済みで保留は無い」場合も
 *    `deletedFiles` に入ってしまう。ローカルに編集を残したまま削除されたケースは
 *    `deletedWithLocalEdits` として既に分離済みなので、ここで見るのは「local も無い」場合だけ。
 * 2. `ZikuConfigStatus` が `LocalOnlyPatterns`（テンプレート側が ziku.jsonc 自体を削除して
 *    おり、pull・push のどちらも書き込まないが、ローカルには届いていないパターンが残る状態）
 *    のとき、pendingPush/pendingPull どちらにも自然には現れないため conflicts へ手動で足す。
 *    テンプレートの削除を意図的なものとして追随すべきか、利用側の独自パターンとして残す
 *    べきかは自動で決めがたく、人の判断を要する点で通常の conflicts と同じ性質だから。
 */
function finalizeClassification(
  files: FileClassification,
  configStatus: ZikuConfigStatus,
  hashes: SyncHashes,
): FileClassification {
  return {
    ...files,
    deletedFiles: files.deletedFiles.filter((path) => hashes.localHashes[path] !== undefined),
    conflicts:
      configStatus._tag === "LocalOnlyPatterns"
        ? [...files.conflicts, ZIKU_CONFIG_FILE]
        : files.conflicts,
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

/**
 * `conflicts`（テキストとして 3-way マージを試みる対象）と `deletedWithLocalEdits`
 * （テンプレート側で削除され、ローカルは base から変更している対象）はどちらも
 * 「双方が変更しており自動では確定できない」ので同じ conflicts バケツへまとめるが、
 * 後段のエージェントが手順を分岐できるよう reason で区別する。
 */
function toConflictEntries(c: FileClassification): ConflictEntry[] {
  return [
    ...c.conflicts.map((path): ConflictEntry => ({ path, reason: "textConflict" })),
    ...c.deletedWithLocalEdits.map((path): ConflictEntry => ({
      path,
      reason: "deletedWithLocalEdits",
    })),
  ];
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
 * 変更ファイル 1 件ごとに直列で呼ぶと差分の多いリポジトリほど遅くなる。並列に投げるが、
 * 同時実行数は呼び出し元が全リポジトリ横断で 1 つだけ作ったセマフォで抑える。ここに
 * リポジトリ側と同じ並列度の数値を置くと、外側の並列度と掛け算になって上限が効かない。
 */
function attachLastCommittedAt<T extends { readonly path: RepoRelPath }>(
  repoInfo: OwnerRepoInfo,
  ref: CommitSha,
  entries: readonly T[],
  commitDateLimit: Effect.Semaphore,
): Effect.Effect<AttachLastCommittedAtResult<T>> {
  return Effect.gen(function* () {
    const results = yield* Effect.forEach(
      entries,
      (entry) =>
        Effect.either(
          commitDateLimit.withPermits(1)(
            tryGitHub(() => getLastCommitDate(repoInfo.owner, repoInfo.repo, entry.path, ref)),
          ),
        ).pipe(
          Effect.map((result) =>
            Either.match(result, {
              onLeft: () => ({
                entry: { ...entry, lastCommittedAt: undefined },
                fetchFailed: true,
              }),
              onRight: (opt) => ({
                entry: {
                  ...entry,
                  lastCommittedAt: Option.match(opt, {
                    onNone: () => undefined,
                    onSome: normalizeCommitDateToUtc,
                  }),
                },
                fetchFailed: false,
              }),
            }),
          ),
        ),
      // 同時実行数はセマフォが全リポジトリ横断で抑えるので、ここでは制限しない。
      // ここに数値を置くと、リポジトリ側の並列度と掛け算になって上限が効かなくなる。
      { concurrency: "unbounded" },
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
  templateRefSha: CommitSha,
  repositories: AggregateRepositoryReport[],
  skipped: SkippedRepository[],
  excludedBySince: number,
): AggregateReport {
  return {
    template: { owner: template.owner, repo: template.repo, ref: templateRefSha },
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
