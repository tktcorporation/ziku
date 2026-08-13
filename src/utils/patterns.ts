import { globSync } from "tinyglobby";

/**
 * フラットな include/exclude パターン
 */
export interface FlatPatterns {
  include: string[];
  exclude: string[];
}

/**
 * パターンにマッチするファイル一覧を取得
 */
export function resolvePatterns(baseDir: string, patterns: string[], ignore?: string[]): string[] {
  const files = globSync(patterns, {
    cwd: baseDir,
    dot: true,
    onlyFiles: true,
    ignore: ignore ?? [],
  });
  return files.toSorted();
}
