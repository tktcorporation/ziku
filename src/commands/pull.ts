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
import { hashContent, hashFiles } from "../utils/hash";
import {
  classifyFiles,
  downloadBaseForMerge,
  hasConflictMarkers,
  mergeOneFile,
  readFileSafe,
  writeFileEnsureDir,
} from "../utils/merge";
import { mergeTemplatePatterns } from "../utils/template-patterns";
import { computeMergedZikuConfig } from "../utils/config-merge";

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
      note: "加法 union マージで同期（テンプレの追加を取り込む。削除は伝播しない）",
    },
    {
      file: LOCK_FILE,
      location: "local",
      op: "update",
      note: "新しい baseHashes, baseRef で上書き",
    },
  ],
  notes: [
    "`ziku.jsonc` 自体が追跡ファイルとして加法 union マージされる。テンプレ側で追加されたパターンはユーザーの `ziku.jsonc` へ取り込まれる（push と双方向に同期）。パターンの削除は自動伝播しない（安全側）。",
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
    dryRun: {
      type: "boolean",
      alias: "n",
      description: "Preview changes without applying them",
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
      await runContinue(targetDir, lockOption.value, args.dryRun as boolean);
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
      logNewIncludeNotice(newInclude);

      log.step("Analyzing changes...");

      // ziku.jsonc 自体を追跡対象に含め、他ファイルと同じ 3-way マージで同期する。
      const effectiveInclude = withConfigTracked(mergedInclude);
      const [templateHashes, localHashes] = await Promise.all([
        hashFiles(templateDir, effectiveInclude, mergedExclude),
        hashFiles(targetDir, effectiveInclude, mergedExclude),
      ]);
      const baseHashes = lock.baseHashes ?? {};

      const classification = classifyFiles({ baseHashes, localHashes, templateHashes });

      // ziku.jsonc は常に加法 union で同期する（autoUpdate も conflict も）。
      // 汎用の applyFiles（テンプレ丸ごとコピー）や diff3 マージに乗せると、テンプレ側で
      // 削除されたパターンがローカルへ伝播し「削除は自動伝播しない」方針に反する（codex P2）。
      // よって autoUpdate / conflict から ziku.jsonc を抜き出し、専用の union マージで扱う。
      const configSync = await resolveConfigMerge(targetDir, templateDir, classification);
      const autoUpdate = classification.autoUpdate.filter((f) => f !== ZIKU_CONFIG_FILE);
      const conflicts = classification.conflicts.filter((f) => f !== ZIKU_CONFIG_FILE);
      // ziku.jsonc は ziku 自身の制御ファイル。テンプレが ziku.jsonc を削除しても、ローカルの
      // 制御ファイルを消すと以降プロジェクトが壊れる（loadCommandContext が未初期化扱いにする）。
      // deletedFiles からも除外し、削除は伝播させない（codex P2）。
      const deletedFiles = classification.deletedFiles.filter((f) => f !== ZIKU_CONFIG_FILE);

      // configInPlay のとき lock の base[ziku.jsonc] をローカル最終内容（union）に揃える。
      // templateHashes 側に寄せると、テンプレが削除したパターンを後続 push が localOnly として
      // 再追加してしまう（codex P2）。
      const baseHashesForLock: Record<string, string> =
        configSync.baseHash !== undefined
          ? { ...templateHashes, [ZIKU_CONFIG_FILE]: configSync.baseHash }
          : templateHashes;

      const totalChanges =
        autoUpdate.length +
        classification.newFiles.length +
        conflicts.length +
        deletedFiles.length +
        (configSync.write !== undefined ? 1 : 0);

      // ファイル変更が無くても、ziku.jsonc の base を union に揃える必要がある場合
      // （例: conflict だが union==local で書き込み不要）は lock を更新しないと、
      // 古い base が残って status/push が誤判定する（codex P2）。その場合は early-return しない。
      const configBaseChanged =
        configSync.baseHash !== undefined &&
        configSync.baseHash !== lock.baseHashes?.[ZIKU_CONFIG_FILE];

      if (totalChanges === 0 && !configBaseChanged) {
        log.success("Already up to date");
        outro("No changes needed");
        return;
      }

      if (totalChanges > 0) {
        logPullSummary({ ...classification, autoUpdate, conflicts, deletedFiles });
      }

      if (args.dryRun) {
        await previewPull({
          targetDir,
          templateDir,
          source,
          lock,
          conflicts,
          deletedFiles,
          configWrite: configSync.write,
        });
        return;
      }

      // 自動更新・新規追加・ziku.jsonc union 同期をまとめて適用
      await applyPullUpdates({
        autoUpdate,
        newFiles: classification.newFiles,
        configWrite: configSync.write,
        targetDir,
        templateDir,
      });

      // コンフリクト解決
      const unresolvedConflicts = await resolveConflicts(conflicts, {
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
            templateHashes: baseHashesForLock,
            ...(Option.isSome(latestRefOption) ? { latestRef: latestRefOption.value } : {}),
          },
        });
        outro("Merge paused — resolve conflicts then run `ziku pull --continue`");
        return;
      }

      // 削除されたファイルを処理（ziku.jsonc は除外済み）
      if (deletedFiles.length > 0) {
        await handleDeletedFiles(deletedFiles, targetDir, args.force as boolean);
      }

      // ziku.jsonc は上の classification で他ファイルと同様に同期済み
      // （autoUpdate: テンプレ内容で上書き / conflict: 3-way マージ）。
      // 旧来の generateZikuJsonc による加法的上書きは廃止した。

      const latestRefOption = await Effect.runPromise(resolveBaseRef);

      await saveLock(targetDir, {
        ...lock,
        baseHashes: baseHashesForLock,
        ...(Option.isSome(latestRefOption) ? { baseRef: latestRefOption.value } : {}),
      });

      outro("Pull complete");
    }, cleanup);
  },
});

// ─── ヘルパー関数 ───

/**
 * テンプレ側で追加された include パターンをユーザーへ通知する。
 * mergeTemplatePatterns 自体は副作用フリーなので、ログ出力はここで行う。
 */
function logNewIncludeNotice(newInclude: string[]): void {
  if (newInclude.length === 0) return;
  log.info(`Template added ${newInclude.length} new pattern(s):`);
  for (const p of newInclude) {
    log.message(`  ${pc.green("+")} ${p}`);
  }
}

/**
 * pull における `ziku.jsonc` の加法 union 同期を計算する。
 *
 * - `baseHash`: lock に記録すべき base ハッシュ（= ローカル最終内容 = union）。
 *   ziku.jsonc が classification に関与する場合のみ定義される。base をローカル最終内容に
 *   揃えることで、テンプレ削除パターンを後続 push が再追加するのを防ぐ（codex P2）。
 * - `write`: 実際に書き込む内容。union が現在のローカルと一致する場合（テンプレ削除のみ等）は
 *   undefined（no-op）。これにより再検出ノイズを防ぐ。
 */
async function resolveConfigMerge(
  targetDir: string,
  templateDir: string,
  classification: { autoUpdate: string[]; conflicts: string[] },
): Promise<{ baseHash?: string; write?: string }> {
  const inPlay =
    classification.autoUpdate.includes(ZIKU_CONFIG_FILE) ||
    classification.conflicts.includes(ZIKU_CONFIG_FILE);
  if (!inPlay) return {};

  const merged = await computeMergedZikuConfig({ targetDir, templateDir });
  const currentLocal = await readFile(join(targetDir, ZIKU_CONFIG_FILE), "utf-8");
  return {
    baseHash: hashContent(merged),
    write: merged !== currentLocal ? merged : undefined,
  };
}

/**
 * pull の適用フェーズ（autoUpdate コピー・newFiles 追加・ziku.jsonc の union 書き込み）を
 * まとめて実行する。run() 本体の分岐数（複雑度）を抑えるために切り出す。
 */
async function applyPullUpdates(opts: {
  autoUpdate: string[];
  newFiles: string[];
  configWrite: string | undefined;
  targetDir: string;
  templateDir: string;
}): Promise<void> {
  await applyFiles(opts.autoUpdate, opts.templateDir, opts.targetDir);
  if (opts.autoUpdate.length > 0) {
    log.success(`Updated ${opts.autoUpdate.length} file(s)`);
  }

  await applyFiles(opts.newFiles, opts.templateDir, opts.targetDir);
  if (opts.newFiles.length > 0) {
    log.success(`Added ${opts.newFiles.length} new file(s)`);
  }

  // ziku.jsonc を加法 union で同期（テンプレの追加は取り込み、削除は伝播しない）。
  if (opts.configWrite !== undefined) {
    await Effect.runPromise(
      writeFileEnsureDir(join(opts.targetDir, ZIKU_CONFIG_FILE), opts.configWrite),
    );
    log.success(`Merged ${pc.cyan(ZIKU_CONFIG_FILE)}`);
  }
}

/**
 * `--dryRun` のプレビュー出力。
 *
 * 実 pull と同じ auto-merge（resolveConflicts に dryRun: true）を試すことで、
 * 「実際に conflict が残るのはどのファイルか」まで実挙動と一致させてプレビューする。
 * ファイルへの書き込みや lock.json の更新は行わない。
 */
async function previewPull(params: {
  targetDir: string;
  templateDir: string;
  source: TemplateSource;
  lock: LockState;
  conflicts: string[];
  deletedFiles: string[];
  configWrite: string | undefined;
}): Promise<void> {
  log.info("Dry run mode");

  if (params.configWrite !== undefined) {
    log.message(`  ${pc.cyan("~")} ${pc.cyan(ZIKU_CONFIG_FILE)} ${pc.dim("(would be merged)")}`);
  }

  const previewUnresolved = await resolveConflicts(params.conflicts, {
    targetDir: params.targetDir,
    templateDir: params.templateDir,
    source: params.source,
    lock: params.lock,
    dryRun: true,
  });

  if (previewUnresolved.length > 0) {
    log.warn("Pull would pause here — resolve these conflicts, then run `ziku pull --continue`.");
  } else if (params.deletedFiles.length > 0) {
    log.info(
      `${params.deletedFiles.length} file(s) removed from the template would be candidates for deletion.`,
    );
  }

  outro("Dry run complete — no changes were made");
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
    dryRun?: boolean;
  },
): Promise<string[]> {
  if (conflicts.length === 0) return [];

  const dryRun = ctx.dryRun ?? false;
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

        // dry-run ではマージ結果をディスクへ書かない（プレビューのみ）。
        if (!dryRun) {
          await Effect.runPromise(writeFileEnsureDir(join(ctx.targetDir, file), result.content));
        }

        if (result.hasConflicts) {
          unresolvedConflicts.push(file);
          log.warn(
            dryRun
              ? `Conflict in ${pc.cyan(file)} — would need manual resolution`
              : `Conflict in ${pc.cyan(file)} — manual resolution needed`,
          );
        } else {
          log.success(`${dryRun ? "Would auto-merge" : "Auto-merged"}: ${pc.cyan(file)}`);
        }
      }

      if (unresolvedConflicts.length > 0 && !dryRun) {
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

async function runContinue(targetDir: string, lock: LockState, dryRun: boolean): Promise<void> {
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

  // dryRun: --continue は pendingMerge の確定（lock 更新・baseHashes 前進）が本体の
  // 副作用なので、書き込みだけ省略する。conflict マーカーの残存チェックは読み取りのみ
  // なので dryRun でも実行してよい（他の dryRun 分岐と同じくプレビュー精度を保つため）。
  if (dryRun) {
    log.info("Dry run mode");
    outro("Dry run complete — no changes were made. Conflicts are resolved and ready to finalize.");
    return;
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
