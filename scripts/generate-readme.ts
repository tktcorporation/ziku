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

import { readFile, writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import { stripVTControlCharacters } from "node:util";
import { renderUsage } from "citty";
import { diffCommand } from "../src/commands/diff";
import { generateInitialModulesJsonc, initCommand } from "../src/commands/init";
import { pullCommand } from "../src/commands/pull";
import { pushCommand } from "../src/commands/push";
import { trackCommand } from "../src/commands/track";
import { DEFAULT_TEMPLATE_REPO } from "../src/utils/git-remote";

const README_PATH = resolve(import.meta.dirname, "../README.md");

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
  // Generate example modules.jsonc from the same function used at runtime,
  // but pick only 2 representative modules to keep the README concise
  const fullJson = JSON.parse(generateInitialModulesJsonc());
  const exampleModules = fullJson.modules.filter(
    (m: { id: string }) => m.id === "." || m.id === ".github",
  );
  const exampleJson = JSON.stringify(
    { $schema: fullJson.$schema, modules: exampleModules },
    null,
    2,
  );

  const lines: string[] = [];
  lines.push("## Getting Started\n");

  lines.push("### 1. Set up your template repository\n");
  lines.push(
    `ziku uses a GitHub repository as the template source. By default, it looks for \`{your-org}/${DEFAULT_TEMPLATE_REPO}\` based on your git remote.\n`,
  );
  lines.push(
    "If the repository doesn't exist yet, `npx ziku` will offer to create it for you interactively. You can also create it manually or specify a different source:\n",
  );
  lines.push("```bash");
  lines.push("# Auto-detect from git remote (recommended)");
  lines.push("npx ziku");
  lines.push("");
  lines.push("# Use a specific template repository");
  lines.push("npx ziku --from my-org/my-templates");
  lines.push("```\n");

  lines.push("### 2. Add `.devenv/modules.jsonc` to your template\n");
  lines.push(
    "The template repository needs a `.devenv/modules.jsonc` file that defines which modules and file patterns ziku manages. If this file is missing, ziku will offer to create a PR that adds one with a default configuration.\n",
  );
  lines.push("Example `modules.jsonc`:\n");
  lines.push("```jsonc");
  lines.push(exampleJson);
  lines.push("```\n");

  lines.push("### 3. Apply the template to your project\n");
  lines.push("```bash");
  lines.push("npx ziku");
  lines.push("```\n");
  lines.push(
    "Select the modules you want, and ziku copies the matching files into your project. A `.devenv.json` config and `.devenv/modules.jsonc` are created locally to track what was installed.\n",
  );

  lines.push("### 4. Keep it in sync\n");
  lines.push("```bash");
  lines.push("# Push local improvements back to the template");
  lines.push('npx ziku push -m "Add new workflow"');
  lines.push("");
  lines.push("# Pull latest template updates");
  lines.push("npx ziku pull");
  lines.push("");
  lines.push("# Check what's different");
  lines.push("npx ziku diff");
  lines.push("```\n");

  return lines.join("\n");
}

/**
 * Generate Usage section
 */
function generateUsageSection(): string {
  const lines: string[] = [];
  lines.push("## Usage\n");
  lines.push("```bash");
  lines.push("# Apply template to current directory");
  lines.push("npx ziku");
  lines.push("");
  lines.push("# Apply to a specific directory");
  lines.push("npx ziku ./my-project");
  lines.push("");
  lines.push("# Push your improvements back");
  lines.push('npx ziku push -m "Add new workflow"');
  lines.push("");
  lines.push("# Check what's different");
  lines.push("npx ziku diff");
  lines.push("```\n");
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
  const sections: string[] = [];
  sections.push("## Commands\n");

  // init command
  sections.push("### `init`\n");
  sections.push(`${getCommandDescription(initCommand.meta)}\n`);
  sections.push("```");
  sections.push(cleanUsageOutput(await renderUsage(initCommand)));
  sections.push("```\n");

  // push command
  sections.push("### `push`\n");
  sections.push(`${getCommandDescription(pushCommand.meta)}\n`);
  sections.push("```");
  sections.push(cleanUsageOutput(await renderUsage(pushCommand)));
  sections.push("```\n");

  // pull command
  sections.push("### `pull`\n");
  sections.push(`${getCommandDescription(pullCommand.meta)}\n`);
  sections.push("```");
  sections.push(cleanUsageOutput(await renderUsage(pullCommand)));
  sections.push("```\n");

  // diff command
  sections.push("### `diff`\n");
  sections.push(`${getCommandDescription(diffCommand.meta)}\n`);
  sections.push("```");
  sections.push(cleanUsageOutput(await renderUsage(diffCommand)));
  sections.push("```\n");

  // track command
  sections.push("### `track`\n");
  sections.push(`${getCommandDescription(trackCommand.meta)}\n`);
  sections.push("```");
  sections.push(cleanUsageOutput(await renderUsage(trackCommand)));
  sections.push("```\n");

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

  console.log("📝 Generating README documentation...\n");

  // Generate sections
  const gettingStartedSection = generateGettingStartedSection();
  const usageSection = generateUsageSection();
  const commandsSection = await generateCommandsSection();

  // Update README
  let readme = await readFile(README_PATH, "utf-8");
  const originalReadme = readme;

  readme = updateSection(
    readme,
    MARKERS.gettingStarted.start,
    MARKERS.gettingStarted.end,
    gettingStartedSection,
  );
  readme = updateSection(readme, MARKERS.usage.start, MARKERS.usage.end, usageSection);
  readme = updateSection(readme, MARKERS.commands.start, MARKERS.commands.end, commandsSection);

  const updated = readme !== originalReadme;

  if (isCheck) {
    if (updated) {
      console.error("\n❌ README.md is out of date.");
      console.error("   Run `pnpm run docs` to update.\n");
      process.exit(1);
    }
    console.log("\n✅ README.md is up to date.\n");
    return;
  }

  if (updated) {
    await writeFile(README_PATH, readme);
    console.log("\n✅ README.md updated.\n");
  } else {
    console.log("\n✅ README.md is already up to date.\n");
  }
}

main().catch((error) => {
  console.error("Error:", error.message);
  process.exit(1);
});
