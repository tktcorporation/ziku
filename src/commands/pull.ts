import { readFile, rm } from "node:fs/promises";
import { defineCommand } from "citty";
import { Effect, Option } from "effect";
import { join, resolve } from "pathe";
import { withFinally } from "../effect-helpers";
import { ZikuError } from "../errors";
import type { LockState, TemplateSource, ZikuConfig } from "../modules/schemas";
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
  classifyFiles,
  downloadBaseForMerge,
  hasConflictMarkers,
  mergeOneFile,
  readFileSafe,
  writeFileEnsureDir,
} from "../utils/merge";
import {
  type LabelFilter,
  computeActiveLabels,
  filterBaseHashesToScope,
  formatUnknownLabelMessage,
  mergeLabelDefinitions,
  mergeScopedBaseHashes,
  parseLabelsFlag,
  resolveLabeledPatterns,
} from "../utils/labels";

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
      note: "テンプレートの新パターンをマージ",
    },
    {
      file: LOCK_FILE,
      location: "local",
      op: "update",
      note: "新しい baseHashes, baseRef で上書き",
    },
  ],
  notes: [
    "テンプレートの `ziku.jsonc` に新しいパターンが追加された場合、pull 時にユーザーの `ziku.jsonc` へ自動マージされる。既存パターンはそのまま維持される。",
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
    labels: {
      type: "string",
      description: "Comma-separated labels to include in this sync (others are skipped)",
    },
    "skip-labels": {
      type: "string",
      description: "Comma-separated labels to exclude from this sync",
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

    if (config.include.length === 0 && Object.keys(config.labels ?? {}).length === 0) {
      log.warn("No patterns configured");
      cleanup();
      return;
    }

    const labelFilter: LabelFilter = {
      include: parseLabelsFlag(args.labels as string | undefined),
      skip: parseLabelsFlag(args["skip-labels"] as string | undefined),
    };
    const isScoped = labelFilter.include !== undefined || labelFilter.skip !== undefined;

    await withFinally(
      () =>
        performPull({
          targetDir,
          templateDir,
          config,
          lock,
          source,
          resolveBaseRef,
          labelFilter,
          isScoped,
          force: args.force as boolean,
        }),
      cleanup,
    );
  },
});

/**
 * pull の本体ロジック。withFinally の async 本体から切り出すことで
 * 各ステップを独立して読めるようにし、関数の複雑度を抑える。
 */
async function performPull(opts: {
  targetDir: string;
  templateDir: string;
  config: ZikuConfig;
  lock: LockState;
  source: TemplateSource;
  resolveBaseRef: Effect.Effect<Option.Option<string>>;
  labelFilter: LabelFilter;
  isScoped: boolean;
  force: boolean;
}): Promise<void> {
  const { mergedConfig, patternsUpdated } = await mergeTemplateConfig(
    opts.templateDir,
    opts.config,
  );
  const syncPatterns = await resolveSyncPatterns(mergedConfig, opts.labelFilter);

  if (syncPatterns.include.length === 0) {
    log.warn("No patterns match the current label selection");
    return;
  }
  if (opts.isScoped) logActiveLabels(mergedConfig, opts.labelFilter);

  log.step("Analyzing changes...");

  const [templateHashes, localHashes] = await Promise.all([
    hashFiles(opts.templateDir, syncPatterns.include, syncPatterns.exclude),
    hashFiles(opts.targetDir, syncPatterns.include, syncPatterns.exclude),
  ]);
  const classification = classifyFiles({
    baseHashes: opts.isScoped
      ? filterBaseHashesToScope(
          opts.lock.baseHashes ?? {},
          new Set([...Object.keys(templateHashes), ...Object.keys(localHashes)]),
        )
      : (opts.lock.baseHashes ?? {}),
    localHashes,
    templateHashes,
  });

  if (pullSummaryHasNoChanges(classification)) {
    log.success("Already up to date");
    outro("No changes needed");
    return;
  }

  logPullSummary(classification);
  await applyClassifiedChanges(classification, opts);

  const unresolvedConflicts = await resolveConflicts(classification.conflicts, {
    targetDir: opts.targetDir,
    templateDir: opts.templateDir,
    source: opts.source,
    lock: opts.lock,
  });
  if (unresolvedConflicts.length > 0) {
    await savePendingMerge(opts, unresolvedConflicts, templateHashes);
    return;
  }

  if (classification.deletedFiles.length > 0) {
    await handleDeletedFiles(classification.deletedFiles, opts.targetDir, opts.force);
  }

  if (patternsUpdated) {
    await saveMergedConfig(opts.targetDir, mergedConfig);
  }

  await finalizePull(opts, templateHashes, localHashes);
  outro("Pull complete");
}

/** classification の主要カテゴリ（自動更新・新規・コンフリクト・削除）が空か判定する。 */
function pullSummaryHasNoChanges(c: {
  autoUpdate: string[];
  newFiles: string[];
  conflicts: string[];
  deletedFiles: string[];
}): boolean {
  return (
    c.autoUpdate.length === 0 &&
    c.newFiles.length === 0 &&
    c.conflicts.length === 0 &&
    c.deletedFiles.length === 0
  );
}

/** autoUpdate / newFiles を順次適用し、件数に応じた成功ログを出す。 */
async function applyClassifiedChanges(
  classification: { autoUpdate: string[]; newFiles: string[] },
  opts: { templateDir: string; targetDir: string },
): Promise<void> {
  await applyFiles(classification.autoUpdate, opts.templateDir, opts.targetDir);
  if (classification.autoUpdate.length > 0) {
    log.success(`Updated ${classification.autoUpdate.length} file(s)`);
  }
  await applyFiles(classification.newFiles, opts.templateDir, opts.targetDir);
  if (classification.newFiles.length > 0) {
    log.success(`Added ${classification.newFiles.length} new file(s)`);
  }
}

/** 未解決コンフリクトを lock.pendingMerge に保存する。 */
async function savePendingMerge(
  opts: {
    targetDir: string;
    lock: LockState;
    resolveBaseRef: Effect.Effect<Option.Option<string>>;
  },
  unresolvedConflicts: string[],
  templateHashes: Record<string, string>,
): Promise<void> {
  const latestRefOption = await Effect.runPromise(opts.resolveBaseRef);
  await saveLock(opts.targetDir, {
    ...opts.lock,
    pendingMerge: {
      conflicts: unresolvedConflicts,
      templateHashes,
      ...(Option.isSome(latestRefOption) ? { latestRef: latestRefOption.value } : {}),
    },
  });
  outro("Merge paused — resolve conflicts then run `ziku pull --continue`");
}

/** pull 完了時にローカルの ziku.jsonc を更新する。 */
async function saveMergedConfig(targetDir: string, mergedConfig: ZikuConfig): Promise<void> {
  const updatedContent = generateZikuJsonc({
    include: mergedConfig.include,
    exclude: mergedConfig.exclude ?? [],
    labels: mergedConfig.labels,
  });
  await saveZikuConfig(targetDir, updatedContent);
  log.success(`Updated ${ZIKU_CONFIG_FILE} with new patterns from template`);
}

/**
 * pull 完了時の lock 更新。scope 指定時は scope 外の baseHashes を保持し、
 * baseRef も更新しない（scope 外ファイルの3-wayマージで古い baseRef が必要）。
 */
async function finalizePull(
  opts: {
    targetDir: string;
    lock: LockState;
    resolveBaseRef: Effect.Effect<Option.Option<string>>;
    isScoped: boolean;
  },
  templateHashes: Record<string, string>,
  localHashes: Record<string, string>,
): Promise<void> {
  const latestRefOption = await Effect.runPromise(opts.resolveBaseRef);
  const newBaseHashes = opts.isScoped
    ? mergeScopedBaseHashes({
        previous: opts.lock.baseHashes ?? {},
        scopedHashes: templateHashes,
        scopeBoundary: new Set([...Object.keys(templateHashes), ...Object.keys(localHashes)]),
      })
    : templateHashes;

  await saveLock(opts.targetDir, {
    ...opts.lock,
    baseHashes: newBaseHashes,
    ...(!opts.isScoped && Option.isSome(latestRefOption) ? { baseRef: latestRefOption.value } : {}),
  });
}

// ─── ヘルパー関数 ───

/**
 * テンプレートの ziku.jsonc からパターン（include/exclude/labels）を読み込み、
 * ローカル設定にマージする。テンプレート側で追加された分はログに表示する。
 *
 * ラベルの扱い: テンプレートにしかないラベルはローカルに追加し、
 * 両方にあるラベルはパターンのみマージする（ローカルのカスタマイズを尊重）。
 */
async function mergeTemplateConfig(
  templateDir: string,
  local: ZikuConfig,
): Promise<{ mergedConfig: ZikuConfig; patternsUpdated: boolean }> {
  const templateConfigOption = await Effect.runPromise(
    loadTemplateConfig(templateDir).pipe(Effect.option),
  );

  if (Option.isNone(templateConfigOption)) {
    return { mergedConfig: local, patternsUpdated: false };
  }

  const template = templateConfigOption.value;
  const include = local.include;
  const exclude = local.exclude ?? [];

  const newInclude = template.include.filter((p) => !include.includes(p));
  const newExclude = (template.exclude ?? []).filter((p) => !exclude.includes(p));

  const {
    merged: mergedLabels,
    addedLabels,
    addedPatterns,
  } = mergeLabelDefinitions(local.labels, template.labels);

  const labelsChanged = addedLabels.length > 0 || addedPatterns > 0;
  if (newInclude.length === 0 && newExclude.length === 0 && !labelsChanged) {
    return { mergedConfig: local, patternsUpdated: false };
  }

  if (newInclude.length > 0) {
    log.info(`Template added ${newInclude.length} new pattern(s):`);
    for (const p of newInclude) {
      log.message(`  ${pc.green("+")} ${p}`);
    }
  }
  if (addedLabels.length > 0) {
    log.info(`Template added ${addedLabels.length} new label(s): ${addedLabels.join(", ")}`);
  }

  return {
    mergedConfig: {
      ...local,
      include: [...include, ...newInclude],
      ...(exclude.length + newExclude.length > 0 ? { exclude: [...exclude, ...newExclude] } : {}),
      ...(mergedLabels ? { labels: mergedLabels } : {}),
    },
    patternsUpdated: true,
  };
}

/**
 * ラベルフィルタを適用して同期対象パターンを解決する。
 * UnknownLabelError を ZikuError に変換する共通処理。
 */
function resolveSyncPatterns(
  config: ZikuConfig,
  filter: LabelFilter,
): Promise<{ include: string[]; exclude: string[] }> {
  return runCommandEffect(
    resolveLabeledPatterns(config, filter).pipe(
      Effect.mapError((e) => {
        const { title, hint } = formatUnknownLabelMessage(e);
        return new ZikuError(title, hint);
      }),
    ),
  );
}

/**
 * 現在有効なラベル選択をログに表示する。
 */
function logActiveLabels(config: ZikuConfig, filter: LabelFilter): void {
  const { effective, skipped } = computeActiveLabels(Object.keys(config.labels ?? {}), filter);
  const parts = [`${pc.cyan("labels:")} ${effective.join(", ") || "(none)"}`];
  if (skipped.length > 0) parts.push(pc.dim(`(skipped: ${skipped.join(", ")})`));
  log.info(parts.join(" "));
}

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
