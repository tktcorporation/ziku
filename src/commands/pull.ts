import { readFile, rm } from "node:fs/promises";
import { defineCommand } from "citty";
import { Effect, Option } from "effect";
import { P, match } from "ts-pattern";
import { withCleanup } from "../effect-helpers";
import type { ZikuFailure } from "../errors";
import { describeConflictLines, zikuFailure } from "../errors";
import type {
  AbsPath,
  ContentHash,
  GlobPattern,
  HashMap,
  MergingLockState,
  PendingConflict,
  PendingConflicts,
  RepoRelPath,
  ResumableLockState,
  UnmergedConflict,
} from "../modules/schemas";
import {
  baseCommitSha,
  baseHashesOf,
  markMerging,
  markSynced,
  resolveMerge,
} from "../modules/schemas";
import type { UnmergedResolution } from "../ui/prompts";
import {
  selectDeletedFiles,
  selectDeletedFilesWithLocalEdits,
  selectUnmergedResolution,
} from "../ui/prompts";
import { intro, log, outro, pc } from "../ui/renderer";
import { LOCK_FILE, loadLock, saveLock } from "../utils/lock";
import {
  buildCommitPinnedSource,
  buildTemplateSource,
  downloadTemplateToTemp,
} from "../utils/template";
import { ZIKU_CONFIG_FILE, withConfigTracked, zikuConfigExists } from "../utils/ziku-config";
import { loadCommandContext, runCommandEffect, toZikuFailure } from "../services/command-context";
import type { CommandLifecycle } from "../docs/lifecycle-types";
import { SYNCED_FILES } from "../docs/lifecycle-types";
import { hashBytes, hashContent } from "../utils/hash";
import { absPath, joinAbs } from "../utils/paths";
import type { ConflictRegion, FileMergeOutcome } from "../utils/merge";
import {
  findConflictRegions,
  mergeConflictFiles,
  readFileSafe,
  writeFileEnsureDir,
} from "../utils/merge";
import type { ZikuConfigPullAction } from "../utils/merge/sync-plan";
import { zikuConfigPullAction } from "../utils/merge/sync-plan";
import { analyzeSync } from "../utils/sync-analysis";
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
    { file: LOCK_FILE, location: "local", op: "read", note: "source と同期ベースを取得" },
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
      note: "新しい同期ベースで上書き",
    },
  ],
  notes: [
    "`ziku.jsonc` 自体が追跡ファイルとして加法 union マージされる。テンプレ側で追加されたパターンはユーザーの `ziku.jsonc` へ取り込まれる（push と双方向に同期）。パターンの削除は自動伝播しない（安全側）。",
    "テンプレートで削除されたファイルは、対話実行ではユーザーが選択的に削除できる。`--force` は削除の承認なので全て削除し、`--yes` はプロンプトを省くだけなので全て残す。ローカルに編集があるものはどちらのフラグでも削除せず、対話実行で明示的に選んだものだけを削除する。",
    "ローカルに残したファイルは同期ベースを据え置くため、次回の `pull` でも同じ削除候補として提示される。ベースを進めるとローカルにしかないファイルと区別できなくなり、続く `push` がテンプレート側の削除を巻き戻してしまう。テンプレートとローカルの双方から既に消えているファイルは、消すものが無いので削除候補として提示せず、ベースからエントリを落とす。",
    "自動マージを試みなかったファイル（共通祖先を取得できない / バイナリ）は、`--continue` がローカルとテンプレートのどちらを残すか尋ねる。ziku がそれらのファイルへ何も書いていないため、コンフリクトマーカーの有無では解決を判定できない。`--yes` / `--force` を付けた実行では代わりに決めず中断する。",
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
      description: "Approve deleting local files that were removed from the template",
      default: false,
    },
    yes: {
      type: "boolean",
      alias: "y",
      description: "Skip prompts (files removed from the template are kept, not deleted)",
      default: false,
    },
    continue: {
      type: "boolean",
      description:
        "Continue a paused merge (asks which version to keep for files that could not be auto-merged)",
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

    const targetDir = absPath(args.dir);
    // 既定値付きの boolean 引数なので、citty のパース結果は常に真偽値が入る。
    // `as boolean` で潰さずそのまま渡し、フラグ名を変えたときに型で気付けるようにする。
    const approvalFlags: PullApprovalFlags = { force: args.force, yes: args.yes };

    // --continue モードは lock.json のみ必要（テンプレート不要）
    if (args.continue) {
      const lock = await runCommandEffect(loadPausedMerge(targetDir));
      await runContinue(targetDir, lock, {
        dryRun: args.dryRun as boolean,
        flags: approvalFlags,
      });
      return;
    }

    // loadCommandContext + runCommandEffect で DRY 化
    const ctx = await runCommandEffect(
      loadCommandContext(targetDir).pipe(Effect.mapError(toZikuFailure)),
    );

    const { config, lock, source, templateDir, cleanup, resolveBaseRef } = ctx;

    // コンフリクト解決待ちの lock は通常の pull フローへ渡さない。マーカーが残ったまま
    // 再マージすると、マーカーが入れ子になったうえ、解決待ちの記録も上書きされて
    // `push` が恒久的にブロックされる。ここで弾くことで、以降 lock は
    // ResumableLockState に絞られ、再実行経路が型として存在しなくなる。
    if (lock.sync === "merging") {
      await cleanup();
      throw pausedMergeFailure(lock);
    }

    log.info(`Template: ${pc.cyan(templateDir)}${source.kind === "local" ? " (local)" : ""}`);

    const include = config.include;
    const exclude = config.exclude ?? [];

    if (include.length === 0) {
      log.warn("No patterns configured");
      await cleanup();
      return;
    }

    // 本体を Effect.promise で包む理由: 本体は Promise を返す I/O を並べるので、失敗は型に
    // 現れず throw で抜ける。Effect.tryPromise の catch で拾うとエラーチャネルが unknown に
    // 潰れるので、defect として運び runCommandEffect が投げられた値をそのまま再スローする。
    await runCommandEffect(
      withCleanup(
        Effect.promise(async () => {
          // mergeTemplatePatterns は「テンプレ側で追加されたパターン配下のファイルも
          // 差分検出の対象に含める」ための include 和集合（discovery 用）を計算する。
          // ziku.jsonc 自体の内容同期は、下の resolveConfigMerge が加法 union で行う。
          const { mergedInclude, mergedExclude, newInclude } = await mergeTemplatePatterns(
            templateDir,
            include,
            exclude,
          );

          // テンプレ側で追加された include パターンをユーザー向けに通知。
          // mergeTemplatePatterns 自体は副作用フリーなので、ログはここで行う。
          logNewIncludeNotice(newInclude);

          log.step("Analyzing changes...");

          const { plan, hashes } = await analyzeSync({
            targetDir,
            templateDir,
            baseHashes: baseHashesOf(lock),
            // ziku.jsonc 自体を追跡対象に含め、他ファイルと同じ差分検出に乗せる。
            include: withConfigTracked(mergedInclude),
            exclude: mergedExclude,
          });

          // ziku.jsonc の扱いは分類カテゴリではなく sync-plan の判断に従う。汎用の applyFiles
          // （テンプレ丸ごとコピー）や diff3 マージに乗せると、テンプレ側で削除されたパターンが
          // ローカルへ伝播し「削除は自動伝播しない」方針に反する。plan.files には ziku.jsonc が
          // 入らないため、以降の適用・削除処理へ紛れ込むことはない。
          const configSync = await resolveConfigMerge(
            targetDir,
            templateDir,
            zikuConfigPullAction(plan.config),
          );
          const { autoUpdate, conflicts, deletedFiles, deletedWithLocalEdits } = plan.files;

          const { deletable: deletableFiles, hasStaleBaseEntries } = splitTemplateDeletions(
            deletedFiles,
            hashes.localHashes,
          );

          // テンプレートが削除したファイルは、どちらのカテゴリでも「削除するか残すか」が
          // 実行時に決まる。ベースの確定にはその結果が要るので、候補を 1 本にまとめて
          // 通常フローと中断の両方から同じ集合を渡す。ここは実在しないファイルも含めた
          // まま渡す。ベースのエントリを落とす判断は {@link baseAfterDeletions} が持つ。
          const deletionCandidates: readonly RepoRelPath[] = [
            ...deletedFiles,
            ...deletedWithLocalEdits,
          ];

          // union マージを行ったときは lock の base[ziku.jsonc] をローカル最終内容（union）に
          // 揃える。templateHashes 側に寄せると、テンプレが削除したパターンを後続 push が
          // localOnly として再追加してしまう。
          const baseHashesForLock: HashMap =
            configSync.baseHash !== undefined
              ? { ...hashes.templateHashes, [ZIKU_CONFIG_FILE]: configSync.baseHash }
              : hashes.templateHashes;

          const totalChanges =
            autoUpdate.length +
            plan.files.newFiles.length +
            conflicts.length +
            deletableFiles.length +
            deletedWithLocalEdits.length +
            (configSync.write !== undefined ? 1 : 0);

          const rewriteLock = lockNeedsRewrite({
            configBaseHash: configSync.baseHash,
            recordedConfigBaseHash: hashes.baseHashes[ZIKU_CONFIG_FILE],
            hasStaleBaseEntries,
          });

          if (totalChanges === 0 && !rewriteLock) {
            log.success("Already up to date");
            outro("No changes needed");
            return;
          }

          if (totalChanges > 0) {
            logPullSummary({ ...plan.files, deletedFiles: deletableFiles });
          }

          if (args.dryRun) {
            await previewPull({
              targetDir,
              templateDir,
              lock,
              conflicts,
              deletedFiles: deletableFiles,
              deletedWithLocalEdits,
              configWrite: configSync.write,
              flags: approvalFlags,
            });
            return;
          }

          // 自動更新・新規追加・ziku.jsonc union 同期をまとめて適用
          await applyPullUpdates({
            autoUpdate,
            newFiles: plan.files.newFiles,
            configWrite: configSync.write,
            targetDir,
            templateDir,
          });

          // コンフリクト解決
          const unresolvedConflicts = await resolveConflicts(conflicts, {
            targetDir,
            templateDir,
            lock,
          });

          const [firstConflict, ...restConflicts] = unresolvedConflicts;
          if (firstConflict !== undefined) {
            const pendingConflicts: PendingConflicts = [firstConflict, ...restConflicts];
            const latestRefOption = await Effect.runPromise(resolveBaseRef);
            await saveLock(
              targetDir,
              markMerging(
                lock,
                {
                  // 解決待ちで抜けるこの経路は、削除の問い合わせより手前にある。削除は
                  // 1 件も適用していないので、候補すべてのベースを据え置く。
                  hashes: baseAfterDeletions({
                    advancedBase: baseHashesForLock,
                    previousBase: hashes.baseHashes,
                    localHashes: hashes.localHashes,
                    deletions: { candidates: deletionCandidates, applied: new Set() },
                  }),
                  // SHA を解決できなかった場合は既存のベース SHA を引き継ぐ。ハッシュだけ
                  // 前進させて SHA を落とすと、次回のマージがベースツリーを取り直せなくなる。
                  commitSha: Option.getOrUndefined(latestRefOption) ?? baseCommitSha(lock),
                },
                pendingConflicts,
              ),
            );
            outro("Merge paused — resolve conflicts then run `ziku pull --continue`");
            return;
          }

          // 削除されたファイルを処理（plan.files に ziku.jsonc は入らない）
          const appliedDeletions = new Set<RepoRelPath>();
          if (deletableFiles.length > 0) {
            for (const path of await handleDeletedFiles(deletableFiles, targetDir, approvalFlags)) {
              appliedDeletions.add(path);
            }
          }

          if (deletedWithLocalEdits.length > 0) {
            for (const path of await handleDeletedWithLocalEdits(
              deletedWithLocalEdits,
              targetDir,
              approvalFlags,
            )) {
              appliedDeletions.add(path);
            }
          }

          const latestRefOption = await Effect.runPromise(resolveBaseRef);

          // SHA を解決できなかった場合は、既存のベース SHA を引き継ぐ。ハッシュだけ前進させて
          // SHA を落とすと、次回のマージがベースツリーを取り直せなくなる。
          await saveLock(
            targetDir,
            markSynced(lock, {
              hashes: baseAfterDeletions({
                advancedBase: baseHashesForLock,
                previousBase: hashes.baseHashes,
                localHashes: hashes.localHashes,
                deletions: { candidates: deletionCandidates, applied: appliedDeletions },
              }),
              commitSha: Option.getOrUndefined(latestRefOption) ?? baseCommitSha(lock),
            }),
          );

          outro("Pull complete");
        }),
        cleanup,
      ),
    );
  },
});

// ─── ヘルパー関数 ───

/**
 * テンプレ側で追加された include パターンをユーザーへ通知する。
 * mergeTemplatePatterns 自体は副作用フリーなので、ログ出力はここで行う。
 */
function logNewIncludeNotice(newInclude: readonly GlobPattern[]): void {
  if (newInclude.length === 0) return;
  log.info(`Template added ${newInclude.length} new pattern(s):`);
  for (const p of newInclude) {
    log.message(`  ${pc.green("+")} ${p}`);
  }
}

/**
 * pull における `ziku.jsonc` の加法 union 同期を計算する。
 *
 * - `baseHash`: lock に記録すべき base ハッシュ（= ローカル最終内容 = union）。union マージを
 *   行う場合のみ定義される。base をローカル最終内容に揃えることで、テンプレ削除パターンを
 *   後続 push が再追加するのを防ぐ。
 * - `write`: 実際に書き込む内容。union が現在のローカルと一致する場合（テンプレ削除のみ等）は
 *   undefined（no-op）。これにより再検出ノイズを防ぐ。
 */
function resolveConfigMerge(
  targetDir: AbsPath,
  templateDir: AbsPath,
  action: ZikuConfigPullAction,
): Promise<{ baseHash?: ContentHash; write?: string }> {
  return match(action)
    .with({ _tag: "Skip" }, () => Promise.resolve({}))
    .with({ _tag: "UnionMerge" }, async () => {
      const merged = await computeMergedZikuConfig({ targetDir, templateDir });
      const currentLocal = await readFile(joinAbs(targetDir, ZIKU_CONFIG_FILE), "utf-8");
      return {
        baseHash: hashContent(merged),
        write: merged !== currentLocal ? merged : undefined,
      };
    })
    .exhaustive();
}

/**
 * pull の適用フェーズ（autoUpdate コピー・newFiles 追加・ziku.jsonc の union 書き込み）を
 * まとめて実行する。run() 本体の分岐数（複雑度）を抑えるために切り出す。
 */
async function applyPullUpdates(opts: {
  autoUpdate: readonly RepoRelPath[];
  newFiles: readonly RepoRelPath[];
  configWrite: string | undefined;
  targetDir: AbsPath;
  templateDir: AbsPath;
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
      writeFileEnsureDir(joinAbs(opts.targetDir, ZIKU_CONFIG_FILE), opts.configWrite),
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
  targetDir: AbsPath;
  templateDir: AbsPath;
  lock: ResumableLockState;
  conflicts: readonly RepoRelPath[];
  deletedFiles: readonly RepoRelPath[];
  deletedWithLocalEdits: readonly RepoRelPath[];
  configWrite: string | undefined;
  flags: PullApprovalFlags;
}): Promise<void> {
  log.info("Dry run mode");

  if (params.configWrite !== undefined) {
    log.message(`  ${pc.cyan("~")} ${pc.cyan(ZIKU_CONFIG_FILE)} ${pc.dim("(would be merged)")}`);
  }

  const previewUnresolved = await resolveConflicts(params.conflicts, {
    targetDir: params.targetDir,
    templateDir: params.templateDir,
    lock: params.lock,
    dryRun: true,
  });

  // 実 pull は解決待ちで中断すると削除の処理まで到達しない。中断するプレビューで削除の
  // 見込みを伝えると、この実行では起きないことを予告することになる。削除候補は解決後の
  // `--continue` を経て次の pull で改めて提示されるので、ここでは黙って中断だけを伝える。
  if (previewUnresolved.length > 0) {
    log.warn("Pull would pause here — resolve these conflicts, then run `ziku pull --continue`.");
  } else {
    logDeletionPreview(params);
  }

  outro("Dry run complete — no changes were made");
}

/** dry-run で、テンプレートから消えたファイルが 2 つのカテゴリそれぞれでどう扱われるかを伝える。 */
function logDeletionPreview(params: {
  deletedFiles: readonly RepoRelPath[];
  deletedWithLocalEdits: readonly RepoRelPath[];
  flags: PullApprovalFlags;
}): void {
  if (params.deletedFiles.length > 0) {
    log.info(describeDeletedFilesPreview(params.deletedFiles.length, params.flags));
  }

  if (params.deletedWithLocalEdits.length > 0) {
    const count = params.deletedWithLocalEdits.length;
    log.warn(
      isNonInteractive(params.flags)
        ? `${count} file(s) removed from the template have local edits — pull would keep them (local edits are never discarded automatically).`
        : `${count} file(s) removed from the template have local edits — pull would ask you to pick which to delete (never deleted automatically).`,
    );
  }
}

/** dry-run で、テンプレートから消えたファイル（ローカル編集なし）がどう扱われるかを伝える。 */
function describeDeletedFilesPreview(count: number, flags: PullApprovalFlags): string {
  return match(resolveDeletionPolicy(flags))
    .with("deleteAll", () => `${count} file(s) removed from the template would be deleted.`)
    .with(
      "keepAll",
      () =>
        `${count} file(s) removed from the template would be kept — --yes does not approve deletion (use --force).`,
    )
    .with(
      "askUser",
      () => `${count} file(s) removed from the template would be candidates for deletion.`,
    )
    .exhaustive();
}

/**
 * テンプレートからファイルをコピーする共通処理。
 * autoUpdate と newFiles で同じロジックを使う（DRY）。
 *
 * 内容をバイト列のまま運ぶ。テンプレートの画像やフォントを utf-8 の文字列として
 * 読み書きすると、不正バイトが U+FFFD へ置き換わってファイルが壊れる。
 */
async function applyFiles(
  files: readonly RepoRelPath[],
  templateDir: AbsPath,
  targetDir: AbsPath,
): Promise<void> {
  for (const file of files) {
    const bytes = await readFile(joinAbs(templateDir, file));
    await Effect.runPromise(writeFileEnsureDir(joinAbs(targetDir, file), bytes));
  }
}

/**
 * コンフリクトファイルのマージを試み、未解決のものを経路付きで返す。
 *
 * ループとベース取得は `mergeConflictFiles` が持つ。ここが担うのは pull 固有の後処理、
 * つまり「マージできた内容をローカルへ書き戻し、結末をユーザーへ伝える」ことだけ。
 */
async function resolveConflicts(
  conflicts: readonly RepoRelPath[],
  ctx: {
    targetDir: AbsPath;
    templateDir: AbsPath;
    lock: ResumableLockState;
    dryRun?: boolean;
  },
): Promise<readonly PendingConflict[]> {
  const dryRun = ctx.dryRun ?? false;

  const unresolvedConflicts = await Effect.runPromise(
    mergeConflictFiles({
      conflicts,
      targetDir: ctx.targetDir,
      templateDir: ctx.templateDir,
      lock: ctx.lock,
      onFileResult: ({ file, outcome }) =>
        applyMergeOutcome({ file, outcome, targetDir: ctx.targetDir, dryRun }),
    }),
  );

  if (unresolvedConflicts.length > 0 && !dryRun) {
    log.warn("Some files have conflicts. Resolve them, then run `ziku pull --continue`");
  }

  return unresolvedConflicts;
}

/**
 * マージの結末をローカルへ反映し、ユーザーへ伝える。
 *
 * マーカー入りの内容もローカルへ書き出す。ユーザーが手で解決する対象なので、書かずに
 * 済ませるとどこが衝突したのか分からなくなる。一方ベース不在（`NoBase`）ではマージ自体を
 * 試みていないため書き出す内容が無く、ローカルのファイルには一切触れない。
 * dry-run はプレビューなのでどの結末でもディスクへ触れない。
 */
function applyMergeOutcome(params: {
  file: RepoRelPath;
  outcome: FileMergeOutcome;
  targetDir: AbsPath;
  dryRun: boolean;
}): Effect.Effect<void> {
  const { file, outcome, targetDir, dryRun } = params;
  const writeMerged = (content: string): Effect.Effect<void> =>
    dryRun ? Effect.void : writeFileEnsureDir(joinAbs(targetDir, file), content);

  return match(outcome)
    .with({ _tag: "Clean" }, ({ content }) =>
      Effect.gen(function* () {
        yield* writeMerged(content);
        log.success(`${dryRun ? "Would auto-merge" : "Auto-merged"}: ${pc.cyan(file)}`);
      }),
    )
    .with({ _tag: "Conflicted" }, ({ content, regions }) =>
      Effect.gen(function* () {
        yield* writeMerged(content);
        log.warn(
          dryRun
            ? `Conflict in ${pc.cyan(file)} ${formatRegions(regions)} — would need manual resolution`
            : `Conflict in ${pc.cyan(file)} ${formatRegions(regions)} — manual resolution needed`,
        );
      }),
    )
    .with({ _tag: "NoBase" }, () =>
      Effect.sync(() => {
        const reason = `Cannot auto-merge ${pc.cyan(file)} — the base version is unavailable, so local and template changes can't be told apart`;
        log.warn(
          dryRun
            ? `${reason} — would need manual resolution`
            : `${reason}. Compare it with the template and edit it yourself.`,
        );
      }),
    )
    .exhaustive();
}

/** 未解決ブロックの位置を、失敗の hint と同じ文言でログへ出す。 */
function formatRegions(regions: readonly ConflictRegion[]): string {
  return pc.dim(describeConflictLines(regions.map((r) => r.startLine)));
}

/**
 * `--force`（破壊的操作の承認）と `--yes`（対話の省略）の組み合わせ。
 * 削除候補の扱いはこの 2 つだけで決まる。
 */
interface PullApprovalFlags {
  readonly force: boolean;
  readonly yes: boolean;
}

/** 削除候補に対して取る行動。 */
type DeletionPolicy = "deleteAll" | "keepAll" | "askUser";

/**
 * テンプレートで削除され、ローカルも base のままのファイルの扱いを決める。
 *
 * 失われるのはテンプレートから再取得できる内容だけなので、`--force` はこの削除の承認に
 * なる。承認済みの対象について改めて選択を求めても意味が無いので全件削除する。
 * `--yes` はプロンプトを省くだけで削除を承認しないため、全件残す。
 */
function resolveDeletionPolicy(flags: PullApprovalFlags): DeletionPolicy {
  return match(flags)
    .with({ force: true }, () => "deleteAll" as const)
    .with({ force: false, yes: true }, () => "keepAll" as const)
    .with({ force: false, yes: false }, () => "askUser" as const)
    .exhaustive();
}

/**
 * プロンプトを出さずに進める実行か。
 *
 * `--yes` は対話の省略、`--force` は破壊的操作の承認で、どちらも対話端末を前提にしない
 * 実行を意図する指定。選択を求める処理はこの判定で分岐し、入力待ちで止まらないようにする。
 * 選択できないときに何をするかは処理ごとに違う（削除候補は残し、マージの選択は中断する）。
 */
function isNonInteractive(flags: PullApprovalFlags): boolean {
  return flags.force || flags.yes;
}

/**
 * ユーザーへ見せる変更が 1 件も無くても、lock だけは書き直す必要があるか。
 *
 * 該当するのは 2 つ。ziku.jsonc の base を union の内容へ揃える必要がある場合（例: conflict
 * だが union==local で書き込みが要らない）と、ベースにだけ残ったエントリを落とす場合。
 * どちらも古い base を残すと `status` / `push` が誤判定し、同じ状態のまま毎回走ることになる。
 *
 * @param configBaseHash union マージが決めた ziku.jsonc の base。揃える必要が無ければ undefined。
 * @param recordedConfigBaseHash lock に記録されている ziku.jsonc の base。
 */
function lockNeedsRewrite(params: {
  readonly configBaseHash: ContentHash | undefined;
  readonly recordedConfigBaseHash: ContentHash | undefined;
  readonly hasStaleBaseEntries: boolean;
}): boolean {
  const configBaseChanged =
    params.configBaseHash !== undefined && params.configBaseHash !== params.recordedConfigBaseHash;
  return configBaseChanged || params.hasStaleBaseEntries;
}

/** テンプレートが削除したファイルを、削除を問える側と問う意味が無い側に分けた結果。 */
interface TemplateDeletions {
  /** ローカルに実在し、削除するか残すかを問える候補。 */
  readonly deletable: readonly RepoRelPath[];
  /** ベースにだけエントリが残っているファイルがあるか。 */
  readonly hasStaleBaseEntries: boolean;
}

/**
 * テンプレートが削除したファイルを、ローカルでの実在で分ける。
 *
 * `deletedFiles` には「テンプレートにもワークツリーにも無く、ベースにだけ残っている」
 * ファイルも入る（`utils/merge/classify.ts`）。消すものが無いので、候補として見せても
 * 選択も削除ログも実体を伴わない。
 *
 * ベースにだけ残ったエントリは、見せる変更が無くても lock を書き直して落とす必要がある
 * （{@link baseAfterDeletions}）。落とさないと毎回同じ状態で走り、`status` も同期済みに
 * ならないため、その有無を呼び出し側へ返す。
 */
function splitTemplateDeletions(
  deletedFiles: readonly RepoRelPath[],
  localHashes: HashMap,
): TemplateDeletions {
  const deletable = deletedFiles.filter((path) => localHashes[path] !== undefined);
  return { deletable, hasStaleBaseEntries: deletable.length < deletedFiles.length };
}

/**
 * テンプレート側の削除候補と、そのうち実際にローカルから消したもの。
 *
 * 候補と適用結果を 1 つの値で運ぶことで、{@link baseAfterDeletions} が「残ったのはどれか」を
 * 自分で導ける。呼び出し側が差を計算して渡す形にすると、経路ごとに引き算が散る。
 */
interface DeletionOutcome {
  /** テンプレートから消えたファイル。`deletedFiles` と `deletedWithLocalEdits` の合計。 */
  readonly candidates: readonly RepoRelPath[];
  /** そのうちローカルからも消したファイル。 */
  readonly applied: ReadonlySet<RepoRelPath>;
}

/**
 * lock に書き込む同期ベースを、適用された削除だけ反映した形で組み立てる。
 *
 * pull は分類に使ったテンプレート側のハッシュをそのまま次のベースにする。テンプレートから
 * 消えたファイルはそこにエントリを持たないので、ローカルに残したファイルまでベースを進めると
 * 「base に無い・template に無い・local にある」＝ `localOnly` に化ける。`localOnly` は
 * push の既定送信集合であり、`restoresTemplateDeletion`（テンプレートの削除を取り消す操作
 * だと識別するための集合）にも入らない。結果として、次の `ziku push --yes` がテンプレートの
 * 削除を黙って巻き戻す。
 *
 * そこで据え置くのは、次の 2 つをどちらも満たすファイルだけ。
 *
 * 1. 今回の実行で削除を適用しなかった
 * 2. ローカルのワークツリーにファイルが実在する（`localHashes` にエントリがある）
 *
 * 条件 2 が要るのは、据え置きが `localOnly` への化けを防ぐためのものだから。ローカルに無い
 * ファイルは push の送信集合に入りようがなく、据え置く理由が無い。削除候補には
 * 「テンプレートにもワークツリーにも無く、ベースにだけ残っている」ファイルも入る
 * （`utils/merge/classify.ts`）。これは削除の適用対象にならないので、据え置くとベースの
 * エントリだけが永久に残り、毎回削除候補として報告され `status` も同期済みにならない。
 * エントリを落とせば以降は分類の対象から外れ、繰り返しても状態が収束する。
 *
 * 据え置いたファイルは次回の pull でも「テンプレートが削除した」状態として同じカテゴリに
 * 分類され、ユーザーは削除するか残すかを再び問われる。テンプレートとの差異が解消していない
 * 以上、問われ続けるのが正しい。黙ってテンプレートへ送り返すより、毎回目に入るほうが失う
 * ものが小さい。
 *
 * lock を書く経路は 3 つある（通常フローの確定・解決待ちでの中断・`pull --continue` の確定）。
 * 前 2 つはこの関数を通し、`--continue` は中断時に書いた `merge.nextBase` をそのまま昇格
 * させるので、ベースの決め方はこの 1 箇所に閉じる。
 */
function baseAfterDeletions(params: {
  /** テンプレート側へ前進させたベース（`ziku.jsonc` の補正込み）。 */
  readonly advancedBase: HashMap;
  /** 今回の比較で共通祖先として使ったベース。 */
  readonly previousBase: HashMap;
  /** 今回の走査で得たローカルのハッシュ。エントリの有無がワークツリーでの実在と一致する。 */
  readonly localHashes: HashMap;
  readonly deletions: DeletionOutcome;
}): HashMap {
  const retained = params.deletions.candidates.filter(
    (path) => !params.deletions.applied.has(path) && params.localHashes[path] !== undefined,
  );
  if (retained.length === 0) return params.advancedBase;

  const base: HashMap = { ...params.advancedBase };
  for (const path of retained) {
    const previous = params.previousBase[path];
    // 削除候補はベースにエントリを持つ（`utils/merge/classify.ts` の `hasBase: true` 側から
    // しか出てこない）。型はそれを保証しないので、無ければ前進させた側をそのまま残す。
    if (previous === undefined) continue;
    base[path] = previous;
  }
  return base;
}

/**
 * テンプレートで削除され、ローカルも base のままのファイルを処理する。
 *
 * @returns 実際にローカルから削除したファイル。残したものはベースを据え置く
 *   （{@link baseAfterDeletions}）。
 */
async function handleDeletedFiles(
  deletedFiles: readonly RepoRelPath[],
  targetDir: AbsPath,
  flags: PullApprovalFlags,
): Promise<ReadonlySet<RepoRelPath>> {
  const filesToDelete = await match(resolveDeletionPolicy(flags))
    .with("deleteAll", (): readonly RepoRelPath[] => {
      log.info(`Deleting ${deletedFiles.length} file(s) removed from template...`);
      return deletedFiles;
    })
    .with("keepAll", (): readonly RepoRelPath[] => {
      log.warn(
        `Kept ${deletedFiles.length} file(s) removed from the template — --yes skips prompts but does not approve deletion. Re-run with --force to delete them.`,
      );
      return [];
    })
    .with("askUser", () => selectDeletedFiles(deletedFiles))
    .exhaustive();

  return deleteSelectedFiles(filesToDelete, targetDir);
}

/**
 * テンプレートで削除され、ローカルに編集があるファイルを処理する。
 *
 * このカテゴリはどちらのフラグでも自動削除しない。テンプレートから消えているため削除すると
 * ローカルの編集はどこからも復元できず、`--force`（テンプレート由来の削除の承認）はその
 * 損失までは承認していない。非対話を意図する実行（`--force` / `--yes`）では選択プロンプトも
 * 出さずに全て残す。CI で入力待ちのまま止まるのを避けつつ、編集を守る側へ倒す。
 *
 * 残したファイルはベースを据え置くので、次回の pull でも同じ問いが出る
 * （{@link baseAfterDeletions}）。
 *
 * @returns 実際にローカルから削除したファイル。
 */
async function handleDeletedWithLocalEdits(
  files: readonly RepoRelPath[],
  targetDir: AbsPath,
  flags: PullApprovalFlags,
): Promise<ReadonlySet<RepoRelPath>> {
  if (isNonInteractive(flags)) {
    log.warn(
      `Kept ${files.length} file(s) removed from the template because they have local edits. Run 'ziku pull' without --force / --yes to choose which to delete.`,
    );
    return new Set();
  }

  log.warn(
    `${files.length} file(s) removed from the template have local edits — select explicitly to delete:`,
  );
  const filesToDelete = await selectDeletedFilesWithLocalEdits(files);

  const deleted = await deleteSelectedFiles(filesToDelete, targetDir);

  const kept = files.filter((f) => !deleted.has(f));
  if (kept.length > 0) {
    log.info(`Kept ${kept.length} locally edited file(s).`);
  }

  return deleted;
}

/**
 * 選択された削除対象をローカルから削除する。削除できないファイルは警告のみで続行する。
 *
 * @returns 実際に消えたファイル。消せなかったファイルはローカルに残っているため、
 *   呼び出し側はベースを進めてはいけない。
 */
async function deleteSelectedFiles(
  files: readonly RepoRelPath[],
  targetDir: AbsPath,
): Promise<ReadonlySet<RepoRelPath>> {
  const deleted = new Set<RepoRelPath>();
  for (const file of files) {
    const removed = await Effect.runPromise(
      Effect.tryPromise(async () => {
        await rm(joinAbs(targetDir, file), { force: true });
        log.success(`Deleted: ${file}`);
        return true;
      }).pipe(
        Effect.orElseSucceed(() => {
          log.warn(`Could not delete: ${file}`);
          return false;
        }),
      ),
    );
    if (removed) deleted.add(file);
  }
  return deleted;
}

/**
 * コンフリクト解決待ちの lock を受け取ったときの中断エラー。
 *
 * 通常の pull は解決待ちのファイルを持たない状態を前提に組み立てられているため、
 * 解決の続きは `--continue` へ誘導する。
 */
function pausedMergeFailure(lock: MergingLockState): ZikuFailure {
  return zikuFailure({ kind: "MergePaused", conflicts: lock.merge.conflicts.map((c) => c.path) });
}

/**
 * `--continue` の前提を確認し、解決待ちの lock を返す。
 *
 * 前提が崩れる 2 通り（未初期化 / 解決待ちが無い）はユーザーが取る行動が違うので、
 * 別々の失敗理由で返す。戻り値が `MergingLockState` に絞られるため、再開処理は
 * 解決待ちでない lock を受け取れない。
 */
function loadPausedMerge(targetDir: AbsPath): Effect.Effect<MergingLockState, ZikuFailure> {
  return Effect.gen(function* () {
    if (!zikuConfigExists(targetDir)) {
      return yield* Effect.fail(zikuFailure({ kind: "NotInitialized", path: ZIKU_CONFIG_FILE }));
    }

    const lock = yield* loadLock(targetDir).pipe(Effect.mapError(toZikuFailure));
    if (lock.sync !== "merging") {
      return yield* Effect.fail(zikuFailure({ kind: "NoMergePaused" }));
    }

    return lock;
  });
}

/**
 * コンフリクト解決後に同期ベースを確定する。
 *
 * 解決待ちの確かめ方は経路ごとに違う（`PendingConflict` を参照）。マーカーを書き出した
 * ファイルはマーカーが消えたことが解決の証拠になるが、自動マージを試みなかったファイル
 * （`noBase` / `binary`）はローカルに何も書かれていないため、マーカーが無いことは何も
 * 意味しない。後者はどちらの内容を残すかをユーザーに選ばせてから確定する。
 *
 * どちらを選んでもベースはテンプレート側へ前進する。「ローカルを残す」は git の `--ours`
 * と同じく、テンプレートの変更を意図して拒否したという意思表示なので、次回以降その差分を
 * 蒸し返さない。
 *
 * 確定するベースの土台は中断時に記録した `merge.nextBase`。中断は削除の問い合わせより手前で
 * 起きるため、`nextBase` はテンプレートが削除したファイルのエントリを据え置いた状態で書かれて
 * いる（{@link baseAfterDeletions}）。そのまま昇格させることで、問われないまま削除が失われる
 * 経路が無くなり、未処理の削除は次回の pull で改めてユーザーに提示される。テンプレートの内容で
 * 置き換えたファイルだけは、書き込んだ内容のハッシュで差し替える（{@link finalizeMergedBase}）。
 *
 * 引数が `MergingLockState` なので、解決待ちでない lock に対しては呼べない。
 */
async function runContinue(
  targetDir: AbsPath,
  lock: MergingLockState,
  opts: { dryRun: boolean; flags: PullApprovalFlags },
): Promise<void> {
  const unmerged = lock.merge.conflicts.filter(isUnmergedConflict);

  const stillConflicted = await findRemainingMarkers(
    targetDir,
    lock.merge.conflicts.filter(hasReadableText),
  );
  if (stillConflicted.length > 0) {
    throw zikuFailure({
      kind: "ConflictsUnresolved",
      files: stillConflicted.map(({ file, regions }) => ({
        path: file,
        lines: regions.map((r) => r.startLine),
      })),
    });
  }

  // dryRun: --continue は同期ベースの確定（lock 更新）が本体の副作用なので、書き込みだけ
  // 省略する。マーカーの残存チェックは読み取りのみなので dryRun でも実行してよい
  // （他の dryRun 分岐と同じくプレビュー精度を保つため）。選択を伴う問い合わせは、
  // プレビューが入力待ちで止まらないよう予告に留める。
  //
  // 選択を代行できないことによる中断より手前に置く。プレビューは「実行すると何が起きるか」を
  // 見せるものなので、その実行が中断する見込みであること自体もプレビューの内容に含まれる。
  if (opts.dryRun) {
    log.info("Dry run mode");
    if (unmerged.length > 0) {
      log.warn(describeUnmergedPreview(unmerged.length, opts.flags));
      for (const conflict of unmerged) log.message(`  ${pc.yellow("!")} ${conflict.path}`);
    }
    outro(
      unmerged.length > 0
        ? "Dry run complete — no changes were made."
        : "Dry run complete — no changes were made. Conflicts are resolved and ready to finalize.",
    );
    return;
  }

  // 非対話を意図する実行で選択を代行しない。どちらを選んでも片側の変更が消えるため、
  // ツールが黙って決めてよい判断ではない。
  if (unmerged.length > 0 && isNonInteractive(opts.flags)) {
    throw zikuFailure({
      kind: "UnmergedChoiceRequired",
      files: unmerged.map((c) => c.path),
    });
  }

  const takenFromTemplate =
    unmerged.length > 0 ? await applyUnmergedChoices(targetDir, lock, unmerged) : {};

  await saveLock(targetDir, finalizeMergedBase(lock, takenFromTemplate));

  log.success("All conflicts resolved");
  outro("Pull complete");
}

/**
 * 解決を終えたベースを確定した lock を組み立てる。
 *
 * テンプレートの内容で置き換えたファイルは、`nextBase` に記録されたハッシュではなく実際に
 * 書き込んだ内容のハッシュをベースにする。書き込む内容の取得元が中断時点のツリーである保証は
 * 無いため（{@link acquireResolutionTemplate}）、`nextBase` をそのまま載せると「ローカルに
 * ある内容」と「ベースが指す内容」が食い違い、直後から同じファイルが `localOnly` として現れて
 * 次の push がテンプレートの内容をローカルの変更として送り返す。
 *
 * 置き換えたファイルが無ければ到達点は `nextBase` そのものなので、`resolveMerge` で確定する。
 *
 * @param takenFromTemplate テンプレートの内容で置き換えたファイルと、書き込んだ内容のハッシュ。
 */
function finalizeMergedBase(
  lock: MergingLockState,
  takenFromTemplate: HashMap,
): ResumableLockState {
  if (Object.keys(takenFromTemplate).length === 0) return resolveMerge(lock);

  return markSynced(lock, {
    hashes: { ...lock.merge.nextBase.hashes, ...takenFromTemplate },
    commitSha: lock.merge.nextBase.ref,
  });
}

/**
 * dry-run で、自動マージできなかったファイルを `--continue` がどう扱うかを伝える。
 *
 * 非対話を意図する実行では選択を求められないまま中断するため、プレビューの時点でそれを
 * 伝える。プレビューだけ通って本番が止まると、ユーザーは理由を掴めないまま失敗を受け取る。
 */
function describeUnmergedPreview(count: number, flags: PullApprovalFlags): string {
  return isNonInteractive(flags)
    ? `${count} file(s) could not be auto-merged — continue asks whether to keep your local version or take the template's, so this run would stop instead (--yes / --force skip prompts):`
    : `${count} file(s) could not be auto-merged — continue would ask whether to keep your local version or take the template's:`;
}

/** 自動マージを試みなかった経路か。マーカーの有無では解決を判定できない側。 */
function isUnmergedConflict(conflict: PendingConflict): conflict is UnmergedConflict {
  return match(conflict)
    .with({ reason: "markers" }, () => false)
    .with({ reason: P.union("noBase", "binary") }, () => true)
    .exhaustive();
}

/** テキストとして読めるか。バイナリの中からマーカーを探しても意味を持たない。 */
function hasReadableText(conflict: PendingConflict): boolean {
  return match(conflict)
    .with({ reason: P.union("markers", "noBase") }, () => true)
    .with({ reason: "binary" }, () => false)
    .exhaustive();
}

/**
 * ローカルに残っているコンフリクトマーカーを探す。
 *
 * 解決済みかどうかはディスクの現在の内容だけが決める。ユーザーが手で編集した後なので、
 * マージ時点で得た位置情報は既にずれている。読み直して今のブロック位置を提示する。
 *
 * ziku がマーカーを書いていない `noBase` も走査する。ユーザーが自分でマーカーを書いた
 * まま再開することがあり、そのままテンプレートへ送らせないため。
 */
async function findRemainingMarkers(
  targetDir: AbsPath,
  conflicts: readonly PendingConflict[],
): Promise<Array<{ file: RepoRelPath; regions: readonly ConflictRegion[] }>> {
  const stillConflicted: Array<{ file: RepoRelPath; regions: readonly ConflictRegion[] }> = [];
  for (const { path } of conflicts) {
    const contentOption = await Effect.runPromise(
      readFileSafe(joinAbs(targetDir, path)).pipe(Effect.option),
    );
    if (Option.isNone(contentOption)) continue;
    const regions = findConflictRegions(contentOption.value);
    if (regions.length > 0) stillConflicted.push({ file: path, regions });
  }
  return stillConflicted;
}

/**
 * 自動マージできなかったファイルの扱いをユーザーに選ばせ、選択を適用する。
 *
 * 「テンプレートの内容を取る」を選べる以上、その内容が要る。取り寄せ先は中断時点のツリーとは
 * 限らない（{@link acquireResolutionTemplate}）ので、書き込んだ内容のハッシュを返し、
 * 呼び出し側がそれをベースとして確定する（{@link finalizeMergedBase}）。ツリーの出所によらず
 * 「ローカルにある内容」と「ベースが指す内容」が一致するので、次の pull/push が同じファイルを
 * 変更ありと誤検出しない。
 *
 * テンプレートの取得はどれか 1 つでも「テンプレートを取る」が選ばれたときだけ行う。
 * 全て「ローカルを残す」ならファイルへ触れる必要が無く、ダウンロードは無駄になる。
 *
 * @returns テンプレートの内容で置き換えたファイルと、書き込んだ内容のハッシュ。
 */
async function applyUnmergedChoices(
  targetDir: AbsPath,
  lock: MergingLockState,
  unmerged: readonly UnmergedConflict[],
): Promise<HashMap> {
  log.warn(
    `${unmerged.length} file(s) could not be auto-merged. Choose which version to keep for each:`,
  );

  const takingTemplate: RepoRelPath[] = [];
  for (const conflict of unmerged) {
    const resolution: UnmergedResolution = await selectUnmergedResolution(conflict);
    match(resolution)
      .with("keepLocal", () => {
        log.info(`Kept your local version: ${pc.cyan(conflict.path)}`);
      })
      .with("takeTemplate", () => {
        takingTemplate.push(conflict.path);
      })
      .exhaustive();
  }

  if (takingTemplate.length === 0) return {};

  const template = await acquireResolutionTemplate(targetDir, lock);
  return runCommandEffect(
    copyFromTemplate(takingTemplate, template.dir, targetDir).pipe(
      Effect.ensuring(Effect.sync(template.cleanup)),
    ),
  );
}

/**
 * 「テンプレートを取る」で書き込む内容の取得元を用意する。
 *
 * 取り出せるのは中断時点のツリーとは限らない。一致するのは、GitHub ソースでベースとして確定する
 * コミットの SHA を記録できている場合だけで、次の 2 つでは中断後のテンプレートを読むことになる。
 *
 * - ローカルソース: ディレクトリを直接読む。過去のツリーを取り直す手段が無い（`SyncBase` が
 *   ローカルソースでコミット SHA を持たない理由と同じ）。
 * - GitHub ソースで SHA が未記録: API へ到達できないまま中断した場合で、ソースの ref をそのまま
 *   辿るしかない。
 *
 * ズレたまま整合を保つ仕組みは呼び出し側にある。書き込んだ内容のハッシュをベースへ載せるので
 * （{@link applyUnmergedChoices} / {@link finalizeMergedBase}）、どのツリーから読んでも
 * 「ローカルにある内容」と「ベースが指す内容」は一致する。
 *
 * 取得できなければ失敗として返す。ユーザーは接続を直して再開すればよく、その間 lock は
 * 解決待ちのまま残る。
 */
function acquireResolutionTemplate(
  targetDir: AbsPath,
  lock: MergingLockState,
): Promise<{ dir: AbsPath; cleanup: () => void }> {
  return match(lock)
    .with({ source: { kind: "local" } }, (l) =>
      Promise.resolve({ dir: l.source.path, cleanup: () => {} }),
    )
    .with({ source: { kind: "github" } }, (l) => {
      const ref = l.merge.nextBase.ref;
      const source =
        ref === undefined ? buildTemplateSource(l.source) : buildCommitPinnedSource(l.source, ref);
      return runCommandEffect(
        Effect.tryPromise({
          try: () => downloadTemplateToTemp(targetDir, source, "continue"),
          catch: (cause) =>
            zikuFailure(
              {
                kind: "TemplateUnavailable",
                detail: `Could not download the template version being merged (${source}): ${String(cause)}`,
              },
              { cause },
            ),
        }).pipe(Effect.map(({ templateDir, cleanup }) => ({ dir: templateDir, cleanup }))),
      );
    })
    .exhaustive();
}

/**
 * テンプレートの内容でローカルを置き換え、書き込んだ内容のハッシュを返す。
 *
 * 内容をバイト列のまま運ぶ。バイナリを utf-8 の文字列として読み書きすると、不正バイトが
 * U+FFFD へ置き換わってファイルが壊れる（このカテゴリにはバイナリが含まれる）。ハッシュも
 * 同じバイト列から計算するので、ディスクを読み直したときの値と一致する。
 *
 * 取り寄せたテンプレートにファイルが無い場合は失敗として返す。書き込む内容が無いまま
 * 進めると、ローカルを残したのにベースだけがテンプレート側へ前進する。
 *
 * @returns 置き換えたファイルと、書き込んだ内容のハッシュ。呼び出し側がベースとして確定する。
 */
function copyFromTemplate(
  files: readonly RepoRelPath[],
  templateDir: AbsPath,
  targetDir: AbsPath,
): Effect.Effect<HashMap, ZikuFailure> {
  return Effect.gen(function* () {
    const written: HashMap = {};
    for (const file of files) {
      const bytes = yield* Effect.tryPromise({
        try: () => readFile(joinAbs(templateDir, file)),
        catch: (cause) => zikuFailure({ kind: "TemplateFileMissing", path: file }, { cause }),
      });
      yield* writeFileEnsureDir(joinAbs(targetDir, file), bytes);
      written[file] = hashBytes(bytes);
      log.success(`Took the template version: ${pc.cyan(file)}`);
    }
    return written;
  });
}

function logPullSummary(classification: {
  autoUpdate: readonly RepoRelPath[];
  newFiles: readonly RepoRelPath[];
  conflicts: readonly RepoRelPath[];
  deletedFiles: readonly RepoRelPath[];
  deletedWithLocalEdits: readonly RepoRelPath[];
  localOnly: readonly RepoRelPath[];
  unchanged: readonly RepoRelPath[];
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
  // 削除候補だがローカルに編集がある。削除すると編集が失われるので、他の削除と見分けが
  // つくよう注記を添える。
  for (const file of classification.deletedWithLocalEdits) {
    lines.push(`${pc.red("-")} ${pc.red(file)} ${pc.dim("(locally edited)")}`);
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
    classification.deletedWithLocalEdits.length > 0
      ? pc.red(`-${classification.deletedWithLocalEdits.length} deleted (locally edited)`)
      : null,
  ]
    .filter(Boolean)
    .join(pc.dim(" | "));

  log.message([...lines, "", summaryParts].join("\n"));
}
