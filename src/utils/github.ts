import { Octokit } from "@octokit/rest";
import { Effect, Option } from "effect";
import { match } from "ts-pattern";
import { zikuFailure } from "../errors";
import type { ZikuFailure } from "../errors";
import type {
  BlobSha,
  BranchRef,
  CommitSha,
  PrResult,
  RepoRelPath,
  TemplateRef,
} from "../modules/schemas";
import { blobShaSchema, commitShaSchema } from "../modules/schemas";
import { transportTextToBytes } from "./file-content";

export interface PushOptions {
  owner: string;
  repo: string;
  /**
   * PR に載せるファイル。`content` はテキストなら utf-8、バイナリならバイト列を保つ
   * エンコードで載っている（`src/utils/file-content.ts`）。GitHub API へ渡す前に
   * 元のバイト列へ戻す。
   */
  files: Array<{ path: RepoRelPath; content: string }>;
  /** テンプレートから削除するファイル（PR にファイル削除コミットを含める） */
  deletions?: Array<{ path: RepoRelPath }>;
  title: string;
  body?: string;
  /**
   * PR の宛先ブランチ。既定値を持たせない理由: 既定ブランチは `main` とは限らず
   * （`master` / `trunk` 等）、仮定すると存在しないブランチを宛先にした PR 作成が
   * 404 になる。必須にすることで、宛先の解決を呼び出し側へ強制する。
   */
  baseBranch: string;
}

/**
 * GitHub API を使って PR を作成
 */
export async function createPullRequest(token: string, options: PushOptions): Promise<PrResult> {
  const octokit = new Octokit({ auth: token });
  const { owner, repo, files, title, body, baseBranch } = options;

  // 1. 認証ユーザー情報を取得
  const { data: user } = await octokit.users.getAuthenticated();
  const forkOwner = user.login;

  // 2. fork を確認・作成
  const forkRepo = await resolveForkRepo(octokit, { owner, repo, forkOwner });

  // 3. ベースブランチの最新コミット SHA を取得
  const { data: baseBranchRef } = await octokit.repos.getBranch({
    owner,
    repo,
    branch: baseBranch,
  });
  const baseSha = baseBranchRef.commit.sha;

  // 4. 新しいブランチ名を生成
  const branchName = `ziku-sync-${Date.now()}`;

  // 5. fork に新しいブランチを作成
  await octokit.git.createRef({
    owner: forkOwner,
    repo: forkRepo,
    ref: `refs/heads/${branchName}`,
    sha: baseSha,
  });

  // 6. 既存ファイルの SHA を一括取得
  //    getContent を個別に呼ぶと、未存在ファイルで 404 レスポンスが
  //    @octokit/plugin-request-log によりコンソールに出力されるため、
  //    getTree で一括取得して Map で引く。
  const { data: treeData } = await octokit.git.getTree({
    owner: forkOwner,
    repo: forkRepo,
    tree_sha: branchName,
    recursive: "true",
  });
  // 欠けた一覧のまま進むと、既存ファイルの blob SHA を引けず更新が新規作成として送られる。
  // ユーザーが取れる行動（リポジトリのファイル数を減らす）があるので、分類済みの失敗にする。
  if (treeData.truncated) {
    throw zikuFailure({ kind: "RepoTreeTooLarge", repo: `${forkOwner}/${forkRepo}` });
  }
  // GitHub が採番した blob SHA の写像。ziku が計算する内容ハッシュと形が同じなので、
  // API レスポンスから取り出すここで blob SHA として brand しておく。
  const shaMap = new Map<string, BlobSha>();
  for (const item of treeData.tree) {
    if (item.type === "blob" && item.sha !== undefined && item.sha !== null && item.path) {
      shaMap.set(item.path, blobShaSchema.parse(item.sha));
    }
  }

  // 7. ファイルを作成または更新
  for (const file of files) {
    await octokit.repos.createOrUpdateFileContents({
      owner: forkOwner,
      repo: forkRepo,
      path: file.path,
      message: `Update ${file.path}`,
      // base64 は入力のバイト列をそのまま符号化する。バイナリを utf-8 として符号化すると
      // 1 文字が複数バイトへ膨らみ、PR には壊れたファイルが載る。
      content: transportTextToBytes(file.content).toString("base64"),
      branch: branchName,
      sha: shaMap.get(file.path),
    });
  }

  // 7b. ファイルを削除
  if (options.deletions) {
    for (const file of options.deletions) {
      const fileSha = shaMap.get(file.path);
      if (fileSha) {
        await octokit.repos.deleteFile({
          owner: forkOwner,
          repo: forkRepo,
          path: file.path,
          message: `Delete ${file.path}`,
          sha: fileSha,
          branch: branchName,
        });
      }
    }
  }

  // 8. PR を作成
  const { data: pr } = await octokit.pulls.create({
    owner,
    repo,
    title,
    body: body || generatePrBody(files),
    head: `${forkOwner}:${branchName}`,
    base: baseBranch,
  });

  return {
    url: pr.html_url,
    number: pr.number,
    branch: branchName,
  };
}

/** fork の作成が API から見えるようになるまで待つ時間。直後に問い合わせると 404 が返る。 */
const FORK_PROPAGATION_WAIT_MS = 3000;

/**
 * PR の head に使う fork のリポジトリ名を返す。まだ無ければ fork を作る。
 *
 * 作成の失敗は包み直さずそのまま投げる。Octokit の例外は HTTP ステータスを持っており、
 * 呼び出し側はそれを見て「権限が足りない」「レート制限」をユーザー向けの案内へ分類する
 * （{@link classifyGitHubApiFailure}）。`Effect.runPromise` で包むと失敗が FiberFailure に
 * 埋もれ、ステータスごと分類の材料が失われる。
 *
 * 既存 fork の問い合わせが失敗したときだけ作成へ倒す。未 fork なら 404 が返るが、それ以外の
 * 理由（トークンの失効等）でも作成が同じ理由で失敗し、そちらの例外が呼び出し側へ届く。
 */
async function resolveForkRepo(
  octokit: Octokit,
  target: { owner: string; repo: string; forkOwner: string },
): Promise<string> {
  const existing = await octokit.repos
    .get({ owner: target.forkOwner, repo: target.repo })
    .then(({ data }) => data.name)
    .catch(() => undefined);
  if (existing !== undefined) return existing;

  const { data } = await octokit.repos.createFork({ owner: target.owner, repo: target.repo });
  await sleep(FORK_PROPAGATION_WAIT_MS);
  return data.name;
}

/**
 * PR の本文を生成
 */
function generatePrBody(files: Array<{ path: RepoRelPath; content: string }>): string {
  const fileList = files.map((f) => `- \`${f.path}\``).join("\n");

  return `## Summary

Auto-generated PR by ziku push command.

## Changed files

${fileList}

---
Generated by [ziku](https://github.com/tktcorporation/.github/tree/main/packages/ziku)
`;
}

/**
 * GitHub トークンを環境変数または gh CLI から取得
 *
 * 優先順位:
 *   1. GITHUB_TOKEN 環境変数
 *   2. GH_TOKEN 環境変数
 *   3. `gh auth token` コマンド出力（gh CLI がインストール済みの場合）
 *
 * 背景: gh CLI でログイン済みなのにトークンを手動入力させるのは不親切。
 * 多くの開発者は `gh auth login` 済みなので、そのトークンを自動取得する。
 */
export function getGitHubToken(): string | undefined {
  const envToken = process.env.GITHUB_TOKEN || process.env.GH_TOKEN;
  if (envToken) return envToken;

  return getGhCliToken();
}

/**
 * gh CLI の `gh auth token` からトークンを取得する。
 * gh CLI が未インストール or 未ログインの場合は undefined を返す。
 */
export function getGhCliToken(): string | undefined {
  return Option.getOrUndefined(
    Effect.runSync(
      Effect.try(() => {
        const { execFileSync } = require("node:child_process");
        return (
          execFileSync("gh", ["auth", "token"], {
            encoding: "utf-8",
            timeout: 5000,
            stdio: ["pipe", "pipe", "pipe"],
          }) as string
        ).trim();
      }).pipe(
        Effect.flatMap((token) =>
          token &&
          (token.startsWith("ghp_") || token.startsWith("gho_") || token.startsWith("github_pat_"))
            ? Effect.succeed(token)
            : Effect.fail("invalid token format" as const),
        ),
        Effect.option,
      ),
    ),
  );
}

/**
 * 認証済み GitHub ユーザーのログイン名を取得する。
 *
 * 背景: テンプレートソースの自動検出で、自分のアカウントの `.ziku` / `.github` リポジトリを
 * 候補に含めるために使用する。トークンがない場合や API エラー時は undefined を返す。
 */
export async function getAuthenticatedUserLogin(): Promise<string | undefined> {
  const token = getGitHubToken();
  if (!token) return undefined;

  return Option.getOrUndefined(
    await Effect.runPromise(
      Effect.tryPromise(async () => {
        const res = await fetch("https://api.github.com/user", {
          headers: { Authorization: `Bearer ${token}` },
        });
        if (!res.ok) return undefined;
        const data = (await res.json()) as { login?: string };
        return data.login;
      }).pipe(Effect.option),
    ),
  );
}

/**
 * GitHub REST API に載せる認証ヘッダを組み立てる。
 *
 * トークンが無ければヘッダを付けない。未認証でも公開リポジトリは読めるので、
 * トークン未設定の環境を弾かないため。逆にトークンがあるのに付け忘れると、
 * GitHub はプライベートリポジトリを 404 として返すため、参照できるはずの
 * リポジトリや ref を「存在しない」と誤判定する。
 */
function githubAuthHeaders(token: string | undefined): Record<string, string> {
  return token === undefined ? {} : { Authorization: `Bearer ${token}` };
}

/**
 * GitHub リポジトリの存在確認結果。
 *
 * 背景: 単純な boolean では「確実に存在しない（404）」と「確認不能
 * （レート制限・ネットワーク断・5xx 等）」を区別できず、後者を "not found"
 * と誤判定する問題があった（未認証 API は 60req/h で 403 が返る）。
 * 呼び出し側で match().exhaustive() により網羅的にハンドリングできるよう、
 * 確認結果をタグ付き Union で表現する。
 *
 * ライフサイクル: checkRepoExists が返し、init/setup の解決ロジックで消費される。
 */
export type RepoExistence =
  | { readonly _tag: "Exists" }
  | { readonly _tag: "NotFound" }
  | {
      readonly _tag: "RateLimited";
      /** `x-ratelimit-reset` ヘッダから算出したリセット時刻。取得できなければ undefined */
      readonly resetAt: Date | undefined;
      /** 認証済みトークンで問い合わせたかどうか。エラーメッセージの分岐に使う */
      readonly authenticated: boolean;
    }
  | {
      readonly _tag: "Unauthorized";
      /**
       * GitHub が返したメッセージ（例: "Bad credentials"）。
       * 認証トークンを付けて問い合わせたが、401 が返ったケースに使う。
       * ライフサイクル: checkRepoExists が返し、init/setup は即 ZikuFailure に変換して
       * ユーザーにトークン更新を促す。
       */
      readonly message: string;
    }
  | {
      readonly _tag: "Unknown";
      /** HTTP ステータス。ネットワークエラー等で取得できない場合は undefined */
      readonly status: number | undefined;
      readonly reason: string;
    };

/**
 * GitHub リポジトリの存在を確認する。
 *
 * 背景: ziku init でテンプレートリポジトリが存在しない場合に、giget の
 * エラーメッセージではなく分かりやすいガイダンスを表示するため、
 * 事前にリポジトリの存在をチェックする。HEAD リクエストで軽量に確認。
 *
 * 認証トークンがあれば付与する理由: 未認証 API は 60req/h のレート制限があり、
 * すぐに 403 で弾かれる。また、プライベートリポジトリは未認証だと 404 扱いになる。
 *
 * 戻り値は RepoExistence 型で、各ケース（Exists/NotFound/RateLimited/Unknown）を
 * 呼び出し側が match で網羅的にハンドリングできるようにする。
 */
export function checkRepoExists(owner: string, repo: string): Promise<RepoExistence> {
  const token = getGitHubToken();
  const headers = githubAuthHeaders(token);
  return Effect.runPromise(
    Effect.tryPromise({
      try: () =>
        fetch(`https://api.github.com/repos/${owner}/${repo}`, { method: "HEAD", headers }),
      // 明示的に catch を指定しないと Effect.tryPromise は原因を UnknownException で
      // ラップしてしまい、元の Error.message（"Network error" 等）が失われる。
      catch: (cause) => (cause instanceof Error ? cause : new Error(String(cause))),
    }).pipe(
      Effect.map((res): RepoExistence => classifyRepoResponse(res, token !== undefined)),
      Effect.catchAll((cause) =>
        Effect.succeed<RepoExistence>({
          _tag: "Unknown",
          status: undefined,
          reason: cause.message,
        }),
      ),
    ),
  );
}

/**
 * RepoExistence の Unauthorized ケースを失敗へ変換する。
 *
 * 背景: `GITHUB_TOKEN` / `GH_TOKEN` が失効または無効な場合、GitHub API は 401 を返す。
 * この状態のまま init/setup を続行するとダウンロードや PR 作成で分かりにくいエラーが
 * 発生するため、早い段階で「トークンを更新せよ」と明確に案内する。
 */
export function unauthorizedError(
  r: Extract<RepoExistence, { readonly _tag: "Unauthorized" }>,
): ZikuFailure {
  return zikuFailure({ kind: "GitHubAuthRejected", detail: r.message });
}

/**
 * RepoExistence の RateLimited ケースを失敗へ変換する。
 *
 * 認証状況とリセット時刻を渡すことで、ユーザーが
 * 「GITHUB_TOKEN を設定する」か「しばらく待つ」かを判断できる。
 */
export function rateLimitedError(
  r: Extract<RepoExistence, { readonly _tag: "RateLimited" }>,
): ZikuFailure {
  return zikuFailure({
    kind: "GitHubRateLimited",
    authenticated: r.authenticated,
    resetAt: r.resetAt,
  });
}

/**
 * HTTP レスポンスを RepoExistence に分類する。
 *
 * GitHub のレート制限応答は「403 + x-ratelimit-remaining: 0」で判定する。
 * 403 でも二要素認証要求など別原因のケースがあるため、ヘッダで明示的に確認する。
 * 401 は無効/失効トークンのシグナル（パブリックリポジトリへの未認証アクセスは
 * 200 や 404 を返すので、401 は付与した Authorization が拒否されたことを意味する）。
 */
function classifyRepoResponse(res: Response, authenticated: boolean): RepoExistence {
  if (res.ok) return { _tag: "Exists" };
  if (res.status === 404) return { _tag: "NotFound" };
  if (res.status === 401) {
    return { _tag: "Unauthorized", message: res.statusText || "Bad credentials" };
  }
  if (res.status === 403 && res.headers.get("x-ratelimit-remaining") === "0") {
    const resetHeader = res.headers.get("x-ratelimit-reset") ?? "";
    // 数値にパースして有限値でなければ undefined（タイムスタンプ不明）とする。
    const resetEpoch = resetHeader !== "" ? Number(resetHeader) : Number.NaN;
    const resetAt = Number.isFinite(resetEpoch) ? new Date(resetEpoch * 1000) : undefined;
    return { _tag: "RateLimited", resetAt, authenticated };
  }
  return {
    _tag: "Unknown",
    status: res.status,
    reason: res.statusText || `HTTP ${res.status}`,
  };
}

/**
 * テンプレートリポジトリがセットアップ済み（.ziku/ziku.jsonc が存在する）か確認する。
 *
 * 背景: リポジトリが存在しても .ziku/ziku.jsonc がなければテンプレートとして
 * 機能しないため、候補の優先順位付けやユーザーへのヒント表示に利用する。
 * GitHub Contents API で軽量に確認。
 */
export function checkRepoSetup(owner: string, repo: string): Promise<boolean> {
  const headers = githubAuthHeaders(getGitHubToken());
  return Effect.runPromise(
    Effect.tryPromise(() =>
      fetch(`https://api.github.com/repos/${owner}/${repo}/contents/.ziku/ziku.jsonc`, {
        method: "HEAD",
        headers,
      }),
    ).pipe(
      Effect.map((res) => res.ok),
      // ネットワークエラー等の場合は不明として false を返す
      Effect.orElseSucceed(() => false),
    ),
  );
}

/**
 * テンプレートリポジトリを新規作成する。
 *
 * 背景: org に `.github` テンプレートリポジトリが存在しない場合、
 * 空のリポジトリを作成し、README と .ziku/modules.jsonc を初期コミットする。
 */
export async function scaffoldTemplateRepo(
  token: string,
  targetOwner: string,
  targetRepo: string,
): Promise<{ url: string }> {
  const { Octokit: OctokitClient } = await import("@octokit/rest");
  const octokit = new OctokitClient({ auth: token });

  // org か personal かを判定
  const isOrg = await Effect.runPromise(
    Effect.tryPromise(() => octokit.orgs.get({ org: targetOwner })).pipe(
      Effect.map(() => true),
      Effect.orElseSucceed(() => false),
    ),
  );

  // リポジトリを作成
  const createParams = {
    name: targetRepo,
    description: "Dev environment template managed by ziku",
    auto_init: true, // README.md を自動作成
  };

  if (isOrg) {
    const { data: repo } = await octokit.repos.createInOrg({
      org: targetOwner,
      ...createParams,
    });
    return { url: repo.html_url };
  }

  const { data: repo } = await octokit.repos.createForAuthenticatedUser(createParams);
  return { url: repo.html_url };
}

/**
 * GitHub への問い合わせが値を返せなかった理由。
 *
 * 2 ケースに分けるのは、呼び出し側が取れる行動が違うため。
 *
 * - `AuthRejected`: 付与したトークンを GitHub が拒否した（401）。人がトークンを直すまで
 *   何度問い合わせても結果は変わらないので、黙って続けると壊れた前提のまま進み続ける。
 *   プライベートリポジトリでは「見えるはずのものが見えない」状態でもあるため、続行の判断を
 *   ツールが代わりに下してよい失敗ではない。
 * - `Unresolved`: ネットワーク断・5xx・レート制限・対象が見つからない。再実行や時間経過で
 *   解消しうるので、呼び出し側は手持ちの値で続行するかを選べる。
 */
export type GitHubLookupFailure =
  | {
      readonly _tag: "AuthRejected";
      /** GitHub が返したメッセージ（例: "Bad credentials"）。 */
      readonly detail: string;
    }
  | {
      readonly _tag: "Unresolved";
      /** 値を返せなかった事情。HTTP ステータス文か例外のメッセージ。 */
      readonly reason: string;
    };

/**
 * コミット SHA の解決結果。
 *
 * 単なる `CommitSha | undefined` では「トークンが拒否された」と「一時的に引けなかった」が
 * 同じ値に潰れる。3-way マージのベースは引けなかったとき古い SHA へ倒れるため、潰したまま
 * だとトークン失効に誰も気づかないまま陳腐化したベースでマージが続く。
 *
 * ライフサイクル: {@link resolveSourceCommit} が返し、`services/command-context.ts` が
 * ベースリビジョンへ変換する（認証拒否は失敗、それ以外は None）。
 */
export type CommitShaResolution =
  | { readonly _tag: "Resolved"; readonly sha: CommitSha }
  | GitHubLookupFailure;

/** リポジトリの既定ブランチ名の解決結果。失敗の分け方は {@link GitHubLookupFailure} と同じ。 */
export type DefaultBranchResolution =
  | { readonly _tag: "Resolved"; readonly name: string }
  | GitHubLookupFailure;

/**
 * 既定ブランチ名を使ってよいかの決着。{@link decideDefaultBranch} が出す。
 *
 * 名前が得られた 2 ケースを分けるのは、控えへ倒したかで呼び出し側の振る舞いが変わるため。
 * lock へ控え直してよいのは GitHub から引き直した `Fetched` だけで、`Recorded` は「最後に
 * 引けた名前」で進んでいることを利用者へ知らせる対象になる。
 */
export type DefaultBranchDecision =
  /** GitHub から引けた名前。 */
  | { readonly _tag: "Fetched"; readonly name: string }
  /** 引けなかったので控えた名前を使う。`reason` は引けなかった事情。 */
  | { readonly _tag: "Recorded"; readonly name: string; readonly reason: string }
  /** トークンを拒否された。控えがあっても使わない。 */
  | { readonly _tag: "AuthRejected"; readonly detail: string }
  /** 引けず、控えも無い。名前が決まらない。 */
  | { readonly _tag: "Unresolved"; readonly reason: string };

/**
 * 既定ブランチの問い合わせ結果と lock の控えから、使ってよい名前を決める。
 *
 * 引けなかったときの扱いは、人が直すまで結果が変わるかで分ける。
 *
 * - 401（トークン拒否）: 控えがあっても倒さない。同じトークンで何度問い合わせても結果は
 *   変わらず、プライベートリポジトリでは「見えるはずのものが見えない」状態でもある。控えへ
 *   倒すと、権限の切れたトークンのまま同期が進み続ける。
 * - レート制限・5xx・接続断・対象が見つからない: 控えがあればその名前で続行する。待てば直る
 *   失敗で中断すると、テンプレートの取得も PR の作成も揃って動かなくなる。控えが無ければ
 *   名前が決まらないので中断する。
 *
 * 既定ブランチ名は 1 回の実行の中で複数の場所が要る（テンプレートの取得先・lock へ記録する
 * コミット SHA・push が PR を向ける宛先）。規則をこの関数へ閉じることで、片方だけが控えへ
 * 倒れて別のブランチを指す状態を作れなくする。
 *
 * @param recorded lock に控えた既定ブランチ名。控えが無ければ undefined。
 */
export function decideDefaultBranch(
  resolution: DefaultBranchResolution,
  recorded: string | undefined,
): DefaultBranchDecision {
  return match(resolution)
    .with({ _tag: "Resolved" }, (r): DefaultBranchDecision => ({ _tag: "Fetched", name: r.name }))
    .with(
      { _tag: "AuthRejected" },
      (f): DefaultBranchDecision => ({ _tag: "AuthRejected", detail: f.detail }),
    )
    .with(
      { _tag: "Unresolved" },
      (f): DefaultBranchDecision =>
        recorded === undefined
          ? { _tag: "Unresolved", reason: f.reason }
          : { _tag: "Recorded", name: recorded, reason: f.reason },
    )
    .exhaustive();
}

/**
 * 値を返さなかった HTTP レスポンスを、呼び出し側の行動が変わる 2 つの理由へ分類する。
 *
 * 401 だけを認証拒否として扱う。401 は付与した Authorization が拒否されたことを意味し、
 * 未認証アクセスでは返らない（公開リポジトリは 200、プライベートリポジトリは 404）。
 * 403 のレート制限・5xx・404 は待つか再実行すれば解消しうるので分けない。
 */
function classifyLookupFailure(res: Response): GitHubLookupFailure {
  if (res.status === 401) {
    return { _tag: "AuthRejected", detail: res.statusText || "Bad credentials" };
  }
  return { _tag: "Unresolved", reason: res.statusText || `HTTP ${res.status}` };
}

/**
 * Octokit が投げた例外を {@link classifyLookupFailure} と同じ基準で分類する。
 *
 * Octokit の RequestError は HTTP ステータスを `status` に載せる。ネットワーク断のように
 * ステータスを持たない例外も飛んでくるため、形を確かめてから読む。
 */
function classifyOctokitFailure(cause: unknown): GitHubLookupFailure {
  const detail = cause instanceof Error ? cause.message : String(cause);
  return httpStatusOf(cause) === 401
    ? { _tag: "AuthRejected", detail }
    : { _tag: "Unresolved", reason: detail };
}

/** 例外オブジェクトに載っている HTTP ステータス。持たない例外では undefined。 */
function httpStatusOf(cause: unknown): number | undefined {
  if (typeof cause !== "object" || cause === null || !("status" in cause)) return undefined;
  const { status } = cause;
  return typeof status === "number" ? status : undefined;
}

/**
 * GitHub API の呼び出しが失敗した理由のうち、ユーザーが次に取る行動が変わるもの。
 *
 * {@link RepoExistence} と同じく、行動の単位でケースを分ける。`Unclassified` は「ユーザーに
 * 書ける行動が無い」ことを表す明示的なケースで、呼び出し側はこれを文言へ潰さず defect の
 * まま運ぶ（{@link githubApiFailure} が受け取れないシグネチャになっている）。
 *
 * ライフサイクル: {@link classifyGitHubApiFailure} が例外から作り、コマンド層が
 * {@link githubApiFailure} で `ZikuFailure` へ変換する。
 */
export type GitHubApiFailure =
  /** 付与したトークンを拒否された (401)。人がトークンを直すまで結果は変わらない。 */
  | { readonly _tag: "AuthRejected"; readonly detail: string }
  /** クォータを使い切った、または連投を弾かれた。待てば解ける。 */
  | { readonly _tag: "RateLimited"; readonly resetAt: Date | undefined }
  /** トークンは通ったが操作を拒否された (403)。権限か fork の可否が足りない。 */
  | { readonly _tag: "PermissionDenied"; readonly detail: string }
  /** GitHub へ届かなかった (名前解決失敗・接続断・タイムアウト)。 */
  | { readonly _tag: "Unreachable"; readonly detail: string }
  /** 上のどれでもない。行動を書けないので、文言に潰さず原因ごと見せる側へ回す。 */
  | { readonly _tag: "Unclassified" };

/**
 * GitHub API 呼び出しが投げた例外を {@link GitHubApiFailure} へ分類する。
 *
 * 接続断をステータスで見分けない理由: Octokit は fetch の失敗も `RequestError` の status 500
 * に包み直すため、ステータスだけでは GitHub が返した 5xx と区別できない。接続断は例外チェーンに
 * 残る errno（`ENOTFOUND` 等）で判定する。
 *
 * GitHub が返した 5xx を分類しないのは、一時障害と ziku が送った不正なリクエストが同じ形で
 * 届き、「待てば直る」と言い切れないため。原因を見せる側（defect）に残す。
 */
export function classifyGitHubApiFailure(cause: unknown): GitHubApiFailure {
  const detail = cause instanceof Error ? cause.message : String(cause);

  return match(httpStatusOf(cause))
    .with(401, (): GitHubApiFailure => ({ _tag: "AuthRejected", detail }))
    .with(429, (): GitHubApiFailure => ({ _tag: "RateLimited", resetAt: rateLimitResetOf(cause) }))
    .with(
      403,
      (): GitHubApiFailure =>
        isRateLimitResponse(cause)
          ? { _tag: "RateLimited", resetAt: rateLimitResetOf(cause) }
          : { _tag: "PermissionDenied", detail },
    )
    .otherwise(
      (): GitHubApiFailure =>
        isNetworkFailure(cause) ? { _tag: "Unreachable", detail } : { _tag: "Unclassified" },
    );
}

/**
 * 分類済みの GitHub API 失敗を、ユーザー向けの失敗へ変換する。
 *
 * @param context.operation 何をしようとして失敗したか（"create a pull request" 等）。
 *   文中に埋め込むので動詞から始める。
 * @param context.authenticated トークンを付けて呼んだか。レート制限の案内が変わる。
 * @param context.cause 元の例外。原因を捨てないため必ず渡す。
 */
export function githubApiFailure(
  failure: Exclude<GitHubApiFailure, { readonly _tag: "Unclassified" }>,
  context: { readonly operation: string; readonly authenticated: boolean; readonly cause: unknown },
): ZikuFailure {
  const options = { cause: context.cause };

  return match(failure)
    .with({ _tag: "AuthRejected" }, (f) =>
      zikuFailure({ kind: "GitHubAuthRejected", detail: f.detail }, options),
    )
    .with({ _tag: "RateLimited" }, (f) =>
      zikuFailure(
        {
          kind: "GitHubRateLimited",
          authenticated: context.authenticated,
          resetAt: f.resetAt,
        },
        options,
      ),
    )
    .with({ _tag: "PermissionDenied" }, (f) =>
      zikuFailure(
        { kind: "GitHubPermissionDenied", operation: context.operation, detail: f.detail },
        options,
      ),
    )
    .with({ _tag: "Unreachable" }, (f) =>
      zikuFailure(
        { kind: "GitHubUnreachable", operation: context.operation, detail: f.detail },
        options,
      ),
    )
    .exhaustive();
}

/**
 * 403 がレート制限かを判定する。
 *
 * GitHub は 1 時間あたりのクォータ超過を「`x-ratelimit-remaining: 0`」で、短時間の連投を弾く
 * secondary rate limit を「`retry-after`」で知らせる。権限不足の 403 はどちらのヘッダも
 * 持たないので、ヘッダの有無で分けられる。
 */
function isRateLimitResponse(cause: unknown): boolean {
  return (
    responseHeaderOf(cause, "x-ratelimit-remaining") === "0" ||
    responseHeaderOf(cause, "retry-after") !== undefined
  );
}

/**
 * レート制限が解ける時刻。読めるヘッダが無ければ undefined（残り時間を出さない）。
 *
 * `retry-after` は「あと何秒」、`x-ratelimit-reset` は「いつ（epoch 秒）」で意味が違うため、
 * 同じ時刻へ直してから返す。
 */
function rateLimitResetOf(cause: unknown): Date | undefined {
  const retryAfterSeconds = Number(responseHeaderOf(cause, "retry-after"));
  if (Number.isFinite(retryAfterSeconds)) {
    return new Date(Date.now() + retryAfterSeconds * 1000);
  }

  const resetEpoch = Number(responseHeaderOf(cause, "x-ratelimit-reset"));
  return Number.isFinite(resetEpoch) ? new Date(resetEpoch * 1000) : undefined;
}

/** 例外に載っているレスポンスヘッダ。Octokit の `RequestError` は小文字の名前で持つ。 */
function responseHeaderOf(cause: unknown, name: string): string | undefined {
  const headers = propertyOf(propertyOf(cause, "response"), "headers");
  const value = propertyOf(headers, name);
  return typeof value === "string" ? value : undefined;
}

/** 任意のオブジェクトから自身のプロパティを取り出す。オブジェクトでなければ undefined。 */
function propertyOf(value: unknown, key: string): unknown {
  if (typeof value !== "object" || value === null) return undefined;
  return Object.getOwnPropertyDescriptor(value, key)?.value;
}

/**
 * GitHub へ届かなかったことを示す errno。
 *
 * 名前解決・接続・タイムアウトの失敗だけを挙げる。いずれも「接続を確かめて実行し直す」で
 * 同じ行動になるので、原因ごとに分けない。
 */
const NETWORK_ERROR_CODES: ReadonlySet<string> = new Set([
  "EAI_AGAIN",
  "ECONNABORTED",
  "ECONNREFUSED",
  "ECONNRESET",
  "EHOSTUNREACH",
  "ENETUNREACH",
  "ENOTFOUND",
  "EPIPE",
  "ETIMEDOUT",
  "UND_ERR_CONNECT_TIMEOUT",
  "UND_ERR_HEADERS_TIMEOUT",
  "UND_ERR_SOCKET",
]);

/** 例外チェーンを何段まで辿るか。fetch の失敗は Octokit と undici で 2 段包まれる。 */
const MAX_CAUSE_DEPTH = 5;

/**
 * 例外チェーンのどこかに接続失敗の errno があるか調べる。
 *
 * チェーンを辿るのは、届かなかった事実が最も外側の例外には残らないため。Octokit は
 * `RequestError` で、undici は `TypeError: fetch failed` でそれぞれ包み、errno は最も内側に
 * だけ載る。
 */
function isNetworkFailure(cause: unknown): boolean {
  let current = cause;
  for (let depth = 0; depth < MAX_CAUSE_DEPTH; depth++) {
    const code = propertyOf(current, "code");
    if (typeof code === "string" && NETWORK_ERROR_CODES.has(code)) return true;
    current = propertyOf(current, "cause");
  }
  return false;
}

/**
 * リポジトリの既定ブランチ名を、失敗理由を保ったまま取得する。
 *
 * 既定ブランチは `main` とは限らない（`master` / `trunk` 等）。ブランチが指定されていない
 * ときに `main` を仮定すると、存在しないブランチを見に行くか、別ブランチのコミットを掴む。
 * どちらも 3-way マージのベースを取り違える原因になる。
 *
 * 引けなかった理由で行動を変える呼び出し（トークン拒否なら中断、待てば直る失敗なら控えの
 * ブランチ名へ倒す）は、undefined へ潰す {@link resolveDefaultBranch} ではなくこちらを使う。
 */
export function fetchDefaultBranch(owner: string, repo: string): Promise<DefaultBranchResolution> {
  const octokit = new Octokit({ auth: getGitHubToken() });

  return Effect.runPromise(
    Effect.tryPromise({
      try: () => octokit.repos.get({ owner, repo }),
      catch: classifyOctokitFailure,
    }).pipe(
      Effect.map(
        ({ data }): DefaultBranchResolution => ({ _tag: "Resolved", name: data.default_branch }),
      ),
      // 成功も失敗も同じ union なので、エラーチャネルを戻り値へ畳む。
      Effect.merge,
    ),
  );
}

/**
 * リポジトリの既定ブランチ名を取得する。
 *
 * 取得できない場合（リポジトリ不在・認証失敗・ネットワーク断・レート制限）は undefined を
 * 返す。誤ったブランチ名で解決を続けるより、未解決として呼び出し側のフォールバックへ倒す
 * ほうが安全なため。失敗の理由で行動を変える呼び出しは {@link fetchDefaultBranch} を使い、
 * 分類済みの結果を扱うこと。
 */
export async function resolveDefaultBranch(
  owner: string,
  repo: string,
): Promise<string | undefined> {
  return match(await fetchDefaultBranch(owner, repo))
    .with({ _tag: "Resolved" }, (r) => r.name)
    .with({ _tag: "AuthRejected" }, () => undefined)
    .with({ _tag: "Unresolved" }, () => undefined)
    .exhaustive();
}

/**
 * 任意の git ref（ブランチ名 / タグ名 / コミット SHA）が指すコミット SHA を取得する。
 *
 * GitHub API の `Accept: application/vnd.github.sha` を使い、SHA 文字列のみを取得する。
 * トークンがあれば付与する: プライベートなテンプレートリポジトリは未認証だと 404 になり、
 * ベースコミットが lock に記録されないまま 3-way マージの共通祖先を失う。
 */
function fetchCommitSha(owner: string, repo: string, ref: string): Promise<CommitShaResolution> {
  const headers = {
    Accept: "application/vnd.github.sha",
    ...githubAuthHeaders(getGitHubToken()),
  };

  return Effect.runPromise(
    Effect.tryPromise({
      try: async (): Promise<CommitShaResolution> => {
        const url = `https://api.github.com/repos/${owner}/${repo}/commits/${ref}`;
        const res = await fetch(url, { headers });
        if (!res.ok) return classifyLookupFailure(res);
        // API レスポンスがコミット SHA の入口。ここから先は brand 付きで流れる。
        // 想定外の本文（HTML のエラーページ等）はスキーマが弾き、下の catch が拾う。
        return { _tag: "Resolved", sha: commitShaSchema.parse((await res.text()).trim()) };
      },
      catch: (cause): GitHubLookupFailure => ({
        _tag: "Unresolved",
        reason: cause instanceof Error ? cause.message : String(cause),
      }),
    }).pipe(Effect.merge),
  );
}

/**
 * ブランチの最新コミット SHA を取得する。
 *
 * 引数がブランチに限られるのは「最新」という語がブランチでしか意味を持たないため。
 * タグやコミットを渡せてしまうと、固定のコミットがそのまま返り、最新を取得した
 * つもりの呼び出し側が意図しない結果を受け取る。
 * 省略した場合はリポジトリの既定ブランチを使う。既定ブランチの問い合わせで認証が拒否
 * されたときも認証拒否として返す。ref を省いた設定が最も多いので、ここで潰すと
 * トークン失効がほとんどの経路で見えなくなる。
 */
export async function resolveLatestCommitSha(
  owner: string,
  repo: string,
  branch?: BranchRef,
): Promise<CommitShaResolution> {
  if (branch !== undefined) return fetchCommitSha(owner, repo, branch.name);

  return match(await fetchDefaultBranch(owner, repo))
    .with({ _tag: "Resolved" }, (r) => fetchCommitSha(owner, repo, r.name))
    .with({ _tag: "AuthRejected" }, (f): CommitShaResolution => f)
    .with(
      { _tag: "Unresolved" },
      (f): CommitShaResolution => ({
        _tag: "Unresolved",
        reason: `could not resolve the default branch: ${f.reason}`,
      }),
    )
    .exhaustive();
}

/**
 * テンプレートソースの ref が現在指しているコミットを解決する。
 *
 * 3-way マージのベースツリーを取り直すために lock へ記録する値。ref の種別ごとに
 * 「今どのコミットか」の意味が違うため、ここで種別を吸収する。
 *
 * - ブランチ / 未指定: そのブランチ（未指定なら既定ブランチ）の最新コミット
 * - タグ: タグが指すコミット
 * - コミット: その SHA 自身（API 呼び出し不要）
 *
 * 失敗は戻り値で表す（{@link CommitShaResolution}）。reject するのは実装の不具合だけ。
 */
export function resolveSourceCommit(
  owner: string,
  repo: string,
  ref?: TemplateRef,
): Promise<CommitShaResolution> {
  return match(ref)
    .with(undefined, () => resolveLatestCommitSha(owner, repo))
    .with({ kind: "branch" }, (branch) => resolveLatestCommitSha(owner, repo, branch))
    .with({ kind: "tag" }, (tag) => fetchCommitSha(owner, repo, tag.name))
    .with({ kind: "commit" }, (commit) =>
      Promise.resolve<CommitShaResolution>({ _tag: "Resolved", sha: commit.sha }),
    )
    .exhaustive();
}

/**
 * テンプレートソースの ref が指すコミット SHA を、解決できなければ undefined として返す。
 *
 * 「SHA が取れたら記録し、取れなければ記録しない」だけで足りる呼び出し向け。既に記録済みの
 * ベースを持たない経路（`init`）では、失敗の理由が分かっても取れる行動が変わらない。
 * 既存のベースへ倒れる経路は理由で行動が変わるので {@link resolveSourceCommit} を使うこと。
 */
export async function resolveSourceCommitSha(
  owner: string,
  repo: string,
  ref?: TemplateRef,
): Promise<CommitSha | undefined> {
  return match(await resolveSourceCommit(owner, repo, ref))
    .with({ _tag: "Resolved" }, (r) => r.sha)
    .with({ _tag: "AuthRejected" }, () => undefined)
    .with({ _tag: "Unresolved" }, () => undefined)
    .exhaustive();
}

/**
 * sleep utility
 */
function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => {
    setTimeout(resolve, ms);
  });
}
