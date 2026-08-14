import { readFile, rm } from "node:fs/promises";
import { defineCommand } from "citty";
import { Effect, Option } from "effect";
import { match } from "ts-pattern";
import { withCleanup } from "../effect-helpers";
import type { ZikuFailure } from "../errors";
import { describeConflictLines, zikuFailure } from "../errors";
import type {
  AbsPath,
  GlobPattern,
  HashMap,
  MergingLockState,
  PendingConflict,
  PendingConflicts,
  RepoRelPath,
  ResumableLockState,
  SyncPoint,
  UnmergedConflict,
} from "../modules/schemas";
import { baseCommitSha, baseHashesOf, markMerging, markSynced } from "../modules/schemas";
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
import { resolveGitHubFetchSource } from "../utils/template-resolve";
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
import type { PullApprovalFlags, ZikuConfigMergeResult } from "./pull-plan";
import {
  configContentToWrite,
  finalizeMergedBase,
  hasReadableText,
  isNonInteractive,
  isUnmergedConflict,
  nextSyncBase,
  planPullChanges,
  resolveDeletionPolicy,
} from "./pull-plan";

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

          // ziku.jsonc の扱いは分類カテゴリではなく sync-plan の判断に従う。テンプレートの
          // 内容をそのまま置くコピー（{@link copyTemplateFiles}）や diff3 マージに乗せると、
          // テンプレ側で削除されたパターンがローカルへ伝播し「削除は自動伝播しない」方針に
          // 反する。plan.files には ziku.jsonc が入らないため、以降の適用・削除処理へ
          // 紛れ込むことはない。
          const configSync = await resolveConfigMerge(
            targetDir,
            templateDir,
            zikuConfigPullAction(plan.config),
          );
          const configWrite = configContentToWrite(configSync);
          const { autoUpdate, conflicts, deletedWithLocalEdits } = plan.files;

          const changes = planPullChanges({ files: plan.files, hashes, configSync });

          if (changes.totalChanges === 0 && !changes.rewriteLock) {
            log.success("Already up to date");
            outro("No changes needed");
            return;
          }

          if (changes.totalChanges > 0) {
            logPullSummary({ ...plan.files, deletedFiles: changes.deletableFiles });
          }

          if (args.dryRun) {
            await previewPull({
              targetDir,
              templateDir,
              lock,
              conflicts,
              deletedFiles: changes.deletableFiles,
              deletedWithLocalEdits,
              configWrite,
              flags: approvalFlags,
            });
            return;
          }

          // ベースの解決は、ファイルへ書き込む前に済ませる。トークンが拒否されていれば
          // ここで失敗するので、ワークツリーも lock も手つかずのまま止まり、トークンを
          // 直して実行し直せばよい状態になる。書き込みの後ろに置くと、更新済みのファイルと
          // 解決待ちの記録を残したまま lock だけ書けずに終わる。
          const latestRefOption = await runCommandEffect(resolveBaseRef);

          // 中断経路（markMerging）と確定経路（markSynced）が書くベースは、削除を適用した
          // かどうか以外すべて同じ。両方をこの 1 つの計算へ通すことで、片方だけ直して
          // ベースがずれる事故（{@link baseAfterDeletions} が最も避けたい失敗）を作れなくする。
          const syncBaseAfter = (appliedDeletions: ReadonlySet<RepoRelPath>): SyncPoint =>
            nextSyncBase({
              advancedBase: changes.advancedBase,
              previousBase: hashes.baseHashes,
              localHashes: hashes.localHashes,
              deletions: { candidates: changes.deletionCandidates, applied: appliedDeletions },
              resolvedRef: Option.getOrUndefined(latestRefOption),
              recordedRef: baseCommitSha(lock),
            });

          // 自動更新・新規追加・ziku.jsonc union 同期をまとめて適用
          await runCommandEffect(
            applyPullUpdates({
              autoUpdate,
              newFiles: plan.files.newFiles,
              configWrite,
              targetDir,
              templateDir,
            }),
          );

          // コンフリクト解決
          const unresolvedConflicts = await runCommandEffect(
            resolveConflicts(conflicts, { targetDir, templateDir, lock }),
          );

          const [firstConflict, ...restConflicts] = unresolvedConflicts;
          if (firstConflict !== undefined) {
            const pendingConflicts: PendingConflicts = [firstConflict, ...restConflicts];
            // 解決待ちで抜けるこの経路は、削除の問い合わせより手前にある。削除は 1 件も
            // 適用していないので、候補すべてのベースが据え置かれる。
            await saveLock(
              targetDir,
              markMerging(lock, syncBaseAfter(new Set()), pendingConflicts),
            );
            outro("Merge paused — resolve conflicts then run `ziku pull --continue`");
            return;
          }

          // 削除されたファイルを処理（plan.files に ziku.jsonc は入らない）
          const appliedDeletions = new Set<RepoRelPath>();
          if (changes.deletableFiles.length > 0) {
            for (const path of await runCommandEffect(
              handleDeletedFiles(changes.deletableFiles, targetDir, approvalFlags),
            )) {
              appliedDeletions.add(path);
            }
          }

          if (deletedWithLocalEdits.length > 0) {
            for (const path of await runCommandEffect(
              handleDeletedWithLocalEdits(deletedWithLocalEdits, targetDir, approvalFlags),
            )) {
              appliedDeletions.add(path);
            }
          }

          await saveLock(targetDir, markSynced(lock, syncBaseAfter(appliedDeletions)));

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
 * ローカルとテンプレートの内容を読むところまでがここの仕事で、結末をどう lock と書き込みへ
 * 反映するかは {@link ZikuConfigMergeResult} を受け取る `pull-plan.ts` 側が決める。
 */
function resolveConfigMerge(
  targetDir: AbsPath,
  templateDir: AbsPath,
  action: ZikuConfigPullAction,
): Promise<ZikuConfigMergeResult> {
  return match(action)
    .with({ _tag: "Skip" }, (): Promise<ZikuConfigMergeResult> => Promise.resolve({ _tag: "Skip" }))
    .with({ _tag: "UnionMerge" }, async (): Promise<ZikuConfigMergeResult> => {
      const merged = await computeMergedZikuConfig({ targetDir, templateDir });
      const currentLocal = await readFile(joinAbs(targetDir, ZIKU_CONFIG_FILE), "utf-8");
      const baseHash = hashContent(merged);
      return merged === currentLocal
        ? { _tag: "BaseOnly", baseHash }
        : { _tag: "Write", baseHash, content: merged };
    })
    .exhaustive();
}

/**
 * pull の適用フェーズ（autoUpdate コピー・newFiles 追加・ziku.jsonc の union 書き込み）を
 * まとめて実行する。run() 本体の分岐数（複雑度）を抑えるために切り出す。
 */
function applyPullUpdates(opts: {
  autoUpdate: readonly RepoRelPath[];
  newFiles: readonly RepoRelPath[];
  configWrite: string | undefined;
  targetDir: AbsPath;
  templateDir: AbsPath;
}): Effect.Effect<void> {
  return Effect.gen(function* () {
    yield* applyTemplateFiles(opts.autoUpdate, opts.templateDir, opts.targetDir);
    if (opts.autoUpdate.length > 0) {
      log.success(`Updated ${opts.autoUpdate.length} file(s)`);
    }

    yield* applyTemplateFiles(opts.newFiles, opts.templateDir, opts.targetDir);
    if (opts.newFiles.length > 0) {
      log.success(`Added ${opts.newFiles.length} new file(s)`);
    }

    // ziku.jsonc を加法 union で同期（テンプレの追加は取り込み、削除は伝播しない）。
    if (opts.configWrite !== undefined) {
      yield* writeFileEnsureDir(joinAbs(opts.targetDir, ZIKU_CONFIG_FILE), opts.configWrite);
      log.success(`Merged ${pc.cyan(ZIKU_CONFIG_FILE)}`);
    }
  });
}

/**
 * テンプレートの更新（autoUpdate / newFiles）をローカルへ置く。
 *
 * 読むのは走査した直後のテンプレートなので、ここでファイルが消えているのは実行中にテンプレート
 * のツリーが変わった場合だけ。ユーザーが選び直せる失敗ではないため defect として運び、元の
 * 例外をそのまま見せる。書き込んだ内容のハッシュは使わない（次のベースはテンプレートを走査した
 * ハッシュから決まる）。
 */
function applyTemplateFiles(
  files: readonly RepoRelPath[],
  templateDir: AbsPath,
  targetDir: AbsPath,
): Effect.Effect<void> {
  return copyTemplateFiles({
    files,
    templateDir,
    targetDir,
    onUnreadable: (_file, cause) => cause,
  }).pipe(Effect.orDie, Effect.asVoid);
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

  const previewUnresolved = await runCommandEffect(
    resolveConflicts(params.conflicts, {
      targetDir: params.targetDir,
      templateDir: params.templateDir,
      lock: params.lock,
      dryRun: true,
    }),
  );

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
 * テンプレートの内容でローカルを置き換え、書き込んだ内容のハッシュを返す。
 *
 * 取り込み（autoUpdate / newFiles）と `--continue` の「テンプレートを取る」は、どちらも
 * 「テンプレートのバイト列をそのままローカルへ置く」操作なのでこの 1 本に集約する。
 *
 * 内容をバイト列のまま運ぶ。テンプレートの画像やフォントを utf-8 の文字列として読み書き
 * すると、不正バイトが U+FFFD へ置き換わってファイルが壊れる。ハッシュも同じバイト列から
 * 計算するので、ディスクを読み直したときの値と一致する。
 *
 * @param onUnreadable テンプレート側を読めなかったときの失敗。何が起きているかが経路ごとに
 *   違う（取り込み中なら実行中にテンプレートが変わった予期しない事象、`--continue` なら
 *   ユーザーがローカルを残す側で選び直せる失敗）ので、失敗の作り方だけを呼び出し側が渡す。
 * @param onCopied 1 ファイル書き終えるたびに呼ぶ通知。どのファイルを置き換えたかを都度
 *   見せる経路だけが渡す。
 * @returns 置き換えたファイルと、書き込んだ内容のハッシュ。
 */
function copyTemplateFiles<E>(params: {
  readonly files: readonly RepoRelPath[];
  readonly templateDir: AbsPath;
  readonly targetDir: AbsPath;
  readonly onUnreadable: (file: RepoRelPath, cause: unknown) => E;
  readonly onCopied?: (file: RepoRelPath) => void;
}): Effect.Effect<HashMap, E> {
  return Effect.gen(function* () {
    const written: HashMap = {};
    for (const file of params.files) {
      const bytes = yield* Effect.tryPromise({
        try: () => readFile(joinAbs(params.templateDir, file)),
        catch: (cause) => params.onUnreadable(file, cause),
      });
      yield* writeFileEnsureDir(joinAbs(params.targetDir, file), bytes);
      written[file] = hashBytes(bytes);
      params.onCopied?.(file);
    }
    return written;
  });
}

/**
 * コンフリクトファイルのマージを試み、未解決のものを経路付きで返す。
 *
 * ループとベース取得は `mergeConflictFiles` が持つ。ここが担うのは pull 固有の後処理、
 * つまり「マージできた内容をローカルへ書き戻し、結末をユーザーへ伝える」ことだけ。
 */
function resolveConflicts(
  conflicts: readonly RepoRelPath[],
  ctx: {
    targetDir: AbsPath;
    templateDir: AbsPath;
    lock: ResumableLockState;
    dryRun?: boolean;
  },
): Effect.Effect<readonly PendingConflict[]> {
  const dryRun = ctx.dryRun ?? false;

  return Effect.gen(function* () {
    const unresolvedConflicts = yield* mergeConflictFiles({
      conflicts,
      targetDir: ctx.targetDir,
      templateDir: ctx.templateDir,
      lock: ctx.lock,
      onFileResult: ({ file, outcome }) =>
        applyMergeOutcome({ file, outcome, targetDir: ctx.targetDir, dryRun }),
    });

    if (unresolvedConflicts.length > 0 && !dryRun) {
      log.warn("Some files have conflicts. Resolve them, then run `ziku pull --continue`");
    }

    return unresolvedConflicts;
  });
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
 * テンプレートで削除され、ローカルも base のままのファイルを処理する。
 *
 * @returns 実際にローカルから削除したファイル。残したものはベースを据え置く
 *   （{@link baseAfterDeletions}）。
 */
function handleDeletedFiles(
  deletedFiles: readonly RepoRelPath[],
  targetDir: AbsPath,
  flags: PullApprovalFlags,
): Effect.Effect<ReadonlySet<RepoRelPath>> {
  return Effect.gen(function* () {
    const filesToDelete = yield* match(resolveDeletionPolicy(flags))
      .with("deleteAll", (): Effect.Effect<readonly RepoRelPath[]> => {
        log.info(`Deleting ${deletedFiles.length} file(s) removed from template...`);
        return Effect.succeed(deletedFiles);
      })
      .with("keepAll", (): Effect.Effect<readonly RepoRelPath[]> => {
        log.warn(
          `Kept ${deletedFiles.length} file(s) removed from the template — --yes skips prompts but does not approve deletion. Re-run with --force to delete them.`,
        );
        return Effect.succeed([]);
      })
      .with(
        "askUser",
        (): Effect.Effect<readonly RepoRelPath[]> =>
          Effect.promise(() => selectDeletedFiles(deletedFiles)),
      )
      .exhaustive();

    return yield* deleteSelectedFiles(filesToDelete, targetDir);
  });
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
function handleDeletedWithLocalEdits(
  files: readonly RepoRelPath[],
  targetDir: AbsPath,
  flags: PullApprovalFlags,
): Effect.Effect<ReadonlySet<RepoRelPath>> {
  return Effect.gen(function* () {
    if (isNonInteractive(flags)) {
      log.warn(
        `Kept ${files.length} file(s) removed from the template because they have local edits. Run 'ziku pull' without --force / --yes to choose which to delete.`,
      );
      return new Set<RepoRelPath>();
    }

    log.warn(
      `${files.length} file(s) removed from the template have local edits — select explicitly to delete:`,
    );
    const filesToDelete = yield* Effect.promise(() => selectDeletedFilesWithLocalEdits(files));

    const deleted = yield* deleteSelectedFiles(filesToDelete, targetDir);

    const kept = files.filter((f) => !deleted.has(f));
    if (kept.length > 0) {
      log.info(`Kept ${kept.length} locally edited file(s).`);
    }

    return deleted;
  });
}

/**
 * 選択された削除対象をローカルから削除する。削除できないファイルは警告のみで続行する。
 *
 * @returns 実際に消えたファイル。消せなかったファイルはローカルに残っているため、
 *   呼び出し側はベースを進めてはいけない。
 */
function deleteSelectedFiles(
  files: readonly RepoRelPath[],
  targetDir: AbsPath,
): Effect.Effect<ReadonlySet<RepoRelPath>> {
  return Effect.gen(function* () {
    const deleted = new Set<RepoRelPath>();
    for (const file of files) {
      const removed = yield* Effect.tryPromise(async () => {
        await rm(joinAbs(targetDir, file), { force: true });
        log.success(`Deleted: ${file}`);
        return true;
      }).pipe(
        Effect.orElseSucceed(() => {
          log.warn(`Could not delete: ${file}`);
          return false;
        }),
      );
      if (removed) deleted.add(file);
    }
    return deleted;
  });
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

  const stillConflicted = await runCommandEffect(
    findRemainingMarkers(targetDir, lock.merge.conflicts.filter(hasReadableText)),
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

/**
 * ローカルに残っているコンフリクトマーカーを探す。
 *
 * 解決済みかどうかはディスクの現在の内容だけが決める。ユーザーが手で編集した後なので、
 * マージ時点で得た位置情報は既にずれている。読み直して今のブロック位置を提示する。
 *
 * ziku がマーカーを書いていない `noBase` も走査する。ユーザーが自分でマーカーを書いた
 * まま再開することがあり、そのままテンプレートへ送らせないため。
 */
function findRemainingMarkers(
  targetDir: AbsPath,
  conflicts: readonly PendingConflict[],
): Effect.Effect<Array<{ file: RepoRelPath; regions: readonly ConflictRegion[] }>> {
  return Effect.gen(function* () {
    const stillConflicted: Array<{ file: RepoRelPath; regions: readonly ConflictRegion[] }> = [];
    for (const { path } of conflicts) {
      const contentOption = yield* readFileSafe(joinAbs(targetDir, path)).pipe(Effect.option);
      if (Option.isNone(contentOption)) continue;
      const regions = findConflictRegions(contentOption.value);
      if (regions.length > 0) stillConflicted.push({ file: path, regions });
    }
    return stillConflicted;
  });
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
 * - GitHub ソースで SHA が未記録: API へ到達できないまま中断した場合で、ソースの取得先をもう一度
 *   辿るしかない。取得先の決め方は {@link resolveGitHubFetchSource} に合わせる。ここだけ ref を
 *   省いて giget の既定へ倒すと、書き込んだ内容とベースが別のブランチのツリーを指す。
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
      const fetchSource: Effect.Effect<string, ZikuFailure> =
        ref === undefined
          ? resolveGitHubFetchSource(l.source).pipe(
              Effect.map((target) => buildTemplateSource(target.pinned)),
              Effect.mapError(toZikuFailure),
            )
          : Effect.succeed(buildCommitPinnedSource(l.source, ref));
      return runCommandEffect(
        fetchSource.pipe(
          Effect.flatMap((source) =>
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
            }),
          ),
          Effect.map(({ templateDir, cleanup }) => ({ dir: templateDir, cleanup })),
        ),
      );
    })
    .exhaustive();
}

/**
 * 「テンプレートを取る」と選ばれたファイルを、テンプレートの内容で置き換える。
 *
 * 取り寄せたテンプレートにファイルが無い場合は失敗として返す。書き込む内容が無いまま
 * 進めると、ローカルを残したのにベースだけがテンプレート側へ前進する。ユーザーはローカルを
 * 残す側で選び直せるので、失敗として渡して判断材料にする。
 *
 * @returns 置き換えたファイルと、書き込んだ内容のハッシュ。呼び出し側がベースとして確定する。
 */
function copyFromTemplate(
  files: readonly RepoRelPath[],
  templateDir: AbsPath,
  targetDir: AbsPath,
): Effect.Effect<HashMap, ZikuFailure> {
  return copyTemplateFiles({
    files,
    templateDir,
    targetDir,
    onUnreadable: (file, cause) =>
      zikuFailure({ kind: "TemplateFileMissing", path: file }, { cause }),
    onCopied: (file) => log.success(`Took the template version: ${pc.cyan(file)}`),
  });
}

/**
 * 取り込む変更の一覧と内訳を表示する。
 *
 * 受け取るのは行として出す分類だけ。ローカルにしか無いファイルと差分の無いファイルは pull が
 * 何もしない対象なので、渡されても出す行が無い。
 */
function logPullSummary(classification: {
  autoUpdate: readonly RepoRelPath[];
  newFiles: readonly RepoRelPath[];
  conflicts: readonly RepoRelPath[];
  deletedFiles: readonly RepoRelPath[];
  deletedWithLocalEdits: readonly RepoRelPath[];
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
