import {
  accessSync,
  constants,
  copyFileSync,
  existsSync,
  mkdirSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { homedir, tmpdir } from "node:os";
import * as p from "@clack/prompts";
import { downloadTemplate } from "giget";
import { dirname, join, resolve } from "pathe";
import { match } from "ts-pattern";
import type { FileOperationResult, OverwriteStrategy } from "../modules/schemas";
import { log } from "../ui/renderer";
import { loadMergedGitignore, separateByGitignore } from "./gitignore";
import type { FlatPatterns } from "./patterns";
import { resolvePatterns } from "./patterns";

export const TEMPLATE_SOURCE = "gh:tktcorporation/.github";

/**
 * giget のキャッシュディレクトリが書き込み可能か確認し、不可能なら XDG_CACHE_HOME を
 * 書き込み可能な一時ディレクトリにフォールバックさせる。
 *
 * 背景: giget は内部で homedir()/.cache/giget にキャッシュを作成するが、
 * Codespaces 等の環境で homedir のキャッシュディレクトリに書き込み権限がない場合に
 * EACCES エラーが発生する。XDG_CACHE_HOME が設定済みなら giget はそちらを使うため、
 * フォールバック先として tmpdir を設定する。
 *
 * 呼び出し元: downloadTemplateToTemp(), fetchTemplates()
 * giget が XDG_CACHE_HOME 対応をやめれば不要になる。
 */
function ensureGigetCacheDir(): void {
  // XDG_CACHE_HOME が既に設定済みなら giget はそちらを使うため介入不要
  if (process.env.XDG_CACHE_HOME) {
    return;
  }
  const defaultCacheDir = resolve(homedir(), ".cache");
  try {
    // .cache ディレクトリが存在しなければ作成を試みる
    if (!existsSync(defaultCacheDir)) {
      mkdirSync(defaultCacheDir, { recursive: true });
    }
    accessSync(defaultCacheDir, constants.W_OK);
  } catch {
    // 書き込み不可の場合、OS の一時ディレクトリをフォールバックに設定
    process.env.XDG_CACHE_HOME = resolve(tmpdir(), "giget-cache");
  }
}

// 後方互換性のためのエイリアス
export type CopyResult = FileOperationResult;

/**
 * DevEnvConfig の source フィールドから giget 用のテンプレートソース文字列を構築する。
 *
 * 背景: giget は "gh:owner/repo" または "gh:owner/repo#ref" 形式を期待する。
 * .ziku.json の source: { owner, repo, ref? } をこの形式に変換する。
 */
export function buildTemplateSource(source: { owner: string; repo: string; ref?: string }): string {
  const base = `gh:${source.owner}/${source.repo}`;
  return source.ref ? `${base}#${source.ref}` : base;
}

/**
 * テンプレートをダウンロードして一時ディレクトリのパスを返す。
 *
 * @param targetDir - テンプレートを展開するベースディレクトリ
 * @param source - giget 形式のテンプレートソース (例: "gh:owner/repo")。
 *                 未指定時はデフォルトの TEMPLATE_SOURCE を使用。
 * @param label - 一時ディレクトリを区別するためのラベル。
 *                同一 targetDir で複数回ダウンロードする場合（pull の template と base）、
 *                ラベルを変えないと後のダウンロードが先のディレクトリを上書きする。
 */
export async function downloadTemplateToTemp(
  targetDir: string,
  source?: string,
  label?: string,
): Promise<{ templateDir: string; cleanup: () => void }> {
  const tempDir = join(targetDir, label ? `.ziku-temp-${label}` : ".ziku-temp");

  ensureGigetCacheDir();
  const { dir: templateDir } = await downloadTemplate(source ?? TEMPLATE_SOURCE, {
    dir: tempDir,
    force: true,
  });

  const cleanup = () => {
    if (existsSync(tempDir)) {
      rmSync(tempDir, { recursive: true, force: true });
    }
  };

  return { templateDir, cleanup };
}

export interface DownloadOptions {
  targetDir: string;
  overwriteStrategy: OverwriteStrategy;
  patterns: FlatPatterns; // フラットな include/exclude パターン
  templateDir?: string; // 事前にダウンロードしたテンプレートディレクトリ
}

export interface WriteFileOptions {
  destPath: string;
  content: string;
  strategy: OverwriteStrategy;
  relativePath: string;
}

/**
 * 上書き戦略に従ってファイルを書き込む
 */
export async function writeFileWithStrategy(
  options: WriteFileOptions,
): Promise<FileOperationResult> {
  const { destPath, content, strategy, relativePath } = options;
  const destExists = existsSync(destPath);

  // ファイルが存在しない場合は常に作成
  if (!destExists) {
    const destDir = dirname(destPath);
    if (!existsSync(destDir)) {
      mkdirSync(destDir, { recursive: true });
    }
    writeFileSync(destPath, content);
    return { action: "created", path: relativePath };
  }

  // 既存ファイルの処理 - ts-pattern で網羅的にマッチ
  return match(strategy)
    .with("overwrite", () => {
      writeFileSync(destPath, content);
      return { action: "overwritten" as const, path: relativePath };
    })
    .with("skip", () => {
      return { action: "skipped" as const, path: relativePath };
    })
    .with("prompt", async () => {
      const shouldOverwrite = await p.confirm({
        message: `${relativePath} already exists. Overwrite?`,
        initialValue: false,
      });
      if (p.isCancel(shouldOverwrite) || !shouldOverwrite) {
        return { action: "skipped" as const, path: relativePath };
      }
      writeFileSync(destPath, content);
      return { action: "overwritten" as const, path: relativePath };
    })
    .exhaustive();
}

/**
 * テンプレートを取得してパターンベースでコピー
 */
export async function fetchTemplates(options: DownloadOptions): Promise<FileOperationResult[]> {
  const { targetDir, overwriteStrategy, patterns, templateDir: preDownloadedDir } = options;
  const allResults: FileOperationResult[] = [];

  // 事前ダウンロード済みか、新規ダウンロードか
  const shouldDownload = !preDownloadedDir;
  const tempDir = join(targetDir, ".ziku-temp");

  let templateDir: string;

  try {
    if (shouldDownload) {
      ensureGigetCacheDir();
      const result = await downloadTemplate(TEMPLATE_SOURCE, {
        dir: tempDir,
        force: true,
      });
      templateDir = result.dir;
    } else {
      templateDir = preDownloadedDir;
    }

    // ローカルとテンプレート両方の .gitignore をマージして読み込み
    const gitignore = await loadMergedGitignore([targetDir, templateDir]);

    // フラットパターンでファイルを解決
    const resolvedFiles = resolvePatterns(templateDir, patterns.include, patterns.exclude);
    const { tracked, ignored } = separateByGitignore(resolvedFiles, gitignore);

    if (tracked.length === 0 && ignored.length === 0) {
      log.warn("No files matched for selected modules");
    }

    {
      // tracked ファイルは通常通りコピー
      for (const relativePath of tracked) {
        const srcPath = join(templateDir, relativePath);
        const destPath = join(targetDir, relativePath);

        const result = await copyFile(srcPath, destPath, overwriteStrategy, relativePath);
        allResults.push(result);
      }

      // ignored ファイルは特別処理:
      // - ローカルに存在しない場合 → コピー
      // - ローカルに存在する場合 → スキップ（上書き防止）
      for (const relativePath of ignored) {
        const srcPath = join(templateDir, relativePath);
        const destPath = join(targetDir, relativePath);
        const destExists = existsSync(destPath);

        if (destExists) {
          // ローカルに既存 → スキップして警告
          const result: FileOperationResult = {
            action: "skipped_ignored",
            path: relativePath,
          };
          allResults.push(result);
        } else {
          // ローカルにない → 通常通りコピー
          const result = await copyFile(srcPath, destPath, overwriteStrategy, relativePath);
          allResults.push(result);
        }
      }
    }
  } finally {
    // 新規ダウンロードした場合のみ一時ディレクトリを削除
    if (shouldDownload && existsSync(tempDir)) {
      rmSync(tempDir, { recursive: true, force: true });
    }
  }

  return allResults;
}

/**
 * 単一ファイルをコピー
 */
export async function copyFile(
  srcPath: string,
  destPath: string,
  strategy: OverwriteStrategy,
  relativePath: string,
): Promise<CopyResult> {
  const destExists = existsSync(destPath);

  if (!destExists) {
    // 新規ファイル: 常にコピー
    const destDir = dirname(destPath);
    if (!existsSync(destDir)) {
      mkdirSync(destDir, { recursive: true });
    }
    copyFileSync(srcPath, destPath);
    return { action: "copied", path: relativePath };
  }

  // 既存ファイルの処理
  switch (strategy) {
    case "overwrite":
      copyFileSync(srcPath, destPath);
      return { action: "overwritten", path: relativePath };

    case "skip":
      return { action: "skipped", path: relativePath };

    case "prompt": {
      const shouldOverwrite = await p.confirm({
        message: `${relativePath} already exists. Overwrite?`,
        initialValue: false,
      });
      if (p.isCancel(shouldOverwrite) || !shouldOverwrite) {
        return { action: "skipped", path: relativePath };
      }
      copyFileSync(srcPath, destPath);
      return { action: "overwritten", path: relativePath };
    }
  }
}
