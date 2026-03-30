import { existsSync } from "node:fs";
import { readFile } from "node:fs/promises";
import ignore, { type Ignore } from "ignore";
import { join } from "pathe";

/**
 * 複数ディレクトリの .gitignore をマージして読み込み
 * ローカルとテンプレートの両方の .gitignore を考慮することで、
 * クレデンシャル等の機密情報の誤流出を防止する
 */
export async function loadMergedGitignore(dirs: string[]): Promise<Ignore> {
  const ig = ignore();
  for (const dir of dirs) {
    const gitignorePath = join(dir, ".gitignore");
    if (existsSync(gitignorePath)) {
      const content = await readFile(gitignorePath, "utf-8");
      ig.add(content);
    }
  }
  return ig;
}

/**
 * gitignore ルールでファイルをフィルタリング
 * gitignore に該当しないファイルのみを返す
 */
export function filterByGitignore(files: string[], ig: Ignore): string[] {
  return ig.filter(files);
}

/**
 * ファイルが gitignore に該当するかどうかを判定
 */
export function isIgnored(file: string, ig: Ignore): boolean {
  return ig.ignores(file);
}

/**
 * ファイルリストを ignored と non-ignored に分離
 */
export interface SeparatedFiles {
  /** gitignore に該当しないファイル */
  tracked: string[];
  /** gitignore に該当するファイル */
  ignored: string[];
}

export function separateByGitignore(files: string[], ig: Ignore): SeparatedFiles {
  const tracked: string[] = [];
  const ignored: string[] = [];

  for (const file of files) {
    if (ig.ignores(file)) {
      ignored.push(file);
    } else {
      tracked.push(file);
    }
  }

  return { tracked, ignored };
}
