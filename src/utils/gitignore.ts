import { existsSync } from "node:fs";
import { readFile } from "node:fs/promises";
import ignore, { type Ignore } from "ignore";
import type { AbsPath, RepoRelPath } from "../modules/schemas";
import { joinAbs } from "./paths";

/**
 * 複数ディレクトリの .gitignore をマージして読み込み
 * ローカルとテンプレートの両方の .gitignore を考慮することで、
 * クレデンシャル等の機密情報の誤流出を防止する
 */
export async function loadMergedGitignore(dirs: readonly AbsPath[]): Promise<Ignore> {
  const ig = ignore();
  for (const dir of dirs) {
    const gitignorePath = joinAbs(dir, ".gitignore");
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
export function filterByGitignore(files: readonly RepoRelPath[], ig: Ignore): RepoRelPath[] {
  return files.filter((file) => !ig.ignores(file));
}

/**
 * ファイルリストを ignored と non-ignored に分離
 */
export interface SeparatedFiles {
  /** gitignore に該当しないファイル */
  tracked: RepoRelPath[];
  /** gitignore に該当するファイル */
  ignored: RepoRelPath[];
}

export function separateByGitignore(files: readonly RepoRelPath[], ig: Ignore): SeparatedFiles {
  const tracked: RepoRelPath[] = [];
  const ignored: RepoRelPath[] = [];

  for (const file of files) {
    if (ig.ignores(file)) {
      ignored.push(file);
    } else {
      tracked.push(file);
    }
  }

  return { tracked, ignored };
}
