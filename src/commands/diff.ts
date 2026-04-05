import { existsSync } from "node:fs";
import { rm } from "node:fs/promises";
import { withFinally } from "../effect-helpers";
import { defineCommand } from "citty";
import { Effect } from "effect";
import { downloadTemplate } from "giget";
import { join, resolve } from "pathe";
import { isLocalSource } from "../modules/schemas";
import { ZikuError } from "../errors";
import { renderFileDiff } from "../ui/diff-view";
import { intro, log, logDiffSummary, outro, pc, withSpinner } from "../ui/renderer";
import { detectDiff, hasDiff } from "../utils/diff";
import { buildTemplateSource } from "../utils/template";
import { detectUntrackedFiles, getTotalUntrackedCount } from "../utils/untracked";
import { ZIKU_CONFIG_FILE, loadZikuConfig, zikuConfigExists } from "../utils/ziku-config";
import { LOCK_FILE, loadLock } from "../utils/lock";
import type { CommandLifecycle } from "../docs/lifecycle-types";
import { SYNCED_FILES } from "../docs/lifecycle-types";

/**
 * diff コマンドのファイル操作メタデータ。
 * ドキュメント自動生成（npm run docs）の SSOT として使われる。
 */
export const diffLifecycle: CommandLifecycle = {
  name: "diff",
  description: "ローカルとテンプレートの差分を表示",
  ops: [
    { file: ZIKU_CONFIG_FILE, location: "local", op: "read", note: "patterns を取得" },
    { file: LOCK_FILE, location: "local", op: "read", note: "source を取得" },
    {
      file: SYNCED_FILES,
      location: "local",
      op: "read",
      note: "ローカルファイルを読み取り",
    },
    {
      file: SYNCED_FILES,
      location: "template",
      op: "read",
      note: "テンプレートをダウンロードして比較",
    },
  ],
};

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

    if (!zikuConfigExists(targetDir)) {
      throw new ZikuError(".ziku/ziku.jsonc not found.", "Run 'ziku init' first.");
    }

    const { config: zikuConfig } = await loadZikuConfig(targetDir);

    // source は lock.json から取得
    const lock = await Effect.runPromise(
      Effect.tryPromise(() => loadLock(targetDir)).pipe(
        Effect.mapError(
          () => new ZikuError(".ziku/lock.json not found.", "Run 'ziku init' first."),
        ),
      ),
    );
    const source = lock.source;

    const patterns = {
      include: zikuConfig.include,
      exclude: zikuConfig.exclude ?? [],
    };

    if (patterns.include.length === 0) {
      log.warn("No patterns configured");
      return;
    }

    // Step 1: テンプレートを取得
    let templateDir: string;
    let tempDir: string | undefined;

    if (isLocalSource(source)) {
      templateDir = resolve(source.path);
      log.info(`Template: ${pc.cyan(templateDir)} (local)`);
    } else {
      log.step("Fetching template...");
      const templateSource = buildTemplateSource(source);
      const td = join(targetDir, ".ziku-temp");
      tempDir = td;
      const { dir } = await withSpinner("Downloading template from GitHub...", () =>
        downloadTemplate(templateSource, {
          dir: td,
          force: true,
        }),
      );
      templateDir = dir;
    }

    await withFinally(
      async () => {
        // Step 2: 差分を検出
        log.step("Detecting changes...");

        const diff = await withSpinner("Analyzing differences...", () =>
          detectDiff({ targetDir, templateDir, patterns }),
        );

        // 未トラックファイルを検出
        const untrackedByFolder = await detectUntrackedFiles({ targetDir, patterns });
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
          log.warn(
            `However, ${untrackedCount} untracked file(s) exist outside the sync whitelist:`,
          );
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
      },
      async () => {
        if (tempDir && existsSync(tempDir)) {
          await rm(tempDir, { recursive: true, force: true });
        }
      },
    );
  },
});
