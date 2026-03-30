import { existsSync, rmSync } from "node:fs";
import { readFile, rm } from "node:fs/promises";
import { defineCommand } from "citty";
import { downloadTemplate } from "giget";
import { parse } from "jsonc-parser";
import { join, resolve } from "pathe";
import { BermError } from "../errors";
import { addPatternToModulesFileWithCreate, loadModulesFile, modulesFileExists } from "../modules";
import type { DevEnvConfig, TemplateModule } from "../modules/schemas";
import { configSchema } from "../modules/schemas";
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

/**
 * FileDiff の差分統計を "+N -M" 形式でフォーマットする。
 *
 * 背景: git push の出力に合わせ、変更行数を可視化する。
 * calculateDiffStats に統一し、unified diff ベースで実際の変更行数を算出する。
 * 以前は行数の差で計算していたため、実際の変更量と大きくズレる問題があった。
 */
function formatFileStat(file: {
  path: string;
  type: string;
  localContent?: string;
  templateContent?: string;
}): string {
  const stats = calculateDiffStats(file as import("../modules/schemas").FileDiff);
  return formatStats(stats);
}

/**
 * process.exit() でも確実に一時ディレクトリを削除するための同期クリーンアップを登録する。
 *
 * 背景: handleCancel() が process.exit(0) を呼ぶため async finally ブロックが
 * スキップされ、.ziku-temp が残る問題への対策。process.on('exit') は
 * process.exit() でも発火するが同期処理のみ実行可能なため rmSync を使用。
 *
 * 削除条件: handleCancel() が process.exit() を使わなくなった場合。
 */
function registerSyncCleanup(tempDir: string): () => void {
  const cleanup = () => {
    try {
      if (existsSync(tempDir)) {
        rmSync(tempDir, { recursive: true, force: true });
      }
    } catch {
      // プロセス終了中のエラーは無視（ベストエフォート）
    }
  };
  process.on("exit", cleanup);
  return () => {
    process.removeListener("exit", cleanup);
  };
}

const MODULES_FILE_PATH = ".ziku/modules.jsonc";
const README_PATH = "README.md";

interface LocalModuleAdditions {
  mergedModuleList: TemplateModule[];
  newModuleIds: string[];
  updatedModulesContent: string | undefined;
}

/**
 * ローカルの modules.jsonc とテンプレートの modules.jsonc を比較し、
 * ローカルにのみ存在するモジュール（track コマンドで追加されたもの等）を検出してマージする。
 * テンプレートの raw content をベースに新モジュールを追加した内容を返す。
 */
async function detectLocalModuleAdditions(
  targetDir: string,
  templateModules: TemplateModule[],
  templateRawContent: string,
): Promise<LocalModuleAdditions> {
  if (!modulesFileExists(targetDir)) {
    return {
      mergedModuleList: templateModules,
      newModuleIds: [],
      updatedModulesContent: undefined,
    };
  }

  const local = await loadModulesFile(targetDir);
  const templateModuleIds = new Set(templateModules.map((m) => m.id));

  // ローカルにのみ存在するモジュールを検出
  const newModules = local.modules.filter((m) => !templateModuleIds.has(m.id));

  if (newModules.length === 0) {
    // 新モジュールはないが、既存モジュールにローカルでパターンが追加されていないかチェック
    let updatedContent = templateRawContent;
    let hasPatternAdditions = false;
    for (const localMod of local.modules) {
      const templateMod = templateModules.find((m) => m.id === localMod.id);
      if (!templateMod) continue;
      const newPatterns = localMod.patterns.filter((p) => !templateMod.patterns.includes(p));
      if (newPatterns.length > 0) {
        updatedContent = addPatternToModulesFileWithCreate(
          updatedContent,
          localMod.id,
          newPatterns,
        );
        hasPatternAdditions = true;
      }
    }

    if (hasPatternAdditions) {
      const merged = parse(updatedContent) as { modules: TemplateModule[] };
      return {
        mergedModuleList: merged.modules,
        newModuleIds: [],
        updatedModulesContent: updatedContent,
      };
    }

    return {
      mergedModuleList: templateModules,
      newModuleIds: [],
      updatedModulesContent: undefined,
    };
  }

  // テンプレートの raw content に新モジュールを追加
  let updatedContent = templateRawContent;
  for (const mod of newModules) {
    updatedContent = addPatternToModulesFileWithCreate(updatedContent, mod.id, mod.patterns, {
      name: mod.name,
      description: mod.description,
    });
  }

  // 既存モジュールへのパターン追加もチェック
  for (const localMod of local.modules) {
    const templateMod = templateModules.find((m) => m.id === localMod.id);
    if (!templateMod) continue; // 新モジュールは上で処理済み
    const newPatterns = localMod.patterns.filter((p) => !templateMod.patterns.includes(p));
    if (newPatterns.length > 0) {
      updatedContent = addPatternToModulesFileWithCreate(updatedContent, localMod.id, newPatterns);
    }
  }

  const merged = parse(updatedContent) as { modules: TemplateModule[] };
  return {
    mergedModuleList: merged.modules,
    newModuleIds: newModules.map((m) => m.id),
    updatedModulesContent: updatedContent,
  };
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
      alias: ["y", "f"], // -f は後方互換のため残す
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
    const configPath = join(targetDir, ".ziku.json");

    // .ziku.json の存在確認
    if (!existsSync(configPath)) {
      throw new BermError(".ziku.json not found.", "Run 'ziku init' first.");
    }

    // 設定読み込み
    const configContent = await readFile(configPath, "utf-8");
    const configData = JSON.parse(configContent);
    const parseResult = configSchema.safeParse(configData);

    if (!parseResult.success) {
      throw new BermError("Invalid .ziku.json format", parseResult.error.message);
    }

    const config: DevEnvConfig = parseResult.data;

    if (config.modules.length === 0) {
      log.warn("No modules installed");
      return;
    }

    // pendingMerge がある場合はコンフリクト未解決のためブロック
    if (config.pendingMerge) {
      throw new BermError(
        "Unresolved merge conflicts from `ziku pull`",
        "Resolve conflicts in these files, then run `ziku pull --continue`:\n" +
          config.pendingMerge.conflicts.map((f) => `  • ${f}`).join("\n"),
      );
    }

    // Step 1: テンプレートをダウンロード
    log.step("Fetching template...");

    // テンプレートを一時ディレクトリにダウンロード
    const templateSource = buildTemplateSource(config.source);
    const tempDir = join(targetDir, ".ziku-temp");
    const unregisterCleanup = registerSyncCleanup(tempDir);

    try {
      const { dir: templateDir } = await withSpinner("Downloading template from GitHub...", () =>
        downloadTemplate(templateSource, {
          dir: tempDir,
          force: true,
        }),
      );

      // modules.jsonc を読み込み
      let moduleList: TemplateModule[];
      let modulesRawContent: string | undefined;

      if (modulesFileExists(templateDir)) {
        const loaded = await loadModulesFile(templateDir);
        moduleList = loaded.modules;
        modulesRawContent = loaded.rawContent;
      } else if (modulesFileExists(targetDir)) {
        const loaded = await loadModulesFile(targetDir);
        moduleList = loaded.modules;
        modulesRawContent = loaded.rawContent;
      } else {
        throw new BermError(
          "No .ziku/modules.jsonc found",
          "Run `ziku init` to set up the project, or add .ziku/modules.jsonc to the template",
        );
      }

      // ローカルのモジュール追加を検出してマージ
      const effectiveModuleIds = [...config.modules];
      let updatedModulesContent: string | undefined;

      if (modulesRawContent) {
        const localAdditions = await detectLocalModuleAdditions(
          targetDir,
          moduleList,
          modulesRawContent,
        );
        moduleList = localAdditions.mergedModuleList;
        updatedModulesContent = localAdditions.updatedModulesContent;
        for (const id of localAdditions.newModuleIds) {
          if (!effectiveModuleIds.includes(id)) {
            effectiveModuleIds.push(id);
          }
        }
        if (localAdditions.newModuleIds.length > 0) {
          log.info(
            `Detected ${localAdditions.newModuleIds.length} new module(s) from local: ${localAdditions.newModuleIds.join(", ")}`,
          );
        }
      }

      // 3-way マージで解決されたファイルの内容を保持する
      // PR 作成時に localContent の代わりにマージ済み内容を使う
      const mergedContents = new Map<string, string>();

      // push 対象ファイルパスの集合。
      // pull と同じく classifyFiles の結果を一次情報として使い、
      // 「ユーザーが変更したファイル」(localOnly + conflicts) のみを push 対象とする。
      // これにより autoUpdate（テンプレートのみ変更）や newFiles（テンプレート新規追加）が
      // 誤って push されてテンプレート変更がリバートされることを構造的に防止する。
      let pushableFilePaths: Set<string> = new Set();

      // ファイル分類（pull と同じパターン）
      // baseHashes がない場合は {} をデフォルトとし、全ファイルを base なしで分類する。
      // base がないファイルは local ≠ template なら conflicts 扱いとなり、
      // ユーザーに確認を求めることで意図しないリバートを防止する。
      {
        const { hashFiles } = await import("../utils/hash");
        const { classifyFiles } = await import("../utils/merge");
        const { getModuleById } = await import("../modules");
        const { getEffectivePatterns } = await import("../utils/patterns");

        // 全モジュールの有効パターンを収集
        const allPatterns: string[] = [];
        for (const moduleId of effectiveModuleIds) {
          const mod = getModuleById(moduleId, moduleList);
          if (mod) {
            const patterns = getEffectivePatterns(moduleId, mod.patterns, config);
            allPatterns.push(...patterns);
          }
        }

        const templateHashes = await hashFiles(templateDir, allPatterns);
        const localHashes = await hashFiles(targetDir, allPatterns);

        const classification = classifyFiles({
          baseHashes: config.baseHashes ?? {},
          localHashes,
          templateHashes,
        });

        // push 対象: localOnly（ユーザーのみ変更）+ conflicts（両方変更、マージ後に push）
        // pull と同じく classification がファイルの処理方法を決定する。
        for (const file of classification.localOnly) {
          pushableFilePaths.add(file);
        }
        for (const file of classification.conflicts) {
          pushableFilePaths.add(file);
        }

        // autoUpdate（テンプレートのみ変更）をユーザーに通知。
        // push 対象には含めない（classification が除外済み）。
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

          // baseRef がある場合はハッシュを強調表示する（git の "non-fast-forward" エラーに相当）
          const baseInfo = config.baseRef
            ? `since ${pc.bold(config.baseRef.slice(0, 7))} (your last sync)`
            : "since your last pull/init";
          log.warn(
            `Template updated ${baseInfo} — ${classification.conflicts.length} conflict(s) detected, attempting auto-merge...`,
          );

          // baseRef が存在すれば、ベースバージョンを再ダウンロードして 3-way マージ
          let baseTemplateDir: string | undefined;
          let baseCleanup: (() => void) | undefined;

          if (config.baseRef) {
            try {
              log.info(`Downloading base version (${config.baseRef.slice(0, 7)}...) for merge...`);
              const { downloadTemplateToTemp: downloadBase } = await import("../utils/template");
              const baseSource = `gh:${config.source.owner}/${config.source.repo}#${config.baseRef}`;
              const baseResult = await downloadBase(targetDir, baseSource);
              baseTemplateDir = baseResult.templateDir;
              baseCleanup = baseResult.cleanup;
            } catch {
              log.warn(
                "Could not download base version. Falling back to local content for conflicts.",
              );
            }
          }

          try {
            const autoMerged: string[] = [];
            const unresolved: string[] = [];

            for (const file of classification.conflicts) {
              const localContent = await readFile(join(targetDir, file), "utf-8");
              const templateContent = await readFile(join(templateDir, file), "utf-8");

              // baseRef のテンプレートからベース内容を読む
              let baseContent: string | undefined;
              if (baseTemplateDir && existsSync(join(baseTemplateDir, file))) {
                baseContent = await readFile(join(baseTemplateDir, file), "utf-8");
              }

              if (baseContent) {
                // 3-way マージ: ユーザーのローカル内容をベースに、テンプレート側の変更を適用
                // コンフリクト時はローカル（ユーザー）側を優先し、コメントやフォーマットも保持する
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
          } finally {
            baseCleanup?.();
          }
        }
      }

      // ホワイトリスト外ファイルの検出と情報表示
      if (!args.yes && modulesRawContent) {
        const untrackedByFolder = await detectUntrackedFiles({
          targetDir,
          moduleIds: effectiveModuleIds,
          config,
          moduleList,
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
          moduleIds: effectiveModuleIds,
          config,
          moduleList,
        }),
      );

      // push 対象ファイルを取得。
      // classification が決定した pushableFilePaths をソースオブトゥルースとして使う。
      // diff はコンテンツ（localContent/templateContent）の提供元としてのみ使用する。
      // これにより autoUpdate/newFiles/deletedFiles が push に含まれることを構造的に防止する。
      let pushableFiles = diff.files.filter(
        (f) => (f.type === "added" || f.type === "modified") && pushableFilePaths.has(f.path),
      );

      if (pushableFiles.length === 0 && !updatedModulesContent) {
        log.info("No changes to push");
        log.step("Current status:");
        logDiffSummary(diff.files);
        return;
      }

      // ドライランモード
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
      // --files: ノンインタラクティブにファイルをカンマ区切りで指定（AI エージェント向け）
      // それ以外: インタラクティブにファイルを選択
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

      // PR タイトル・本文（自動生成がデフォルト、--edit 時のみ編集プロンプト）
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

      // README を更新（対象の場合のみ）
      const readmeResult = await detectAndUpdateReadme(targetDir, templateDir);

      // ファイル内容を準備（3-way マージ済みの内容があればそちらを優先）
      const files = pushableFiles.map((f) => ({
        path: f.path,
        content: mergedContents.get(f.path) ?? f.localContent ?? "",
      }));

      // modules.jsonc の変更があれば追加
      if (updatedModulesContent) {
        files.push({
          path: MODULES_FILE_PATH,
          content: updatedModulesContent,
        });
      }

      // README の変更があれば追加
      if (readmeResult?.updated) {
        files.push({
          path: README_PATH,
          content: readmeResult.content,
        });
      }

      // Step 4: git-like なサマリー表示 + 確認
      // "To owner/repo → branch" 形式でプッシュ先と変更内容を一覧表示する。
      // 詳細な unified diff は `ziku diff` で確認可能。
      const destination = `${config.source.owner}/${config.source.repo}`;
      const baseBranch = config.source.ref || "main";
      const baseHashStr = config.baseRef
        ? `  ${pc.dim(`since ${config.baseRef.slice(0, 7)}`)}`
        : "";

      // 変更ファイル行の生成（type アイコン + パス + 行数統計）
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
      // pushableFiles に含まれない追加ファイル（modules.jsonc、README 自動更新等）
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
          owner: config.source.owner,
          repo: config.source.repo,
          files,
          title,
          body,
          baseBranch: config.source.ref || "main",
        }),
      );

      // 成功メッセージ — git push の "To repo branch" 形式に準拠
      log.success("Pull request created!");
      log.message(
        [
          `${pc.dim("To")} ${pc.bold(`${config.source.owner}/${config.source.repo}`)}`,
          `  ${config.baseRef ? `${pc.dim(config.baseRef.slice(0, 7))}..` : ""}${pc.green(result.branch)}  ${pc.dim(`(${files.length} file${files.length !== 1 ? "s" : ""} changed)`)}`,
          "",
          `  ${pc.bold(`PR #${result.number}`)}  ${pc.cyan(result.url)}`,
        ].join("\n"),
      );
      outro(`Review and merge at ${pc.cyan(result.url)}`);
    } finally {
      unregisterCleanup();
      // 一時ディレクトリを削除
      if (existsSync(tempDir)) {
        await rm(tempDir, { recursive: true, force: true });
      }
    }
  },
});
