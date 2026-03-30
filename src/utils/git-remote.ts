import { execFileSync } from "node:child_process";

/** フォールバック用のデフォルトテンプレートオーナー */
export const DEFAULT_TEMPLATE_OWNER = "tktcorporation";

/** フォールバック用のデフォルトテンプレートリポジトリ名 */
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
  // HTTPS: https://github.com/{owner}/{repo}
  const httpsMatch = url.match(/github\.com\/([^/]+)\//);
  if (httpsMatch) {
    return httpsMatch[1];
  }

  // SSH: git@github.com:{owner}/{repo}
  const sshMatch = url.match(/github\.com:([^/]+)\//);
  if (sshMatch) {
    return sshMatch[1];
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
  try {
    const url = execFileSync("git", ["remote", "get-url", "origin"], {
      encoding: "utf-8",
      cwd,
      stdio: ["pipe", "pipe", "pipe"],
    }).trim();

    return parseGitHubOwner(url);
  } catch {
    return null;
  }
}
