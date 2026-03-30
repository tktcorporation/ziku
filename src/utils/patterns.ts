import { globSync } from "tinyglobby";
import type { DevEnvConfig } from "../modules/schemas";

/**
 * パターンにマッチするファイル一覧を取得
 */
export function resolvePatterns(baseDir: string, patterns: string[]): string[] {
  const files = globSync(patterns, {
    cwd: baseDir,
    dot: true,
    onlyFiles: true,
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
 * 除外パターンでフィルタリング
 */
export function filterByExcludePatterns(files: string[], excludePatterns?: string[]): string[] {
  if (!excludePatterns || excludePatterns.length === 0) {
    return files;
  }
  return files.filter((file) => !matchesPatterns(file, excludePatterns));
}

/**
 * 設定からモジュールの有効パターンを取得
 */
export function getEffectivePatterns(
  _moduleId: string,
  modulePatterns: string[],
  config?: DevEnvConfig,
): string[] {
  let patterns = [...modulePatterns];

  // グローバル除外パターンを適用
  if (config?.excludePatterns) {
    const excludePatterns = config.excludePatterns as string[];
    patterns = patterns.filter((p) => !matchesPatterns(p, excludePatterns));
  }

  return patterns;
}

/**
 * 2つのディレクトリ間でパターンに一致するファイルを比較
 */
export function compareDirectories(
  localDir: string,
  templateDir: string,
  patterns: string[],
): {
  localOnly: string[];
  templateOnly: string[];
  both: string[];
} {
  const localFiles = new Set(resolvePatterns(localDir, patterns));
  const templateFiles = new Set(resolvePatterns(templateDir, patterns));

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
