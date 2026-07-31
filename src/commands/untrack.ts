import { defineCommand } from "citty";
import { resolve } from "pathe";
import { ZikuError } from "../errors";
import { intro, log, outro, pc } from "../ui/renderer";
import {
  ZIKU_CONFIG_FILE,
  loadZikuConfig,
  removeIncludePattern,
  saveZikuConfig,
  zikuConfigExists,
} from "../utils/ziku-config";
import type { CommandLifecycle } from "../docs/lifecycle-types";

/**
 * untrack コマンドのファイル操作メタデータ。
 * ドキュメント自動生成（npm run docs）の SSOT として使われる。
 */
export const untrackLifecycle: CommandLifecycle = {
  name: "untrack",
  description: "Remove file patterns from the sync whitelist",
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
      note: "指定パターンを include から削除",
    },
  ],
  notes: [
    "`ziku untrack` は `ziku track` の逆操作。ローカルの `ziku.jsonc` の include からパターンを削除する。テンプレートには影響しない（反映するには `ziku push` でテンプレートの `ziku.jsonc` を更新する）。",
  ],
};

export const untrackCommand = defineCommand({
  meta: {
    name: "untrack",
    description: "Remove file patterns from the tracking whitelist in ziku.jsonc",
  },
  args: {
    patterns: {
      type: "positional",
      description: "File paths or glob patterns to untrack (e.g., .cloud/rules/*.md)",
      required: false,
    },
    dir: {
      type: "string",
      alias: "d",
      description: "Project directory (default: current directory)",
      default: ".",
    },
  },
  async run({ args }) {
    intro("untrack");

    const targetDir = resolve(args.dir);

    if (!zikuConfigExists(targetDir)) {
      throw new ZikuError(
        ".ziku/ziku.jsonc not found.",
        "Run 'ziku init' first to set up the project.",
      );
    }

    const patterns = parsePatternArgs();

    if (patterns.length === 0) {
      throw new ZikuError(
        "No patterns specified.",
        "Usage: ziku untrack <patterns...>\nExample: ziku untrack '.cloud/rules/*.md' '.cloud/config.json'",
      );
    }

    const { config, rawContent } = await loadZikuConfig(targetDir);

    // 指定パターンを「実際に追跡中のもの」と「未追跡（削除対象なし）」に分ける。
    // 完全一致で比較する: untrack は track が追記した文字列をそのまま消す操作のため、
    // glob の展開ではなくパターン文字列の一致で扱う（track と対称）。
    const tracked = new Set(config.include);
    const toRemove = patterns.filter((p) => tracked.has(p));
    const notTracked = patterns.filter((p) => !tracked.has(p));

    if (notTracked.length > 0) {
      log.warn(`Not tracked (skipped): ${notTracked.join(", ")}`);
    }

    if (toRemove.length === 0) {
      log.info("None of the specified patterns are tracked. No changes needed.");
      outro("No changes.");
      return;
    }

    const updatedContent = removeIncludePattern(rawContent, toRemove);
    await saveZikuConfig(targetDir, updatedContent);

    log.success("Patterns removed!");
    const details = ["Removed:", ...toRemove.map((p) => `  ${pc.red("-")} ${p}`)];
    log.message(details.join("\n"));
    outro("Updated .ziku/ziku.jsonc");
  },
});

/**
 * process.argv から untrack サブコマンド以降のパターン引数を抽出する。
 * フラグ引数（--dir 等）は除外する。
 *
 * track.ts の parsePatternArgs と同じ方針: citty の positional は複数値を
 * 1 つしか拾わないため、生の argv から自前で全パターンを集める。
 */
function parsePatternArgs(): string[] {
  const rawArgs = process.argv.slice(2);
  const untrackIdx = rawArgs.indexOf("untrack");
  const argsAfterUntrack = untrackIdx === -1 ? rawArgs : rawArgs.slice(untrackIdx + 1);

  const patterns: string[] = [];
  let i = 0;
  while (i < argsAfterUntrack.length) {
    const arg = argsAfterUntrack[i];
    if (arg === "--help" || arg === "-h") {
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

  return patterns;
}
