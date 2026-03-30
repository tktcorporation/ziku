import { defineCommand } from "citty";
import { resolve } from "pathe";
import { BermError } from "../errors";
import {
  addPatternToModulesFileWithCreate,
  loadModulesFile,
  modulesFileExists,
  saveModulesFile,
} from "../modules";
import { getModuleIdFromPath } from "../utils/untracked";
import { intro, log, outro, pc } from "../ui/renderer";

/**
 * パターン文字列からモジュール ID を推定
 * 例: ".cloud/rules/*.md" → ".cloud"
 *     ".mcp.json" → "."
 *     ".github/workflows/ci.yml" → ".github"
 */
function inferModuleId(pattern: string): string {
  // glob のメタ文字を除いた先頭パスからモジュール ID を推定
  const cleanPath = pattern.replace(/\*.*$/, "").replace(/\{.*$/, "");
  return getModuleIdFromPath(cleanPath || pattern);
}

export const trackCommand = defineCommand({
  meta: {
    name: "track",
    description: "Add file patterns to the tracking whitelist in modules.jsonc",
  },
  args: {
    patterns: {
      type: "positional",
      description: "File paths or glob patterns to track (e.g., .cloud/rules/*.md)",
      required: false, // --list 時はパターン不要。パターンなし+--listなしはrun()内でBermError
    },
    dir: {
      type: "string",
      alias: "d",
      description: "Project directory (default: current directory)",
      default: ".",
    },
    module: {
      type: "string",
      alias: "m",
      description: "Module ID to add patterns to (auto-detected from path if omitted)",
    },
    name: {
      type: "string",
      description: "Module name (used when creating a new module)",
    },
    description: {
      type: "string",
      description: "Module description (used when creating a new module)",
    },
    list: {
      type: "boolean",
      alias: "l",
      description: "List all currently tracked modules and patterns",
      default: false,
    },
  },
  async run({ args }) {
    intro("track");

    const targetDir = resolve(args.dir);

    // modules.jsonc の存在確認
    if (!modulesFileExists(targetDir)) {
      throw new BermError(
        ".ziku/modules.jsonc not found.",
        "Run 'ziku init' first to set up the project.",
      );
    }

    // --list モード: 現在の追跡パターンを表示
    if (args.list) {
      const { modules } = await loadModulesFile(targetDir);
      log.info("Tracked modules and patterns:");
      for (const mod of modules) {
        const lines: string[] = [];
        lines.push(`${pc.cyan(mod.id)} ${pc.dim(`(${mod.name})`)}`);
        if (mod.description) {
          lines.push(`  ${pc.dim(mod.description)}`);
        }
        for (const pattern of mod.patterns) {
          lines.push(`  ${pc.dim("→")} ${pattern}`);
        }
        log.message(lines.join("\n"));
      }
      outro("Done.");
      return;
    }

    // パターン引数のパース（citty は positional を単一の文字列として渡す）
    // process.argv から track 以降の positional 引数を収集
    const rawArgs = process.argv.slice(2);
    const trackIdx = rawArgs.indexOf("track");
    const argsAfterTrack = trackIdx !== -1 ? rawArgs.slice(trackIdx + 1) : rawArgs;

    // フラグ以外の引数をパターンとして収集
    const patterns: string[] = [];
    let i = 0;
    while (i < argsAfterTrack.length) {
      const arg = argsAfterTrack[i];
      if (arg === "--list" || arg === "-l" || arg === "--help" || arg === "-h") {
        i++;
        continue;
      }
      // 値付きフラグをスキップ
      if (
        arg === "--dir" ||
        arg === "-d" ||
        arg === "--module" ||
        arg === "-m" ||
        arg === "--name" ||
        arg === "--description"
      ) {
        i += 2; // フラグ + 値
        continue;
      }
      // フラグ以外の引数はパターン
      if (!arg.startsWith("-")) {
        patterns.push(arg);
      }
      i++;
    }

    if (patterns.length === 0) {
      throw new BermError(
        "No patterns specified.",
        "Usage: ziku track <patterns...> [--module <id>]\nExample: ziku track '.cloud/rules/*.md' '.cloud/config.json'",
      );
    }

    // モジュール ID の決定
    const moduleId = args.module || inferModuleId(patterns[0]);

    // modules.jsonc を読み込み
    const { rawContent } = await loadModulesFile(targetDir);

    // パターンを追加（モジュールがなければ作成）
    const updatedContent = addPatternToModulesFileWithCreate(rawContent, moduleId, patterns, {
      name: args.name,
      description: args.description,
    });

    if (updatedContent === rawContent) {
      log.info("All patterns are already tracked. No changes needed.");
      return;
    }

    // 保存
    await saveModulesFile(targetDir, updatedContent);

    // 結果表示
    log.success("Patterns added!");
    const details = [
      `Module: ${pc.cyan(moduleId)}`,
      "Added:",
      ...patterns.map((p) => `  ${pc.green("+")} ${p}`),
    ];
    log.message(details.join("\n"));
    outro("Updated .ziku/modules.jsonc");
  },
});
