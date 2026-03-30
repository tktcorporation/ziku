import { existsSync } from "node:fs";
import { mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { defineCommand } from "citty";
import { dirname, join, resolve } from "pathe";
import { BermError } from "../errors";
import { loadModulesFile, modulesFileExists } from "../modules";
import type { DevEnvConfig, TemplateModule } from "../modules/schemas";
import { selectDeletedFiles } from "../ui/prompts";
import { intro, log, outro, pc, withSpinner } from "../ui/renderer";
import { loadConfig, saveConfig } from "../utils/config";
import { resolveLatestCommitSha } from "../utils/github";
import { hashFiles } from "../utils/hash";
import {
  asBaseContent,
  asLocalContent,
  asTemplateContent,
  classifyFiles,
  hasConflictMarkers,
  threeWayMerge,
} from "../utils/merge";
import { downloadTemplateToTemp } from "../utils/template";
import { getEffectivePatterns } from "../utils/patterns";

/**
 * テンプレートの最新更新をローカルに反映するコマンド。
 *
 * 背景: init 後にテンプレートが更新された場合、ローカルの変更を保持しつつ
 * テンプレートの変更を取り込むために使用する。base/local/template の
 * 3-way マージにより、コンフリクトを最小限に抑える。
 *
 * 呼び出し元: CLI から `ziku pull` で実行
 */
export const pullCommand = defineCommand({
  meta: {
    name: "pull",
    description: "Pull latest template updates",
  },
  args: {
    dir: {
      type: "positional",
      description: "Project directory",
      default: ".",
    },
    force: {
      type: "boolean",
      alias: "f",
      description: "Skip confirmations",
      default: false,
    },
    continue: {
      type: "boolean",
      description: "Continue after resolving merge conflicts",
      default: false,
    },
  },
  async run({ args }) {
    intro("pull");

    const targetDir = resolve(args.dir);

    // Step 1: 設定読み込み
    let config;
    try {
      config = await loadConfig(targetDir);
    } catch {
      throw new BermError("Not initialized", "Run `ziku init` first");
    }

    // --continue モード: コンフリクト解決後の状態更新
    if (args.continue) {
      await runContinue(targetDir, config);
      return;
    }

    if (config.modules.length === 0) {
      log.warn("No modules installed");
      return;
    }

    // Step 2: テンプレートをダウンロード
    log.step("Fetching template...");

    const { templateDir, cleanup } = await withSpinner("Downloading template from GitHub...", () =>
      downloadTemplateToTemp(targetDir, `gh:${config.source.owner}/${config.source.repo}`),
    );

    try {
      // modules.jsonc を読み込み
      let moduleList: TemplateModule[];
      if (modulesFileExists(templateDir)) {
        const loaded = await loadModulesFile(templateDir);
        moduleList = loaded.modules;
      } else if (modulesFileExists(targetDir)) {
        const loaded = await loadModulesFile(targetDir);
        moduleList = loaded.modules;
      } else {
        throw new BermError(
          "No .devenv/modules.jsonc found",
          "Run `ziku init` to set up the project, or add .devenv/modules.jsonc to the template",
        );
      }

      // Step 3: ハッシュ計算
      log.step("Analyzing changes...");

      // インストール済みモジュールの有効パターンを取得
      const patterns = getInstalledModulePatterns(config.modules, moduleList, config);

      const [templateHashes, localHashes] = await Promise.all([
        hashFiles(templateDir, patterns),
        hashFiles(targetDir, patterns),
      ]);
      const baseHashes = config.baseHashes ?? {};

      // Step 4: ファイル分類
      const classification = classifyFiles({ baseHashes, localHashes, templateHashes });

      // Step 5: サマリー表示
      const totalChanges =
        classification.autoUpdate.length +
        classification.newFiles.length +
        classification.conflicts.length +
        classification.deletedFiles.length;

      if (totalChanges === 0) {
        log.success("Already up to date");
        outro("No changes needed");
        return;
      }

      logPullSummary(classification);

      // Step 6: 自動更新ファイルを適用
      for (const file of classification.autoUpdate) {
        const content = await readFile(join(templateDir, file), "utf-8");
        const destPath = join(targetDir, file);
        const destDir = dirname(destPath);
        if (!existsSync(destDir)) {
          await mkdir(destDir, { recursive: true });
        }
        await writeFile(destPath, content, "utf-8");
      }
      if (classification.autoUpdate.length > 0) {
        log.success(`Updated ${classification.autoUpdate.length} file(s)`);
      }

      // Step 7: 新規ファイルを追加
      for (const file of classification.newFiles) {
        const content = await readFile(join(templateDir, file), "utf-8");
        const destPath = join(targetDir, file);
        const destDir = dirname(destPath);
        if (!existsSync(destDir)) {
          await mkdir(destDir, { recursive: true });
        }
        await writeFile(destPath, content, "utf-8");
      }
      if (classification.newFiles.length > 0) {
        log.success(`Added ${classification.newFiles.length} new file(s)`);
      }

      // Step 8: コンフリクト解決
      const unresolvedConflicts: string[] = [];
      if (classification.conflicts.length > 0) {
        // baseRef が存在する場合、ベースバージョンを再ダウンロードして 3-way マージ
        let baseTemplateDir: string | undefined;
        let baseCleanup: (() => void) | undefined;

        if (config.baseRef) {
          try {
            log.info(`Downloading base version (${config.baseRef.slice(0, 7)}...) for merge...`);
            const baseSource = `gh:${config.source.owner}/${config.source.repo}#${config.baseRef}`;
            const baseResult = await downloadTemplateToTemp(targetDir, baseSource, "base");
            baseTemplateDir = baseResult.templateDir;
            baseCleanup = baseResult.cleanup;
          } catch {
            log.warn("Could not download base version. Falling back to 2-way conflict markers.");
          }
        }

        try {
          for (const file of classification.conflicts) {
            const localContent = await readFile(join(targetDir, file), "utf-8");
            const templateContent = await readFile(join(templateDir, file), "utf-8");

            // base がない場合は "" をデフォルトとして使う（共通祖先が空 = 新規追加のマージ相当）
            let baseContent = "";
            if (baseTemplateDir && existsSync(join(baseTemplateDir, file))) {
              baseContent = await readFile(join(baseTemplateDir, file), "utf-8");
            }

            const result = threeWayMerge({
              base: asBaseContent(baseContent),
              local: asLocalContent(localContent),
              template: asTemplateContent(templateContent),
              filePath: file,
            });
            await writeFile(join(targetDir, file), result.content, "utf-8");
            if (result.hasConflicts) {
              unresolvedConflicts.push(file);
              logMergeConflict(file);
            } else {
              log.success(`Auto-merged: ${pc.cyan(file)}`);
            }
          }

          if (unresolvedConflicts.length > 0) {
            log.warn("Some files have conflicts. Resolve them, then run `ziku pull --continue`");
          }
        } finally {
          baseCleanup?.();
        }

        if (unresolvedConflicts.length > 0) {
          // pendingMerge を保存して中断。baseHashes/baseRef は --continue 後に更新する。
          // 自動マージ成功したファイルは含めず、未解決ファイルのみ記録する。
          const latestRef = await resolveLatestCommitSha(config.source.owner, config.source.repo);
          await saveConfig(targetDir, {
            ...config,
            pendingMerge: {
              conflicts: unresolvedConflicts,
              templateHashes: templateHashes,
              ...(latestRef ? { latestRef } : {}),
            },
          });
          outro("Merge paused — resolve conflicts then run `ziku pull --continue`");
          return;
        }
      }

      // Step 9: 削除されたファイルを処理
      if (classification.deletedFiles.length > 0) {
        let filesToDelete: string[];

        if (args.force) {
          // --force: 確認なしで全削除
          filesToDelete = classification.deletedFiles;
          log.info(`Deleting ${filesToDelete.length} file(s) removed from template...`);
        } else {
          // 通常: ユーザーに選択させる
          filesToDelete = await selectDeletedFiles(classification.deletedFiles);
        }

        for (const file of filesToDelete) {
          try {
            await rm(join(targetDir, file), { force: true });
            log.success(`Deleted: ${file}`);
          } catch {
            log.warn(`Could not delete: ${file}`);
          }
        }
      }

      // Step 10: 設定を更新（baseRef + baseHashes）
      const latestRef = await resolveLatestCommitSha(config.source.owner, config.source.repo);

      const updatedConfig = {
        ...config,
        baseHashes: templateHashes,
        ...(latestRef ? { baseRef: latestRef } : {}),
      };
      await saveConfig(targetDir, updatedConfig);

      outro("Pull complete");
    } finally {
      cleanup();
    }
  },
});

/**
 * `--continue` モードの処理: コンフリクト解決後に baseHashes/baseRef を更新する。
 *
 * 背景: `ziku pull` でコンフリクトが発生した際、ユーザーが手動解決した後に
 * `ziku pull --continue` を実行することで状態更新が完了する。
 * git の `git merge --continue` / `git rebase --continue` パターンを踏襲。
 *
 * 対になる操作: pull.ts の pendingMerge 保存ロジック（コンフリクト発生時）
 */
async function runContinue(targetDir: string, config: DevEnvConfig): Promise<void> {
  if (!config.pendingMerge) {
    throw new BermError("No pending merge found", "Run `ziku pull` first to start a merge");
  }

  const { conflicts, templateHashes, latestRef } = config.pendingMerge;

  // コンフリクトマーカーが残っていないか確認
  const stillConflicted: string[] = [];
  for (const file of conflicts) {
    try {
      const content = await readFile(join(targetDir, file), "utf-8");
      if (hasConflictMarkers(content).found) {
        stillConflicted.push(file);
      }
    } catch {
      // ファイルが存在しない場合は解決済みとみなす（削除により解決）
    }
  }

  if (stillConflicted.length > 0) {
    for (const file of stillConflicted) {
      log.warn(`Still has conflict markers: ${pc.cyan(file)}`);
    }
    throw new BermError(
      "Unresolved conflicts remain",
      "Resolve all conflict markers then run `ziku pull --continue` again",
    );
  }

  // 全て解決済み: baseHashes/baseRef を更新して pendingMerge を削除
  const updatedConfig = {
    ...config,
    baseHashes: templateHashes,
    ...(latestRef ? { baseRef: latestRef } : {}),
    pendingMerge: undefined,
  };
  await saveConfig(targetDir, updatedConfig);

  log.success("All conflicts resolved");
  outro("Pull complete");
}

/**
 * 1ファイルのマージコンフリクトをユーザーに報告する。
 *
 * 背景: threeWayMerge は hasConflicts: true を返す場合、必ずファイル内に
 * コンフリクトマーカー（<<<<<<< LOCAL / ======= / >>>>>>> TEMPLATE）を挿入する。
 * ユーザーはマーカーを手動で解決し、`ziku pull --continue` で完了する。
 */
function logMergeConflict(file: string): void {
  log.warn(`Conflict in ${pc.cyan(file)} — manual resolution needed`);
}

/**
 * インストール済みモジュールの有効パターンを全て取得する。
 *
 * 背景: pull 時にハッシュ計算対象のファイルを特定するため、
 * 各モジュールの patterns に excludePatterns を適用した結果を集約する。
 */
function getInstalledModulePatterns(
  moduleIds: string[],
  moduleList: TemplateModule[],
  config: DevEnvConfig,
): string[] {
  const patterns: string[] = [];
  for (const moduleId of moduleIds) {
    const mod = moduleList.find((m) => m.id === moduleId);
    if (!mod) continue;
    patterns.push(...getEffectivePatterns(moduleId, mod.patterns, config));
  }
  return patterns;
}

/**
 * pull のサマリーを表示する。
 *
 * 背景: ユーザーが pull の影響範囲を把握できるよう、
 * 分類結果を色分けして一覧表示する。diff.ts の表示スタイルに合わせる。
 */
function logPullSummary(classification: {
  autoUpdate: string[];
  newFiles: string[];
  conflicts: string[];
  deletedFiles: string[];
  localOnly: string[];
  unchanged: string[];
}): void {
  const lines: string[] = [];

  for (const file of classification.autoUpdate) {
    lines.push(`${pc.cyan("↓")} ${pc.cyan(file)}`);
  }
  for (const file of classification.newFiles) {
    lines.push(`${pc.green("+")} ${pc.green(file)}`);
  }
  for (const file of classification.conflicts) {
    lines.push(`${pc.yellow("!")} ${pc.yellow(file)}`);
  }
  for (const file of classification.deletedFiles) {
    lines.push(`${pc.red("-")} ${pc.red(file)}`);
  }

  const summaryParts = [
    classification.autoUpdate.length > 0
      ? pc.cyan(`↓${classification.autoUpdate.length} updated`)
      : null,
    classification.newFiles.length > 0 ? pc.green(`+${classification.newFiles.length} new`) : null,
    classification.conflicts.length > 0
      ? pc.yellow(`!${classification.conflicts.length} conflicts`)
      : null,
    classification.deletedFiles.length > 0
      ? pc.red(`-${classification.deletedFiles.length} deleted`)
      : null,
  ]
    .filter(Boolean)
    .join(pc.dim(" | "));

  log.message([...lines, "", summaryParts].join("\n"));
}
