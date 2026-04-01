import { existsSync } from "node:fs";
import { readFile, rm } from "node:fs/promises";
import { defineCommand } from "citty";
import { downloadTemplate } from "giget";
import { join, resolve } from "pathe";
import { BermError } from "../errors";
import { loadPatternsFile, modulesFileExists } from "../modules";
import { configSchema } from "../modules/schemas";
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
    const configPath = join(targetDir, ".ziku.json");

    if (!existsSync(configPath)) {
      throw new BermError(".ziku.json not found.", "Run 'ziku init' first.");
    }

    const configContent = await readFile(configPath, "utf-8");
    const configData = JSON.parse(configContent);
    const parseResult = configSchema.safeParse(configData);

    if (!parseResult.success) {
      throw new BermError("Invalid .ziku.json format", parseResult.error.message);
    }

    const config = parseResult.data;

    // ローカルの modules.jsonc からフラットパターンを読み込み
    if (!modulesFileExists(targetDir)) {
      throw new BermError(
        "No .ziku/modules.jsonc found",
        "Run `ziku init` to set up the project",
      );
    }

    const patterns = await loadPatternsFile(targetDir);

    if (patterns.include.length === 0) {
      log.warn("No patterns configured");
      return;
    }

    // Step 1: テンプレートをダウンロード
    log.step("Fetching template...");

    const templateSource = buildTemplateSource(config.source);
    const tempDir = join(targetDir, ".ziku-temp");

    try {
      const { dir: templateDir } = await withSpinner("Downloading template from GitHub...", () =>
        downloadTemplate(templateSource, {
          dir: tempDir,
          force: true,
        }),
      );

      // Step 2: 差分を検出
      log.step("Detecting changes...");

      const diff = await withSpinner("Analyzing differences...", () =>
        detectDiff({
          targetDir,
          templateDir,
          patterns,
        }),
      );

      // 未トラックファイルを検出
      const untrackedByFolder = await detectUntrackedFiles({
        targetDir,
        patterns,
      });
      const untrackedCount = getTotalUntrackedCount(untrackedByFolder);

      // 結果表示
      if (hasDiff(diff)) {
        logDiffSummary(diff.files);

        if (args.verbose) {
          for (const file of diff.files.filter((f) => f.type !== "unchanged")) {
            renderFileDiff(file);
          }
        }

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
      if (existsSync(tempDir)) {
        await rm(tempDir, { recursive: true, force: true });
      }
    }
  },
});
