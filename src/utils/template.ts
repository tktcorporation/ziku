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
import { Effect } from "effect";
import type { Scope } from "effect";
import { match } from "ts-pattern";
import { TemplateError } from "../errors";
import type { FileOperationResult, OverwriteStrategy } from "../modules/schemas";
import { log } from "../ui/renderer";
import { loadMergedGitignore, separateByGitignore } from "./gitignore";
import type { FlatPatterns } from "./patterns";
import { resolvePatterns } from "./patterns";
import {
  registerTempDir,
  registerTempDirEffect,
  removeTempDirEffect,
  unregisterTempDir,
  unregisterTempDirEffect,
} from "./temp-tracker";

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
  Effect.runSync(
    Effect.try(() => {
      if (!existsSync(defaultCacheDir)) {
        mkdirSync(defaultCacheDir, { recursive: true });
      }
      accessSync(defaultCacheDir, constants.W_OK);
    }).pipe(
      // 書き込み不可の場合、OS の一時ディレクトリをフォールバックに設定
      Effect.orElse(() =>
        Effect.sync(() => {
          process.env.XDG_CACHE_HOME = resolve(tmpdir(), "giget-cache");
        }),
      ),
    ),
  );
}

// 後方互換性のためのエイリアス
export type CopyResult = FileOperationResult;

/**
 * ZikuConfig の source フィールドから giget 用のテンプレートソース文字列を構築する。
 *
 * 背景: giget は "gh:owner/repo" または "gh:owner/repo#ref" 形式を期待する。
 * .ziku/ziku.jsonc の source: { owner, repo, ref? } をこの形式に変換する。
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
/**
 * テンプレートを一時ディレクトリにダウンロードし、Scope 終了時 (成功/失敗/中断)
 * に削除する Effect。新規コードはこちらを使うこと。
 *
 * 設計:
 *   - 同期 tracker への register: process.exit() / SIGINT の最終防衛線
 *   - Effect.addFinalizer: Scope 終了時の構造的クリーンアップ保証
 *   - 両方を入れることで「型で cleanup を強制」+「同期 exit でも漏れない」
 *
 * 使い方:
 *   const program = Effect.gen(function* () {
 *     const dir = yield* acquireTempTemplate(targetDir, source);
 *     // dir を使う処理 (失敗・中断しても dir は自動削除される)
 *   });
 *   await Effect.runPromise(Effect.scoped(program));
 *
 * @param targetDir ベースディレクトリ (この配下に .ziku-temp[-label] を作る)
 * @param source giget 形式 ("gh:owner/repo[#ref]"). 未指定は TEMPLATE_SOURCE
 * @param label 同一 targetDir で複数同時取得する場合の識別子 (例: "base")
 */
export function acquireTempTemplate(
  targetDir: string,
  source?: string,
  label?: string,
): Effect.Effect<string, TemplateError, Scope.Scope> {
  return Effect.gen(function* () {
    const tempDir = join(targetDir, label ? `.ziku-temp-${label}` : ".ziku-temp");

    // 順序が重要: register → addFinalizer → download
    // download が失敗・中断しても、Scope クローズ時に finalizer が走って
    // unregister + rmSync されるため漏れない。
    yield* registerTempDirEffect(tempDir);
    yield* Effect.addFinalizer(() =>
      unregisterTempDirEffect(tempDir).pipe(Effect.zipRight(removeTempDirEffect(tempDir))),
    );

    yield* Effect.sync(ensureGigetCacheDir);

    const result = yield* Effect.tryPromise({
      try: () => downloadTemplate(source ?? TEMPLATE_SOURCE, { dir: tempDir, force: true }),
      catch: (e) => new TemplateError({ message: "Failed to download template", cause: e }),
    });

    return result.dir;
  });
}

export function downloadTemplateToTemp(
  targetDir: string,
  source?: string,
  label?: string,
): Promise<{ templateDir: string; cleanup: () => void }> {
  const tempDir = join(targetDir, label ? `.ziku-temp-${label}` : ".ziku-temp");

  // 中断時 (Ctrl+C / process.exit) でも削除されるよう、ダウンロード前に登録する。
  // 通常終了は cleanup() 経由で unregister + 削除する。
  registerTempDir(tempDir);
  ensureGigetCacheDir();

  // 失敗時の解放: downloadTemplate が reject すると返り値の cleanup が
  // 作られないため、tracker に古いエントリが残る (codex review #74)。
  // 後段で同名 .ziku-temp* が新規作成された場合に process exit で
  // 誤って削除されうるので、reject 経路でも unregister + rmSync する。
  // try/catch は ast-grep で禁止のため Promise.then(onFulfilled, onRejected) を使う。
  return downloadTemplate(source ?? TEMPLATE_SOURCE, { dir: tempDir, force: true }).then(
    ({ dir: templateDir }) => {
      const cleanup = () => {
        unregisterTempDir(tempDir);
        if (existsSync(tempDir)) {
          rmSync(tempDir, { recursive: true, force: true });
        }
      };
      return { templateDir, cleanup };
    },
    (error: unknown) => {
      unregisterTempDir(tempDir);
      if (existsSync(tempDir)) {
        rmSync(tempDir, { recursive: true, force: true });
      }
      throw error;
    },
  );
}

export interface DownloadOptions {
  targetDir: string;
  overwriteStrategy: OverwriteStrategy;
  patterns: FlatPatterns; // フラットな include/exclude パターン
  templateDir?: string; // 事前にダウンロードしたテンプレートディレクトリ
  dryRun?: boolean; // true の場合、ファイルへの書き込みを行わずプレビューのみ行う
}

export interface WriteFileOptions {
  destPath: string;
  content: string;
  strategy: OverwriteStrategy;
  relativePath: string;
  dryRun?: boolean; // true の場合、判定結果は返すがディスクへは書き込まない
}

/**
 * 上書き戦略に従ってファイルを書き込む。
 *
 * dryRun: true の場合、新規作成/上書き/スキップの判定は通常どおり行うが、fs への
 * 書き込みだけを省略する。判定ロジックを複製せず単一の経路で「実行結果」と
 * 「プレビュー結果」を一致させるための実装なので、判定分岐自体は変更しないこと。
 * ただし prompt 戦略は例外で、dryRun 中は confirm() を呼ばずに `p.confirm` の
 * `initialValue: false` と同じ既定値（上書きしない）を採用する。push の
 * dry-run（対話選択を行わず既定選択をそのまま使う）と同じ方針で、プレビューが
 * 対話入力をブロックしないようにするため。
 */
export async function writeFileWithStrategy(
  options: WriteFileOptions,
): Promise<FileOperationResult> {
  const { destPath, content, strategy, relativePath, dryRun = false } = options;
  const destExists = existsSync(destPath);

  // ファイルが存在しない場合は常に作成
  if (!destExists) {
    if (!dryRun) {
      const destDir = dirname(destPath);
      if (!existsSync(destDir)) {
        mkdirSync(destDir, { recursive: true });
      }
      writeFileSync(destPath, content);
    }
    return { action: "created", path: relativePath };
  }

  // 既存ファイルの処理 - ts-pattern で網羅的にマッチ
  return await match(strategy)
    .with("overwrite", () => {
      if (!dryRun) writeFileSync(destPath, content);
      return { action: "overwritten" as const, path: relativePath };
    })
    .with("skip", () => {
      return { action: "skipped" as const, path: relativePath };
    })
    .with("prompt", async () => {
      if (dryRun) {
        return { action: "skipped" as const, path: relativePath };
      }
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
export function fetchTemplates(options: DownloadOptions): Promise<FileOperationResult[]> {
  const {
    targetDir,
    overwriteStrategy,
    patterns,
    templateDir: preDownloadedDir,
    dryRun = false,
  } = options;
  // 事前ダウンロード済みか、新規ダウンロードか
  const shouldDownload = !preDownloadedDir;
  const tempDir = join(targetDir, ".ziku-temp");

  if (shouldDownload) {
    // 中断時 (Ctrl+C / process.exit) でも削除されるよう、ダウンロード前に登録する。
    registerTempDir(tempDir);
    ensureGigetCacheDir();
  }

  // 実体を IIFE で包み、Promise.finally で cleanup を保証する。
  // download / コピー処理いずれが失敗しても tracker から外して物理削除する
  // (codex review #74 — try/finally は ast-grep で禁止のため Promise.finally で対応)。
  const work = async (): Promise<FileOperationResult[]> => {
    const allResults: FileOperationResult[] = [];

    let templateDir: string;
    if (shouldDownload) {
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

    // tracked ファイルは通常通りコピー
    for (const relativePath of tracked) {
      const srcPath = join(templateDir, relativePath);
      const destPath = join(targetDir, relativePath);

      const result = await copyFile(srcPath, destPath, overwriteStrategy, relativePath, dryRun);
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
        const result: FileOperationResult = {
          action: "skipped_ignored",
          path: relativePath,
        };
        allResults.push(result);
      } else {
        const result = await copyFile(srcPath, destPath, overwriteStrategy, relativePath, dryRun);
        allResults.push(result);
      }
    }

    return allResults;
  };

  if (!shouldDownload) {
    return work();
  }

  return work().finally(() => {
    unregisterTempDir(tempDir);
    if (existsSync(tempDir)) {
      rmSync(tempDir, { recursive: true, force: true });
    }
  });
}

/**
 * 単一ファイルをコピー。
 *
 * dryRun: true では新規/上書き/スキップの判定は通常どおり行い、実際のコピー
 * （mkdirSync/copyFileSync）だけを省略する。writeFileWithStrategy と同じ理由で
 * 判定ロジックは複製しない。prompt 戦略の dryRun 時の扱いも同関数と同じ
 * （confirm() を呼ばず `initialValue: false` 相当の「上書きしない」を既定値にする）。
 */
export async function copyFile(
  srcPath: string,
  destPath: string,
  strategy: OverwriteStrategy,
  relativePath: string,
  dryRun = false,
): Promise<CopyResult> {
  const destExists = existsSync(destPath);

  if (!destExists) {
    // 新規ファイル: 常にコピー
    if (!dryRun) {
      const destDir = dirname(destPath);
      if (!existsSync(destDir)) {
        mkdirSync(destDir, { recursive: true });
      }
      copyFileSync(srcPath, destPath);
    }
    return { action: "copied", path: relativePath };
  }

  // 既存ファイルの処理
  switch (strategy) {
    case "overwrite":
      if (!dryRun) copyFileSync(srcPath, destPath);
      return { action: "overwritten", path: relativePath };

    case "skip":
      return { action: "skipped", path: relativePath };

    case "prompt": {
      if (dryRun) {
        return { action: "skipped", path: relativePath };
      }
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

    default: {
      // TypeScriptの型システムでexhaustiveなswitchだが、
      // consistent-returnルールのために明示的なデフォルトを追加
      const _exhaustive: never = strategy;
      throw new Error(`Unhandled strategy: ${String(_exhaustive)}`);
    }
  }
}
