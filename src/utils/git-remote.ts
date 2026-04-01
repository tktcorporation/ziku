import { execFileSync } from "node:child_process";
import { Effect } from "effect";

/** テンプレートリポジトリのデフォルト名 */
export const DEFAULT_TEMPLATE_REPO = ".github";

/**
 * GitHub URL からオーナー名を抽出する。
 *
 * 背景: `ziku init` で --from が未指定の場合、git remote URL から
 * オーナーを推定し `{owner}/.github` をテンプレートソースとする。
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
  return Effect.runSync(
    Effect.try(() =>
      execFileSync("git", ["remote", "get-url", "origin"], {
        encoding: "utf-8",
        cwd,
        stdio: ["pipe", "pipe", "pipe"],
      }).trim(),
    ).pipe(
      Effect.map(parseGitHubRepo),
      Effect.orElseSucceed(() => null),
    ),
  );
}
