import { existsSync } from "node:fs";
import { mkdir, rm, writeFile } from "node:fs/promises";
import { defineCommand } from "citty";
import { Effect } from "effect";
import { dirname, join, resolve } from "pathe";
import { P, match } from "ts-pattern";
import { withFinally } from "../effect-helpers";
import { ZikuError } from "../errors";
import type { FileDiff, TemplateSource } from "../modules/schemas";
import { LOCK_FILE, saveLock } from "../utils/lock";
import {
  ZIKU_CONFIG_FILE,
  addIncludePattern,
  loadZikuConfig,
  saveZikuConfig,
} from "../utils/ziku-config";
import { loadCommandContext, runCommandEffect, toZikuError } from "../services/command-context";
import { downloadBaseForMerge, mergeOneFile } from "../utils/merge";
import type { CommandContextShape } from "../services/command-context";
import type { CommandLifecycle } from "../docs/lifecycle-types";
import { SYNCED_FILES } from "../docs/lifecycle-types";
import {
  confirmAction,
  generatePrBody,
  generatePrTitle,
  inputGitHubToken,
  inputPrBody,
  inputPrTitle,
  logUntrackedFilesNotice,
  selectPushFiles,
  selectUntrackedToTrack,
} from "../ui/prompts";
import { calculateDiffStats, formatStats } from "../ui/diff-view";
import { intro, log, logDiffSummary, outro, pc, withSpinner } from "../ui/renderer";
import { detectDiff } from "../utils/diff";
import { createPullRequest, getGitHubToken } from "../utils/github";
import { hashFiles } from "../utils/hash";
import { detectAndUpdateReadme } from "../utils/readme";
import { detectUntrackedFiles, getTotalUntrackedCount } from "../utils/untracked";

export const pushLifecycle: CommandLifecycle = {
  name: "push",
  description: "Push local changes to template (GitHub: PR / local: direct copy)",
  ops: [
    { file: ZIKU_CONFIG_FILE, location: "local", op: "read", note: "patterns を取得" },
    {
      file: ZIKU_CONFIG_FILE,
      location: "local",
      op: "update",
      note: "選択した未追跡ファイルを include に追記（push 成功後）",
    },
    { file: LOCK_FILE, location: "local", op: "read", note: "source, baseRef, baseHashes を取得" },
    { file: SYNCED_FILES, location: "local", op: "read", note: "ローカルの変更を検出" },
    {
      file: SYNCED_FILES,
      location: "template",
      op: "read",
      note: "テンプレートと差分検出・3-way マージ",
    },
    {
      file: SYNCED_FILES,
      location: "template",
      op: "update",
      note: "GitHub: PR を作成 / ローカル: ファイルを直接コピー",
    },
    { file: LOCK_FILE, location: "local", op: "update", note: "baseHashes を更新" },
  ],
};

// ─── Push 戦略: GitHub / Local を Effect で分離 ───

interface PushTarget {
  readonly files: Array<{ path: string; content: string }>;
  readonly deletions: Array<{ path: string }>;
  readonly pushableFiles: FileDiff[];
}

/**
 * GitHub へ push: PR を作成する。
 *
 * トークン取得 → タイトル/本文 → サマリー表示 → 確認 → PR 作成
 *
 * @returns PR を作成したら true、確認でキャンセルされたら false。
 *   呼び出し側はこの結果で「追跡の永続化を行うか」を判断する（push 成功後のみ永続化する）。
 */
function pushToGitHub(
  ghSource: { owner: string; repo: string; ref?: string },
  target: PushTarget,
  ctx: CommandContextShape,
  args: { message?: string; edit?: boolean; yes?: boolean },
): Effect.Effect<boolean, ZikuError> {
  return Effect.tryPromise({
    try: async () => {
      let token = getGitHubToken();
      if (!token) {
        token = await inputGitHubToken();
      }

      const suggestedTitle = generatePrTitle(target.pushableFiles);
      const suggestedBody = generatePrBody(target.pushableFiles);

      const { title, body } = await match(args)
        .with({ message: P.string }, ({ message }) => ({
          title: message,
          body: suggestedBody,
        }))
        .with({ edit: true }, async () => ({
          title: await inputPrTitle(suggestedTitle),
          body: await inputPrBody(suggestedBody),
        }))
        .otherwise(() => ({ title: suggestedTitle, body: suggestedBody }));

      const readmeResult = await detectAndUpdateReadme(ctx.templateDir, ctx.templateDir);
      const files = [...target.files];
      if (readmeResult?.updated) {
        files.push({ path: "README.md", content: readmeResult.content });
      }

      // サマリー表示
      const baseBranch = ghSource.ref || "main";
      const baseHashStr = ctx.lock.baseRef
        ? `  ${pc.dim(`since ${ctx.lock.baseRef.slice(0, 7)}`)}`
        : "";
      logPushSummary(
        `${ghSource.owner}/${ghSource.repo}`,
        `→ ${baseBranch}`,
        baseHashStr,
        title,
        target.pushableFiles,
        files,
        target.deletions,
      );

      if (!args.yes) {
        const confirmed = await confirmAction("Create PR?", { initialValue: true });
        if (!confirmed) {
          log.info("Cancelled.");
          return false;
        }
      }

      log.step("Creating pull request...");
      const result = await withSpinner("Creating PR on GitHub...", () =>
        createPullRequest(token, {
          owner: ghSource.owner,
          repo: ghSource.repo,
          files,
          deletions: target.deletions,
          title,
          body,
          baseBranch,
        }),
      );

      log.success("Pull request created!");
      log.message(
        [
          `${pc.dim("To")} ${pc.bold(`${ghSource.owner}/${ghSource.repo}`)}`,
          `  ${ctx.lock.baseRef ? `${pc.dim(ctx.lock.baseRef.slice(0, 7))}..` : ""}${pc.green(result.branch)}  ${pc.dim(`(${files.length + target.deletions.length} file${files.length + target.deletions.length === 1 ? "" : "s"} changed)`)}`,
          "",
          `  ${pc.bold(`PR #${result.number}`)}  ${pc.cyan(result.url)}`,
        ].join("\n"),
      );
      outro(`Review and merge at ${pc.cyan(result.url)}`);
      return true;
    },
    catch: (e) => (e instanceof ZikuError ? e : new ZikuError("Push failed", String(e))),
  });
}

/**
 * ローカルテンプレートへ push: ファイルを直接コピーする。
 *
 * PR の代わりにテンプレートディレクトリにファイルを書き込み、
 * lock.json の baseHashes を更新する。
 *
 * @param patterns baseHashes 再計算に使うパターン。新規追跡ファイルを含む effectivePatterns を
 *   渡すことで、追跡したファイルが baseHashes に反映され、lock と配置のズレを防ぐ。
 * @returns push したら true、確認でキャンセルされたら false。
 */
function pushToLocal(
  localSource: { path: string },
  target: PushTarget,
  ctx: CommandContextShape,
  projectDir: string,
  args: { yes?: boolean },
  patterns: { include: string[]; exclude: string[] },
): Effect.Effect<boolean, ZikuError> {
  return Effect.tryPromise({
    try: async () => {
      logPushSummary(
        localSource.path,
        "(local)",
        "",
        `push ${target.files.length + target.deletions.length} file(s)`,
        target.pushableFiles,
        target.files,
        target.deletions,
      );

      if (!args.yes) {
        const confirmed = await confirmAction("Push to local template?", { initialValue: true });
        if (!confirmed) {
          log.info("Cancelled.");
          return false;
        }
      }

      log.step("Pushing to local template...");

      for (const file of target.files) {
        const destPath = join(localSource.path, file.path);
        const destDir = dirname(destPath);
        if (!existsSync(destDir)) {
          await mkdir(destDir, { recursive: true });
        }
        await writeFile(destPath, file.content, "utf-8");
        log.message(`  ${pc.green("+")} ${file.path}`);
      }

      // 削除対象ファイルを処理
      for (const file of target.deletions) {
        const destPath = join(localSource.path, file.path);
        if (existsSync(destPath)) {
          await rm(destPath, { force: true });
          log.message(`  ${pc.red("-")} ${file.path}`);
        }
      }

      // lock.json の baseHashes を更新（テンプレート側のハッシュを再計算）。
      // 新規追跡ファイルを含む effectivePatterns で計算するため、追跡したファイルも baseHashes に入る。
      const baseHashes = await hashFiles(localSource.path, patterns.include, patterns.exclude);
      await saveLock(projectDir, { ...ctx.lock, baseHashes });

      const totalCount = target.files.length + target.deletions.length;
      log.success(`Pushed ${totalCount} file(s) to ${pc.cyan(localSource.path)}`);
      outro("Push complete");
      return true;
    },
    catch: (e) => (e instanceof ZikuError ? e : new ZikuError("Push failed", String(e))),
  });
}

// ─── サマリー表示 ───

function logPushSummary(
  destination: string,
  branchInfo: string,
  baseHashStr: string,
  title: string,
  pushableFiles: FileDiff[],
  files: Array<{ path: string; content: string }>,
  deletions: Array<{ path: string }> = [],
): void {
  const fileLines: string[] = [];
  // files の content は mergedContent を含むため、detectDiff の localContent ではなく
  // 実際に push される content でサマリーを計算する（PR の差分行数と一致させる）
  const pushedContentMap = new Map(files.map((f) => [f.path, f.content]));
  for (const pf of pushableFiles) {
    const pushedContent = pushedContentMap.get(pf.path);
    const isDeletion = deletions.some((d) => d.path === pf.path);
    if (pushedContent === undefined && !isDeletion) continue;

    // 実際に push される content と templateContent から正しい type と stat を算出
    const effectiveDiff = buildEffectiveDiff(pf, pushedContent);
    // push 内容がテンプレートと同一なら表示不要
    if (effectiveDiff.type === "unchanged") continue;
    const stat = formatFileStat(effectiveDiff);
    const icon = match(effectiveDiff.type)
      .with("added", () => pc.green("+"))
      .with("modified", () => pc.yellow("~"))
      .with("deleted", () => pc.red("-"))
      .exhaustive();
    fileLines.push(`  ${icon} ${pf.path.padEnd(50)} ${stat}`);
  }
  for (const f of files) {
    if (!pushableFiles.some((pf) => pf.path === f.path)) {
      fileLines.push(`  ${pc.green("+")} ${f.path.padEnd(50)} ${pc.dim("(auto-updated)")}`);
    }
  }

  log.message(
    [
      `${pc.dim("To")} ${pc.bold(destination)}  ${pc.dim(branchInfo)}${baseHashStr}`,
      pc.dim("─".repeat(62)),
      ...fileLines,
      pc.dim("─".repeat(62)),
      `  ${pc.dim("Push:")} ${title}`,
    ].join("\n"),
  );
}

/**
 * push される実際のコンテンツに基づいて FileDiff を再構築する。
 *
 * 背景: detectDiff の FileDiff はディスク上の localContent を持つが、
 * auto-merge 後の push では mergedContent が使われる。PR の差分行数と
 * 一致させるため、pushed content と templateContent で type を再判定する。
 */
function buildEffectiveDiff(original: FileDiff, pushedContent: string | undefined): FileDiff {
  // 削除の場合はそのまま
  if (pushedContent === undefined) return original;

  const templateContent = original.templateContent;

  // templateContent がない → テンプレートに新規追加
  if (templateContent === undefined) {
    return { path: original.path, type: "added", localContent: pushedContent };
  }

  // push される内容がテンプレートと同一 → 変更なし
  if (pushedContent === templateContent) {
    return { path: original.path, type: "unchanged" };
  }

  // テンプレートと異なる → modified として unified diff で統計計算
  return {
    path: original.path,
    type: "modified",
    localContent: pushedContent,
    templateContent,
  };
}

function formatFileStat(file: FileDiff): string {
  const stats = calculateDiffStats(file);
  return formatStats(stats);
}

// ─── メインコマンド ───

export const pushCommand = defineCommand({
  meta: {
    name: "push",
    description: "Push local changes to the template (PR for GitHub, direct copy for local)",
  },
  args: {
    dir: {
      type: "positional",
      description: "Project directory",
      default: ".",
    },
    dryRun: {
      type: "boolean",
      alias: "n",
      description: "Preview only, don't push",
      default: false,
    },
    message: {
      type: "string",
      alias: "m",
      description: "PR title (GitHub only)",
    },
    yes: {
      type: "boolean",
      alias: ["y", "f"],
      description: "Skip confirmation prompts",
      default: false,
    },
    edit: {
      type: "boolean",
      description: "Edit PR title and description before creating (GitHub only)",
      default: false,
    },
    files: {
      type: "string",
      description: "Comma-separated file paths to include (skips file selection prompt)",
    },
    includeDeletions: {
      type: "boolean",
      description: "Include locally deleted files (default: unselected in interactive mode)",
      default: false,
    },
  },
  async run({ args }) {
    intro("push");

    const targetDir = resolve(args.dir);

    const ctx = await runCommandEffect(
      loadCommandContext(targetDir).pipe(Effect.mapError(toZikuError)),
    );
    const { config, lock, source, templateDir, cleanup } = ctx;

    if (lock.pendingMerge) {
      await cleanup();
      throw new ZikuError(
        "Unresolved merge conflicts from `ziku pull`",
        "Resolve conflicts in these files, then run `ziku pull --continue`:\n" +
          lock.pendingMerge.conflicts.map((f) => `  • ${f}`).join("\n"),
      );
    }

    const patterns = {
      include: config.include,
      exclude: config.exclude ?? [],
    };

    if (patterns.include.length === 0) {
      log.warn("No patterns configured");
      await cleanup();
      return;
    }

    await withFinally(async () => {
      // ─── 共通: 差分検出 + ファイル選択 ───

      const mergedContents = new Map<string, string>();
      const pushableFilePaths: Set<string> = new Set();

      // ─── 未追跡ファイルの追跡フロー ───
      // 検知・選択・include へのマージは classify より「前」に行う必要がある。
      // classify が pushableFilePaths を確定するため、ここで include を広げておかないと
      // 新規追跡ファイルが push 対象に乗らない。永続化（saveZikuConfig）は push 成功後に行う。
      const { effectivePatterns, newlyTrackedPaths } = await resolveUntrackedTracking(
        targetDir,
        patterns,
        { yes: args.yes as boolean, dryRun: args.dryRun as boolean },
      );

      {
        const { classifyFiles } = await import("../utils/merge");

        const templateHashes = await hashFiles(
          templateDir,
          effectivePatterns.include,
          effectivePatterns.exclude,
        );
        const localHashes = await hashFiles(
          targetDir,
          effectivePatterns.include,
          effectivePatterns.exclude,
        );

        const classification = classifyFiles({
          baseHashes: lock.baseHashes ?? {},
          localHashes,
          templateHashes,
        });

        for (const file of classification.localOnly) pushableFilePaths.add(file);
        for (const file of classification.conflicts) pushableFilePaths.add(file);
        for (const file of classification.deletedLocally) pushableFilePaths.add(file);

        if (classification.autoUpdate.length > 0) {
          log.info(
            `Skipping ${classification.autoUpdate.length} file(s) only changed in template (use \`ziku pull\` to sync):`,
          );
          for (const file of classification.autoUpdate) {
            log.message(`  ${pc.dim("↓")} ${pc.dim(file)}`);
          }
        }

        if (classification.conflicts.length > 0) {
          await resolveConflicts(classification.conflicts, {
            targetDir,
            templateDir,
            source,
            lock,
            mergedContents,
          });
        }
      }

      log.step("Detecting changes...");

      const diff = await withSpinner("Analyzing differences...", () =>
        detectDiff({ targetDir, templateDir, patterns: effectivePatterns }),
      );

      let pushableFiles = diff.files.filter(
        (f) =>
          (f.type === "added" || f.type === "modified" || f.type === "deleted") &&
          pushableFilePaths.has(f.path),
      );

      if (pushableFiles.length === 0) {
        log.info("No changes to push");
        log.step("Current status:");
        logDiffSummary(diff.files);
        return;
      }

      if (args.dryRun) {
        log.info("Dry run mode");
        log.step("Files that would be pushed:");
        logDiffSummary(diff.files);
        return;
      }

      // ファイル選択
      pushableFiles = await selectFilesToPush(pushableFiles, {
        filesArg: args.files as string | undefined,
        includeDeletions: args.includeDeletions as boolean,
      });
      if (pushableFiles.length === 0) return;

      const files = pushableFiles
        .filter((f) => f.type !== "deleted")
        .map((f) => ({
          path: f.path,
          content: mergedContents.get(f.path) ?? f.localContent ?? "",
        }));

      const deletions = pushableFiles
        .filter((f) => f.type === "deleted")
        .map((f) => ({ path: f.path }));

      // ─── 分岐: ソース���別に応じた push 戦略 (ts-pattern + Effect) ───

      const pushed = await runCommandEffect(
        match(source)
          .with({ owner: P.string, repo: P.string }, (ghSource) =>
            pushToGitHub(ghSource, { files, deletions, pushableFiles }, ctx, {
              message: args.message as string | undefined,
              edit: args.edit as boolean,
              yes: args.yes as boolean,
            }),
          )
          .with({ path: P.string }, (localSource) =>
            pushToLocal(
              localSource,
              { files, deletions, pushableFiles },
              ctx,
              targetDir,
              { yes: args.yes as boolean },
              effectivePatterns,
            ),
          )
          .exhaustive(),
      );

      // ─── push 成功後に追跡を永続化（M2: 部分適用の回避）───
      // ziku.jsonc の書き換えは push が実際に成功したときだけ行う。push 失敗（throw）や
      // 確認キャンセル（pushed=false）では設定を変えない。
      if (pushed && newlyTrackedPaths.length > 0) {
        const pushedPaths = new Set([...files.map((f) => f.path), ...deletions.map((d) => d.path)]);
        await persistNewlyTracked(targetDir, newlyTrackedPaths, pushedPaths);
      }
    }, cleanup);
  },
});

// ─── 未追跡ファイルの追跡 ───

/**
 * 未追跡ファイルを検知し、追跡対象を決定する。
 *
 * 対話時はユーザーに追跡対象（include 追加）を選択させ、選択分を含めた effectivePatterns を返す。
 * 非対話（--yes）/ プレビュー（--dry-run）時は暗黙追加せず、除外されるファイルを通知する。
 * 暗黙の include 膨張を避けるため、設定変更は人間の明示操作（選択）に限定する。
 *
 * @returns effectivePatterns（追跡選択を反映したパターン。以降の hash/classify/diff に使う）と
 *   newlyTrackedPaths（push 成功後に永続化する候補パス。非対話時は空）。
 */
async function resolveUntrackedTracking(
  targetDir: string,
  patterns: { include: string[]; exclude: string[] },
  args: { yes: boolean; dryRun: boolean },
): Promise<{
  effectivePatterns: { include: string[]; exclude: string[] };
  newlyTrackedPaths: string[];
}> {
  const untrackedByFolder = await detectUntrackedFiles({ targetDir, patterns });
  const untrackedCount = getTotalUntrackedCount(untrackedByFolder);
  if (untrackedCount === 0) {
    return { effectivePatterns: patterns, newlyTrackedPaths: [] };
  }

  if (args.yes || args.dryRun) {
    logUntrackedFilesNotice(untrackedByFolder, untrackedCount, {
      headline: `${untrackedCount} untracked file(s) excluded from push (outside the sync whitelist):`,
    });
    return { effectivePatterns: patterns, newlyTrackedPaths: [] };
  }

  const selected = await selectUntrackedToTrack(untrackedByFolder);
  if (selected.length === 0) {
    return { effectivePatterns: patterns, newlyTrackedPaths: [] };
  }

  return {
    effectivePatterns: {
      include: [...patterns.include, ...selected],
      exclude: patterns.exclude,
    },
    newlyTrackedPaths: selected,
  };
}

/**
 * push 成功後に、新規追跡ファイルを ziku.jsonc の include へ永続化する。
 *
 * 実際に push されたファイルのパターンのみ追記する。これによりファイル選択で外された
 * 追跡候補を除外し、「追跡したのに push していない」状態を作らない。
 * パターン = ファイルパス（個別追跡）の前提。ディレクトリ glob 対応は将来拡張。
 */
async function persistNewlyTracked(
  targetDir: string,
  newlyTrackedPaths: string[],
  pushedPaths: Set<string>,
): Promise<void> {
  const patternsToPersist = newlyTrackedPaths.filter((p) => pushedPaths.has(p));
  if (patternsToPersist.length === 0) return;

  const { rawContent } = await loadZikuConfig(targetDir);
  const updated = addIncludePattern(rawContent, patternsToPersist);
  if (updated === rawContent) return;

  await saveZikuConfig(targetDir, updated);
  log.success(`Tracked ${patternsToPersist.length} new file(s) in ${ZIKU_CONFIG_FILE}`);
}

// ─── ファイル選択 ───

/**
 * push 対象ファイルを選択する。
 * --files 指定時はフィルタリング、未指定時はインタラクティブ選択。
 * 選択結果が空の場合はログを出力して空配列を返す。
 */
async function selectFilesToPush(
  candidates: FileDiff[],
  opts: { filesArg: string | undefined; includeDeletions: boolean },
): Promise<FileDiff[]> {
  if (opts.filesArg) {
    const requestedPaths = opts.filesArg
      .split(",")
      .map((p) => p.trim())
      .filter(Boolean);
    const availablePaths = new Set(candidates.map((f) => f.path));
    const notFound = requestedPaths.filter((p) => !availablePaths.has(p));
    if (notFound.length > 0) log.warn(`Files not found: ${notFound.join(", ")}`);
    const requestedSet = new Set(requestedPaths);
    const filtered = candidates.filter((f) => requestedSet.has(f.path));
    if (filtered.length === 0) {
      log.info("No matching files. Cancelled.");
      return [];
    }
    log.info(`${filtered.length} file(s) selected via --files`);
    return filtered;
  }

  log.step("Selecting files...");
  const selected = await selectPushFiles(candidates, {
    preselectDeletions: opts.includeDeletions,
  });
  if (selected.length === 0) {
    log.info("No files selected. Cancelled.");
  }
  return selected;
}

// ─── コンフリクト解決 ───

/**
 * push 時のコンフリクト解決。
 *
 * ファイル読み込み・マージ・ベースダウンロードは conflict-io の共通ユーティリティを使い、
 * push 固有の処理（mergedContents への保存）だけをここで行う。
 * pull との違い: ローカルに書き込まず、auto-merge 成功分のみ mergedContents に保存する。
 *
 * 自動マージできない衝突が 1 つでも残った場合は ZikuError を throw して push 全体を
 * 確定的に中断する（ローカル内容での暗黙の上書き push を防ぐ）。利用者は `ziku pull` で
 * 衝突を解決してから push し直す。
 */
async function resolveConflicts(
  conflicts: string[],
  ctx: {
    targetDir: string;
    templateDir: string;
    source: TemplateSource;
    lock: { baseRef?: string };
    mergedContents: Map<string, string>;
  },
): Promise<void> {
  const baseInfo = ctx.lock.baseRef
    ? `since ${pc.bold(ctx.lock.baseRef.slice(0, 7))} (your last sync)`
    : "since your last pull/init";
  log.warn(
    `Template updated ${baseInfo} — ${conflicts.length} conflict(s) detected, attempting auto-merge...`,
  );

  const baseResult = await Effect.runPromise(
    downloadBaseForMerge({
      source: ctx.source,
      baseRef: ctx.lock.baseRef,
      targetDir: ctx.targetDir,
    }),
  );

  await withFinally(
    async () => {
      const autoMerged: string[] = [];
      const unresolved: string[] = [];

      for (const file of conflicts) {
        // ベースがない場合は 3-way マージ不可 → unresolved
        // 旧実装ではファイル単位で baseContent の truthy チェックをしていたが、
        // mergeOneFile 内で readFileSafe が空文字列を返すため、ベースに
        // 特定ファイルがない場合は空ベースでのマージ（= conflict マーカー付き）になる。
        // hasConflicts=true → unresolved に分類されるので PR に壊れた内容は送られない。
        if (!baseResult) {
          unresolved.push(file);
          continue;
        }

        const result = await Effect.runPromise(
          mergeOneFile({
            file,
            targetDir: ctx.targetDir,
            templateDir: ctx.templateDir,
            baseTemplateDir: baseResult.templateDir,
          }),
        );

        if (!result.hasConflicts) {
          ctx.mergedContents.set(file, result.content);
          autoMerged.push(file);
        } else {
          unresolved.push(file);
        }
      }

      if (autoMerged.length > 0) {
        log.success(`Auto-merged ${autoMerged.length} file(s):`);
        for (const f of autoMerged) log.message(`  ${pc.green("✓")} ${f}`);
      }

      if (unresolved.length > 0) {
        // 自動マージできなかった衝突が残っている場合は確定的に中断する。
        // ここで続行すると、未解決ファイルはマージ結果ではなくローカルの内容が
        // そのまま push され、テンプレートの更新を黙って上書きしてしまう
        // （mergedContents に保存されないため push.ts:473 で localContent が使われる）。
        // Yes/No で判断を委ねるとこの危険な上書きが実行ごとにブレるので、
        // 「衝突が残る → 必ず止める」という不変条件に固定する。
        // push 冒頭の pendingMerge チェック（pull 側の未解決衝突を弾く）と同じ思想。
        throw new ZikuError(
          `${unresolved.length} file(s) have conflicts that couldn't be auto-merged`,
          "Resolve these conflicts before pushing:\n" +
            unresolved.map((f) => `  • ${f}`).join("\n") +
            "\n\nRun `ziku pull` to bring in the template changes and resolve the conflicts, then push again.",
        );
      }
    },
    () => baseResult?.cleanup?.(),
  );
}
