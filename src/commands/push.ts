import { existsSync, rmSync } from "node:fs";
import { readFile, rm } from "node:fs/promises";
import { defineCommand } from "citty";
import { Effect } from "effect";
import { downloadTemplate } from "giget";
import { join, resolve } from "pathe";
import { withFinally } from "../effect-helpers";
import { ZikuError } from "../errors";
import { loadPatternsFile, modulesFileExists } from "../modules";
import type { LockState, ZikuConfig } from "../modules/schemas";
import { lockSchema } from "../modules/schemas";
import { LOCK_FILE } from "../utils/lock";
import {
  ZIKU_CONFIG_FILE,
  addIncludePattern,
  loadZikuConfig,
  zikuConfigExists,
} from "../utils/ziku-config";
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
import { detectAndUpdateReadme } from "../utils/readme";
import { buildTemplateSource } from "../utils/template";
import { detectUntrackedFiles } from "../utils/untracked";

function formatFileStat(file: {
  path: string;
  type: string;
  localContent?: string;
  templateContent?: string;
}): string {
  const stats = calculateDiffStats(file as import("../modules/schemas").FileDiff);
  return formatStats(stats);
}

function registerSyncCleanup(tempDir: string): () => void {
  const cleanup = () => {
    // ベストエフォート: プロセス終了時の一時ディレクトリ削除
    Effect.runSync(
      Effect.try(() => {
        if (existsSync(tempDir)) {
          rmSync(tempDir, { recursive: true, force: true });
        }
      }).pipe(Effect.orElseSucceed(() => {})),
    );
  };
  process.on("exit", cleanup);
  return () => {
    process.removeListener("exit", cleanup);
  };
}

const MODULES_FILE_PATH = ".ziku/modules.jsonc"; // テンプレート側の modules.jsonc パス
const README_PATH = "README.md";

/**
 * ローカルの include パターンとテンプレートのフラット化パターンを比較し、
 * ローカルにのみ存在するパターンを検出する。
 */
function detectLocalPatternAdditions(localInclude: string[], templateInclude: string[]): string[] {
  const templateSet = new Set(templateInclude);
  return localInclude.filter((p) => !templateSet.has(p));
}

export const pushCommand = defineCommand({
  meta: {
    name: "push",
    description: "Push local changes to the template repository as a PR",
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
      description: "Preview only, don't create PR",
      default: false,
    },
    message: {
      type: "string",
      alias: "m",
      description: "PR title",
    },
    yes: {
      type: "boolean",
      alias: ["y", "f"],
      description: "Skip confirmation prompts",
      default: false,
    },
    edit: {
      type: "boolean",
      description: "Edit PR title and description before creating",
      default: false,
    },
    files: {
      type: "string",
      description: "Comma-separated file paths to include in PR (skips file selection prompt)",
    },
  },
  async run({ args }) {
    intro("push");

    const targetDir = resolve(args.dir);

    if (!zikuConfigExists(targetDir)) {
      throw new ZikuError(".ziku/ziku.jsonc not found.", "Run 'ziku init' first.");
    }

    const { config: zikuConfig, rawContent: zikuConfigRaw } = await loadZikuConfig(targetDir);

    // lock.json を読み込み
    const lockPath = join(targetDir, LOCK_FILE);

    if (!existsSync(lockPath)) {
      throw new ZikuError(".ziku/lock.json not found.", "Run 'ziku init' first.");
    }

    const lockContent = await readFile(lockPath, "utf-8");
    const lockData = JSON.parse(lockContent);
    const lockResult = lockSchema.safeParse(lockData);

    if (!lockResult.success) {
      throw new ZikuError("Invalid .ziku/lock.json format", lockResult.error.message);
    }

    const lock: LockState = lockResult.data;

    if (lock.pendingMerge) {
      throw new ZikuError(
        "Unresolved merge conflicts from `ziku pull`",
        "Resolve conflicts in these files, then run `ziku pull --continue`:\n" +
          lock.pendingMerge.conflicts.map((f) => `  • ${f}`).join("\n"),
      );
    }

    const localPatterns = {
      include: zikuConfig.include,
      exclude: zikuConfig.exclude ?? [],
      rawContent: zikuConfigRaw,
    };

    if (localPatterns.include.length === 0) {
      log.warn("No patterns configured");
      return;
    }

    // Step 1: テンプレートをダウンロード
    log.step("Fetching template...");

    const templateSource = buildTemplateSource(zikuConfig.source);
    const tempDir = join(targetDir, ".ziku-temp");
    const unregisterCleanup = registerSyncCleanup(tempDir);

    await withFinally(
      async () => {
        const { dir: templateDir } = await withSpinner("Downloading template from GitHub...", () =>
          downloadTemplate(templateSource, {
            dir: tempDir,
            force: true,
          }),
        );

        // テンプレート側のパターンを読み込み、ローカル追加を検出
        let updatedModulesContent: string | undefined;
        let effectiveInclude = localPatterns.include;
        let effectiveExclude = localPatterns.exclude;

        if (modulesFileExists(templateDir)) {
          const templatePatterns = await loadPatternsFile(templateDir);
          const newPatterns = detectLocalPatternAdditions(
            localPatterns.include,
            templatePatterns.include,
          );

          if (newPatterns.length > 0) {
            log.info(
              `Detected ${newPatterns.length} new pattern(s) from local: ${newPatterns.join(", ")}`,
            );
            // テンプレートの modules.jsonc に新パターンを追加
            const { loadPatternsFile: loadRaw } = await import("../modules/loader");
            const templateRaw = await loadRaw(templateDir);
            const { addIncludePattern: addModulePattern } = await import("../modules/loader");
            updatedModulesContent = addModulePattern(templateRaw.rawContent, newPatterns);
          }

          // マージされたパターンを使用
          const allInclude = new Set([...templatePatterns.include, ...localPatterns.include]);
          effectiveInclude = [...allInclude];
          effectiveExclude = [...new Set([...templatePatterns.exclude, ...localPatterns.exclude])];
        }

        const patterns = { include: effectiveInclude, exclude: effectiveExclude };

        // 3-way マージ結果を保持
        const mergedContents = new Map<string, string>();
        let pushableFilePaths: Set<string> = new Set();

        // ファイル分類
        {
          const { hashFiles } = await import("../utils/hash");
          const { classifyFiles } = await import("../utils/merge");

          const templateHashes = await hashFiles(templateDir, patterns.include, patterns.exclude);
          const localHashes = await hashFiles(targetDir, patterns.include, patterns.exclude);

          const classification = classifyFiles({
            baseHashes: lock.baseHashes ?? {},
            localHashes,
            templateHashes,
          });

          for (const file of classification.localOnly) {
            pushableFilePaths.add(file);
          }
          for (const file of classification.conflicts) {
            pushableFilePaths.add(file);
          }

          if (classification.autoUpdate.length > 0) {
            log.info(
              `Skipping ${classification.autoUpdate.length} file(s) only changed in template (use \`ziku pull\` to sync):`,
            );
            for (const file of classification.autoUpdate) {
              log.message(`  ${pc.dim("↓")} ${pc.dim(file)}`);
            }
          }

          if (classification.conflicts.length > 0) {
            const { threeWayMerge, asBaseContent, asLocalContent, asTemplateContent } =
              await import("../utils/merge");

            const baseInfo = lock.baseRef
              ? `since ${pc.bold(lock.baseRef!.slice(0, 7))} (your last sync)`
              : "since your last pull/init";
            log.warn(
              `Template updated ${baseInfo} — ${classification.conflicts.length} conflict(s) detected, attempting auto-merge...`,
            );

            let baseTemplateDir: string | undefined;
            let baseCleanup: (() => void) | undefined;

            // ベースバージョンのダウンロード（失敗時はフォールバック）
            if (lock.baseRef) {
              const baseResult = await Effect.runPromise(
                Effect.tryPromise(async () => {
                  log.info(
                    `Downloading base version (${lock.baseRef!.slice(0, 7)}...) for merge...`,
                  );
                  const { downloadTemplateToTemp: downloadBase } =
                    await import("../utils/template");
                  const baseSource = `gh:${zikuConfig.source.owner}/${zikuConfig.source.repo}#${lock.baseRef}`;
                  return downloadBase(targetDir, baseSource);
                }).pipe(
                  Effect.orElseSucceed(() => {
                    log.warn(
                      "Could not download base version. Falling back to local content for conflicts.",
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
                const autoMerged: string[] = [];
                const unresolved: string[] = [];

                for (const file of classification.conflicts) {
                  const localContent = await readFile(join(targetDir, file), "utf-8");
                  const templateContent = await readFile(join(templateDir, file), "utf-8");

                  let baseContent: string | undefined;
                  if (baseTemplateDir && existsSync(join(baseTemplateDir, file))) {
                    baseContent = await readFile(join(baseTemplateDir, file), "utf-8");
                  }

                  if (baseContent) {
                    const result = threeWayMerge({
                      base: asBaseContent(baseContent),
                      local: asLocalContent(localContent),
                      template: asTemplateContent(templateContent),
                      filePath: file,
                    });
                    if (!result.hasConflicts) {
                      mergedContents.set(file, result.content);
                      autoMerged.push(file);
                      continue;
                    }
                  }
                  unresolved.push(file);
                }

                if (autoMerged.length > 0) {
                  log.success(`Auto-merged ${autoMerged.length} file(s):`);
                  for (const file of autoMerged) {
                    log.message(`  ${pc.green("✓")} ${file}`);
                  }
                }

                if (unresolved.length > 0) {
                  log.warn(`${unresolved.length} file(s) could not be auto-merged:`);
                  for (const file of unresolved) {
                    log.message(`  ${pc.yellow("!")} ${file}`);
                  }
                  log.message(
                    [
                      pc.dim("Your local changes will be included in the PR."),
                      pc.dim(
                        `hint: Run ${pc.cyan("ziku pull")} to sync changes first, then push again.`,
                      ),
                    ].join("\n"),
                  );

                  if (!args.yes) {
                    const proceed = await confirmAction("Continue with unresolved conflicts?", {
                      initialValue: true,
                    });
                    if (!proceed) {
                      log.info("Run `ziku pull` first to sync template changes, then push again.");
                      return;
                    }
                  }
                }
              },
              () => baseCleanup?.(),
            );
          }
        }

        // ホワイトリスト外ファイルの検出
        if (!args.yes) {
          const untrackedByFolder = await detectUntrackedFiles({
            targetDir,
            patterns,
          });

          if (untrackedByFolder.length > 0) {
            const untrackedCount = untrackedByFolder.reduce((sum, f) => sum + f.files.length, 0);
            log.info(`${untrackedCount} untracked file(s) detected (not included in push)`);
          }
        }

        // Step 2: 差分を検出
        log.step("Detecting changes...");

        const diff = await withSpinner("Analyzing differences...", () =>
          detectDiff({
            targetDir,
            templateDir,
            patterns,
          }),
        );

        let pushableFiles = diff.files.filter(
          (f) => (f.type === "added" || f.type === "modified") && pushableFilePaths.has(f.path),
        );

        if (pushableFiles.length === 0 && !updatedModulesContent) {
          log.info("No changes to push");
          log.step("Current status:");
          logDiffSummary(diff.files);
          return;
        }

        // ドライラン
        if (args.dryRun) {
          log.info("Dry run mode");
          log.step("Files that would be included in PR:");
          logDiffSummary(diff.files);

          if (updatedModulesContent) {
            log.message(`${pc.green("+")} ${MODULES_FILE_PATH} ${pc.dim("(pattern additions)")}`);
          }

          log.info("No PR was created (dry run)");
          return;
        }

        // Step 3: ファイル選択
        if (args.files) {
          const requestedPaths = args.files
            .split(",")
            .map((p) => p.trim())
            .filter(Boolean);
          const availablePaths = new Set(pushableFiles.map((f) => f.path));
          const notFound = requestedPaths.filter((p) => !availablePaths.has(p));
          if (notFound.length > 0) {
            log.warn(`Files not found in pushable changes: ${notFound.join(", ")}`);
          }
          const requestedSet = new Set(requestedPaths);
          pushableFiles = pushableFiles.filter((f) => requestedSet.has(f.path));
          if (pushableFiles.length === 0 && !updatedModulesContent) {
            log.info("No matching files found. Cancelled.");
            return;
          }
          log.info(`${pushableFiles.length} file(s) selected via --files`);
        } else {
          log.step("Selecting files...");
          pushableFiles = await selectPushFiles(pushableFiles);
          if (pushableFiles.length === 0 && !updatedModulesContent) {
            log.info("No files selected. Cancelled.");
            return;
          }
        }

        // GitHub トークン取得
        let token = getGitHubToken();
        if (!token) {
          token = await inputGitHubToken();
        }

        const suggestedTitle = generatePrTitle(pushableFiles);
        const suggestedBody = generatePrBody(pushableFiles);

        let title: string;
        let body: string | undefined;

        if (args.message) {
          title = args.message;
          body = suggestedBody;
        } else if (args.edit) {
          title = await inputPrTitle(suggestedTitle);
          body = await inputPrBody(suggestedBody);
        } else {
          title = suggestedTitle;
          body = suggestedBody;
        }

        const readmeResult = await detectAndUpdateReadme(targetDir, templateDir);

        const files = pushableFiles.map((f) => ({
          path: f.path,
          content: mergedContents.get(f.path) ?? f.localContent ?? "",
        }));

        if (updatedModulesContent) {
          files.push({
            path: MODULES_FILE_PATH,
            content: updatedModulesContent,
          });
        }

        if (readmeResult?.updated) {
          files.push({
            path: README_PATH,
            content: readmeResult.content,
          });
        }

        // Step 4: サマリー表示 + 確認
        const destination = `${zikuConfig.source.owner}/${zikuConfig.source.repo}`;
        const baseBranch = zikuConfig.source.ref || "main";
        const baseHashStr = lock.baseRef
          ? `  ${pc.dim(`since ${lock.baseRef.slice(0, 7)}`)}`
          : "";

        const fileLines: string[] = [];
        for (const pf of pushableFiles) {
          if (!files.some((f) => f.path === pf.path)) continue;
          const stat = formatFileStat(pf);
          const icon =
            pf.type === "added"
              ? pc.green("+")
              : pf.type === "modified"
                ? pc.yellow("~")
                : pc.red("-");
          fileLines.push(`  ${icon} ${pf.path.padEnd(50)} ${stat}`);
        }
        for (const f of files) {
          if (!pushableFiles.some((pf) => pf.path === f.path)) {
            fileLines.push(`  ${pc.green("+")} ${f.path.padEnd(50)} ${pc.dim("(auto-updated)")}`);
          }
        }

        log.message(
          [
            `${pc.dim("To")} ${pc.bold(destination)}  ${pc.dim(`→ ${baseBranch}`)}${baseHashStr}`,
            pc.dim("─".repeat(62)),
            ...fileLines,
            pc.dim("─".repeat(62)),
            `  ${pc.dim("PR:")} ${title}`,
          ].join("\n"),
        );

        if (!args.yes) {
          const confirmed = await confirmAction("Create PR?", { initialValue: true });
          if (!confirmed) {
            log.info("Cancelled. Use --edit to customize title/body, or --files to specify files.");
            return;
          }
        }

        // Step 5: PR を作成
        log.step("Creating pull request...");

        const result = await withSpinner("Creating PR on GitHub...", () =>
          createPullRequest(token, {
            owner: zikuConfig.source.owner,
            repo: zikuConfig.source.repo,
            files,
            title,
            body,
            baseBranch: zikuConfig.source.ref || "main",
          }),
        );

        log.success("Pull request created!");
        log.message(
          [
            `${pc.dim("To")} ${pc.bold(`${zikuConfig.source.owner}/${zikuConfig.source.repo}`)}`,
            `  ${lock.baseRef ? `${pc.dim(lock.baseRef.slice(0, 7))}..` : ""}${pc.green(result.branch)}  ${pc.dim(`(${files.length} file${files.length !== 1 ? "s" : ""} changed)`)}`,
            "",
            `  ${pc.bold(`PR #${result.number}`)}  ${pc.cyan(result.url)}`,
          ].join("\n"),
        );
        outro(`Review and merge at ${pc.cyan(result.url)}`);
      },
      async () => {
        unregisterCleanup();
        if (existsSync(tempDir)) {
          await rm(tempDir, { recursive: true, force: true });
        }
      },
    );
  },
});
