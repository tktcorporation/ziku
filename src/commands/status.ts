import { defineCommand } from "citty";
import { Effect } from "effect";
import { resolve } from "pathe";
import { withFinally } from "../effect-helpers";
import { loadCommandContext, runCommandEffect, toZikuError } from "../services/command-context";
import type { CommandLifecycle } from "../docs/lifecycle-types";
import { SYNCED_FILES } from "../docs/lifecycle-types";
import { intro, log, outro, pc, withSpinner } from "../ui/renderer";
import {
  recommendationLine,
  renderStatusLong,
  renderStatusShort,
  type StatusViewModel,
} from "../ui/status-view";
import { LOCK_FILE } from "../utils/lock";
import {
  categorizeForStatus,
  decideRecommendation,
  exitCodeForRecommendation,
  STATUS_EXIT_CODE,
  type StatusExitCode,
} from "../utils/status";
import { analyzeSync } from "../utils/sync-analysis";
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
    "`--exit-code` フラグを付けると、in-sync で 0、差分ありで 1、`pendingMerge` 中で 2 を返す。CI で `ziku status --exit-code` を呼ぶことで「ローカルがテンプレートと同期しているか」を判定できる。",
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
    short: {
      type: "boolean",
      alias: "s",
      description: "Porcelain-style one-line-per-file output",
      default: false,
    },
    "exit-code": {
      type: "boolean",
      description: "Exit non-zero when out of sync (CI use)",
      default: false,
    },
  },
  async run({ args }) {
    const isShort = args.short;
    if (!isShort) intro("status");

    const targetDir = resolve(args.dir);

    const ctx = await runCommandEffect(
      loadCommandContext(targetDir).pipe(Effect.mapError(toZikuError)),
    );

    const { config, lock, source, templateDir, cleanup } = ctx;

    if (!isShort) {
      log.info(`Template: ${pc.cyan(templateDir)}${"path" in source ? " (local)" : ""}`);
    }

    // process.exit を withFinally の中で呼ぶと Effect.ensuring がスキップされ
    // 一時テンプレートディレクトリ (GitHub source 時) がリークする。
    // まず exit code を変数に確定させ、cleanup 完了後にプロセスを終了する。
    let exitCode: StatusExitCode = STATUS_EXIT_CODE.SYNC;

    await withFinally(async () => {
      const include = config.include;
      const exclude = config.exclude ?? [];

      if (include.length === 0) {
        if (!isShort) {
          log.warn("No patterns configured");
          outro("Nothing to compare.");
        }
        return;
      }

      const analyze = () =>
        analyzeSync({
          targetDir,
          templateDir,
          baseHashes: lock.baseHashes,
          include,
          exclude,
        });

      const { classification } = isShort
        ? await analyze()
        : await withSpinner("Comparing local with template...", analyze);

      const buckets = categorizeForStatus(classification);
      const untracked = await detectUntrackedFiles({
        targetDir,
        patterns: { include, exclude },
      });
      const recommendation = decideRecommendation(buckets, lock);

      const model: StatusViewModel = { buckets, untracked, recommendation };

      if (isShort) {
        const out = renderStatusShort(model);
        if (out.length > 0) process.stdout.write(`${out}\n`);
      } else {
        log.message(renderStatusLong(model));
        // recommendation を outro として強調表示する。renderStatusLong には含めず
        // ここで一元化することで、メッセージの SSOT を保つ。
        outro(recommendationLine(recommendation));
      }

      if (args["exit-code"]) {
        exitCode = exitCodeForRecommendation(recommendation);
      }
    }, cleanup);

    if (exitCode !== STATUS_EXIT_CODE.SYNC) process.exit(exitCode);
  },
});
