import { existsSync } from "node:fs";
import { readFile } from "node:fs/promises";
import ignore, { type Ignore } from "ignore";
import { globSync } from "tinyglobby";
import type { AbsPath, GlobPattern, RepoRelPath } from "../modules/schemas";
import { joinAbs, repoRelPaths } from "./paths";
import { resolvePatterns } from "./patterns";
import type { DeclaredPatterns } from "./sync-scope";

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
 * include パターンからベースディレクトリを抽出
 */
function getBaseDirsFromPatterns(include: readonly GlobPattern[]): {
  dirs: string[];
  hasRootPatterns: boolean;
} {
  const dirs = new Set<string>();
  let hasRootPatterns = false;

  for (const pattern of include) {
    const firstSegment = pattern.split("/")[0];
    if (pattern.includes("/") && firstSegment) {
      dirs.add(firstSegment);
    } else {
      hasRootPatterns = true;
    }
  }

  return { dirs: [...dirs], hasRootPatterns };
}

/**
 * ディレクトリ内の全ファイルを取得
 */
export function getAllFilesInDirs(baseDir: AbsPath, dirs: readonly string[]): RepoRelPath[] {
  if (dirs.length === 0) return [];

  const patterns = dirs.map((d) => `${d}/**/*`);
  return repoRelPaths(
    globSync(patterns, {
      cwd: baseDir,
      dot: true,
      onlyFiles: true,
    }).toSorted(),
  );
}

/**
 * ルート直下の隠しファイルを取得
 */
export function getRootDotFiles(baseDir: AbsPath): RepoRelPath[] {
  return repoRelPaths(
    globSync([".*"], {
      cwd: baseDir,
      dot: true,
      onlyFiles: true,
    }).toSorted(),
  );
}

/**
 * 複数ディレクトリの .gitignore をマージして読み込み
 */
export async function loadAllGitignores(
  baseDir: AbsPath,
  dirs: readonly string[],
): Promise<Ignore> {
  const ig = ignore();

  const rootGitignore = joinAbs(baseDir, ".gitignore");
  if (existsSync(rootGitignore)) {
    const content = await readFile(rootGitignore, "utf-8");
    ig.add(content);
  }

  for (const dir of dirs) {
    const gitignorePath = joinAbs(baseDir, dir, ".gitignore");
    if (existsSync(gitignorePath)) {
      const content = await readFile(gitignorePath, "utf-8");
      const prefixedContent = content
        .split("\n")
        .map((line) => {
          const trimmed = line.trim();
          if (!trimmed || trimmed.startsWith("#")) return line;
          if (trimmed.startsWith("!")) {
            return `!${dir}/${trimmed.slice(1)}`;
          }
          return `${dir}/${trimmed}`;
        })
        .join("\n");
      ig.add(prefixedContent);
    }
  }

  return ig;
}

/**
 * ホワイトリスト外のファイルをフォルダごとに検出する。
 *
 * パターンを {@link DeclaredPatterns} でしか受け取らないのは、探索の基点
 * （{@link getBaseDirsFromPatterns}）がパターンの先頭セグメントから決まるため。走査用の
 * パターンを渡せる形にすると、ziku が走査のために足す `.ziku/ziku.jsonc` が基点 `.ziku` を
 * 生み、同期対象ではない `.ziku/lock.json` が追跡候補として提示される。
 */
export async function detectUntrackedFiles(options: {
  targetDir: AbsPath;
  patterns: DeclaredPatterns;
}): Promise<UntrackedFilesByFolder[]> {
  const { targetDir, patterns } = options;

  // フラットパターンで tracked files を算出
  const allTrackedFiles = new Set<string>(
    resolvePatterns(targetDir, patterns.include, patterns.exclude),
  );

  // ベースディレクトリを抽出
  const { dirs: allBaseDirs, hasRootPatterns } = getBaseDirsFromPatterns(patterns.include);

  // gitignore を読み込み
  const gitignore = await loadAllGitignores(targetDir, allBaseDirs);

  // ディレクトリ内の全ファイルを取得
  const allDirFiles = getAllFilesInDirs(targetDir, allBaseDirs);
  const filteredDirFiles = allDirFiles.filter((f) => !gitignore.ignores(f));

  // ルート直下のファイルを取得（ルートパターンがある場合のみ）
  const filteredRootFiles = hasRootPatterns
    ? getRootDotFiles(targetDir).filter((f) => !gitignore.ignores(f))
    : [];

  // 全ファイルをマージ（重複なし）
  const allFiles = new Set<RepoRelPath>([...filteredDirFiles, ...filteredRootFiles]);

  // フォルダごとにグループ化
  const filesByFolder = new Map<string, UntrackedFile[]>();

  for (const filePath of allFiles) {
    if (allTrackedFiles.has(filePath)) continue;

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
