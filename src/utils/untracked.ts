import { existsSync } from "node:fs";
import { readFile } from "node:fs/promises";
import ignore, { type Ignore } from "ignore";
import { join } from "pathe";
import { globSync } from "tinyglobby";
import type { FlatPatterns } from "./patterns";
import { resolvePatterns } from "./patterns";

export interface UntrackedFile {
  path: string;
  folder: string;
}

export interface UntrackedFilesByFolder {
  folder: string;
  files: UntrackedFile[];
}

/**
 * ファイルパスから表示用フォルダ名を取得
 */
export function getDisplayFolderFromPath(filePath: string): string {
  const parts = filePath.split("/");
  if (parts.length === 1) {
    return "root";
  }
  return parts[0];
}

/**
 * include パターンからベースディレクトリを抽出
 */
function getBaseDirsFromPatterns(include: string[]): {
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
export function getAllFilesInDirs(baseDir: string, dirs: string[]): string[] {
  if (dirs.length === 0) return [];

  const patterns = dirs.map((d) => `${d}/**/*`);
  return globSync(patterns, {
    cwd: baseDir,
    dot: true,
    onlyFiles: true,
  }).sort();
}

/**
 * ルート直下の隠しファイルを取得
 */
export function getRootDotFiles(baseDir: string): string[] {
  return globSync([".*"], {
    cwd: baseDir,
    dot: true,
    onlyFiles: true,
  }).sort();
}

/**
 * 複数ディレクトリの .gitignore をマージして読み込み
 */
export async function loadAllGitignores(baseDir: string, dirs: string[]): Promise<Ignore> {
  const ig = ignore();

  const rootGitignore = join(baseDir, ".gitignore");
  if (existsSync(rootGitignore)) {
    const content = await readFile(rootGitignore, "utf-8");
    ig.add(content);
  }

  for (const dir of dirs) {
    const gitignorePath = join(baseDir, dir, ".gitignore");
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
 * ホワイトリスト外のファイルをフォルダごとに検出
 */
export async function detectUntrackedFiles(options: {
  targetDir: string;
  patterns: FlatPatterns;
}): Promise<UntrackedFilesByFolder[]> {
  const { targetDir, patterns } = options;

  // フラットパターンで tracked files を算出
  const allTrackedFiles = new Set(resolvePatterns(targetDir, patterns.include, patterns.exclude));

  // ベースディレクトリを抽出
  const { dirs: allBaseDirs, hasRootPatterns } = getBaseDirsFromPatterns(patterns.include);

  // gitignore を読み込み
  const gitignore = await loadAllGitignores(targetDir, allBaseDirs);

  // ディレクトリ内の全ファイルを取得
  const allDirFiles = getAllFilesInDirs(targetDir, allBaseDirs);
  const filteredDirFiles = gitignore.filter(allDirFiles);

  // ルート直下のファイルを取得（ルートパターンがある場合のみ）
  const filteredRootFiles = hasRootPatterns ? gitignore.filter(getRootDotFiles(targetDir)) : [];

  // 全ファイルをマージ（重複なし）
  const allFiles = new Set([...filteredDirFiles, ...filteredRootFiles]);

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
  const sortedFolders = Array.from(filesByFolder.keys()).sort((a, b) => {
    if (a === "root") return 1;
    if (b === "root") return -1;
    return a.localeCompare(b);
  });

  for (const folder of sortedFolders) {
    const files = filesByFolder.get(folder) || [];
    if (files.length > 0) {
      result.push({
        folder,
        files: files.sort((a, b) => a.path.localeCompare(b.path)),
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
