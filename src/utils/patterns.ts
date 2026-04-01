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
  return files.sort();
}

/**
 * ファイルがパターンにマッチするか判定
 */
export function matchesPatterns(filePath: string, patterns: string[]): boolean {
  // globSync を使って正規化されたパターンマッチングを行う
  for (const pattern of patterns) {
    // 完全一致チェック
    if (filePath === pattern) {
      return true;
    }
    // glob パターンマッチング（minimatch 互換）
    if (isGlobPattern(pattern)) {
      const matched = globSync([pattern], {
        cwd: ".",
        expandDirectories: false,
      });
      if (matched.includes(filePath)) {
        return true;
      }
    }
  }
  return false;
}

/**
 * パターンが glob パターンかどうかを判定
 */
function isGlobPattern(pattern: string): boolean {
  return /[*?[\]{}!]/.test(pattern);
}

/**
 * パターン配列を結合（重複排除）
 */
export function mergePatterns(...patternArrays: string[][]): string[] {
  const merged: string[] = [];
  for (const patterns of patternArrays) {
    merged.push(...patterns);
  }
  return [...new Set(merged)]; // 重複排除
}

/**
 * 2つのディレクトリ間でパターンに一致するファイルを比較
 */
export function compareDirectories(
  localDir: string,
  templateDir: string,
  patterns: string[],
  ignore?: string[],
): {
  localOnly: string[];
  templateOnly: string[];
  both: string[];
} {
  const localFiles = new Set(resolvePatterns(localDir, patterns, ignore));
  const templateFiles = new Set(resolvePatterns(templateDir, patterns, ignore));

  const localOnly: string[] = [];
  const templateOnly: string[] = [];
  const both: string[] = [];

  for (const file of localFiles) {
    if (templateFiles.has(file)) {
      both.push(file);
    } else {
      localOnly.push(file);
    }
  }

  for (const file of templateFiles) {
    if (!localFiles.has(file)) {
      templateOnly.push(file);
    }
  }

  return {
    localOnly: localOnly.sort(),
    templateOnly: templateOnly.sort(),
    both: both.sort(),
  };
}
