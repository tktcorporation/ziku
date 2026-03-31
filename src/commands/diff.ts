import { existsSync } from "node:fs";
import { readFile, rm } from "node:fs/promises";
import { defineCommand } from "citty";
import { downloadTemplate } from "giget";
import { join, resolve } from "pathe";
import { BermError } from "../errors";
import { loadModulesFile, modulesFileExists } from "../modules";
import type { DevEnvConfig, TemplateModule } from "../modules/schemas";
import { configSchema } from "../modules/schemas";
import { CONFIG_FILE, migrateConfigIfNeeded } from "../utils/config";
import { renderFileDiff } from "../ui/diff-view";
import { intro, log, logDiffSummary, outro, pc, withSpinner } from "../ui/renderer";
import { detectDiff, hasDiff } from "../utils/diff";
import { buildTemplateSource } from "../utils/template";
import { detectUntrackedFiles, getTotalUntrackedCount } from "../utils/untracked";

export const diffCommand = defineCommand({
  meta: {
    name: "diff",
    description: "Show differences between local and template",
  },
  args: {
    dir: {
      type: "positional",
      description: "Project directory",
      default: ".",
    },
    verbose: {
      type: "boolean",
      alias: "v",
      description: "Show detailed diff",
      default: false,
    },
  },
  async run({ args }) {
    intro("diff");

    const targetDir = resolve(args.dir);
    await migrateConfigIfNeeded(targetDir);
    const configPath = join(targetDir, CONFIG_FILE);

    if (!existsSync(configPath)) {
      throw new BermError(`${CONFIG_FILE} not found.`, "Run 'ziku init' first.");
    }

    // 設定読み込み
    const configContent = await readFile(configPath, "utf-8");
    const configData = JSON.parse(configContent);
    const parseResult = configSchema.safeParse(configData);

    if (!parseResult.success) {
      throw new BermError(`Invalid ${CONFIG_FILE} format`, parseResult.error.message);
    }

    const config: DevEnvConfig = parseResult.data;

    if (config.modules.length === 0) {
      log.warn("No modules installed");
      return;
    }

    // Step 1: テンプレートをダウンロード
    log.step("Fetching template...");

    // テンプレートを一時ディレクトリにダウンロード
    const templateSource = buildTemplateSource(config.source);
    const tempDir = join(targetDir, ".ziku-temp");

    try {
      const { dir: templateDir } = await withSpinner("Downloading template from GitHub...", () =>
        downloadTemplate(templateSource, {
          dir: tempDir,
          force: true,
        }),
      );

      // modules.jsonc を読み込み
      let moduleList: TemplateModule[];
      if (modulesFileExists(templateDir)) {
        const loaded = await loadModulesFile(templateDir);
        moduleList = loaded.modules;
      } else if (modulesFileExists(targetDir)) {
        const loaded = await loadModulesFile(targetDir);
        moduleList = loaded.modules;
      } else {
        throw new BermError(
          "No .ziku/modules.jsonc found",
          "Run `ziku init` to set up the project, or add .ziku/modules.jsonc to the template",
        );
      }

      // Step 2: 差分を検出
      log.step("Detecting changes...");

      const diff = await withSpinner("Analyzing differences...", () =>
        detectDiff({
          targetDir,
          templateDir,
          moduleIds: config.modules,
          config,
          moduleList,
        }),
      );

      // 未トラックファイルを検出
      const untrackedByFolder = await detectUntrackedFiles({
        targetDir,
        moduleIds: config.modules,
        config,
        moduleList,
      });
      const untrackedCount = getTotalUntrackedCount(untrackedByFolder);

      // 結果表示
      if (hasDiff(diff)) {
        logDiffSummary(diff.files);

        // --verbose: 各ファイルの unified diff を表示
        if (args.verbose) {
          for (const file of diff.files.filter((f) => f.type !== "unchanged")) {
            renderFileDiff(file);
          }
        }

        // 未トラックファイルがあればヒントを表示
        if (untrackedCount > 0) {
          log.warn(`${untrackedCount} untracked file(s) found outside the sync whitelist:`);
          const untrackedLines = untrackedByFolder.flatMap((group) =>
            group.files.map((file) => `  ${pc.dim("•")} ${file.path}`),
          );
          log.message(untrackedLines.join("\n"));
          log.info(
            `To include these files in sync, add them to tracking with the ${pc.cyan("track")} command:`,
          );
          log.message(pc.dim(`  npx ziku track "<pattern>"`));
          log.message(
            pc.dim(
              `  Example: npx ziku track "${untrackedByFolder[0]?.files[0]?.path || ".cloud/rules/*.md"}"`,
            ),
          );
        }

        outro("Run 'ziku push' to push changes.");
      } else if (untrackedCount > 0) {
        log.success("Tracked files are in sync.");
        log.warn(`However, ${untrackedCount} untracked file(s) exist outside the sync whitelist:`);
        const untrackedLines = untrackedByFolder.flatMap((group) =>
          group.files.map((file) => `  ${pc.dim("•")} ${file.path}`),
        );
        log.message(untrackedLines.join("\n"));
        log.info(
          `Use ${pc.cyan("npx ziku track <pattern>")} to add them, then ${pc.cyan("push")} to sync.`,
        );
        outro("Tracked files are in sync, but untracked files exist.");
      } else {
        outro("No changes — in sync with template.");
      }
    } finally {
      // 一時ディレクトリを削除
      if (existsSync(tempDir)) {
        await rm(tempDir, { recursive: true, force: true });
      }
    }
  },
});
