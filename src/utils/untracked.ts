import { glob } from "tinyglobby";
import type { AbsPath, RepoRelPath } from "../modules/schemas";
import { repoRelPaths } from "./paths";
import { getBaseDirsFromPatterns, resolvePatterns } from "./patterns";
import { isExcludedFromScope, type SyncScope } from "./sync-scope";

export interface UntrackedFile {
  path: RepoRelPath;
  folder: string;
}

export interface UntrackedFilesByFolder {
  folder: string;
  files: UntrackedFile[];
}

/**
 * ファイルパスから表示用フォルダ名を取得
 */
export function getDisplayFolderFromPath(filePath: RepoRelPath): string {
  const parts = filePath.split("/");
  if (parts.length === 1) {
    return "root";
  }
  return parts[0];
}

/**
 * ディレクトリ内の全ファイルを取得
 */
export async function getAllFilesInDirs(
  baseDir: AbsPath,
  dirs: readonly string[],
): Promise<RepoRelPath[]> {
  if (dirs.length === 0) return [];

  const patterns = dirs.map((d) => `${d}/**/*`);
  const files = await glob(patterns, {
    cwd: baseDir,
    dot: true,
    onlyFiles: true,
  });
  return repoRelPaths(files.toSorted());
}

/**
 * ルート直下の隠しファイルを取得
 */
export async function getRootDotFiles(baseDir: AbsPath): Promise<RepoRelPath[]> {
  const files = await glob([".*"], {
    cwd: baseDir,
    dot: true,
    onlyFiles: true,
  });
  return repoRelPaths(files.toSorted());
}

/**
 * ホワイトリスト外のファイルをフォルダごとに検出する。
 *
 * 走査範囲を {@link SyncScope} ごと受け取る。「同期の対象か」は
 * {@link isExcludedFromScope} が唯一の答えを持つので、ここで gitignore を読み直さない。
 * 判定が分かれると、ハッシュ計算や差分検出が範囲外として落としたファイルを追跡候補として
 * 勧めることになり、追跡しても同期されないパターンが `ziku.jsonc` に残る。
 *
 * 探索の基点は {@link SyncScope.declared} から採る。基点はパターンの先頭セグメントで
 * 決まるので（{@link getBaseDirsFromPatterns}）、走査用パターンを使うと ziku が走査のために
 * 足す `.ziku/ziku.jsonc` が基点 `.ziku` を生み、同期対象ではない `.ziku/lock.json` が
 * 追跡候補として提示される。追跡すると、そのマシン固有の取得元とベースがテンプレートへ送られる。
 */
export async function detectUntrackedFiles(options: {
  targetDir: AbsPath;
  scope: SyncScope;
}): Promise<UntrackedFilesByFolder[]> {
  const { targetDir, scope } = options;
  const { declared } = scope;

  // フラットパターンで tracked files を算出
  const allTrackedFiles = new Set<string>(
    resolvePatterns(targetDir, declared.include, declared.exclude),
  );

  // ベースディレクトリを抽出
  const { dirs: allBaseDirs, hasRootPatterns } = getBaseDirsFromPatterns(declared.include);

  // 走査範囲の候補（ディレクトリ配下 + ルートパターンがある場合はルート直下）をマージ
  const allFiles = new Set<RepoRelPath>([
    ...(await getAllFilesInDirs(targetDir, allBaseDirs)),
    ...(hasRootPatterns ? await getRootDotFiles(targetDir) : []),
  ]);

  // フォルダごとにグループ化
  const filesByFolder = new Map<string, UntrackedFile[]>();

  for (const filePath of allFiles) {
    if (allTrackedFiles.has(filePath)) continue;
    if (isExcludedFromScope(filePath, scope)) continue;

    const displayFolder = getDisplayFolderFromPath(filePath);

    const isInScope =
      allBaseDirs.some((dir) => filePath.startsWith(`${dir}/`)) ||
      (hasRootPatterns && !filePath.includes("/"));
    if (!isInScope) continue;

    const file: UntrackedFile = {
      path: filePath,
      folder: displayFolder,
    };

    const existing = filesByFolder.get(displayFolder) || [];
    existing.push(file);
    filesByFolder.set(displayFolder, existing);
  }

  const result: UntrackedFilesByFolder[] = [];
  const sortedFolders = Array.from(filesByFolder.keys()).toSorted((a, b) => {
    if (a === "root") return 1;
    if (b === "root") return -1;
    return a.localeCompare(b);
  });

  for (const folder of sortedFolders) {
    const files = filesByFolder.get(folder) || [];
    if (files.length > 0) {
      result.push({
        folder,
        files: files.toSorted((a, b) => a.path.localeCompare(b.path)),
      });
    }
  }

  return result;
}

/**
 * 全フォルダの未追跡ファイル数を取得
 */
export function getTotalUntrackedCount(untrackedByFolder: UntrackedFilesByFolder[]): number {
  return untrackedByFolder.reduce((sum, f) => sum + f.files.length, 0);
}
