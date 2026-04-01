import { defineCommand } from "citty";
import { resolve } from "pathe";
import { BermError } from "../errors";
import {
  addIncludePattern,
  loadPatternsFile,
  modulesFileExists,
  saveModulesFile,
} from "../modules";
import { intro, log, outro, pc } from "../ui/renderer";

export const trackCommand = defineCommand({
  meta: {
    name: "track",
    description: "Add file patterns to the tracking whitelist in modules.jsonc",
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

    if (!modulesFileExists(targetDir)) {
      throw new BermError(
        ".ziku/modules.jsonc not found.",
        "Run 'ziku init' first to set up the project.",
      );
    }

    // --list モード
    if (args.list) {
      const { include, exclude } = await loadPatternsFile(targetDir);
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
    const argsAfterTrack = trackIdx !== -1 ? rawArgs.slice(trackIdx + 1) : rawArgs;

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
      throw new BermError(
        "No patterns specified.",
        "Usage: ziku track <patterns...>\nExample: ziku track '.cloud/rules/*.md' '.cloud/config.json'",
      );
    }

    const { rawContent } = await loadPatternsFile(targetDir);

    const updatedContent = addIncludePattern(rawContent, patterns);

    if (updatedContent === rawContent) {
      log.info("All patterns are already tracked. No changes needed.");
      return;
    }

    await saveModulesFile(targetDir, updatedContent);

    log.success("Patterns added!");
    const details = ["Added:", ...patterns.map((p) => `  ${pc.green("+")} ${p}`)];
    log.message(details.join("\n"));
    outro("Updated .ziku/modules.jsonc");
  },
});
