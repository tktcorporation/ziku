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
  withConfigTracked,
} from "../utils/ziku-config";
import { loadCommandContext, runCommandEffect, toZikuError } from "../services/command-context";
import { downloadBaseForMerge, mergeOneFile } from "../utils/merge";
import { computeMergedZikuConfig } from "../utils/config-merge";
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
    {
      file: ZIKU_CONFIG_FILE,
      location: "template",
      op: "update",
      note: "ローカルで追加したパターンをテンプレの ziku.jsonc へ加法 union マージで伝播",
    },
    { file: LOCK_FILE, location: "local", op: "update", note: "baseHashes を更新" },
  ],
  notes: [
    "`ziku.jsonc` 自体が追跡ファイルとして同期対象に含まれる。`ziku track` で追加したローカルパターンは、push 時にテンプレートの `ziku.jsonc` へ加法 union マージで伝播する（pull と双方向）。パターンの削除は自動伝播しない。",
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

      // ziku.jsonc が衝突解決で union マージされた場合、push される内容はローカルの生
      // 内容ではなく union 結果になる。ローカルを更新しないと、テンプレ・ローカルが
      // 乖離したまま baseHashes をテンプレ（union）へ進めてしまい、次回 push で
      // ローカルが localOnly 判定 → テンプレ側の追加分を上書きで落とす（codex P2）。
      // ローカルにも merged 内容を書き戻して local==template==base を保つ。
      const mergedConfig = target.files.find((f) => f.path === ZIKU_CONFIG_FILE);
      if (mergedConfig) {
        const localConfigPath = join(projectDir, ZIKU_CONFIG_FILE);
        await mkdir(dirname(localConfigPath), { recursive: true });
        await writeFile(localConfigPath, mergedConfig.content, "utf-8");
      }

      // lock.json の baseHashes を更新（テンプレート側のハッシュを再計算）。
      // 新規追跡ファイルと ziku.jsonc を含む effectivePatterns で計算するため、
      // 追跡したファイルも ziku.jsonc も baseHashes に入る（push 後はテンプレと一致する）。
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
      // `.ziku/ziku.jsonc` 自体を追跡対象に含める。これにより `ziku track` で
      // 追加したローカルパターンが、加法 union マージ経由でテンプレートの ziku.jsonc へ
      // 伝播する（孤児化バグの修正）。
      include: withConfigTracked(config.include),
      exclude: config.exclude ?? [],
    };

    // ガードは生の config.include で判定する（patterns.include は ziku.jsonc を
    // 常に含むため 0 にならない）。
    if (config.include.length === 0) {
      log.warn("No patterns configured");
      await cleanup();
      return;
    }

    await withFinally(async () => {
      // ─── 共通: 差分検出 + ファイル選択 ───

      const mergedContents = new Map<string, string>();

      // ─── 未追跡ファイルの追跡フロー ───
      // 検知・選択・include へのマージは classify より「前」に行う必要がある。
      // classify が pushableFilePaths を確定するため、ここで include を広げておかないと
      // 新規追跡ファイルが push 対象に乗らない。永続化（saveZikuConfig）は push 成功後に行う。
      const { effectivePatterns, newlyTrackedPaths } = await resolveUntrackedTracking(
        targetDir,
        patterns,
        { yes: args.yes as boolean, dryRun: args.dryRun as boolean },
      );

      // 分類 + auto-merge。未解決の衝突は控えておき、push 対象に含めようとした時だけ中断する。
      // ziku.jsonc の加法 union マージは classifyAndResolveConflicts 内で処理する。
      const { pushableFilePaths, unresolvedConflicts } = await classifyAndResolveConflicts({
        targetDir,
        templateDir,
        source,
        lock,
        patterns: effectivePatterns,
        mergedContents,
      });

      log.step("Detecting changes...");

      const diff = await withSpinner("Analyzing differences...", () =>
        detectDiff({ targetDir, templateDir, patterns: effectivePatterns }),
      );

      let pushableFiles = diff.files.filter(
        (f) =>
          (f.type === "added" || f.type === "modified" || f.type === "deleted") &&
          pushableFilePaths.has(f.path),
      );

      // 未解決の衝突は既定では push しない。巻き添えで他ファイルを止めず、明示的に
      // 選択された場合だけ後段で中断する。ここでは存在を知らせて pull での解決を促す。
      if (unresolvedConflicts.size > 0) {
        log.warn(
          `${unresolvedConflicts.size} file(s) have unresolved conflicts (excluded by default):`,
        );
        for (const file of unresolvedConflicts) log.message(`  ${pc.yellow("!")} ${file}`);
        log.info(
          "Run `ziku pull` to resolve them, then push. Selecting them here will stop the push.",
        );
      }

      if (pushableFiles.length === 0) {
        log.info("No changes to push");
        log.step("Current status:");
        logDiffSummary(diff.files);
        return;
      }

      if (args.dryRun) {
        log.info("Dry run mode");

        // #81: dry-run プレビューを実 push と一致させる。
        // 旧実装は `--files` 適用前の全 diff を表示していたため、実際に push される
        // 集合とプレビューが食い違っていた。実 push と同じフィルタ規則
        // （--files 指定・未解決衝突の除外・削除の既定除外）を適用して
        // 「実際に push される集合」を表示する。対話選択は dry-run では行わない。
        const filesArg = args.files as string | undefined;
        let previewFiles: FileDiff[];
        if (filesArg) {
          const { filtered, notFound } = filterByFilesArg(pushableFiles, filesArg);
          if (notFound.length > 0) log.warn(`Files not found: ${notFound.join(", ")}`);
          previewFiles = filtered;
        } else {
          // --files 未指定時は対話選択の既定集合（selectPushFiles の initialValues と
          // 同じ規則）を非対話で再現する。
          previewFiles = defaultPushSelection(pushableFiles, {
            includeDeletions: args.includeDeletions as boolean,
            conflictedPaths: unresolvedConflicts,
          });
        }

        log.step("Files that would be pushed:");
        if (previewFiles.length === 0) {
          log.info("No files match the current selection — nothing would be pushed.");
        } else {
          logDiffSummary(previewFiles);
        }

        // 未解決の衝突を --files で明示選択した場合、実 push は中断する（unresolvedConflictError）。
        // dry-run でも同じ予告を出して挙動を一致させる。
        const selectedConflicts = previewFiles.filter((f) => unresolvedConflicts.has(f.path));
        if (selectedConflicts.length > 0) {
          log.warn(
            `${selectedConflicts.length} selected file(s) have unresolved conflicts and would block the push:`,
          );
          for (const f of selectedConflicts) log.message(`  ${pc.yellow("!")} ${f.path}`);
        }
        return;
      }

      // ファイル選択（未解決の衝突は既定で未選択にし、マークして見せる）
      pushableFiles = await selectFilesToPush(pushableFiles, {
        filesArg: args.files as string | undefined,
        includeDeletions: args.includeDeletions as boolean,
        conflictedPaths: unresolvedConflicts,
      });
      if (pushableFiles.length === 0) return;

      // 未解決の衝突を含めて push しようとした場合は確定的に中断する（解決してから push）。
      const selectedConflicts = pushableFiles.filter((f) => unresolvedConflicts.has(f.path));
      if (selectedConflicts.length > 0) {
        throw unresolvedConflictError(selectedConflicts.map((f) => f.path));
      }

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
    // --dry-run は「除外」ではなくプレビューなので追跡判断をスキップしているだけ。
    // 恒久的に弾かれたと誤読されないよう headline を分ける。
    const headline = args.dryRun
      ? `${untrackedCount} untracked file(s) outside the sync whitelist (dry-run: tracking skipped):`
      : `${untrackedCount} untracked file(s) excluded from push (outside the sync whitelist):`;
    logUntrackedFilesNotice(untrackedByFolder, untrackedCount, { headline });
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
 *
 * 永続化は addIncludePattern による include キーのみの部分更新（jsonc の modify）で行う。
 * exclude やコメント等は保持されるため、push 中に外部編集が入っても include 以外は壊さない。
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
 * `--files` 引数で push 対象を絞り込む純粋関数。
 *
 * dry-run プレビューと実 push の両方で同じフィルタ規則を使うために共有する。
 * 共有しないと「プレビューに出た集合」と「実際に push される集合」が
 * 食い違う（#81 の不具合の原因）。
 *
 * @returns filtered: 指定パスに一致した候補、notFound: 候補に存在しなかった指定パス。
 */
function filterByFilesArg(
  candidates: FileDiff[],
  filesArg: string,
): { filtered: FileDiff[]; notFound: string[] } {
  const requestedPaths = filesArg
    .split(",")
    .map((p) => p.trim())
    .filter(Boolean);
  const availablePaths = new Set(candidates.map((f) => f.path));
  const notFound = requestedPaths.filter((p) => !availablePaths.has(p));
  const requestedSet = new Set(requestedPaths);
  const filtered = candidates.filter((f) => requestedSet.has(f.path));
  return { filtered, notFound };
}

/**
 * 対話選択を経由せずに push 対象の既定集合を算出する（dry-run プレビュー用）。
 *
 * selectPushFiles の initialValues と同じ規則: 未解決の衝突と、
 * --include-deletions でない削除を既定で除外する。実 push の既定選択と
 * プレビューを一致させるために同一の規則を共有する。
 */
function defaultPushSelection(
  candidates: FileDiff[],
  opts: { includeDeletions: boolean; conflictedPaths: Set<string> },
): FileDiff[] {
  return candidates.filter(
    (f) => !opts.conflictedPaths.has(f.path) && (opts.includeDeletions || f.type !== "deleted"),
  );
}

/**
 * push 対象ファイルを選択する。
 * --files 指定時はフィルタリング、未指定時はインタラクティブ選択。
 * 選択結果が空の場合はログを出力して空配列を返す。
 */
async function selectFilesToPush(
  candidates: FileDiff[],
  opts: {
    filesArg: string | undefined;
    includeDeletions: boolean;
    conflictedPaths: Set<string>;
  },
): Promise<FileDiff[]> {
  if (opts.filesArg) {
    const { filtered, notFound } = filterByFilesArg(candidates, opts.filesArg);
    if (notFound.length > 0) log.warn(`Files not found: ${notFound.join(", ")}`);
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
    conflictedPaths: opts.conflictedPaths,
  });
  if (selected.length === 0) {
    log.info("No files selected. Cancelled.");
  }
  return selected;
}

// ─── 分類 + コンフリクト解決 ───

/**
 * ローカル/テンプレート/ベースのハッシュを比較して push 対象を分類し、衝突は auto-merge を試みる。
 *
 * - localOnly / conflicts / deletedLocally を push 対象候補（pushableFilePaths）に含める。
 * - autoUpdate（テンプレートのみ変更）は push 対象外としてスキップ理由を表示する。
 * - 衝突は auto-merge を試行し、成功分は mergedContents に保存、失敗分は unresolvedConflicts に返す。
 *
 * 未解決の衝突があってもここでは中断しない（巻き添えで他ファイルの push を止めないため）。
 */
async function classifyAndResolveConflicts(params: {
  targetDir: string;
  templateDir: string;
  source: TemplateSource;
  lock: { baseHashes?: Record<string, string>; baseRef?: string };
  patterns: { include: string[]; exclude: string[] };
  mergedContents: Map<string, string>;
}): Promise<{ pushableFilePaths: Set<string>; unresolvedConflicts: Set<string> }> {
  const { classifyFiles } = await import("../utils/merge");

  const templateHashes = await hashFiles(
    params.templateDir,
    params.patterns.include,
    params.patterns.exclude,
  );
  const localHashes = await hashFiles(
    params.targetDir,
    params.patterns.include,
    params.patterns.exclude,
  );

  const classification = classifyFiles({
    baseHashes: params.lock.baseHashes ?? {},
    localHashes,
    templateHashes,
  });

  const pushableFilePaths = new Set<string>();
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

  // ziku.jsonc が push 対象なら、常に加法 union を送る（localOnly でも生のローカル
  // 内容を送らない）。生のローカルを送ると、ローカルがパターンを削除していた場合に
  // テンプレ側のパターンも消してしまい「削除は自動伝播しない」方針に反する（codex P2）。
  // union 内容を mergedContents に入れておくと、後段の files 構築で採用される。
  // ここで先に処理し、diff3（mergeOneFile）には ziku.jsonc を渡さない。
  if (pushableFilePaths.has(ZIKU_CONFIG_FILE)) {
    const merged = await computeMergedZikuConfig({
      targetDir: params.targetDir,
      templateDir: params.templateDir,
    });
    params.mergedContents.set(ZIKU_CONFIG_FILE, merged);
  }

  const unresolvedConflicts = new Set<string>();
  // ziku.jsonc は上で union 解決済みなので diff3 の対象から外す。
  const conflictsToResolve = classification.conflicts.filter((f) => f !== ZIKU_CONFIG_FILE);
  if (conflictsToResolve.length > 0) {
    const unresolved = await resolveConflicts(conflictsToResolve, {
      targetDir: params.targetDir,
      templateDir: params.templateDir,
      source: params.source,
      lock: params.lock,
      mergedContents: params.mergedContents,
    });
    for (const file of unresolved) unresolvedConflicts.add(file);
  }

  return { pushableFilePaths, unresolvedConflicts };
}

// ─── コンフリクト解決 ───

/**
 * push 時のコンフリクト解決（auto-merge の試行）。
 *
 * ファイル読み込み・マージ・ベースダウンロードは conflict-io の共通ユーティリティを使い、
 * push 固有の処理（mergedContents への保存）だけをここで行う。
 * pull との違い: ローカルに書き込まず、auto-merge 成功分のみ mergedContents に保存する。
 *
 * 自動マージできなかったファイルのパス一覧を返す。ここでは中断しない。
 * 「未解決の衝突が 1 つでもあれば push 全体を止める」のではなく、未解決ファイルを
 * push 対象から外して非衝突ファイルの push は通し、未解決ファイルが実際に push 対象として
 * 選ばれた場合だけ中断する（呼び出し側の責務）。これによりローカル内容での暗黙の上書きを
 * 防ぎつつ、衝突に巻き込まれない変更まで止めてしまう問題を回避する。
 *
 * @returns auto-merge できなかった未解決ファイルのパス一覧。
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
): Promise<string[]> {
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

  return withFinally(
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

      return unresolved;
    },
    () => baseResult?.cleanup?.(),
  );
}

/**
 * 未解決の衝突を push 対象に含めようとしたときの中断エラーを生成する。
 *
 * 未解決ファイルはマージ結果ではなくローカルの内容がそのまま push され、テンプレートの
 * 更新を黙って上書きしてしまう（mergedContents に保存されないため localContent が使われる）。
 * これを防ぐため、未解決ファイルが選択された場合は確定的に中断し、`ziku pull` での解決を促す。
 */
function unresolvedConflictError(files: string[]): ZikuError {
  return new ZikuError(
    `${files.length} selected file(s) have conflicts that couldn't be auto-merged`,
    "Resolve these conflicts before pushing:\n" +
      files.map((f) => `  • ${f}`).join("\n") +
      "\n\nRun `ziku pull` to bring in the template changes and resolve the conflicts, then push again.",
  );
}
