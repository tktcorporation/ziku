#!/usr/bin/env npx tsx
/**
 * Auto-generate README.md sections from source code
 *
 * Usage:
 *   pnpm run docs
 *   pnpm run docs:check  # Check only (for CI)
 *
 * Generated sections:
 *   - Getting Started (from init command constants)
 *   - Usage (static content)
 *   - Commands (from citty renderUsage)
 *
 * Non-generated sections (manually maintained):
 *   - Features/Modules
 *   - What You Get / Files
 */

// Prevent environment-dependent renderUsage output differences
process.env.NO_COLOR = "1";
process.env.FORCE_COLOR = "0";
process.env.COLUMNS = "80";

import { execFileSync } from "node:child_process";
import { readFile, writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import { stripVTControlCharacters } from "node:util";
import { renderUsage } from "citty";
import { z } from "zod";
import { diffCommand } from "../src/commands/diff";
import { generateFlatPatternsJsonc, initCommand } from "../src/commands/init";
import { pullCommand } from "../src/commands/pull";
import { pushCommand } from "../src/commands/push";
import { trackCommand } from "../src/commands/track";
import { modulesFileSchema } from "../src/modules/loader";
import { DEFAULT_TEMPLATE_REPO } from "../src/utils/git-remote";

const README_PATH = resolve(import.meta.dirname, "../README.md");
const SCHEMA_PATH = resolve(import.meta.dirname, "../schema/modules.json");

// Marker definitions
const MARKERS = {
  gettingStarted: {
    start: "<!-- GETTING_STARTED:START -->",
    end: "<!-- GETTING_STARTED:END -->",
  },
  usage: {
    start: "<!-- USAGE:START -->",
    end: "<!-- USAGE:END -->",
  },
  commands: {
    start: "<!-- COMMANDS:START -->",
    end: "<!-- COMMANDS:END -->",
  },
} as const;

/**
 * Generate Getting Started section from source code constants
 */
function generateGettingStartedSection(): string {
  // Generate example modules.jsonc from the same function used at runtime
  const exampleJson = generateFlatPatternsJsonc({
    include: [".editorconfig", ".mcp.json", ".mise.toml", ".github/**"],
    exclude: [],
  });

  const lines: string[] = [
    "## Getting Started\n",
    "### 1. Set up your template repository\n",
    `ziku uses a GitHub repository as the template source. By default, it looks for \`{your-org}/${DEFAULT_TEMPLATE_REPO}\` based on your git remote.\n`,
    "If the repository doesn't exist yet, `npx ziku` will offer to create it for you interactively. You can also create it manually or specify a different source:\n",
    "```bash",
    "# Auto-detect from git remote (recommended)",
    "npx ziku",
    "",
    "# Use a specific template repository",
    "npx ziku --from my-org/my-templates",
    "```\n",
    "### 2. Add `.ziku/modules.jsonc` to your template\n",
    "The template repository needs a `.ziku/modules.jsonc` file that defines which file patterns ziku manages. If this file is missing, ziku will offer to create a PR that adds one with a default configuration.\n",
    "Example `modules.jsonc`:\n",
    "```jsonc",
    exampleJson,
    "```\n",
    "### 3. Apply the template to your project\n",
    "```bash",
    "npx ziku",
    "```\n",
    "ziku copies the matching files into your project. A `.ziku/ziku.jsonc` (config) and `.ziku/lock.json` (sync state) are created locally to track what was installed.\n",
    "### 4. Keep it in sync\n",
    "```bash",
    "# Push local improvements back to the template",
    'npx ziku push -m "Add new workflow"',
    "",
    "# Pull latest template updates",
    "npx ziku pull",
    "",
    "# Check what's different",
    "npx ziku diff",
    "```\n",
  ];

  return lines.join("\n");
}

/**
 * Generate Usage section
 */
function generateUsageSection(): string {
  const lines: string[] = [
    "## Usage\n",
    "```bash",
    "# Apply template to current directory",
    "npx ziku",
    "",
    "# Apply to a specific directory",
    "npx ziku ./my-project",
    "",
    "# Push your improvements back",
    'npx ziku push -m "Add new workflow"',
    "",
    "# Check what's different",
    "npx ziku diff",
    "```\n",
  ];
  return lines.join("\n");
}

/**
 * Get description from command meta (handles Resolvable type)
 */
function getCommandDescription(meta: unknown): string {
  if (meta && typeof meta === "object" && "description" in meta) {
    return (meta as { description?: string }).description || "";
  }
  return "";
}

/**
 * Generate Commands section
 */
async function generateCommandsSection(): Promise<string> {
  /**
   * 各コマンドのヘルプをセクションとして生成するヘルパー。
   * 配列リテラルに直接含めることで no-immediate-mutation を回避。
   */
  const commandSection = async (name: string, cmd: { meta: unknown }) => [
    `### \`${name}\`\n`,
    `${getCommandDescription(cmd.meta)}\n`,
    "```",
    cleanUsageOutput(await renderUsage(cmd)),
    "```\n",
  ];

  const sections: string[] = [
    "## Commands\n",
    ...(await commandSection("init", initCommand)),
    ...(await commandSection("push", pushCommand)),
    ...(await commandSection("pull", pullCommand)),
    ...(await commandSection("diff", diffCommand)),
    ...(await commandSection("track", trackCommand)),
  ];

  return sections.join("\n");
}

/**
 * Clean usage output by removing ANSI codes and trailing whitespace
 */
function cleanUsageOutput(usage: string): string {
  return stripVTControlCharacters(usage)
    .split("\n")
    .map((line) => line.trimEnd())
    .join("\n")
    .trim();
}

/**
 * Update README section between markers
 */
function updateSection(
  content: string,
  startMarker: string,
  endMarker: string,
  newSection: string,
): string {
  const startIndex = content.indexOf(startMarker);
  const endIndex = content.indexOf(endMarker);

  if (startIndex === -1 || endIndex === -1) {
    // Marker not found - skip this section
    return content;
  }

  const before = content.slice(0, startIndex + startMarker.length);
  const after = content.slice(endIndex);

  return `${before}\n\n${newSection}\n${after}`;
}

/**
 * Main
 */
async function main(): Promise<void> {
  const isCheck = process.argv.includes("--check");

  console.log("📝 Generating documentation...\n");

  // Generate JSON Schema from Zod schema
  const jsonSchema = JSON.stringify(z.toJSONSchema(modulesFileSchema), null, 2);

  // Generate sections
  const gettingStartedSection = generateGettingStartedSection();
  const usageSection = generateUsageSection();
  const commandsSection = await generateCommandsSection();

  // Read originals
  let readme = await readFile(README_PATH, "utf-8");
  const originalReadme = readme;

  let originalSchema = "";
  try {
    originalSchema = await readFile(SCHEMA_PATH, "utf-8");
  } catch {
    // file doesn't exist yet
  }

  readme = updateSection(
    readme,
    MARKERS.gettingStarted.start,
    MARKERS.gettingStarted.end,
    gettingStartedSection,
  );
  readme = updateSection(readme, MARKERS.usage.start, MARKERS.usage.end, usageSection);
  readme = updateSection(readme, MARKERS.commands.start, MARKERS.commands.end, commandsSection);

  const readmeUpdated = readme !== originalReadme;

  // Generate formatted JSON Schema (write, run formatter, read back canonical form)
  await writeFile(SCHEMA_PATH, `${jsonSchema}\n`);
  execFileSync("npx", ["oxfmt", "--write", SCHEMA_PATH], { stdio: "ignore" });
  const formattedSchema = await readFile(SCHEMA_PATH, "utf-8");
  const schemaUpdated = originalSchema !== formattedSchema;

  const updated = readmeUpdated || schemaUpdated;

  if (isCheck) {
    // Restore original schema if it was overwritten for formatting
    if (originalSchema) {
      await writeFile(SCHEMA_PATH, originalSchema);
    }

    if (updated) {
      if (readmeUpdated) console.error("  - README.md is out of date");
      if (schemaUpdated) console.error("  - schema/modules.json is out of date");
      console.error("\n❌ Documentation is out of date.");
      console.error("   Run `pnpm run docs` to update.\n");
      process.exit(1);
    }
    console.log("\n✅ Documentation is up to date.\n");
    return;
  }

  // Schema file is already written and formatted above
  if (readmeUpdated) {
    await writeFile(README_PATH, readme);
    console.log("  ✅ README.md updated.");
  }
  if (schemaUpdated) {
    console.log("  ✅ schema/modules.json updated.");
  }
  if (updated) {
    console.log("");
  } else {
    console.log("\n✅ Documentation is already up to date.\n");
  }
}

main().catch((error) => {
  console.error("Error:", error.message);
  process.exit(1);
});
