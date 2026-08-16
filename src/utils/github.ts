import { execFileSync } from "node:child_process";
import { Octokit } from "@octokit/rest";
import { Effect, Option } from "effect";
import { P, match } from "ts-pattern";
import { ZikuFailure, zikuFailure } from "../errors";
import type {
  BlobSha,
  BranchRef,
  CommitSha,
  DeletablePath,
  PrResult,
  PushContent,
  RepoRelPath,
  TemplateRef,
} from "../modules/schemas";
import { blobShaSchema, commitShaSchema } from "../modules/schemas";
import { log } from "../ui/renderer";
import { transportTextToBytes } from "./file-content";
import { ZIKU_CONFIG_FILE } from "./ziku-config";

export interface PushOptions {
  owner: string;
  repo: string;
  /**
   * PR に載せるファイル。`content` はテキストなら utf-8、バイナリならバイト列を保つ
   * エンコードで載っている（`src/utils/file-content.ts`）。GitHub API へ渡す前に
   * 元のバイト列へ戻す。
   *
   * 内容を `PushContent` に限るのは、コンフリクトマーカー入りのテキストが PR に載る経路を
   * 型で塞ぐため。素の `string` を受けると、送信を組み立てる層の検査を通らない消費者が
   * ここへ直接マーカー入りの内容を渡せる。
   */
  files: readonly { readonly path: RepoRelPath; readonly content: PushContent }[];
  /**
   * テンプレートから削除するファイル（PR にファイル削除コミットを含める）。
   *
   * パスを `DeletablePath` に限ることで、ziku 自身の設定ファイルの削除がどの経路からも
   * 載らない（理由は `DeletablePath` の説明を参照）。
   */
  deletions?: readonly { readonly path: DeletablePath }[];
  title: string;
  /**
   * PR の本文。既定値を持たせない理由: 本文は「何を送ったか」の提示で、送る集合を知って
   * いるのは呼び出し側だけ。ここで補うと、送信内容とは別に組み立てた一覧が PR に載り、
   * 同じコマンドが実行経路によって別書式・別内容の本文を出すことになる。
   */
  body: string;
  /**
   * PR の宛先ブランチ。既定値を持たせない理由: 既定ブランチは `main` とは限らず
   * （`master` / `trunk` 等）、仮定すると存在しないブランチを宛先にした PR 作成が
   * 404 になる。必須にすることで、宛先の解決を呼び出し側へ強制する。
   */
  baseBranch: string;
  /**
   * 送るファイルが宛先に既にあるときの扱い。
   *
   * - `replace`（既定）: 既存の内容を置き換える。ローカルの変更を届ける `ziku push`。
   * - `fail`: 副作用の前に失敗する。「まだ無いファイルを足す」操作（`ziku setup`）が、
   *   既に設定済みのテンプレートを規定値で書き戻さないための歯止め。宛先の状態を事前に
   *   確かめられなかった実行でも、この判定は PR に載せる内容と同じ一覧から導かれるので
   *   すり抜けない。
   */
  onExistingFiles?: "replace" | "fail";
}

/**
 * GitHub API を使って PR を作成する。
 *
 * 処理は 2 段に分かれる。{@link preparePush} が読み取りと検証だけを行い、
 * {@link applyPush} が副作用（fork の作成・ブランチ・コミット・PR）だけを行う。
 * 検証が済むまで GitHub 上には何も作らないので、失敗しても後片付けの要る痕跡が残らない。
 */
export function createPullRequest(token: string, options: PushOptions): Promise<PrResult> {
  return classified("create a pull request", true, async () => {
    const octokit = new Octokit({ auth: token });
    const prepared = await preparePush(octokit, options);
    return applyPush(octokit, prepared);
  });
}

/**
 * GitHub API を呼ぶ操作を包み、行動を書ける失敗を分類済みの {@link ZikuFailure} にする。
 *
 * 分類をここに置くのは、呼び出し側で包む形にすると包み忘れが起こるため。実際、包んだ
 * 呼び出し元と包まない呼び出し元が並ぶと、同じ 403 が一方では「fork の可否を確認してください」、
 * もう一方では「ziku の不具合です」とスタックトレース付きで案内される。呼ぶ側の記憶ではなく
 * 呼ばれる側の構造で担保する。
 *
 * `Unclassified`（ユーザーが取れる行動を書けないもの）は文言へ潰さず元の例外のまま投げ直す。
 * 分類済みの失敗（`ZikuFailure`）も、既に行動が書かれているのでそのまま通す。
 *
 * @param authenticated レート制限の案内文を「認証済みクォータ」「未認証クォータ」の
 *   どちらで出すか。トークンを用意できた後にしか走らない書き込み系操作（PR 作成等）は
 *   常に `true` でよいが、トークンが無くても動く読み取り系操作（owner 横断探索等）は
 *   呼び出し側で `getGitHubToken() !== undefined` を渡す。
 */
function classified<A>(
  operation: string,
  authenticated: boolean,
  run: () => Promise<A>,
): Promise<A> {
  return run().catch((cause: unknown): never => {
    if (cause instanceof ZikuFailure) throw cause;

    return match(classifyGitHubApiFailure(cause))
      .with({ _tag: "Unclassified" }, (): never => {
        throw cause;
      })
      .with(
        {
          _tag: P.union(
            "AuthRejected",
            "RateLimited",
            "PermissionDenied",
            "NotFound",
            "Unreachable",
          ),
        },
        (failure): never => {
          throw githubApiFailure(failure, { operation, authenticated, cause });
        },
      )
      .exhaustive();
  });
}

/** PR の宛先と文言。送る内容とは別に運ぶ。 */
interface PullRequestMeta {
  readonly owner: string;
  readonly repo: string;
  readonly title: string;
  readonly body: string;
  readonly baseBranch: string;
}

/** 送信直前のファイル 1 件。内容はバイト列に、更新先は blob SHA に解決済み。 */
interface PreparedFile {
  readonly path: RepoRelPath;
  readonly bytes: Buffer;
  /** 宛先に同名のファイルがあればその blob SHA。無ければ新規作成。 */
  readonly sha: BlobSha | undefined;
}

/** 送信直前の削除 1 件。宛先に実在することを確かめた blob SHA を持つ。 */
interface PreparedDeletion {
  readonly path: RepoRelPath;
  readonly sha: BlobSha;
}

/**
 * PR の head を置く場所。
 *
 * 条件は head が base と共通の履歴を持つことで、それを満たす形は 3 つある。
 * 「fork かどうか」という 1 つの述語に縮めると、認証ユーザーが対象リポジトリの
 * 所有者である構成（fork が要らない）が正当な状態として表せなくなる。
 */
type PushHead =
  /** 対象リポジトリ本体。認証ユーザーが所有者なので fork を挟まない。 */
  | { readonly _tag: "SameRepo" }
  /** 対象リポジトリの既存 fork。 */
  | { readonly _tag: "Fork"; readonly name: string }
  /** fork がまだ無い。applyPush が作る。 */
  | { readonly _tag: "Absent" };

/** ブランチとコミットを置くリポジトリ。{@link ensurePushHead} が決める。 */
interface HeadRepo {
  readonly owner: string;
  readonly repo: string;
}

/**
 * 読み取りと検証を終えた送信内容。{@link applyPush} はこの型しか受け取らない。
 *
 * ここに載る値はすべて解決済み（内容はバイト列、更新先と削除先は blob SHA）で、
 * `applyPush` には確かめるべきことが残っていない。新しい検証は必要な材料が揃う
 * {@link preparePush} にしか書けないので、「副作用を起こしてから検証する」順序を後から
 * 作れない。
 */
interface PreparedPush {
  readonly meta: PullRequestMeta;
  /** PR の head をどこに置くか。 */
  readonly head: PushHead;
  /** 認証ユーザーのログイン名。fork を head に使う場合の所有者になる。 */
  readonly authenticatedUser: string;
  /** 同期ブランチを生やす、宛先ブランチの先端コミット。 */
  readonly baseSha: string;
  readonly files: readonly PreparedFile[];
  readonly deletions: readonly PreparedDeletion[];
}

/**
 * GitHub 上に何も作らずに、送信内容を送れる形へ解決する。
 *
 * 問い合わせるのは対象リポジトリ（fork ではなく）の宛先ブランチ。同期ブランチはその先端から
 * 生やすので、blob SHA も存在するパスの一覧も同じものが得られる。fork を先に用意しないのは、
 * 検証で落ちる実行のために fork を作らないため。
 */
async function preparePush(octokit: Octokit, options: PushOptions): Promise<PreparedPush> {
  const { owner, repo, files, title, body, baseBranch } = options;

  checkSingleIntentPerPath(options);

  const { data: user } = await octokit.users.getAuthenticated();
  const forkOwner = user.login;

  const head = await lookupPushHead(octokit, { owner, repo, forkOwner });

  const { data: baseBranchRef } = await octokit.repos.getBranch({
    owner,
    repo,
    branch: baseBranch,
  });
  const baseSha = baseBranchRef.commit.sha;

  const shaMap = await fetchBlobShas(octokit, { owner, repo, treeSha: baseSha });

  checkExistingFiles(options, shaMap);

  return {
    meta: { owner, repo, title, body, baseBranch },
    head,
    authenticatedUser: forkOwner,
    baseSha,
    files: files.map((file) => ({
      path: file.path,
      // base64 は入力のバイト列をそのまま符号化する。バイナリを utf-8 として符号化すると
      // 1 文字が複数バイトへ膨らみ、PR には壊れたファイルが載る。
      bytes: transportTextToBytes(file.content),
      sha: shaMap.get(file.path),
    })),
    deletions: resolveDeletions(options.deletions ?? [], shaMap, `${owner}/${repo}`),
  };
}

/**
 * 送信内容を GitHub 上へ反映する。ここから先はすべて副作用で、検証は行わない。
 */
async function applyPush(octokit: Octokit, prepared: PreparedPush): Promise<PrResult> {
  const { meta } = prepared;
  const headRepo = await ensurePushHead(octokit, prepared.head, {
    owner: meta.owner,
    repo: meta.repo,
    forkOwner: prepared.authenticatedUser,
  });

  const branchName = `ziku-sync-${Date.now()}`;
  await octokit.git.createRef({
    owner: headRepo.owner,
    repo: headRepo.repo,
    ref: `refs/heads/${branchName}`,
    sha: prepared.baseSha,
  });

  for (const file of prepared.files) {
    await octokit.repos.createOrUpdateFileContents({
      owner: headRepo.owner,
      repo: headRepo.repo,
      path: file.path,
      message: `Update ${file.path}`,
      content: file.bytes.toString("base64"),
      branch: branchName,
      sha: file.sha,
    });
  }

  for (const deletion of prepared.deletions) {
    await octokit.repos.deleteFile({
      owner: headRepo.owner,
      repo: headRepo.repo,
      path: deletion.path,
      message: `Delete ${deletion.path}`,
      sha: deletion.sha,
      branch: branchName,
    });
  }

  const { data: pr } = await octokit.pulls.create({
    owner: meta.owner,
    repo: meta.repo,
    title: meta.title,
    body: meta.body,
    // 同一リポジトリを head にする場合も `owner:branch` 形式で通る。
    head: `${headRepo.owner}:${branchName}`,
    base: meta.baseBranch,
  });

  return {
    url: pr.html_url,
    number: pr.number,
    branch: branchName,
  };
}

/**
 * 1 つのパスに対する指示が 1 つだけか確かめる。
 *
 * 内容の更新は新しい blob を作り、削除は宛先ブランチの blob SHA を要求する。同じパスへ
 * 両方を送ると、削除が更新後の blob と食い違って GitHub に弾かれる。そのときブランチと
 * コミットは既に作られているため、PR の無い同期ブランチだけが残る。読み取りしかしない
 * この段で弾けば、GitHub 上には何も作られない。
 *
 * 送信を組み立てる層は 1 パス 1 指示を型で保証する（`src/commands/push-plan.ts` の
 * `PushPayload`）。ここはその外から来る `PushOptions` に対する境界の検査になる。
 */
function checkSingleIntentPerPath(options: PushOptions): void {
  const deleted = new Set<string>((options.deletions ?? []).map((deletion) => deletion.path));
  const conflicting = options.files.filter((file) => deleted.has(file.path)).map((f) => f.path);
  if (conflicting.length === 0) return;

  throw zikuFailure({
    kind: "PushPathUpdatedAndDeleted",
    repo: `${options.owner}/${options.repo}`,
    paths: conflicting,
  });
}

/**
 * 「足すだけ」と宣言した送信が、宛先に既にあるファイルを含んでいないか確かめる。
 *
 * 判定に使うのは PR へ載せる内容を組み立てるのと同じ一覧なので、宛先の状態を別の問い合わせで
 * 事前確認できなかった実行でもすり抜けない（`PushOptions.onExistingFiles`）。
 */
function checkExistingFiles(options: PushOptions, shaMap: ReadonlyMap<string, BlobSha>): void {
  match(options.onExistingFiles ?? "replace")
    .with("replace", () => undefined)
    .with("fail", () => {
      const existing = options.files
        .filter((file) => shaMap.has(file.path))
        .map((file) => file.path);
      if (existing.length > 0) {
        throw zikuFailure({
          kind: "PushCreateTargetExists",
          repo: `${options.owner}/${options.repo}`,
          paths: existing,
        });
      }
      return undefined;
    })
    .exhaustive();
}

/**
 * ツリーを一括で引き、パスから blob SHA を引ける写像にする。
 *
 * getContent を個別に呼ぶと、未存在ファイルで 404 レスポンスが
 * `@octokit/plugin-request-log` によりコンソールに出力されるため、getTree で一括取得する。
 */
async function fetchBlobShas(
  octokit: Octokit,
  target: { owner: string; repo: string; treeSha: string },
): Promise<ReadonlyMap<string, BlobSha>> {
  const { data: treeData } = await octokit.git.getTree({
    owner: target.owner,
    repo: target.repo,
    tree_sha: target.treeSha,
    recursive: "true",
  });
  // 欠けた一覧のまま進むと、既存ファイルの blob SHA を引けず更新が新規作成として送られる。
  // ユーザーが取れる行動（リポジトリのファイル数を減らす）があるので、分類済みの失敗にする。
  if (treeData.truncated) {
    throw zikuFailure({ kind: "RepoTreeTooLarge", repo: `${target.owner}/${target.repo}` });
  }

  // GitHub が採番した blob SHA の写像。ziku が計算する内容ハッシュと形が同じなので、
  // API レスポンスから取り出すここで blob SHA として brand しておく。
  const shaMap = new Map<string, BlobSha>();
  for (const item of treeData.tree) {
    if (item.type === "blob" && item.sha !== undefined && item.sha !== null && item.path) {
      shaMap.set(item.path, blobShaSchema.parse(item.sha));
    }
  }
  return shaMap;
}

/**
 * 削除するファイルを、その blob SHA と組にして返す。宛先に無いパスが 1 つでもあれば失敗する。
 *
 * `deleteFile` は blob SHA を要求するので、ツリーに無いパスは削除できない。黙って飛ばすと、
 * サマリで「削除する」と見せたファイルがそのまま残った PR ができ、ユーザーには削除が成功した
 * ように見える。ツリーが切り詰められたときと同じく、行動（ベースを取り直して push し直す）が
 * 書ける失敗なので分類して返す。
 */
function resolveDeletions(
  deletions: readonly { readonly path: RepoRelPath }[],
  shaMap: ReadonlyMap<string, BlobSha>,
  repo: string,
): PreparedDeletion[] {
  const resolved: PreparedDeletion[] = [];
  const missing: RepoRelPath[] = [];
  for (const deletion of deletions) {
    const sha = shaMap.get(deletion.path);
    if (sha === undefined) missing.push(deletion.path);
    else resolved.push({ path: deletion.path, sha });
  }

  if (missing.length > 0) {
    throw zikuFailure({ kind: "PushDeletionTargetMissing", repo, paths: missing });
  }
  return resolved;
}

/** fork の作成が API から見えるようになるまで待つ時間。直後に問い合わせると 404 が返る。 */
const FORK_PROPAGATION_WAIT_MS = 3000;

/**
 * PR の head を置ける場所が既にあるかを問い合わせる。作成はしない（{@link ensurePushHead}）。
 *
 * 認証ユーザーが対象リポジトリの所有者なら、対象リポジトリ本体がそのまま head になる。
 * 比較で大文字小文字を畳むのは GitHub のログイン名が case-insensitive なため。畳まずに
 * 比べると、表記だけが違う所有者が同名リポジトリの fork を探しに行き、対象リポジトリ自身を
 * 「fork ではない同名リポジトリ」として弾いてしまう。
 *
 * 既存 fork の問い合わせが失敗したときは「無い」に倒す。未 fork なら 404 が返るが、それ以外の
 * 理由（トークンの失効等）でも作成が同じ理由で失敗し、そちらの例外が呼び出し側へ届く。
 *
 * 同名のリポジトリが見つかっても、対象の fork でなければ使わない（{@link isForkOf}）。
 * 無関係なリポジトリへ同期ブランチを作ると、GitHub のエラーがそのまま出て原因が分からない。
 * この判定は読み取りだけで済むので、副作用の前に済ませる。
 */
async function lookupPushHead(
  octokit: Octokit,
  target: { owner: string; repo: string; forkOwner: string },
): Promise<PushHead> {
  if (target.forkOwner.toLowerCase() === target.owner.toLowerCase()) return { _tag: "SameRepo" };

  const existing = await octokit.repos
    .get({ owner: target.forkOwner, repo: target.repo })
    .then(({ data }) => data)
    .catch(() => undefined);

  if (existing === undefined) return { _tag: "Absent" };

  if (!isForkOf(existing, target)) {
    throw zikuFailure({
      kind: "ForkNameTaken",
      repo: `${target.owner}/${target.repo}`,
      existing: `${target.forkOwner}/${target.repo}`,
    });
  }
  return { _tag: "Fork", name: existing.name };
}

/**
 * ブランチとコミットを置くリポジトリを返す。fork がまだ無ければここで作る。
 *
 * 作成の失敗は包み直さずそのまま投げる。Octokit の例外は HTTP ステータスを持っており、
 * 呼び出し側はそれを見て「権限が足りない」「レート制限」をユーザー向けの案内へ分類する
 * （{@link classifyGitHubApiFailure}）。`Effect.runPromise` で包むと失敗が FiberFailure に
 * 埋もれ、ステータスごと分類の材料が失われる。
 */
function ensurePushHead(
  octokit: Octokit,
  head: PushHead,
  target: { owner: string; repo: string; forkOwner: string },
): Promise<HeadRepo> {
  return match(head)
    .with(
      { _tag: "SameRepo" },
      (): Promise<HeadRepo> => Promise.resolve({ owner: target.owner, repo: target.repo }),
    )
    .with(
      { _tag: "Fork" },
      ({ name }): Promise<HeadRepo> => Promise.resolve({ owner: target.forkOwner, repo: name }),
    )
    .with({ _tag: "Absent" }, async (): Promise<HeadRepo> => {
      const { data } = await octokit.repos.createFork({ owner: target.owner, repo: target.repo });
      await sleep(FORK_PROPAGATION_WAIT_MS);
      return { owner: target.forkOwner, repo: data.name };
    })
    .exhaustive();
}

/**
 * そのリポジトリから対象リポジトリへ PR を出せるか（共通の履歴を持つ fork か）。
 *
 * `parent` は直接の fork 元、`source` は fork の連鎖を辿った根。対象がどちらに当たっても
 * 履歴を共有するので両方を見る。fork の fork から根へ PR を出す形は GitHub が受け付ける。
 */
function isForkOf(
  repository: { fork: boolean; parent?: { full_name: string }; source?: { full_name: string } },
  target: { owner: string; repo: string },
): boolean {
  if (!repository.fork) return false;
  const upstream = `${target.owner}/${target.repo}`.toLowerCase();
  return [repository.parent?.full_name, repository.source?.full_name].some(
    (name) => name?.toLowerCase() === upstream,
  );
}

/**
 * GitHub が発行するトークンの形。
 *
 * `gh*_` は用途ごとの接頭辞（classic PAT / OAuth / user-to-server / server-to-server /
 * refresh）で、`ghs_` には GitHub Actions が `GITHUB_TOKEN` に入れる installation token が
 * 含まれる。`github_pat_` は fine-grained PAT。40 桁の 16 進数は接頭辞の導入前に発行された
 * classic PAT で、いまも有効なため受け入れる。
 *
 * 本体の長さと文字種を絞らないのは、判定の目的が「トークンかどうか」であって「使える
 * トークンかどうか」ではないため。長さや文字種を GitHub の現行仕様に合わせて狭めると、
 * 仕様が変わったときに本物のトークンを弾いてしまい、その症状は private リポジトリの
 * 404 という無関係な形で出る。使えないトークンを弾くのは GitHub の 401 の仕事なので、
 * ここでは接頭辞だけを見て、通した先の判断は GitHub に任せる。
 */
const GITHUB_TOKEN_FORMATS: readonly RegExp[] = [
  /^gh[pousr]_[A-Za-z0-9_]+$/,
  /^github_pat_[A-Za-z0-9_]+$/,
  /^[0-9a-f]{40}$/,
];

/**
 * GitHub トークンとして送ってよい形かどうかを判定する。
 *
 * トークンではない文字列を Authorization ヘッダに載せる経路をここで塞ぐ。判定の範囲は
 * {@link GITHUB_TOKEN_FORMATS} を参照。
 */
export function isGitHubTokenFormat(token: string): boolean {
  return GITHUB_TOKEN_FORMATS.some((format) => format.test(token));
}

/**
 * 形式が不正で無視した環境変数の名前。同じ変数について警告を一度だけ出すために持つ。
 *
 * `githubFetch` は API リクエストのたびに {@link getGitHubToken} を呼ぶので、記録しないと
 * 1 コマンドの実行で同じ警告が何十回も出る。
 */
const warnedInvalidEnvTokens = new Set<string>();

/**
 * 環境変数からトークンを読む。GitHub トークンの形をしていない値は無視して次の候補へ進む。
 *
 * 形式検査を入れる理由: 実体はトークンでないプレースホルダ文字列（サンドボックス実行環境が
 * `GITHUB_TOKEN` に置く定型値など）をそのまま Authorization ヘッダへ載せると、GitHub は
 * 401 を返す。ziku は 401 を「人がトークンを直すまで解消しない失敗」として扱う
 * （{@link classifyGitHubApiFailure}）ため、未認証なら public テンプレートを問題なく取得
 * できる環境でも、テンプレート取得そのものが中断する。トークンの形をしていない値は
 * 「トークンが無い」と同じに扱い、未認証の経路へ倒す。
 *
 * 黙って無視はしない。トークンを設定したつもりの利用者にとっては、private リポジトリの
 * 404 という無関係な症状に化けるため、無視した事実と変数名を警告に出す。
 */
function readEnvGitHubToken(): string | undefined {
  for (const name of ["GITHUB_TOKEN", "GH_TOKEN"] as const) {
    const value = process.env[name];
    if (!value) continue;
    if (isGitHubTokenFormat(value)) return value;

    if (!warnedInvalidEnvTokens.has(name)) {
      warnedInvalidEnvTokens.add(name);
      log.warn(
        `${name} is not in GitHub token format — ignoring it and continuing unauthenticated.`,
      );
    }
  }
  return undefined;
}

/**
 * GitHub トークンを環境変数または gh CLI から取得
 *
 * 優先順位:
 *   1. GITHUB_TOKEN 環境変数
 *   2. GH_TOKEN 環境変数
 *   3. `gh auth token` コマンド出力（gh CLI がインストール済みの場合）
 *
 * どの経路も {@link isGitHubTokenFormat} を通った値だけを返す。通らなかった値の扱いは
 * {@link readEnvGitHubToken} を参照。
 *
 * 背景: gh CLI でログイン済みなのにトークンを手動入力させるのは不親切。
 * 多くの開発者は `gh auth login` 済みなので、そのトークンを自動取得する。
 */
export function getGitHubToken(): string | undefined {
  return readEnvGitHubToken() ?? getGhCliToken();
}

/**
 * `getGhCliToken` の結果（取得できなかった場合の undefined も含めて）を
 * プロセス起動 1 回分だけ保持するモジュールレベルキャッシュ。
 *
 * `githubFetch` は GitHub API リクエストのたびに `getGitHubToken()` を呼ぶ。
 * `GITHUB_TOKEN` / `GH_TOKEN` が未設定の環境では、そのたびに `gh auth token` の同期
 * サブプロセス起動（タイムアウト 5 秒）が走り、イベントループを止めて owner 横断探索
 * （`listOwnerRepos` 等、多数のリポジトリを並列に問い合わせる処理）の並列化の効果を
 * 打ち消す。gh CLI の認証状態はプロセス実行中に変わらない前提でキャッシュする。
 */
let ghCliTokenCache: { readonly token: string | undefined } | undefined;

/**
 * gh CLI の `gh auth token` からトークンを取得する。
 * gh CLI が未インストール or 未ログインの場合は undefined を返す。
 *
 * 結果はプロセス内でキャッシュされる（{@link resetGitHubTokenCaches} 参照）。
 */
export function getGhCliToken(): string | undefined {
  if (ghCliTokenCache !== undefined) return ghCliTokenCache.token;

  const token = Option.getOrUndefined(
    Effect.runSync(
      Effect.try(() =>
        execFileSync("gh", ["auth", "token"], {
          encoding: "utf-8",
          timeout: 5000,
          stdio: ["pipe", "pipe", "pipe"],
        }).trim(),
      ).pipe(
        Effect.flatMap((t) =>
          isGitHubTokenFormat(t) ? Effect.succeed(t) : Effect.fail("invalid token format" as const),
        ),
        Effect.option,
      ),
    ),
  );
  ghCliTokenCache = { token };
  return token;
}

/**
 * トークン取得がプロセス内に持つ状態（gh CLI の結果キャッシュと、形式不正な環境変数に
 * ついて警告済みかの記録）をリセットする。
 *
 * テストで gh CLI の認証状態（またはそのモック）や環境変数を切り替える前に呼ぶこと。
 * プロダクションコードから呼ぶ必要はない（どちらもプロセス寿命の間は変わらない前提のため）。
 */
export function resetGitHubTokenCaches(): void {
  ghCliTokenCache = undefined;
  warnedInvalidEnvTokens.clear();
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
 * リモートのテンプレートリポジトリが ziku 設定済み（`.ziku/ziku.jsonc` がある）か。
 *
 * `Unknown` を分けるのは、確認できなかった状態を「設定されていない」に潰すと、既に設定済みの
 * テンプレートを規定値で書き戻す操作（`ziku setup --remote`）が通ってしまうため。呼び出し側は
 * 3 ケースを網羅して扱う。
 *
 * ライフサイクル: {@link fetchRepoSetupState} が返し、`init` は候補の並べ替えに、`setup` は
 * 「作るか、既に設定済みとして何もしないか」の判断（`src/commands/setup.ts` の `planSetup`）に
 * 使う。
 */
export type RepoSetupState =
  | { readonly _tag: "Configured" }
  | { readonly _tag: "NotConfigured" }
  | {
      readonly _tag: "Unknown";
      /** 確認できなかった事情。HTTP ステータス文か例外のメッセージ。 */
      readonly reason: string;
    };

/**
 * テンプレートリポジトリが ziku 設定済みか問い合わせる。GitHub Contents API で軽量に確認。
 *
 * 認証トークンがあれば付ける理由は {@link checkRepoExists} と同じ（未認証の 60req/h と、
 * プライベートリポジトリの 404 化を避ける）。
 */
export function fetchRepoSetupState(owner: string, repo: string): Promise<RepoSetupState> {
  const headers = githubAuthHeaders(getGitHubToken());
  return Effect.runPromise(
    Effect.tryPromise({
      try: () =>
        fetch(`https://api.github.com/repos/${owner}/${repo}/contents/${ZIKU_CONFIG_FILE}`, {
          method: "HEAD",
          headers,
        }),
      catch: (cause) => (cause instanceof Error ? cause : new Error(String(cause))),
    }).pipe(
      Effect.map((res): RepoSetupState => {
        if (res.ok) return { _tag: "Configured" };
        if (res.status === 404) return { _tag: "NotConfigured" };
        return { _tag: "Unknown", reason: res.statusText || `HTTP ${res.status}` };
      }),
      Effect.catchAll((cause) =>
        Effect.succeed<RepoSetupState>({ _tag: "Unknown", reason: cause.message }),
      ),
    ),
  );
}

/**
 * テンプレートとして使える状態だと確かめられたか。
 *
 * 候補の並べ替え（`init` のテンプレート選択）専用。確認できなかった場合も false になるので、
 * 「設定済みのものを上書きしないためのガード」には使えない。そちらは 3 ケースを扱える
 * {@link fetchRepoSetupState} を直接使う。
 */
export function checkRepoSetup(owner: string, repo: string): Promise<boolean> {
  return fetchRepoSetupState(owner, repo).then((state) => state._tag === "Configured");
}

/**
 * テンプレートリポジトリを新規作成する。
 *
 * 背景: org に `.github` テンプレートリポジトリが存在しない場合、
 * 空のリポジトリを作成し、README と .ziku/modules.jsonc を初期コミットする。
 */
export function scaffoldTemplateRepo(
  token: string,
  targetOwner: string,
  targetRepo: string,
): Promise<{ url: string }> {
  return classified("create the template repository", true, () =>
    scaffoldTemplateRepoUnclassified(token, targetOwner, targetRepo),
  );
}

async function scaffoldTemplateRepoUnclassified(
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
 * 書ける行動が無い」ことを表す明示的なケースで、文言へ潰さず defect のまま運ぶ
 * （{@link githubApiFailure} が受け取れないシグネチャになっている）。
 *
 * ライフサイクル: {@link classifyGitHubApiFailure} が例外から作り、{@link githubApiFailure} が
 * `ZikuFailure` へ変換する。どちらもこのモジュールの外へ出さない。分類の規則を外から呼べると、
 * API を呼ぶ側で分類済みの失敗を、コマンド層が同じ規則を写して分類し直す形が書けてしまう。
 * 呼び出し元が見るのは {@link createPullRequest} 等が投げる `ZikuFailure` だけでよい。
 */
type GitHubApiFailure =
  /** 付与したトークンを拒否された (401)。人がトークンを直すまで結果は変わらない。 */
  | { readonly _tag: "AuthRejected"; readonly detail: string }
  /** クォータを使い切った、または連投を弾かれた。待てば解ける。 */
  | { readonly _tag: "RateLimited"; readonly resetAt: Date | undefined }
  /** トークンは通ったが操作を拒否された (403)。権限か fork の可否が足りない。 */
  | { readonly _tag: "PermissionDenied"; readonly detail: string }
  /** 宛先にした参照を GitHub が見つけられなかった (404)。指した先が上流に無い。 */
  | { readonly _tag: "NotFound"; readonly detail: string }
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
 *
 * 404 を分類するのは、宛先が上流から消えている状態をユーザーが直せるため。lock に控えた
 * 既定ブランチ名は引き直せないときの宛先になるので、上流でブランチが改名・削除されると
 * この形で届く。分類しないと「ziku のバグを報告してください」と案内することになる。
 */
function classifyGitHubApiFailure(cause: unknown): GitHubApiFailure {
  const detail = cause instanceof Error ? cause.message : String(cause);

  return match(httpStatusOf(cause))
    .with(401, (): GitHubApiFailure => ({ _tag: "AuthRejected", detail }))
    .with(404, (): GitHubApiFailure => ({ _tag: "NotFound", detail }))
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
function githubApiFailure(
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
    .with({ _tag: "NotFound" }, (f) =>
      zikuFailure(
        { kind: "GitHubTargetNotFound", operation: context.operation, detail: f.detail },
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
 * 引けなかった理由は潰さずに返す。理由ごとに呼び出し側の行動が変わる（トークン拒否なら
 * 中断、待てば直る失敗なら控えのブランチ名へ倒す）ので、undefined へ畳むと「待てば直る
 * 失敗」と「人が直すまで変わらない失敗」が同じ結末になる。
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
 * 任意の git ref（ブランチ名 / タグ名 / コミット SHA）が指すコミット SHA を取得する。
 *
 * GitHub API の `Accept: application/vnd.github.sha` を使い、SHA 文字列のみを取得する。
 * トークンがあれば付与する: プライベートなテンプレートリポジトリは未認証だと 404 になり、
 * ベースコミットが lock に記録されないまま 3-way マージの共通祖先を失う。
 *
 * ref はセグメントごとにエスケープする。git のブランチ名・タグ名は `#` を許すので、
 * 素のまま URL へ差し込むと `feat/#123` のような ref でフラグメント以降が切り落とされ、
 * 別のコミットを指すか 404 になる。`/` は区切りとして残す。このエンドポイントは
 * `heads/BRANCH_NAME` のように `/` を含む ref をそのまま受け取る。
 */
function fetchCommitSha(owner: string, repo: string, ref: string): Promise<CommitShaResolution> {
  const headers = {
    Accept: "application/vnd.github.sha",
    ...githubAuthHeaders(getGitHubToken()),
  };

  return Effect.runPromise(
    Effect.tryPromise({
      try: async (): Promise<CommitShaResolution> => {
        const url = `https://api.github.com/repos/${encodeURIComponent(owner)}/${encodeURIComponent(repo)}/commits/${encodeGitHubPathSegments(ref)}`;
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

// ────────────────────────────────────────────────────────────────
// owner 横断探索ユーティリティ (ziku aggregate 用)
// ────────────────────────────────────────────────────────────────

/**
 * GitHub REST API への fetch ラッパー。API バージョンと認証ヘッダを固定する。
 *
 * HTTP ステータス（404/403 等）は呼び出し側がレスポンスを見て意味づけする。「存在しない」
 * なのか「エラー」なのかはエンドポイントごとに異なるため、ここでは判定しない。fetch 自体が
 * 失敗する（名前解決不能・接続断等）場合は素の例外のまま reject され、`classified()` が
 * 例外チェーンの errno から `Unreachable` に分類する。
 */
function githubFetch(url: string, init?: RequestInit): Promise<Response> {
  return fetch(url, {
    ...init,
    headers: {
      // API のバージョンを明示しない場合、GitHub 側の既定バージョンが変わると
      // レスポンス形状も変わりうる。明示して形状を固定する。
      Accept: "application/vnd.github+json",
      "X-GitHub-Api-Version": "2022-11-28",
      ...githubAuthHeaders(getGitHubToken()),
      ...(init?.headers as Record<string, string> | undefined),
    },
  });
}

/**
 * 2xx 以外のレスポンスを、`classified()` の分類ロジックが読める形の例外に変換する。
 *
 * `classifyGitHubApiFailure` は Octokit の `RequestError`（`status` と、レート制限判定に
 * 使う `response.headers` を持つ）を読む前提で書かれている。fetch の `Response` はヘッダを
 * `Headers` インスタンスで持つため、`Object.fromEntries` で素のオブジェクトへ詰め替えて
 * 同じ分類ロジックに乗せる。
 */
function githubResponseError(res: Response): Error {
  return Object.assign(new Error(res.statusText || `HTTP ${res.status}`), {
    status: res.status,
    response: { status: res.status, headers: Object.fromEntries(res.headers.entries()) },
  });
}

/**
 * レスポンスボディを JSON としてパースする。GitHub がステータス 200 で不正な JSON を
 * 返すことは通常無いが、`.json()` 自体が reject しうるため、その reject は呼び出し元の
 * `classified()` が拾い、HTTP ステータスを持たない例外として `Unclassified` に分類する。
 */
function parseGitHubJson<T>(res: Response): Promise<T> {
  return res.json() as Promise<T>;
}

/** GitHub Repos API (`/orgs/{owner}/repos` `/users/{owner}/repos`) の 1 要素。必要フィールドのみ */
interface GitHubRepoListItem {
  readonly name: string;
  readonly owner: { readonly login: string };
  readonly default_branch: string;
  readonly archived: boolean;
  readonly pushed_at: string | null;
  readonly private: boolean;
}

/**
 * owner が Organization かどうかを判定する。
 *
 * `GET /orgs/{owner}` が 200 なら org、404 なら Personal アカウントとして user 扱いにする。
 *
 * 404 以外の失敗（レート制限・認証エラー）を user 扱いへ丸めてはいけない。`/users/{org}/repos`
 * は Organization に対しても public リポジトリだけを返すため、丸めるとエラーが表面化しないまま
 * 「private リポジトリが 1 つも無い owner」に見えてしまう。取りこぼしを黙って返すより失敗させる。
 */
async function isOrganization(owner: string): Promise<boolean> {
  const res = await githubFetch(`https://api.github.com/orgs/${encodeURIComponent(owner)}`, {
    method: "HEAD",
  });
  if (res.status === 404) return false;
  if (!res.ok) throw githubResponseError(res);
  return true;
}

/**
 * リポジトリ一覧 API をページネーションしながら全件取得する。
 *
 * `per_page=100` で取得し、返却件数が `per_page` 未満になったページを最後と判定する
 * （GitHub の Link ヘッダをパースする方法もあるが、この用途では単純な件数判定で十分）。
 *
 * @param extraParams `baseUrl` だけでは表現できない追加クエリパラメータ
 *   （例: `/user/repos?affiliation=owner` の `affiliation`）。
 */
async function fetchAllRepoPages(
  baseUrl: string,
  extraParams?: Record<string, string>,
): Promise<readonly GitHubRepoListItem[]> {
  const perPage = 100;
  const acc: GitHubRepoListItem[] = [];
  for (let page = 1; ; page += 1) {
    const url = new URL(baseUrl);
    url.searchParams.set("per_page", String(perPage));
    url.searchParams.set("page", String(page));
    for (const [key, value] of Object.entries(extraParams ?? {})) {
      url.searchParams.set(key, value);
    }
    const res = await githubFetch(url.toString());
    if (!res.ok) throw githubResponseError(res);
    const items = await parseGitHubJson<readonly GitHubRepoListItem[]>(res);
    acc.push(...items);
    if (items.length < perPage) return acc;
  }
}

/**
 * `listOwnerRepos` 用に、認証済み GitHub ユーザーのログイン名を取得する。
 *
 * `getAuthenticatedUserLogin`（テンプレートソースの自動検出向け）とは失敗の扱いを変える。
 * ここでの用途は「探索対象 owner が認証ユーザー自身かどうか」の判定であり、誤って「自分では
 * ない」側に倒すと、private リポジトリしか返さない `/user/repos?affiliation=owner` を使わず
 * public 限定の `/users/{owner}/repos` に落ち、private リポジトリが黙って報告から漏れる。
 * `isOrganization` と同じ「取りこぼしを黙って返すより失敗させる」方針で、次のように区別する。
 *
 * - トークンが無い: `undefined` で成功する。認証ユーザーは存在しないので、owner が誰であっても
 *   「自分ではない」が正しい判定。
 * - トークンはあるが `/user` の取得に失敗した（401/403/ネットワークエラー等）: 失敗させる。
 *   判定不能のまま public 限定へ丸めない。
 */
async function resolveAuthenticatedUserLogin(): Promise<string | undefined> {
  const token = getGitHubToken();
  if (!token) return undefined;

  const res = await githubFetch("https://api.github.com/user");
  if (!res.ok) throw githubResponseError(res);
  const data = await parseGitHubJson<{ login?: string }>(res);
  if (!data.login) {
    throw zikuFailure({
      kind: "GitHubUnusableResponse",
      operation: "identify the authenticated user",
      detail: 'the "/user" response did not include a login',
    });
  }
  return data.login;
}

/**
 * Personal アカウント owner のリポジトリ一覧を取得する。
 *
 * `GET /users/{owner}/repos` は認証していても public リポジトリしか返さない（GitHub API の
 * 仕様）。探索対象の owner が認証ユーザー自身の場合は `GET /user/repos?affiliation=owner` に
 * 切り替える。このエンドポイントは認証ユーザーが owner のリポジトリ（private を含む）を返す。
 *
 * 他人の Personal アカウントを探索する場合に public リポジトリしか見えないのは GitHub API 側の
 * 仕様上の制約であり、この関数の対処範囲外（挙動は変えない）。
 */
async function fetchPersonalOwnerRepoPages(owner: string): Promise<readonly GitHubRepoListItem[]> {
  const authenticatedLogin = await resolveAuthenticatedUserLogin();
  // login はケースを区別しないため、比較前に正規化する。
  const isSelf = authenticatedLogin?.toLowerCase() === owner.toLowerCase();
  if (isSelf) {
    return fetchAllRepoPages("https://api.github.com/user/repos", { affiliation: "owner" });
  }
  return fetchAllRepoPages(`https://api.github.com/users/${encodeURIComponent(owner)}/repos`);
}

/** `listOwnerRepos` が返すリポジトリ 1 件分の情報 */
export interface OwnerRepoInfo {
  readonly owner: string;
  readonly repo: string;
  readonly defaultBranch: string;
  readonly archived: boolean;
  /** ISO 8601 文字列。push 履歴が無い空リポジトリでは null */
  readonly pushedAt: string | null;
  readonly isPrivate: boolean;
}

/** {@link listOwnerRepos} の探索オプション */
export interface ListOwnerReposOptions {
  /** true の場合アーカイブ済みリポジトリも含める。既定は false（除外） */
  readonly includeArchived?: boolean;
}

/**
 * owner（Organization または User）配下の全リポジトリを列挙する。
 *
 * - owner が Organization か User かを {@link isOrganization} で判定する。Organization なら
 *   `/orgs/{owner}/repos` を使う。
 * - User の場合、{@link fetchPersonalOwnerRepoPages} が owner が認証ユーザー自身かどうかで
 *   さらに使い分ける。認証ユーザー自身なら `/user/repos?affiliation=owner`（private を含む）、
 *   他人なら `/users/{owner}/repos`（public のみ、GitHub API の仕様上の制約）。
 * - ページネーションを最後まで辿るため、リポジトリ数が多い owner でも全件返る（1 ページ目だけ
 *   で打ち切らない）。
 * - `includeArchived` が false（既定）の場合、アーカイブ済みリポジトリは結果から除く。
 * - 認証は `getGitHubToken()` に委ねる。トークンが無くても public リポジトリの一覧は取得できる
 *   （未認証は 60req/h に制限されるため、クォータに達すると `ZikuFailure`
 *   （`kind: "GitHubRateLimited"`）で失敗する）。
 */
export function listOwnerRepos(
  owner: string,
  options?: ListOwnerReposOptions,
): Promise<OwnerRepoInfo[]> {
  const includeArchived = options?.includeArchived ?? false;
  return classified(
    `list repositories under ${owner}`,
    getGitHubToken() !== undefined,
    async () => {
      const isOrg = await isOrganization(owner);
      const items = isOrg
        ? await fetchAllRepoPages(`https://api.github.com/orgs/${encodeURIComponent(owner)}/repos`)
        : await fetchPersonalOwnerRepoPages(owner);
      return items
        .filter((item) => includeArchived || !item.archived)
        .map(
          (item): OwnerRepoInfo => ({
            owner: item.owner.login,
            repo: item.name,
            defaultBranch: item.default_branch,
            archived: item.archived,
            pushedAt: item.pushed_at,
            isPrivate: item.private,
          }),
        );
    },
  );
}

/** GitHub Repos API (`/repos/{owner}/{repo}`) の必要フィールドのみ */
interface GitHubRepoDetail {
  readonly default_branch: string;
  /** `owner/repo` 形式の正規表記。リネーム・移管後の旧名アクセスではリダイレクト後の値が入る */
  readonly full_name: string;
}

/** {@link getRepoIdentity} が返す、正規化された owner/repo と既定ブランチ */
export interface RepoIdentity {
  /** GitHub 側の正規表記の owner。リネーム・移管後は追随した値になる */
  readonly owner: string;
  /** GitHub 側の正規表記の repo。リネーム・移管後は追随した値になる */
  readonly repo: string;
  readonly defaultBranch: string;
}

/**
 * 単一リポジトリの正規名（owner/repo）と既定ブランチ名を取得する。
 *
 * `listOwnerRepos` の列挙結果から owner/repo 一致で defaultBranch を引く方法は、探索対象の
 * owner がリポジトリ自身の owner と異なる場合や、リポジトリがアーカイブ済みで列挙結果に
 * 含まれない場合に defaultBranch を解決できない。`GET /repos/{owner}/{repo}` は列挙に依存せず
 * 単一リポジトリの既定ブランチを直接返すため、そのようなケースでも解決できる。
 *
 * `GET /repos/{owner}/{repo}` はリポジトリがリネーム・移管された後も旧名でアクセスすると
 * リダイレクトされ、レスポンスの `full_name` には正規名が入る。呼び出し側は `.ziku/lock.json`
 * に残った旧テンプレート名を正規名へ解決してテンプレートと突き合わせるためにこの `full_name`
 * を利用できる。想定外の形（`owner/repo` の 2 セグメントになっていない）は GitHub 側の契約
 * 違反であり、ユーザーが直せる行動が無いので、文言に潰さず元の例外のまま投げ直す
 * （`classified()` の `Unclassified` 経路）。
 */
export function getRepoIdentity(owner: string, repo: string): Promise<RepoIdentity> {
  return classified(
    `look up the canonical identity of ${owner}/${repo}`,
    getGitHubToken() !== undefined,
    async () => {
      const res = await githubFetch(
        `https://api.github.com/repos/${encodeURIComponent(owner)}/${encodeURIComponent(repo)}`,
      );
      if (!res.ok) throw githubResponseError(res);
      const data = await parseGitHubJson<GitHubRepoDetail>(res);
      const segments = data.full_name.split("/");
      const [canonicalOwner, canonicalRepo] = segments;
      if (segments.length !== 2 || !canonicalOwner || !canonicalRepo) {
        throw zikuFailure({
          kind: "GitHubUnusableResponse",
          operation: `resolve the canonical name of ${owner}/${repo}`,
          detail: `"full_name" was not in owner/repo form: ${data.full_name}`,
        });
      }
      return { owner: canonicalOwner, repo: canonicalRepo, defaultBranch: data.default_branch };
    },
  );
}

/**
 * GitHub API の URL パスセグメントを `/` 区切りで個別に `encodeURIComponent` する。
 *
 * リポジトリ内パスは `/` を含む（例: `.ziku/lock.json`）。文字列全体へ `encodeURIComponent`
 * を適用すると `/` 自体も `%2F` にエスケープされ、GitHub 側が別のパスセグメント数として
 * 解釈してしまう。`/` はパス区切りとして残し、セグメント内の空白や記号だけをエスケープする。
 */
function encodeGitHubPathSegments(path: string): string {
  return path
    .split("/")
    .map((segment) => encodeURIComponent(segment))
    .join("/");
}

/**
 * Contents API の URL を組み立てる。path は {@link encodeGitHubPathSegments} でセグメント
 * ごとにエスケープする。
 */
function buildContentsUrl(owner: string, repo: string, path: RepoRelPath, ref?: string): string {
  const url = new URL(
    `https://api.github.com/repos/${encodeURIComponent(owner)}/${encodeURIComponent(repo)}/contents/${encodeGitHubPathSegments(path)}`,
  );
  if (ref) url.searchParams.set("ref", ref);
  return url.toString();
}

/** GitHub Contents API (`/repos/{owner}/{repo}/contents/{path}`) のレスポンス。ファイル 1 件分 */
interface GitHubContentFile {
  readonly type: "file" | "dir" | "symlink" | "submodule";
  /** base64 エンコードされた内容。1MB を超えるファイルでは省略される */
  readonly content?: string;
  readonly encoding?: string;
  readonly size: number;
}

/**
 * リポジトリ内のテキストファイルを取得する。
 *
 * - ファイルが存在しない（404）場合は `Option.none()` を返す。これは「そのリポジトリが
 *   まだそのファイルを導入していない」という正常系であり、失敗ではない。
 * - path がディレクトリを指していた場合（Contents API は配列を返す）も、テキストファイル
 *   としては取得不可能なので `Option.none()` として扱う。
 * - ファイルが 1MB を超え `content` フィールドが省略されるケースは、空文字列を返すと
 *   「ファイルが空」と区別が付かなくなるため失敗として扱う。
 * - 404 以外の失敗（403 のレート制限、401 の認証エラーなど）は `ZikuFailure` として失敗する。
 *   404 と混同しないよう、ステータスコードでの分岐は 404 を最初に判定する。
 */
export function fetchRepoTextFile(
  owner: string,
  repo: string,
  path: RepoRelPath,
  ref?: string,
): Promise<Option.Option<string>> {
  return classified(
    `fetch ${path} from ${owner}/${repo}`,
    getGitHubToken() !== undefined,
    async () => {
      const res = await githubFetch(buildContentsUrl(owner, repo, path, ref));
      if (res.status === 404) return Option.none<string>();
      if (!res.ok) throw githubResponseError(res);

      const data = await parseGitHubJson<GitHubContentFile | GitHubContentFile[]>(res);
      if (Array.isArray(data)) {
        // ディレクトリを指定した場合。テキストファイルとしては存在しないものとして扱う。
        return Option.none<string>();
      }
      if (data.content === undefined || data.encoding !== "base64") {
        // 分類済みの失敗にしておく。生の Error のままだと呼び出し側で defect になり、
        // 1 ファイルが上限を超えただけで owner 横断の走査全体が落ちる。
        throw zikuFailure({
          kind: "GitHubUnusableResponse",
          operation: `read ${owner}/${repo}/${path}`,
          detail: `the response carried no usable content (size=${data.size} bytes; the Contents API omits bodies over 1MB)`,
        });
      }
      // Option.some(...) は unicorn/no-array-callback-reference が Array.prototype.some との
      // 名前衝突で誤検知するため、fromNullable で同じ意味を表現する（decoded は常に
      // 非 null/undefined の string なので Some(decoded) と等価）。
      const decoded = Buffer.from(data.content, "base64").toString("utf-8");
      return Option.fromNullable(decoded);
    },
  );
}

/** GitHub Commits API (`/repos/{owner}/{repo}/commits`) のレスポンス。1 件分の必要フィールドのみ */
interface GitHubCommitListItem {
  readonly commit: {
    // GitHub App によるコミットなど、committer/author が無いレスポンスも存在するため null 許容
    readonly committer: { readonly date: string } | null;
    readonly author: { readonly date: string } | null;
  };
}

/**
 * リポジトリ内の指定パスに対する最終コミット日時を取得する。
 *
 * - 該当パスへのコミット履歴が無い（0 件）場合は `Option.none()` を返す。これは「そのファイル
 *   がまだ存在しない／変更されたことがない」という正常系。
 * - コミットが見つかった場合は最新 1 件の commit.committer.date（無ければ commit.author.date）
 *   を ISO 8601 文字列で返す。
 * - リポジトリ自体が存在しない、レート制限、認証エラーなどは `ZikuFailure` として失敗する。
 */
export function getLastCommitDate(
  owner: string,
  repo: string,
  path: RepoRelPath,
  ref?: string,
): Promise<Option.Option<string>> {
  return classified(
    `get the last commit date for ${path} in ${owner}/${repo}`,
    getGitHubToken() !== undefined,
    async () => {
      const url = new URL(
        `https://api.github.com/repos/${encodeURIComponent(owner)}/${encodeURIComponent(repo)}/commits`,
      );
      url.searchParams.set("path", path);
      url.searchParams.set("per_page", "1");
      if (ref) url.searchParams.set("sha", ref);

      const res = await githubFetch(url.toString());
      if (!res.ok) throw githubResponseError(res);

      const commits = await parseGitHubJson<readonly GitHubCommitListItem[]>(res);
      if (commits.length === 0) return Option.none<string>();

      const first = commits[0];
      const date = first?.commit.committer?.date ?? first?.commit.author?.date;
      if (!date) {
        throw zikuFailure({
          kind: "GitHubUnusableResponse",
          operation: `read the last commit date of ${owner}/${repo}/${path}`,
          detail: "the latest commit carried neither a committer nor an author date",
        });
      }
      // Option.some(...) は unicorn/no-array-callback-reference が Array.prototype.some との
      // 名前衝突で誤検知するため、fromNullable で同じ意味を表現する（date は直前の !date
      // チェックで非 null/undefined が確定している）。
      return Option.fromNullable(date);
    },
  );
}

/**
 * sleep utility
 */
function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => {
    setTimeout(resolve, ms);
  });
}
