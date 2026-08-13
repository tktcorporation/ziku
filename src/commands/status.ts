import { defineCommand } from "citty";
import { Effect, Option } from "effect";
import { withFinally } from "../effect-helpers";
import { loadCommandContext, runCommandEffect, toZikuFailure } from "../services/command-context";
import type { LockState } from "../modules/schemas";
import { baseHashesOf } from "../modules/schemas";
import type { CommandLifecycle } from "../docs/lifecycle-types";
import { SYNCED_FILES } from "../docs/lifecycle-types";
import { intro, log, outro, pc, withSpinner } from "../ui/renderer";
import { recommendationLine, renderStatusLong, type StatusViewModel } from "../ui/status-view";
import { LOCK_FILE, loadLock } from "../utils/lock";
import { categorizeForStatus, decideRecommendation, type Recommendation } from "../utils/status";
import { withZikuConfigAt, zikuConfigStatusCategory } from "../utils/merge/sync-plan";
import { analyzeSync } from "../utils/sync-analysis";
import { analyzeConfigDrift } from "../utils/config-merge";
import { absPath } from "../utils/paths";
import { mergeTemplatePatterns } from "../utils/template-patterns";
import { detectUntrackedFiles } from "../utils/untracked";
import { ZIKU_CONFIG_FILE, withConfigTracked, zikuConfigExists } from "../utils/ziku-config";

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
      note: "同期ベースとコンフリクト解決待ちの状態を取得",
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

    const targetDir = absPath(args.dir);

    // Fast-path: コンフリクト解決待ちを検出できればテンプレートを fetch せずに案内する。
    //
    // 背景: 解決待ち中の回復コマンド (`ziku pull --continue`) は
    // `merge.nextBase` をそのまま使うため、新たなテンプレ取得は不要。
    // ところが status が常に `loadCommandContext` 経由で template を fetch していると、
    // ネットワーク不通やテンプレリポジトリ移動時に status 自体が失敗し、
    // ユーザーが「`pull --continue` を実行すれば回復できる」と知る術が無くなる
    // (codex review #71)。
    //
    // 整合性条件 (codex review #71 follow-up):
    //   `pull --continue` 自身は `zikuConfigExists` を前提に動く。fast-path で
    //   この前提を満たさない (config 削除済み等) のに `pull --continue` を案内すると、
    //   ユーザーが従っても "Not initialized" で失敗するので「動かない命令」を
    //   出すことになる。zikuConfigExists を先に確認し、不成立なら通常の
    //   `loadCommandContext` 経路に進ませて適切なエラーを出す。
    //
    // lock.json が無いだけなら fast-path をスキップして通常経路のエラーに任せる。
    // 一方で「読めたが lock として解釈できない」は通常経路でも同じ結論になるので、
    // ここでそのまま報告する（テンプレート取得を挟むと原因が遠ざかる）。
    if (zikuConfigExists(targetDir)) {
      const lockOption = await runCommandEffect(
        loadLock(targetDir).pipe(
          Effect.map(Option.some),
          Effect.catchTag("FileNotFoundError", () => Effect.succeed(Option.none<LockState>())),
          Effect.mapError(toZikuFailure),
        ),
      );
      if (Option.isSome(lockOption) && lockOption.value.sync === "merging") {
        const conflicts = lockOption.value.merge.conflicts;
        const recommendation: Recommendation = {
          kind: "continueMerge",
          conflictCount: conflicts.length,
        };
        log.message(
          `${pc.yellow("⚠")} Merge paused. Conflicts to resolve:\n${conflicts
            .map((p) => `  ${pc.dim("•")} ${p}`)
            .join("\n")}`,
        );
        outro(recommendationLine(recommendation));
        return;
      }
    }

    const ctx = await runCommandEffect(
      loadCommandContext(targetDir).pipe(Effect.mapError(toZikuFailure)),
    );

    const { config, lock, source, templateDir, cleanup } = ctx;

    log.info(`Template: ${pc.cyan(templateDir)}${source.kind === "local" ? " (local)" : ""}`);

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

      const { plan } = await withSpinner("Comparing local with template...", () =>
        analyzeSync({
          targetDir,
          templateDir,
          baseHashes: baseHashesOf(lock),
          // ziku.jsonc 自体も追跡ファイルとして差分検出に含める（push/pull と一貫させ、
          // config ドリフトを status に反映する）。
          include: withConfigTracked(mergedInclude),
          exclude: mergedExclude,
        }),
      );

      // ziku.jsonc は加法 union で同期されるため、ハッシュ差分ではなく union 観点の実差分で
      // 入れるバケツを決め直してから表示に載せる（判断は zikuConfigStatusCategory）。
      const drift = await analyzeConfigDrift(targetDir, templateDir);
      const buckets = categorizeForStatus(
        withZikuConfigAt(plan.files, zikuConfigStatusCategory(drift)),
      );
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
