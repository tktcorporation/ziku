import { defineCommand } from "citty";
import { resolve } from "pathe";
import { zikuFailure } from "../errors";
import { intro, log, outro, pc } from "../ui/renderer";
import {
  ZIKU_CONFIG_FILE,
  addIncludePattern,
  loadZikuConfig,
  newIncludePatterns,
  saveZikuConfig,
  zikuConfigExists,
} from "../utils/ziku-config";
import type { CommandLifecycle } from "../docs/lifecycle-types";

/**
 * track コマンドのファイル操作メタデータ。
 * ドキュメント自動生成（npm run docs）の SSOT として使われる。
 */
export const trackLifecycle: CommandLifecycle = {
  name: "track",
  description: "Add file patterns to the sync whitelist",
  ops: [
    {
      file: ZIKU_CONFIG_FILE,
      location: "local",
      op: "read",
      note: "現在の include パターンを取得",
    },
    {
      file: ZIKU_CONFIG_FILE,
      location: "local",
      op: "update",
      note: "新しいパターンを include に追加",
    },
  ],
  notes: [
    "`ziku track` で追加したパターンはローカルの `ziku.jsonc` にのみ反映される。テンプレートに反映するには `ziku push` でテンプレートの `ziku.jsonc` を更新する。",
  ],
};

/**
 * 追跡パターンを ziku.jsonc の include に追加するコマンド。
 *
 * パターンを位置引数、プロジェクトディレクトリを `--dir` で受け取る。他コマンドが
 * ディレクトリを位置引数に置いているのとは非対称だが、track の主役は可変長のパターン列で、
 * 先頭の位置引数をディレクトリに割り当てると `ziku track '.claude/rules/*.md'` の
 * パターンがディレクトリとして解釈されてしまう。パターン側を位置引数に取る。
 */
export const trackCommand = defineCommand({
  meta: {
    name: "track",
    description: "Add file patterns to the tracking whitelist in ziku.jsonc",
  },
  args: {
    // citty は位置引数の定義 1 つにつき 1 値しか束縛しないため、この定義は usage 表示用。
    // 実際に使うパターン列は run() の args._（パース済み位置引数の全件）から取る。
    patterns: {
      type: "positional",
      description: "File paths or glob patterns to track (e.g., .cloud/rules/*.md)",
      required: false,
    },
    dir: {
      type: "string",
      alias: "d",
      description: "Project directory (default: current directory)",
      default: ".",
    },
    list: {
      type: "boolean",
      alias: "l",
      description: "List all currently tracked patterns",
      default: false,
    },
    dryRun: {
      type: "boolean",
      alias: "n",
      description: "Preview patterns that would be tracked, without writing",
      default: false,
    },
  },
  async run({ args }) {
    intro("track");

    const targetDir = resolve(args.dir);

    if (!zikuConfigExists(targetDir)) {
      throw zikuFailure({ kind: "NotInitialized", path: ZIKU_CONFIG_FILE });
    }

    if (args.list) {
      await listTrackedPatterns(targetDir);
      return;
    }

    // args._ には citty がパースした位置引数だけが入る。`--dir foo` のようなフラグの値も
    // citty 側で取り除かれるため、パース規則をコマンド側に持たなくてよい。
    const patterns = args._;

    if (patterns.length === 0) {
      throw zikuFailure({
        kind: "MissingArgument",
        argument: "patterns",
        usage:
          "Usage: ziku track <patterns...>\nExample: ziku track '.cloud/rules/*.md' '.cloud/config.json'",
      });
    }

    const { config, rawContent } = await loadZikuConfig(targetDir);

    const updatedContent = addIncludePattern(rawContent, patterns);

    if (updatedContent === rawContent) {
      log.info("All patterns are already tracked. No changes needed.");
      return;
    }

    // 指定パターンに既存追跡済みのものが混ざっていても、実際に書き込まれる
    // 新規パターンだけを表示する（addIncludePattern と同じ差分を使う）。
    const newPatterns = newIncludePatterns(config.include, patterns);

    if (args.dryRun) {
      log.info("Dry run mode");
      const details = ["Would add:", ...newPatterns.map((p) => `  ${pc.green("+")} ${p}`)];
      log.message(details.join("\n"));
      outro("Dry run complete — .ziku/ziku.jsonc was not written");
      return;
    }

    await saveZikuConfig(targetDir, updatedContent);

    log.success("Patterns added!");
    const details = ["Added:", ...newPatterns.map((p) => `  ${pc.green("+")} ${p}`)];
    log.message(details.join("\n"));
    outro("Updated .ziku/ziku.jsonc");
  },
});

/** --list モード: 現在追跡中のパターン一覧を表示する */
async function listTrackedPatterns(targetDir: string): Promise<void> {
  const {
    config: { include, exclude: excludeRaw },
  } = await loadZikuConfig(targetDir);
  const exclude = excludeRaw ?? [];
  log.info("Tracked patterns:");
  for (const pattern of include) {
    log.message(`  ${pc.dim("→")} ${pattern}`);
  }
  if (exclude.length > 0) {
    log.info("Excluded patterns:");
    for (const pattern of exclude) {
      log.message(`  ${pc.dim("✕")} ${pc.dim(pattern)}`);
    }
  }
  outro("Done.");
}
