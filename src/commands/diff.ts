import { defineCommand } from "citty";
import { Effect } from "effect";
import { resolve } from "pathe";
import { withFinally } from "../effect-helpers";
import { renderFileDiff } from "../ui/diff-view";
import { intro, log, logDiffSummary, outro, pc, withSpinner } from "../ui/renderer";
import { detectDiff, hasDiff } from "../utils/diff";
import { detectUntrackedFiles, getTotalUntrackedCount } from "../utils/untracked";
import { ZIKU_CONFIG_FILE } from "../utils/ziku-config";
import { LOCK_FILE } from "../utils/lock";
import { loadCommandContext, runCommandEffect, toZikuError } from "../services/command-context";
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

    // loadCommandContext + runCommandEffect で設定読み込み・テンプレート解決を DRY 化
    const ctx = await runCommandEffect(
      loadCommandContext(targetDir).pipe(Effect.mapError(toZikuError)),
    );

    const { config, source, templateDir, cleanup } = ctx;

    log.info(`Template: ${pc.cyan(templateDir)}${"path" in source ? " (local)" : ""}`);

    await withFinally(
      async () => {
        const patterns = {
          include: config.include,
          exclude: config.exclude ?? [],
        };

        if (patterns.include.length === 0) {
          log.warn("No patterns configured");
          return;
        }

        log.step("Detecting changes...");

        const diff = await withSpinner("Analyzing differences...", () =>
          detectDiff({ targetDir, templateDir, patterns }),
        );

        const untrackedByFolder = await detectUntrackedFiles({ targetDir, patterns });
        const untrackedCount = getTotalUntrackedCount(untrackedByFolder);

        if (hasDiff(diff)) {
          logDiffSummary(diff.files);

          if (args.verbose) {
            for (const file of diff.files.filter((f) => f.type !== "unchanged")) {
              renderFileDiff(file);
            }
          }

          if (untrackedCount > 0) {
            logUntrackedFiles(untrackedByFolder, untrackedCount);
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
      cleanup,
    );
  },
});

function logUntrackedFiles(
  untrackedByFolder: Array<{ files: Array<{ path: string }> }>,
  untrackedCount: number,
): void {
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
