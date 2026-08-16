import { execFileSync } from "node:child_process";
import { Effect, Option } from "effect";

/** テンプレートリポジトリのデフォルト名（優先順） */
export const DEFAULT_TEMPLATE_REPOS: readonly string[] = [".ziku", ".github"];

/** テンプレートリポジトリのデフォルト名（後方互換用） */
export const DEFAULT_TEMPLATE_REPO = DEFAULT_TEMPLATE_REPOS[0];

/**
 * GitHub URL からオーナー名を抽出する。
 *
 * 背景: `ziku init` で --from が未指定の場合、git remote URL から
 * オーナーを推定し `{owner}/.ziku` または `{owner}/.github` をテンプレートソースとする。
 * テスト容易性のため detectGitHubOwner から分離した純粋関数。
 *
 * 対応形式:
 *   - https://github.com/{owner}/{repo}(.git)?
 *   - git@github.com:{owner}/{repo}(.git)?
 */
export function parseGitHubOwner(url: string): string | null {
  const parsed = parseGitHubRepo(url);
  return parsed ? parsed.owner : null;
}

/**
 * GitHub URL からオーナー名とリポジトリ名を抽出する。
 *
 * 対応形式:
 *   - https://github.com/{owner}/{repo}(.git)?
 *   - git@github.com:{owner}/{repo}(.git)?
 */
export function parseGitHubRepo(url: string): { owner: string; repo: string } | null {
  // HTTPS: https://github.com/{owner}/{repo}
  const httpsMatch = url.match(/github\.com\/([^/]+)\/([^/]+?)(?:\.git)?$/);
  if (httpsMatch) {
    return { owner: httpsMatch[1], repo: httpsMatch[2] };
  }

  // SSH: git@github.com:{owner}/{repo}
  const sshMatch = url.match(/github\.com:([^/]+)\/([^/]+?)(?:\.git)?$/);
  if (sshMatch) {
    return { owner: sshMatch[1], repo: sshMatch[2] };
  }

  return null;
}

/**
 * git remote origin の URL から GitHub オーナー名を検出する。
 *
 * 背景: テンプレートソースの自動解決に使用。
 * git リポジトリでない場合や origin が未設定の場合は null を返す。
 */
export function detectGitHubOwner(cwd?: string): string | null {
  const repo = detectGitHubRepo(cwd);
  return repo ? repo.owner : null;
}

/**
 * git remote origin の URL から GitHub オーナー名とリポジトリ名を検出する。
 *
 * 背景: テンプレートリポジトリ自体で init を実行した場合の検出に使用。
 */
export function detectGitHubRepo(cwd?: string): { owner: string; repo: string } | null {
  return Option.getOrNull(
    Effect.runSync(
      Effect.try(() =>
        execFileSync("git", ["remote", "get-url", "origin"], {
          encoding: "utf-8",
          cwd,
          stdio: ["pipe", "pipe", "pipe"],
        }).trim(),
      ).pipe(Effect.map(parseGitHubRepo), Effect.option),
    ),
  );
}

/**
 * `git ls-remote` の待ち時間の上限。
 *
 * 認証情報を持たない相手や到達しないホストで固まったまま ziku を止めないための上限で、
 * 参照 1 本を引くだけの応答時間から見れば十分に長い。
 */
const LS_REMOTE_TIMEOUT_MS = 10_000;

/**
 * リモートの参照を `git ls-remote` で引く。引けなければ undefined。
 *
 * GitHub REST API の代わりに使う。REST API は未認証だと IP あたり 60 req/h に制限され、
 * 共有 IP から実行する環境ではこの枠が他の利用者と混ざって枯れる。git のプロトコルは
 * この枠を消費しないので、参照を引くだけの用途は git 側で足りる。
 *
 * `GIT_TERMINAL_PROMPT=0` を渡すのは、認証情報を持たない private リポジトリに対して
 * git が対話プロンプトを出し、非対話実行のまま応答待ちで止まるのを防ぐため。
 */
function lsRemote(args: readonly string[]): string | undefined {
  return Option.getOrUndefined(
    Effect.runSync(
      Effect.try(() =>
        execFileSync("git", ["ls-remote", ...args], {
          encoding: "utf-8",
          timeout: LS_REMOTE_TIMEOUT_MS,
          stdio: ["pipe", "pipe", "pipe"],
          env: { ...process.env, GIT_TERMINAL_PROMPT: "0" },
        }),
      ).pipe(Effect.option),
    ),
  );
}

/** `git ls-remote` に渡す GitHub リポジトリの URL。 */
function gitHubRepoUrl(owner: string, repo: string): string {
  return `https://github.com/${owner}/${repo}.git`;
}

/**
 * リポジトリの既定ブランチ名を `git ls-remote` で引く。引けなければ undefined。
 *
 * `HEAD` がどの参照を指しているかを聞く。GitHub のリモート HEAD はリポジトリ設定の
 * 既定ブランチを指すため、REST API の `default_branch` と同じ名前が返る。
 */
export function lsRemoteDefaultBranch(owner: string, repo: string): string | undefined {
  const output = lsRemote(["--symref", gitHubRepoUrl(owner, repo), "HEAD"]);
  if (output === undefined) return undefined;

  return /^ref:\s+refs\/heads\/(?<branch>\S+)\s+HEAD$/m.exec(output)?.groups?.branch;
}

/**
 * ブランチ名またはタグ名が指すコミット SHA を `git ls-remote` で引く。引けなければ undefined。
 *
 * 呼び出し側は種別を区別せずに名前だけを渡すので、ブランチとタグの両方を一度に問い合わせて
 * 見つかった方を返す。同名のブランチとタグがある場合はブランチを採る（GitHub の
 * `/repos/{owner}/{repo}/commits/{ref}` と同じ優先順）。
 *
 * 注釈付きタグには `^{}` を付けた参照も併せて聞く。`refs/tags/<name>` はタグオブジェクト自身の
 * SHA を返し、それはコミットの SHA ではないため、剥がした側を優先する。
 */
export function lsRemoteCommitSha(owner: string, repo: string, ref: string): string | undefined {
  const branchRef = `refs/heads/${ref}`;
  const tagRef = `refs/tags/${ref}`;
  const peeledTagRef = `${tagRef}^{}`;

  const output = lsRemote([gitHubRepoUrl(owner, repo), branchRef, tagRef, peeledTagRef]);
  if (output === undefined) return undefined;

  const shaByRef = new Map(
    output
      .split("\n")
      .map((line) => line.split("\t"))
      .filter((columns): columns is [string, string] => columns.length === 2)
      .map(([sha, name]) => [name.trim(), sha.trim()] as const),
  );

  return shaByRef.get(branchRef) ?? shaByRef.get(peeledTagRef) ?? shaByRef.get(tagRef);
}
