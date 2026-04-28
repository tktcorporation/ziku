import { defineCommand } from "citty";
import { Effect } from "effect";
import { resolve } from "pathe";
import { withFinally } from "../effect-helpers";
import { loadCommandContext, runCommandEffect, toZikuError } from "../services/command-context";
import type { CommandLifecycle } from "../docs/lifecycle-types";
import { SYNCED_FILES } from "../docs/lifecycle-types";
import { intro, log, outro, pc, withSpinner } from "../ui/renderer";
import { recommendationLine, renderStatusLong, type StatusViewModel } from "../ui/status-view";
import { LOCK_FILE } from "../utils/lock";
import { categorizeForStatus, decideRecommendation } from "../utils/status";
import { analyzeSync } from "../utils/sync-analysis";
import { mergeTemplatePatterns } from "../utils/template-patterns";
import { detectUntrackedFiles } from "../utils/untracked";
import { ZIKU_CONFIG_FILE } from "../utils/ziku-config";

/**
 * status コマンドのファイル操作メタデータ。
 * ドキュメント自動生成（npm run docs）の SSOT として使われる。
 */
export const statusLifecycle: CommandLifecycle = {
  name: "status",
  description: "Show pending pull/push counts and recommend next action",
  ops: [
    { file: ZIKU_CONFIG_FILE, location: "local", op: "read", note: "patterns を取得" },
    {
      file: LOCK_FILE,
      location: "local",
      op: "read",
      note: "baseHashes と pendingMerge を取得",
    },
    {
      file: SYNCED_FILES,
      location: "local",
      op: "read",
      note: "ローカルファイルのハッシュを計算",
    },
    {
      file: SYNCED_FILES,
      location: "template",
      op: "read",
      note: "テンプレートをダウンロードしてハッシュを計算",
    },
  ],
  notes: [
    "`status` は読み取り専用。ファイルや lock.json を一切変更しない。",
    "`status` は git status と同じく常に exit 0 で終了する（観察コマンドの責務）。CI でゲートしたい場合は将来 `pull --dry-run` や `diff --exit-code` 等の専用コマンドに任せる予定。",
  ],
};

export const statusCommand = defineCommand({
  meta: {
    name: "status",
    description: "Show pending pull/push counts and recommend next action",
  },
  args: {
    dir: {
      type: "positional",
      description: "Project directory",
      default: ".",
    },
  },
  async run({ args }) {
    intro("status");

    const targetDir = resolve(args.dir);

    const ctx = await runCommandEffect(
      loadCommandContext(targetDir).pipe(Effect.mapError(toZikuError)),
    );

    const { config, lock, source, templateDir, cleanup } = ctx;

    log.info(`Template: ${pc.cyan(templateDir)}${"path" in source ? " (local)" : ""}`);

    await withFinally(async () => {
      const include = config.include;
      const exclude = config.exclude ?? [];

      if (include.length === 0) {
        log.warn("No patterns configured");
        outro("Nothing to compare.");
        return;
      }

      // テンプレ側で追加された include/exclude パターンを取り込んだ後でハッシュ比較する。
      // これをしないと、テンプレに新規パターンが追加されている状況で status が
      // 「in sync」と誤判定し、その後 `pull` で大量の新ファイルが降ってくる現象が起きる
      // (pull.ts と同じマージ処理を走らせて整合させる)。
      const { mergedInclude, mergedExclude, newInclude, patternsUpdated } =
        await mergeTemplatePatterns(templateDir, include, exclude);

      if (newInclude.length > 0) {
        log.info(
          `Template added ${newInclude.length} new pattern(s) — files matching these will appear as 'new file:' below:`,
        );
        for (const p of newInclude) {
          log.message(`  ${pc.green("+")} ${p}`);
        }
      }

      const { classification } = await withSpinner("Comparing local with template...", () =>
        analyzeSync({
          targetDir,
          templateDir,
          baseHashes: lock.baseHashes,
          include: mergedInclude,
          exclude: mergedExclude,
        }),
      );

      const buckets = categorizeForStatus(classification);
      const untracked = await detectUntrackedFiles({
        targetDir,
        patterns: { include: mergedInclude, exclude: mergedExclude },
      });
      // patternsUpdated を渡すことで、ファイル差分はゼロでも「テンプレが新パターンを追加」
      // しているケースで pull を強制推奨する (push は raw config.include を読むため、
      // パターン追加を反映するには pull が必要 — codex review #71)。
      const recommendation = decideRecommendation(buckets, lock, patternsUpdated);

      const model: StatusViewModel = { buckets, untracked, recommendation };
      log.message(renderStatusLong(model));
      // recommendation を outro として強調表示する。renderStatusLong には含めず
      // ここで一元化することで、メッセージの SSOT を保つ。
      outro(recommendationLine(recommendation));
    }, cleanup);
  },
});
