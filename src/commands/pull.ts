import { existsSync } from "node:fs";
import { mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { defineCommand } from "citty";
import { Effect } from "effect";
import { dirname, join, resolve } from "pathe";
import { withFinally } from "../effect-helpers";
import { ZikuError } from "../errors";
import type { LockState } from "../modules/schemas";
import { selectDeletedFiles } from "../ui/prompts";
import { intro, log, outro, pc, withSpinner } from "../ui/renderer";
import { loadLock, saveLock } from "../utils/lock";
import { loadZikuConfig, zikuConfigExists } from "../utils/ziku-config";
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

/**
 * テンプレートの最新更新をローカルに反映するコマンド。
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

    // Step 1: 設定読み込み（失敗時は ZikuError に変換して throw）
    if (!zikuConfigExists(targetDir)) {
      throw new ZikuError("Not initialized", "Run `ziku init` first");
    }

    const { config: zikuConfig } = await loadZikuConfig(targetDir);
    const lock = await Effect.runPromise(
      Effect.tryPromise(() => loadLock(targetDir)).pipe(Effect.orElseSucceed(() => null)),
    );
    if (!lock) {
      throw new ZikuError("No .ziku/lock.json found", "Run `ziku init` first");
    }

    // --continue モード
    if (args.continue) {
      await runContinue(targetDir, lock);
      return;
    }

    const { include, exclude } = {
      include: zikuConfig.include,
      exclude: zikuConfig.exclude ?? [],
    };

    if (include.length === 0) {
      log.warn("No patterns configured");
      return;
    }

    // Step 2: テンプレートをダウンロード
    log.step("Fetching template...");

    const { templateDir, cleanup } = await withSpinner("Downloading template from GitHub...", () =>
      downloadTemplateToTemp(targetDir, `gh:${zikuConfig.source.owner}/${zikuConfig.source.repo}`),
    );

    await withFinally(async () => {
      // Step 3: ハッシュ計算
      log.step("Analyzing changes...");

      const [templateHashes, localHashes] = await Promise.all([
        hashFiles(templateDir, include, exclude),
        hashFiles(targetDir, include, exclude),
      ]);
      const baseHashes = lock.baseHashes ?? {};

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
        let baseTemplateDir: string | undefined;
        let baseCleanup: (() => void) | undefined;

        // ベースバージョンのダウンロード（失敗時は 2-way フォールバック）
        if (lock.baseRef) {
          const baseResult = await Effect.runPromise(
            Effect.tryPromise(async () => {
              log.info(`Downloading base version (${lock.baseRef!.slice(0, 7)}...) for merge...`);
              const baseSource = `gh:${zikuConfig.source.owner}/${zikuConfig.source.repo}#${lock.baseRef}`;
              return downloadTemplateToTemp(targetDir, baseSource, "base");
            }).pipe(
              Effect.orElseSucceed(() => {
                log.warn(
                  "Could not download base version. Falling back to 2-way conflict markers.",
                );
                return null;
              }),
            ),
          );
          if (baseResult) {
            baseTemplateDir = baseResult.templateDir;
            baseCleanup = baseResult.cleanup;
          }
        }

        await withFinally(
          async () => {
            for (const file of classification.conflicts) {
              const localContent = await readFile(join(targetDir, file), "utf-8");
              const templateContent = await readFile(join(templateDir, file), "utf-8");

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
          },
          () => baseCleanup?.(),
        );

        if (unresolvedConflicts.length > 0) {
          const latestRef = await resolveLatestCommitSha(
            zikuConfig.source.owner,
            zikuConfig.source.repo,
          );
          await saveLock(targetDir, {
            ...lock,
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
          filesToDelete = classification.deletedFiles;
          log.info(`Deleting ${filesToDelete.length} file(s) removed from template...`);
        } else {
          filesToDelete = await selectDeletedFiles(classification.deletedFiles);
        }

        for (const file of filesToDelete) {
          // ベストエフォート削除（失敗時は警告のみ）
          await Effect.runPromise(
            Effect.tryPromise(async () => {
              await rm(join(targetDir, file), { force: true });
              log.success(`Deleted: ${file}`);
            }).pipe(
              Effect.orElseSucceed(() => {
                log.warn(`Could not delete: ${file}`);
              }),
            ),
          );
        }
      }

      // Step 10: 設定を更新
      const latestRef = await resolveLatestCommitSha(
        zikuConfig.source.owner,
        zikuConfig.source.repo,
      );

      const updatedLock = {
        ...lock,
        baseHashes: templateHashes,
        ...(latestRef ? { baseRef: latestRef } : {}),
      };
      await saveLock(targetDir, updatedLock);

      outro("Pull complete");
    }, cleanup);
  },
});

async function runContinue(targetDir: string, lock: LockState): Promise<void> {
  if (!lock.pendingMerge) {
    throw new ZikuError("No pending merge found", "Run `ziku pull` first to start a merge");
  }

  const { conflicts, templateHashes, latestRef } = lock.pendingMerge;

  const stillConflicted: string[] = [];
  for (const file of conflicts) {
    // ファイルが存在しない場合は解決済みとみなす
    await Effect.runPromise(
      Effect.tryPromise(async () => {
        const content = await readFile(join(targetDir, file), "utf-8");
        if (hasConflictMarkers(content).found) {
          stillConflicted.push(file);
        }
      }).pipe(Effect.orElseSucceed(() => {})),
    );
  }

  if (stillConflicted.length > 0) {
    for (const file of stillConflicted) {
      log.warn(`Still has conflict markers: ${pc.cyan(file)}`);
    }
    throw new ZikuError(
      "Unresolved conflicts remain",
      "Resolve all conflict markers then run `ziku pull --continue` again",
    );
  }

  const updatedLock = {
    ...lock,
    baseHashes: templateHashes,
    ...(latestRef ? { baseRef: latestRef } : {}),
    pendingMerge: undefined,
  };
  await saveLock(targetDir, updatedLock);

  log.success("All conflicts resolved");
  outro("Pull complete");
}

function logMergeConflict(file: string): void {
  log.warn(`Conflict in ${pc.cyan(file)} — manual resolution needed`);
}

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
