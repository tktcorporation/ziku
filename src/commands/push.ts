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
import { ZIKU_CONFIG_FILE } from "../utils/ziku-config";
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
  selectPushFiles,
} from "../ui/prompts";
import { calculateDiffStats, formatStats } from "../ui/diff-view";
import { intro, log, logDiffSummary, outro, pc, withSpinner } from "../ui/renderer";
import { detectDiff } from "../utils/diff";
import { createPullRequest, getGitHubToken } from "../utils/github";
import { hashFiles } from "../utils/hash";
import { detectAndUpdateReadme } from "../utils/readme";
import { detectUntrackedFiles } from "../utils/untracked";

export const pushLifecycle: CommandLifecycle = {
  name: "push",
  description: "Push local changes to template (GitHub: PR / local: direct copy)",
  ops: [
    { file: ZIKU_CONFIG_FILE, location: "local", op: "read", note: "patterns を取得" },
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
 */
function pushToGitHub(
  ghSource: { owner: string; repo: string; ref?: string },
  target: PushTarget,
  ctx: CommandContextShape,
  args: { message?: string; edit?: boolean; yes?: boolean },
): Effect.Effect<void, ZikuError> {
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
          return;
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
    },
    catch: (e) => (e instanceof ZikuError ? e : new ZikuError("Push failed", String(e))),
  });
}

/**
 * ローカルテンプレートへ push: ファイルを直接コピーする。
 *
 * PR の代わりにテンプレートディレクトリにファイルを書き込み、
 * lock.json の baseHashes を更新する。
 */
function pushToLocal(
  localSource: { path: string },
  target: PushTarget,
  ctx: CommandContextShape,
  projectDir: string,
  args: { yes?: boolean },
): Effect.Effect<void, ZikuError> {
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
          return;
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

      // lock.json の baseHashes を更新（テンプレート側のハッシュを再計算）
      const patterns = {
        include: ctx.config.include,
        exclude: ctx.config.exclude ?? [],
      };
      const baseHashes = await hashFiles(localSource.path, patterns.include, patterns.exclude);
      await saveLock(projectDir, { ...ctx.lock, baseHashes });

      const totalCount = target.files.length + target.deletions.length;
      log.success(`Pushed ${totalCount} file(s) to ${pc.cyan(localSource.path)}`);
      outro("Push complete");
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
      cleanup();
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
      cleanup();
      return;
    }

    await withFinally(async () => {
      // ─── 共通: 差分検出 + ファイル選択 ───

      const mergedContents = new Map<string, string>();
      const pushableFilePaths: Set<string> = new Set();

      {
        const { classifyFiles } = await import("../utils/merge");

        const templateHashes = await hashFiles(templateDir, patterns.include, patterns.exclude);
        const localHashes = await hashFiles(targetDir, patterns.include, patterns.exclude);

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
            args: { yes: args.yes as boolean },
          });
        }
      }

      if (!args.yes) {
        const untrackedByFolder = await detectUntrackedFiles({ targetDir, patterns });
        if (untrackedByFolder.length > 0) {
          const untrackedCount = untrackedByFolder.reduce((sum, f) => sum + f.files.length, 0);
          log.info(`${untrackedCount} untracked file(s) detected (not included in push)`);
        }
      }

      log.step("Detecting changes...");

      const diff = await withSpinner("Analyzing differences...", () =>
        detectDiff({ targetDir, templateDir, patterns }),
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
      if (args.files) {
        const requestedPaths = (args.files as string)
          .split(",")
          .map((p) => p.trim())
          .filter(Boolean);
        const availablePaths = new Set(pushableFiles.map((f) => f.path));
        const notFound = requestedPaths.filter((p) => !availablePaths.has(p));
        if (notFound.length > 0) log.warn(`Files not found: ${notFound.join(", ")}`);
        const requestedSet = new Set(requestedPaths);
        pushableFiles = pushableFiles.filter((f) => requestedSet.has(f.path));
        if (pushableFiles.length === 0) {
          log.info("No matching files. Cancelled.");
          return;
        }
        log.info(`${pushableFiles.length} file(s) selected via --files`);
      } else {
        log.step("Selecting files...");
        pushableFiles = await selectPushFiles(pushableFiles, {
          preselectDeletions: args.includeDeletions as boolean,
        });
        if (pushableFiles.length === 0) {
          log.info("No files selected. Cancelled.");
          return;
        }
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

      await runCommandEffect(
        match(source)
          .with({ owner: P.string, repo: P.string }, (ghSource) =>
            pushToGitHub(ghSource, { files, deletions, pushableFiles }, ctx, {
              message: args.message as string | undefined,
              edit: args.edit as boolean,
              yes: args.yes as boolean,
            }),
          )
          .with({ path: P.string }, (localSource) =>
            pushToLocal(localSource, { files, deletions, pushableFiles }, ctx, targetDir, {
              yes: args.yes as boolean,
            }),
          )
          .exhaustive(),
      );
    }, cleanup);
  },
});

// ─── コンフリクト解決 ───

/**
 * push 時のコンフリクト解決。
 *
 * ファイル読み込み・マージ・ベースダウンロードは conflict-io の共通ユーティリティを使い、
 * push 固有の処理（mergedContents への保存・ユーザー確認）だけをここで行う。
 * pull との違い: ローカルに書き込まず、auto-merge 成功分のみ mergedContents に保存する。
 */
async function resolveConflicts(
  conflicts: string[],
  ctx: {
    targetDir: string;
    templateDir: string;
    source: TemplateSource;
    lock: { baseRef?: string };
    mergedContents: Map<string, string>;
    args: { yes: boolean };
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
        // mergeOneFile 内で readFileOrEmpty が空文字列を返すため、ベースに
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
        log.warn(`${unresolved.length} file(s) could not be auto-merged:`);
        for (const f of unresolved) log.message(`  ${pc.yellow("!")} ${f}`);
        if (!ctx.args.yes) {
          const proceed = await confirmAction("Continue with unresolved conflicts?", {
            initialValue: true,
          });
          if (!proceed) {
            log.info("Run `ziku pull` first to sync template changes, then push again.");
          }
        }
      }
    },
    () => baseResult?.cleanup?.(),
  );
}
