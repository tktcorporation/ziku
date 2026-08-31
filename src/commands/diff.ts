import { defineCommand } from "citty";
import { Effect } from "effect";
import { withCleanup } from "../effect-helpers";
import type { DiffResult } from "../modules/schemas";
import { basePatternsOf } from "../modules/schemas";
import { analyzeConfigDrift } from "../utils/config-merge";
import { renderFileDiff } from "../ui/diff-view";
import { logUntrackedFilesNotice } from "../ui/prompts";
import { intro, log, logDiffSummary, outro, pc, withSpinner } from "../ui/renderer";
import { detectDiff, hasDiff } from "../utils/diff";
import { absPath } from "../utils/paths";
import { resolveSyncScope } from "../utils/sync-scope";
import { detectUntrackedFiles, getTotalUntrackedCount } from "../utils/untracked";
import { ZIKU_CONFIG_FILE, isZikuConfigPath } from "../utils/ziku-config";
import { LOCK_FILE } from "../utils/lock";
import { loadCommandContext, runCommandEffect, toZikuFailure } from "../services/command-context";
import type { CommandLifecycle } from "../docs/lifecycle-types";
import { SYNCED_FILES } from "../docs/lifecycle-types";

/**
 * diff コマンドのファイル操作メタデータ。
 * ドキュメント自動生成（npm run docs）の SSOT として使われる。
 */
export const diffLifecycle: CommandLifecycle = {
  name: "diff",
  description: "Show differences between local and template",
  audience: "Template user",
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

    const targetDir = absPath(args.dir);

    // loadCommandContext + runCommandEffect で設定読み込み・テンプレート解決を DRY 化。
    // diff は読むだけなので lock へは書かない。
    const ctx = await runCommandEffect(
      loadCommandContext(targetDir, "readOnly").pipe(Effect.mapError(toZikuFailure)),
    );

    const { config, lock, source, templateDir, cleanup } = ctx;

    log.info(`Template: ${pc.cyan(templateDir)}${source.kind === "local" ? " (local)" : ""}`);

    // 本体を Effect.promise で包む理由: 本体が呼ぶ detectDiff / detectUntrackedFiles は
    // Promise を返すため、失敗は型に現れず throw で抜ける。Effect.tryPromise の catch で
    // 拾うとエラーチャネルが unknown に潰れるので、defect として運び runCommandEffect が
    // 投げられた値をそのまま再スローする。
    await runCommandEffect(
      withCleanup(
        Effect.promise(async () => {
          if (config.include.length === 0) {
            log.warn("No patterns configured");
            return;
          }

          // 走査範囲は全コマンドで同じ規則から決める。pull / push と範囲がずれると、
          // diff が見せる差分と実際に同期される内容が食い違う。
          const { scope } = await resolveSyncScope({
            targetDir,
            templateDir,
            include: config.include,
            exclude: config.exclude ?? [],
            basePatterns: basePatternsOf(lock),
          });

          log.step("Detecting changes...");

          const detected = await withSpinner("Analyzing differences...", () =>
            detectDiff({ targetDir, templateDir, scope }),
          );

          // `.ziku/ziku.jsonc` はテキストの一致ではなくパターン集合の突き合わせで同期する
          // （`utils/config-merge.ts`）。テキストが食い違っていても、ローカルが外したパターンが
          // 残っているだけなら pull も push もこのファイルを書き換えない。そのまま差分として
          // 見せると、実行しても何も起きない `ziku push` を勧めることになる。
          const configDrift = await analyzeConfigDrift(
            targetDir,
            templateDir,
            basePatternsOf(lock),
          );
          const diff: DiffResult =
            configDrift.pullRelevant || configDrift.pushRelevant
              ? detected
              : {
                  ...detected,
                  files: detected.files.filter((file) => !isZikuConfigPath(file.path)),
                };

          const untrackedByFolder = await detectUntrackedFiles({ targetDir, scope });
          const untrackedCount = getTotalUntrackedCount(untrackedByFolder);

          if (hasDiff(diff)) {
            logDiffSummary(diff.files);

            if (args.verbose) {
              for (const file of diff.files.filter((f) => f.type !== "unchanged")) {
                renderFileDiff(file);
              }
            }

            if (untrackedCount > 0) {
              logUntrackedFilesNotice(untrackedByFolder, untrackedCount);
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
        }),
        cleanup,
      ),
    );
  },
});
