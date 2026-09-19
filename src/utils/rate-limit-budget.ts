/**
 * `ziku aggregate` が GitHub API のレート制限予算をどう見積もり・観測し・使い切りを
 * 判定するかを表すドメイン概念。
 *
 * owner 配下の候補リポジトリを列挙しながら問い合わせるため、未認証 60 req/hour・
 * 認証済み 5000 req/hour のクォータを使い切ると owner 横断探索そのものが進められなくなる。
 * ここでは「今どれだけ使えるか」「これから何件まかなえるか」「観測した残量をどう取り込むか」
 * 「使い切ったとどう伝えるか」を、副作用（`Ref` の読み書き・HTTP 呼び出し）から切り離した
 * 型と純粋関数として表現する。可変状態の管理・HTTP 呼び出しは呼び出し側
 * （`aggregate.ts`/`github.ts`）の責務であり、ここには置かない。
 */
import type { Option, Ref } from "effect";
import { match } from "ts-pattern";

/**
 * レート制限の残量から事前の候補数上限を算出する際（{@link candidateLimitFromRemaining}）に
 * 使う安全マージン。単位は GitHub API リクエスト数（{@link ESTIMATED_REQUESTS_PER_CANDIDATE} で
 * 候補数へ変換する前の値）。
 *
 * owner 一覧取得・テンプレートの正規名解決など、候補ごとの処理以外にもこのスキャン中に
 * GitHub API 呼び出しが発生するため、残量をそのまま候補数の上限にすると、それらの
 * 呼び出し分だけ超過しうる。実行中の動的ブレーキ（{@link cannotAffordRemainingCandidates}）は
 * このマージンを使わない。候補処理が始まる前の準備段階の消費はここで既に見込み済みであり、
 * 動的ブレーキの判定でも重ねて差し引くと、候補数が事前算出の上限どおりで準備段階の消費が
 * 少なかった正常なシナリオでも初回候補から誤って発動する。
 */
export const RATE_LIMIT_SAFETY_MARGIN = 10;

/**
 * 候補 1 件を最後まで処理するのに実際にかかる GitHub API リクエスト数の下限見積もり。
 * {@link candidateLimitFromRemaining}（事前の候補数上限算出）と
 * {@link cannotAffordRemainingCandidates}（実行中の動的ブレーキ）の両方が、「候補 1 件 =
 * リクエスト 1 回」という過小評価を避けるためにこの係数で割る。両者が同じ定数を参照することで、
 * 事前の見積もりと実行中の判定が同じ予算感覚に基づく。
 *
 * 内訳（owner 横断探索が候補 1 件ごとに発生しうる GitHub API 呼び出し）:
 * 1. lock.json の初回取得（ふるい用）
 * 2. commit SHA の解決
 * 3. 固定した commit での lock.json 再取得
 * 4. 利用リポジトリ内容のダウンロード（候補ごとに commit SHA 固定でダウンロード URL が変わる
 *    ため常にコールドキャッシュになり、etag 確認の `HEAD` と実体取得の `GET` で 2 リクエストを
 *    消費する）
 * 5. pinned ref チェック（利用リポジトリの `lock.source.ref` が branch/tag 種別の場合のみ、
 *    種別の解決に追加で 1 リクエストを発行する。lock.json は 1〜3 の中でふるい用・pinned 用の
 *    2 回読まれるため、両方の読み取り時点で branch/tag なら最大 2 回分になる。commit 種別や
 *    ref 未指定の利用リポジトリでは発生しない）
 *
 * 1〜4 は必ず発生し 5 リクエスト、5 は最悪ケースで 2 リクエスト加わり、合計で最悪 7。
 *
 * `since` フィルタ指定時のコミット日時取得など、これを超える呼び出しが発生するケースも
 * あるため、あくまで下限の見積もりであることに注意。
 */
export const ESTIMATED_REQUESTS_PER_CANDIDATE = 7;

/**
 * 候補数上限を呼び出し側が明示指定しなかったときの既定値。
 * owner 配下を全量問い合わせるのを避けるための既定値であり、レート制限の残量から
 * 算出した上限がこれより大きくても、明示指定が無ければこの値で頭打ちにする
 * （`aggregate.ts` の `resolveCandidateLimit`）。
 */
export const DEFAULT_MAX_CANDIDATES = 30;

/**
 * 候補に含める push 日時の下限を呼び出し側が明示指定しなかったときの既定値（日数）。
 * owner 配下を全量問い合わせるのを避けるための既定値。暦月の厳密な計算はせず、
 * 固定の日数で計算する（`aggregate.ts` の `recentPushSinceIso`）。
 */
export const DEFAULT_RECENT_PUSH_DAYS = 90;

/**
 * レート制限を検知した経緯。呼び出し側が読む理由文（{@link rateLimitSkipReason}）を
 * 実際に起きたことと一致させるために区別する。
 *
 * - `observed`: GitHub から実際に 403/429 のレート制限応答を受け取った。
 * - `preemptive`: 403 をまだ受け取っておらず、直近のレスポンスヘッダーから観測した残量
 *   だけで「このまま候補を処理すると枯渇する」と見積もり、自発的に止まった
 *   （{@link cannotAffordRemainingCandidates}）。
 */
export type RateLimitDetection =
  | { readonly _tag: "observed"; readonly resetAt: Date | undefined }
  | { readonly _tag: "preemptive"; readonly resetAt: Date | undefined };

/**
 * owner 横断のスキャン全体で共有する、レート制限を検知したかどうかの状態。
 *
 * 「検知したか」と「resetAt」を別々のフィールドに分けると、未検知なのに resetAt を
 * 持つような組み合わせを型が許してしまう。検知済みのときだけ resetAt を持つ形にするため
 * `Option` で包む。`Ref` インスタンスの生成・読み書きは呼び出し側（`aggregate.ts`）の責務で、
 * ここでは状態の「形」だけを定義する。
 */
export type RateLimitGate = Ref.Ref<Option.Option<RateLimitDetection>>;

/**
 * {@link mergeObservedRateLimit} が扱う、直近に観測したレート制限の残量。
 *
 * GitHub のクォータそのものではなく「最後に見たレスポンスヘッダーの値」を表す。403 を実際に
 * 受け取る前に枯渇の兆候へ気づくための先読み専用の値であり、正確な残量の問い合わせは
 * `github.ts` の `fetchRateLimitStatus` が担う。
 */
export interface ObservedRateLimit {
  readonly remaining: number;
  readonly resetAt: Date | undefined;
}

/** GitHub API のレート制限（`core` リソース）の現在値。`GET /rate_limit` で取得する。 */
export interface RateLimitStatus {
  readonly limit: number;
  readonly remaining: number;
  readonly resetAt: Date | undefined;
  readonly authenticated: boolean;
}

/**
 * レート制限の残量から、安全に処理できる候補数の上限を算出する。
 *
 * 安全マージン（{@link RATE_LIMIT_SAFETY_MARGIN}）を引いた残りを、候補 1 件あたりの
 * 想定リクエスト数（{@link ESTIMATED_REQUESTS_PER_CANDIDATE}）で割って候補数へ換算する。
 * マージンを引いた時点で負になる場合は 0 に切り上げてから割るため、戻り値が負になることはない。
 *
 * `remaining` が 0 に近く候補を 1 件もまかなえない場合、戻り値は 0 になる。「0 件の候補で
 * 続行してよいか（`GitHubRateLimited` として失敗させるか）」の判断は、この関数の外側
 * （`aggregate.ts` の `resolveCandidateLimit`）の責務。
 */
export function candidateLimitFromRemaining(remaining: number): number {
  return Math.floor(
    Math.max(0, remaining - RATE_LIMIT_SAFETY_MARGIN) / ESTIMATED_REQUESTS_PER_CANDIDATE,
  );
}

/**
 * 直近に観測した残量で、これから処理する候補分の GitHub API 呼び出しをまかなえないかを判定する。
 *
 * 自分自身と、まだ処理していない候補の分（`remainingCandidateCount` 件）を、候補 1 件あたりの
 * 想定リクエスト数（{@link ESTIMATED_REQUESTS_PER_CANDIDATE}。事前の候補数上限算出
 * （{@link candidateLimitFromRemaining}）と同じ定数）で見積もる。
 *
 * {@link candidateLimitFromRemaining} と異なり {@link RATE_LIMIT_SAFETY_MARGIN} は引かない。
 * 事前の候補数上限算出が同じマージンを既に 1 回差し引いており、その分は候補処理が始まる前の
 * 準備段階（owner 一覧取得・テンプレートの識別解決など）の消費を見込むバッファとして確保済み
 * だから。ここでも同じマージンを重ねて要求すると、候補数が事前算出の上限どおりで準備段階の
 * 消費が少なかった正常なシナリオでも、初回候補から誤って発動する。
 */
export function cannotAffordRemainingCandidates(
  observedRemaining: number,
  remainingCandidateCount: number,
): boolean {
  return observedRemaining < (remainingCandidateCount + 1) * ESTIMATED_REQUESTS_PER_CANDIDATE;
}

/**
 * 2 つの `resetAt` が同じレート制限リセットウィンドウを指しているとみなせるか。
 *
 * 両方とも読めた場合はエポック値そのもので比較する。片方だけ読めない場合は、ウィンドウの
 * 同一性を確認できないので「異なる」に倒す（新しい観測値をそのまま採用する側へ）。両方とも
 * 読めない場合は同一性を確認する手立てが無いが、単調減少の想定自体はウィンドウが分からなくても
 * 成り立つため、{@link mergeObservedRateLimit} 側の「同じウィンドウ」の扱い（残量が既存より
 * 小さいときだけ採用）に委ねる。
 */
function sameRateLimitWindow(a: Date | undefined, b: Date | undefined): boolean {
  if (a === undefined && b === undefined) return true;
  if (a === undefined || b === undefined) return false;
  return a.getTime() === b.getTime();
}

/**
 * 新しく観測したレート制限残量を、それまでの観測値へ単調減少で取り込む。
 *
 * owner 横断探索は複数の GitHub リクエストを並行して発行するため、レスポンスは発行順ではなく
 * 完了順に届く。後から発行した（実際には残量が少ない）リクエストが先に完了して小さい値を
 * 記録した後、先に発行したが完了が遅かったリクエスト（届いた時点では既に古い、値としては
 * 大きい観測）を無条件で採用すると、動的ブレーキが実際より楽観的な残量を見てしまう。同じ
 * リセットウィンドウ内では残量は単調減少するはずなので、新しい観測値が既存より大きければ
 * 採用せず、より保守的な（小さい）既存の値を残す。ウィンドウが変わった
 * （{@link sameRateLimitWindow} が false）場合は、新しいウィンドウの値として無条件に採用する。
 *
 * `current` が無ければ（まだ 1 件も観測していなければ）`next` をそのまま採用する。
 */
export function mergeObservedRateLimit(
  current: ObservedRateLimit | undefined,
  next: ObservedRateLimit,
): ObservedRateLimit {
  if (
    current === undefined ||
    !sameRateLimitWindow(current.resetAt, next.resetAt) ||
    next.remaining < current.remaining
  ) {
    return next;
  }
  return current;
}

/**
 * ゲートが立っている状態で候補の処理に入ったときの `skipped` 理由文。
 *
 * 実際に 403/429 を受け取った（`observed`）のか、まだ受け取っておらず観測残量からの
 * 予防的な打ち切り（`preemptive`）なのかで文言を分ける。後者は「このまま続けると
 * 危険と判断して自発的に止めた」ことが伝わらないと、実際にはまだ枠が残っていたかも
 * しれないのに GitHub 側から拒否されたと読める。
 *
 * リセットまでの残り時間を分単位で示す部分は `errors.ts` の `describeQuotaReset` と
 * 同じ考え方だが、新しい依存を増やさずここに書く。
 */
export function rateLimitSkipReason(detection: RateLimitDetection): string {
  const verb = match(detection)
    .with({ _tag: "observed" }, () => "GitHub API rate limit reached")
    .with(
      { _tag: "preemptive" },
      () => "Stopped short of the GitHub API rate limit based on the observed remaining quota",
    )
    .exhaustive();
  if (detection.resetAt === undefined) {
    return `${verb}; not checking further repositories in this scan.`;
  }
  const minutes = Math.max(0, Math.ceil((detection.resetAt.getTime() - Date.now()) / 60000));
  return `${verb}; not checking further repositories in this scan (resets in ~${minutes} min).`;
}
