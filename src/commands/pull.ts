import { readFile, rm } from "node:fs/promises";
import { defineCommand } from "citty";
import { Effect, Option } from "effect";
import { join, resolve } from "pathe";
import { withFinally } from "../effect-helpers";
import { ZikuError } from "../errors";
import type { LockState, TemplateSource } from "../modules/schemas";
import { selectDeletedFiles } from "../ui/prompts";
import { intro, log, outro, pc } from "../ui/renderer";
import { LOCK_FILE, loadLock, saveLock } from "../utils/lock";
import { ZIKU_CONFIG_FILE, withConfigTracked, zikuConfigExists } from "../utils/ziku-config";
import { loadCommandContext, runCommandEffect, toZikuError } from "../services/command-context";
import type { CommandLifecycle } from "../docs/lifecycle-types";
import { SYNCED_FILES } from "../docs/lifecycle-types";
import { hashFiles } from "../utils/hash";
import {
  classifyFiles,
  downloadBaseForMerge,
  hasConflictMarkers,
  mergeOneFile,
  readFileSafe,
  writeFileEnsureDir,
} from "../utils/merge";
import { mergeTemplatePatterns } from "../utils/template-patterns";

/**
 * pull コマンドのファイル操作メタデータ。
 * ドキュメント自動生成（npm run docs）の SSOT として使われる。
 */
export const pullLifecycle: CommandLifecycle = {
  name: "pull",
  description: "Pull latest template updates to local project",
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
      note: "他ファイルと同様に 3-way マージで同期（テンプレ更新の取り込み）",
    },
    {
      file: LOCK_FILE,
      location: "local",
      op: "update",
      note: "新しい baseHashes, baseRef で上書き",
    },
  ],
  notes: [
    "`ziku.jsonc` 自体が追跡ファイルとして 3-way マージされる。テンプレ側でパターンが追加/変更された場合、その差分がユーザーの `ziku.jsonc` へ取り込まれる（push と双方向に同期）。",
    "テンプレートで削除されたファイルは `--force` で自動削除、またはユーザーが選択的に削除できる。",
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
      const lockOption = await Effect.runPromise(
        Effect.tryPromise(() => loadLock(targetDir)).pipe(Effect.option),
      );
      if (Option.isNone(lockOption)) {
        throw new ZikuError("No .ziku/lock.json found", "Run `ziku init` first");
      }
      await runContinue(targetDir, lockOption.value);
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
      await cleanup();
      return;
    }

    await withFinally(async () => {
      // mergeTemplatePatterns は「テンプレ側で追加されたパターン配下のファイルも
      // 差分検出の対象に含める」ための include 和集合（discovery 用）を計算する。
      // ziku.jsonc 自体の内容同期は、下で ziku.jsonc を追跡ファイルとして
      // classify→3-way マージに乗せることで行う（加法的な上書きは廃止）。
      const { mergedInclude, mergedExclude, newInclude } = await mergeTemplatePatterns(
        templateDir,
        include,
        exclude,
      );

      // テンプレ側で追加された include パターンをユーザー向けに通知。
      // mergeTemplatePatterns 自体は副作用フリーなので、ログはここで行う。
      if (newInclude.length > 0) {
        log.info(`Template added ${newInclude.length} new pattern(s):`);
        for (const p of newInclude) {
          log.message(`  ${pc.green("+")} ${p}`);
        }
      }

      log.step("Analyzing changes...");

      // ziku.jsonc 自体を追跡対象に含め、他ファイルと同じ 3-way マージで同期する。
      const effectiveInclude = withConfigTracked(mergedInclude);
      const [templateHashes, localHashes] = await Promise.all([
        hashFiles(templateDir, effectiveInclude, mergedExclude),
        hashFiles(targetDir, effectiveInclude, mergedExclude),
      ]);
      const baseHashes = lock.baseHashes ?? {};

      const classification = classifyFiles({ baseHashes, localHashes, templateHashes });

      const totalChanges =
        classification.autoUpdate.length +
        classification.newFiles.length +
        classification.conflicts.length +
        classification.deletedFiles.length;

      // テンプレが新パターンを追加しただけのケースでも、ziku.jsonc 自体が
      // 追跡ファイルとして classification に含まれるため totalChanges に計上される
      // （ziku.jsonc が autoUpdate / conflict に分類される）。よって専用の
      // patternsUpdated 分岐は不要になった。
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
        const latestRefOption = await Effect.runPromise(resolveBaseRef);
        await saveLock(targetDir, {
          ...lock,
          pendingMerge: {
            conflicts: unresolvedConflicts,
            templateHashes,
            ...(Option.isSome(latestRefOption) ? { latestRef: latestRefOption.value } : {}),
          },
        });
        outro("Merge paused — resolve conflicts then run `ziku pull --continue`");
        return;
      }

      // 削除されたファイルを処理
      if (classification.deletedFiles.length > 0) {
        await handleDeletedFiles(classification.deletedFiles, targetDir, args.force as boolean);
      }

      // ziku.jsonc は上の classification で他ファイルと同様に同期済み
      // （autoUpdate: テンプレ内容で上書き / conflict: 3-way マージ）。
      // 旧来の generateZikuJsonc による加法的上書きは廃止した。

      const latestRefOption = await Effect.runPromise(resolveBaseRef);

      await saveLock(targetDir, {
        ...lock,
        baseHashes: templateHashes,
        ...(Option.isSome(latestRefOption) ? { baseRef: latestRefOption.value } : {}),
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
    await Effect.runPromise(writeFileEnsureDir(join(targetDir, file), content));
  }
}

/**
 * コンフリクトファイルを 3-way マージで解決する。
 * 未解決のコンフリクトパスを返す。
 *
 * ファイル読み込み・マージ・ベースダウンロードは conflict-io の共通ユーティリティを使い、
 * pull 固有の処理（ローカルへの書き込み・pendingMerge 連携）だけをここで行う。
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

  const baseResult = await Effect.runPromise(
    downloadBaseForMerge({
      source: ctx.source,
      baseRef: ctx.lock.baseRef,
      targetDir: ctx.targetDir,
    }),
  );

  await withFinally(
    async () => {
      for (const file of conflicts) {
        const result = await Effect.runPromise(
          mergeOneFile({
            file,
            targetDir: ctx.targetDir,
            templateDir: ctx.templateDir,
            baseTemplateDir: baseResult?.templateDir,
          }),
        );

        await Effect.runPromise(writeFileEnsureDir(join(ctx.targetDir, file), result.content));

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
    () => baseResult?.cleanup?.(),
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
    const contentOption = await Effect.runPromise(
      readFileSafe(join(targetDir, file)).pipe(Effect.option),
    );
    if (Option.isSome(contentOption) && hasConflictMarkers(contentOption.value).found) {
      stillConflicted.push(file);
    }
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
