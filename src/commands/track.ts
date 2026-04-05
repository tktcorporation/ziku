import { defineCommand } from "citty";
import { resolve } from "pathe";
import { ZikuError } from "../errors";
import { intro, log, outro, pc } from "../ui/renderer";
import {
  ZIKU_CONFIG_FILE,
  addIncludePattern,
  loadZikuConfig,
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

export const trackCommand = defineCommand({
  meta: {
    name: "track",
    description: "Add file patterns to the tracking whitelist in ziku.jsonc",
  },
  args: {
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
  },
  async run({ args }) {
    intro("track");

    const targetDir = resolve(args.dir);

    if (!zikuConfigExists(targetDir)) {
      throw new ZikuError(
        ".ziku/ziku.jsonc not found.",
        "Run 'ziku init' first to set up the project.",
      );
    }

    // --list モード
    if (args.list) {
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
      return;
    }

    // パターン引数のパース
    const rawArgs = process.argv.slice(2);
    const trackIdx = rawArgs.indexOf("track");
    const argsAfterTrack = trackIdx === -1 ? rawArgs : rawArgs.slice(trackIdx + 1);

    const patterns: string[] = [];
    let i = 0;
    while (i < argsAfterTrack.length) {
      const arg = argsAfterTrack[i];
      if (arg === "--list" || arg === "-l" || arg === "--help" || arg === "-h") {
        i++;
        continue;
      }
      if (arg === "--dir" || arg === "-d") {
        i += 2;
        continue;
      }
      if (!arg.startsWith("-")) {
        patterns.push(arg);
      }
      i++;
    }

    if (patterns.length === 0) {
      throw new ZikuError(
        "No patterns specified.",
        "Usage: ziku track <patterns...>\nExample: ziku track '.cloud/rules/*.md' '.cloud/config.json'",
      );
    }

    const { rawContent } = await loadZikuConfig(targetDir);

    const updatedContent = addIncludePattern(rawContent, patterns);

    if (updatedContent === rawContent) {
      log.info("All patterns are already tracked. No changes needed.");
      return;
    }

    await saveZikuConfig(targetDir, updatedContent);

    log.success("Patterns added!");
    const details = ["Added:", ...patterns.map((p) => `  ${pc.green("+")} ${p}`)];
    log.message(details.join("\n"));
    outro("Updated .ziku/ziku.jsonc");
  },
});
