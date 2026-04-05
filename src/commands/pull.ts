import { existsSync } from "node:fs";
import { mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { defineCommand } from "citty";
import { Effect } from "effect";
import { dirname, join, resolve } from "pathe";
import { match, P } from "ts-pattern";
import { withFinally } from "../effect-helpers";
import { ZikuError } from "../errors";
import type { LockState, TemplateSource } from "../modules/schemas";
import { selectDeletedFiles } from "../ui/prompts";
import { intro, log, outro, pc } from "../ui/renderer";
import { LOCK_FILE, loadLock, saveLock } from "../utils/lock";
import {
  ZIKU_CONFIG_FILE,
  saveZikuConfig,
  generateZikuJsonc,
  zikuConfigExists,
} from "../utils/ziku-config";
import { loadCommandContext, runCommandEffect, toZikuError } from "../services/command-context";
import { loadTemplateConfig } from "../utils/template-config";
import type { CommandLifecycle } from "../docs/lifecycle-types";
import { SYNCED_FILES } from "../docs/lifecycle-types";
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
 * pull コマンドのファイル操作メタデータ。
 * ドキュメント自動生成（npm run docs）の SSOT として使われる。
 */
export const pullLifecycle: CommandLifecycle = {
  name: "pull",
  description: "テンプレートの最新更新をローカルに反映",
  ops: [
    { file: ZIKU_CONFIG_FILE, location: "local", op: "read", note: "patterns を取得" },
    { file: LOCK_FILE, location: "local", op: "read", note: "source, baseHashes, baseRef を取得" },
    {
      file: SYNCED_FILES,
      location: "template",
      op: "read",
      note: "テンプレートをダウンロードして差分比較",
    },
    {
      file: SYNCED_FILES,
      location: "local",
      op: "update",
      note: "自動更新・新規追加・3-way マージ・削除",
    },
    {
      file: ZIKU_CONFIG_FILE,
      location: "local",
      op: "update",
      note: "テンプレートの新パターンをマージ",
    },
    {
      file: LOCK_FILE,
      location: "local",
      op: "update",
      note: "新しい baseHashes, baseRef で上書き",
    },
  ],
};

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

    // --continue モードは lock.json のみ必要（テンプレート不要）
    if (args.continue) {
      if (!zikuConfigExists(targetDir)) {
        throw new ZikuError("Not initialized", "Run `ziku init` first");
      }
      const lock = await Effect.runPromise(
        Effect.tryPromise(() => loadLock(targetDir)).pipe(Effect.orElseSucceed(() => null)),
      );
      if (!lock) {
        throw new ZikuError("No .ziku/lock.json found", "Run `ziku init` first");
      }
      await runContinue(targetDir, lock);
      return;
    }

    // loadCommandContext + runCommandEffect で DRY 化
    const ctx = await runCommandEffect(
      loadCommandContext(targetDir).pipe(Effect.mapError(toZikuError)),
    );

    const { config, lock, source, templateDir, cleanup, resolveBaseRef } = ctx;

    log.info(`Template: ${pc.cyan(templateDir)}${"path" in source ? " (local)" : ""}`);

    const include = config.include;
    const exclude = config.exclude ?? [];

    if (include.length === 0) {
      log.warn("No patterns configured");
      cleanup();
      return;
    }

    await withFinally(async () => {
      // テンプレートの ziku.jsonc から新パターンをマージ
      const templateConfig = await Effect.runPromise(
        loadTemplateConfig(templateDir).pipe(Effect.orElseSucceed(() => null)),
      );

      let mergedInclude = include;
      let mergedExclude = exclude;
      let patternsUpdated = false;

      if (templateConfig) {
        const newInclude = templateConfig.include.filter((p) => !include.includes(p));
        const newExclude = (templateConfig.exclude ?? []).filter((p) => !exclude.includes(p));

        if (newInclude.length > 0 || newExclude.length > 0) {
          mergedInclude = [...include, ...newInclude];
          mergedExclude = [...exclude, ...newExclude];
          patternsUpdated = true;

          if (newInclude.length > 0) {
            log.info(`Template added ${newInclude.length} new pattern(s):`);
            for (const p of newInclude) {
              log.message(`  ${pc.green("+")} ${p}`);
            }
          }
        }
      }

      log.step("Analyzing changes...");

      const [templateHashes, localHashes] = await Promise.all([
        hashFiles(templateDir, mergedInclude, mergedExclude),
        hashFiles(targetDir, mergedInclude, mergedExclude),
      ]);
      const baseHashes = lock.baseHashes ?? {};

      const classification = classifyFiles({ baseHashes, localHashes, templateHashes });

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

      // 自動更新ファイルを適用
      await applyFiles(classification.autoUpdate, templateDir, targetDir);
      if (classification.autoUpdate.length > 0) {
        log.success(`Updated ${classification.autoUpdate.length} file(s)`);
      }

      // 新規ファイルを追加
      await applyFiles(classification.newFiles, templateDir, targetDir);
      if (classification.newFiles.length > 0) {
        log.success(`Added ${classification.newFiles.length} new file(s)`);
      }

      // コンフリクト解決
      const unresolvedConflicts = await resolveConflicts(classification.conflicts, {
        targetDir,
        templateDir,
        source,
        lock,
      });

      if (unresolvedConflicts.length > 0) {
        // resolveBaseRef で isGitHubSource 分岐を吸収
        const latestRef = await Effect.runPromise(resolveBaseRef);
        await saveLock(targetDir, {
          ...lock,
          pendingMerge: {
            conflicts: unresolvedConflicts,
            templateHashes,
            ...(latestRef ? { latestRef } : {}),
          },
        });
        outro("Merge paused — resolve conflicts then run `ziku pull --continue`");
        return;
      }

      // 削除されたファイルを処理
      if (classification.deletedFiles.length > 0) {
        await handleDeletedFiles(classification.deletedFiles, targetDir, args.force as boolean);
      }

      // パターンが更新された場合、ユーザーの ziku.jsonc を上書き
      if (patternsUpdated) {
        const updatedContent = generateZikuJsonc({
          include: mergedInclude,
          exclude: mergedExclude,
        });
        await saveZikuConfig(targetDir, updatedContent);
        log.success(`Updated ${ZIKU_CONFIG_FILE} with new patterns from template`);
      }

      // resolveBaseRef で isGitHubSource 分岐を吸収
      const latestRef = await Effect.runPromise(resolveBaseRef);

      await saveLock(targetDir, {
        ...lock,
        baseHashes: templateHashes,
        ...(latestRef ? { baseRef: latestRef } : {}),
      });

      outro("Pull complete");
    }, cleanup);
  },
});

// ─── ヘルパー関数 ───

/**
 * テンプレートからファイルをコピーする共通処理。
 * autoUpdate と newFiles で同じロジックを使う（DRY）。
 */
async function applyFiles(files: string[], templateDir: string, targetDir: string): Promise<void> {
  for (const file of files) {
    const content = await readFile(join(templateDir, file), "utf-8");
    const destPath = join(targetDir, file);
    const destDir = dirname(destPath);
    if (!existsSync(destDir)) {
      await mkdir(destDir, { recursive: true });
    }
    await writeFile(destPath, content, "utf-8");
  }
}

/**
 * コンフリクトファイルを 3-way マージで解決する。
 * 未解決のコンフリクトパスを返す。
 */
async function resolveConflicts(
  conflicts: string[],
  ctx: {
    targetDir: string;
    templateDir: string;
    source: TemplateSource;
    lock: LockState;
  },
): Promise<string[]> {
  if (conflicts.length === 0) return [];

  const unresolvedConflicts: string[] = [];
  let baseTemplateDir: string | undefined;
  let baseCleanup: (() => void) | undefined;

  // ts-pattern でソース種別に応じたベースダウンロードを分岐
  if (ctx.lock.baseRef) {
    const downloadResult = await match(ctx.source)
      .with({ owner: P.string, repo: P.string }, (ghSource) => {
        return Effect.runPromise(
          Effect.tryPromise(() => {
            log.info(`Downloading base version (${ctx.lock.baseRef?.slice(0, 7)}...) for merge...`);
            return downloadTemplateToTemp(
              ctx.targetDir,
              `gh:${ghSource.owner}/${ghSource.repo}#${ctx.lock.baseRef}`,
              "base",
            );
          }).pipe(
            Effect.orElseSucceed(() => {
              log.warn("Could not download base version. Falling back to 2-way conflict markers.");
              return null;
            }),
          ),
        );
      })
      .with({ path: P.string }, () => Promise.resolve(null))
      .exhaustive();

    if (downloadResult) {
      baseTemplateDir = downloadResult.templateDir;
      baseCleanup = downloadResult.cleanup;
    }
  }

  await withFinally(
    async () => {
      for (const file of conflicts) {
        const localContent = await readFile(join(ctx.targetDir, file), "utf-8");
        const templateContent = await readFile(join(ctx.templateDir, file), "utf-8");

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
        await writeFile(join(ctx.targetDir, file), result.content, "utf-8");
        if (result.hasConflicts) {
          unresolvedConflicts.push(file);
          log.warn(`Conflict in ${pc.cyan(file)} — manual resolution needed`);
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

  return unresolvedConflicts;
}

/**
 * テンプレートで削除されたファイルを処理する。
 */
async function handleDeletedFiles(
  deletedFiles: string[],
  targetDir: string,
  force: boolean,
): Promise<void> {
  const filesToDelete = force
    ? (log.info(`Deleting ${deletedFiles.length} file(s) removed from template...`), deletedFiles)
    : await selectDeletedFiles(deletedFiles);

  for (const file of filesToDelete) {
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

async function runContinue(targetDir: string, lock: LockState): Promise<void> {
  if (!lock.pendingMerge) {
    throw new ZikuError("No pending merge found", "Run `ziku pull` first to start a merge");
  }

  const { conflicts, templateHashes, latestRef } = lock.pendingMerge;

  const stillConflicted: string[] = [];
  for (const file of conflicts) {
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

  await saveLock(targetDir, {
    ...lock,
    baseHashes: templateHashes,
    ...(latestRef ? { baseRef: latestRef } : {}),
    pendingMerge: undefined,
  });

  log.success("All conflicts resolved");
  outro("Pull complete");
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
