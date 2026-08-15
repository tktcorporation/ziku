import { glob } from "tinyglobby";
import type { AbsPath, RepoRelPath } from "../modules/schemas";
import { repoRelPaths } from "./paths";
import { getBaseDirsFromPatterns, resolvePatterns } from "./patterns";
import { UNSCANNED_GLOBS } from "./scan-exclusions";
import { isExcludedFromScope, type DeclaredPatterns, type SyncScope } from "./sync-scope";

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
    // 同期の対象になりえないディレクトリは歩かない。モノレポでは起点の配下にも
    // `node_modules` が現れるので、起点を絞っただけでは避けられない。
    ignore: [...UNSCANNED_GLOBS],
  });
  return repoRelPaths(files.toSorted());
}

/**
 * 追跡候補を探すディレクトリを決める。
 *
 * 「利用者が既に同期しているディレクトリの中で、まだ追跡していないファイル」を勧めるのが
 * 目的なので、起点は**実際に追跡されているファイルの位置**から採る。無視規則の探索
 * （{@link import("./gitignore").loadMergedGitignore}）が使う `reachesWholeRepo` を
 * ここでも使うと、`**\/*.md` のようなパターンでリポジトリ全体が候補になり、同期と無関係な
 * ファイルまで追跡候補として並ぶ。あちらは広く歩いても判定結果が変わらないが、こちらは
 * 利用者に見えるリストがそのまま変わる。許容誤差が逆向きなので、同じ値を共有しない。
 *
 * 宣言にリテラルの先頭ディレクトリがあれば、そこにまだ追跡対象のファイルが無くても起点に
 * 含める。`.claude/**` を宣言した直後の空のディレクトリでも候補を出せるようにするため。
 */
function candidateRoots(
  declared: DeclaredPatterns,
  trackedFiles: readonly RepoRelPath[],
): { dirs: string[]; hasRootPatterns: boolean } {
  const { dirs: literalDirs, hasRootPatterns } = getBaseDirsFromPatterns(declared.include);
  const dirs = new Set<string>(literalDirs);
  let tracksRootFile = false;

  for (const file of trackedFiles) {
    const slashIndex = file.indexOf("/");
    if (slashIndex === -1) tracksRootFile = true;
    else dirs.add(file.slice(0, slashIndex));
  }

  return { dirs: [...dirs], hasRootPatterns: hasRootPatterns || tracksRootFile };
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
 * 探索の基点は {@link SyncScope.declared} と、そのパターンが実際に拾ったファイルから採る
 * （{@link candidateRoots}）。走査用パターンを使うと、ziku が走査のために足す
 * `.ziku/ziku.jsonc` が基点 `.ziku` を生み、同期対象ではない `.ziku/lock.json` が追跡候補
 * として提示される。追跡すると、そのマシン固有の取得元とベースがテンプレートへ送られる。
 */
export async function detectUntrackedFiles(options: {
  targetDir: AbsPath;
  scope: SyncScope;
}): Promise<UntrackedFilesByFolder[]> {
  const { targetDir, scope } = options;
  const { declared } = scope;

  // フラットパターンで tracked files を算出
  const trackedFiles = resolvePatterns(targetDir, declared.include, declared.exclude);
  const allTrackedFiles = new Set<string>(trackedFiles);

  const { dirs: allBaseDirs, hasRootPatterns } = candidateRoots(declared, trackedFiles);

  // 走査範囲の候補（ディレクトリ配下 + ルート直下のファイルを追跡しているならルート直下）
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

    // 絞り込みは走査の起点と同じ集合で行う。片方だけを広げると、拾ったものを全部落とすか、
    // 起点の外にあるファイルを勧めるかのどちらかになる。
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
