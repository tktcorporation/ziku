#!/usr/bin/env npx tsx
/**
 * Auto-generate README.md sections from source code
 *
 * Usage:
 *   pnpm run docs
 *   pnpm run docs:check  # Check only (for CI)
 *
 * Generated sections:
 *   - Usage (static content)
 *   - Commands (from citty renderUsage)
 *   - AI Agents (from ai-guide.ts)
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
import { aiDocsCommand } from "../src/commands/ai-docs";
import { diffCommand } from "../src/commands/diff";
import { initCommand } from "../src/commands/init";
import { pushCommand } from "../src/commands/push";
import { generateReadmeSection as generateAiAgentsSection } from "../src/docs/ai-guide";

const README_PATH = resolve(import.meta.dirname, "../README.md");

// Marker definitions
const MARKERS = {
  usage: {
    start: "<!-- USAGE:START -->",
    end: "<!-- USAGE:END -->",
  },
  commands: {
    start: "<!-- COMMANDS:START -->",
    end: "<!-- COMMANDS:END -->",
  },
  aiAgents: {
    start: "<!-- AI_AGENTS:START -->",
    end: "<!-- AI_AGENTS:END -->",
  },
} as const;

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

  // diff command
  sections.push("### `diff`\n");
  sections.push(`${getCommandDescription(diffCommand.meta)}\n`);
  sections.push("```");
  sections.push(cleanUsageOutput(await renderUsage(diffCommand)));
  sections.push("```\n");

  // ai-docs command
  sections.push("### `ai-docs`\n");
  sections.push(`${getCommandDescription(aiDocsCommand.meta)}\n`);
  sections.push("```");
  sections.push(cleanUsageOutput(await renderUsage(aiDocsCommand)));
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
  const usageSection = generateUsageSection();
  const commandsSection = await generateCommandsSection();
  const aiAgentsSection = generateAiAgentsSection();

  // Update README
  let readme = await readFile(README_PATH, "utf-8");
  const originalReadme = readme;

  readme = updateSection(readme, MARKERS.usage.start, MARKERS.usage.end, usageSection);
  readme = updateSection(readme, MARKERS.commands.start, MARKERS.commands.end, commandsSection);
  readme = updateSection(readme, MARKERS.aiAgents.start, MARKERS.aiAgents.end, aiAgentsSection);

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
