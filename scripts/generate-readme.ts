#!/usr/bin/env npx tsx
/**
 * Auto-generate README.md sections from source code
 *
 * Usage:
 *   pnpm run docs
 *   pnpm run docs:check  # Check only (for CI)
 *
 * Generated sections:
 *   - Usage (from command definitions)
 *   - Modules (from modules.jsonc)
 *   - Commands (from citty renderUsage)
 *   - What You Get (from modules.jsonc)
 */

// Prevent environment-dependent renderUsage output differences
process.env.NO_COLOR = "1";
process.env.FORCE_COLOR = "0";
process.env.COLUMNS = "80";

import { readFile, writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import { stripVTControlCharacters } from "node:util";
import { renderUsage } from "citty";
import { parse } from "jsonc-parser";
import { aiDocsCommand } from "../src/commands/ai-docs";
import { diffCommand } from "../src/commands/diff";
import { initCommand } from "../src/commands/init";
import { pushCommand } from "../src/commands/push";
import { generateReadmeSection as generateAiAgentsSection } from "../src/docs/ai-guide";

const README_PATH = resolve(import.meta.dirname, "../README.md");
const MODULES_PATH = resolve(import.meta.dirname, "../../../.devenv/modules.jsonc");

// Marker definitions
const MARKERS = {
  usage: {
    start: "<!-- USAGE:START -->",
    end: "<!-- USAGE:END -->",
  },
  features: {
    start: "<!-- FEATURES:START -->",
    end: "<!-- FEATURES:END -->",
  },
  commands: {
    start: "<!-- COMMANDS:START -->",
    end: "<!-- COMMANDS:END -->",
  },
  aiAgents: {
    start: "<!-- AI_AGENTS:START -->",
    end: "<!-- AI_AGENTS:END -->",
  },
  files: {
    start: "<!-- FILES:START -->",
    end: "<!-- FILES:END -->",
  },
} as const;

interface TemplateModule {
  id: string;
  name: string;
  description: string;
  setupDescription?: string;
  patterns: string[];
}

interface ModulesFile {
  modules: TemplateModule[];
}

/**
 * Load modules.jsonc
 */
async function loadModules(): Promise<TemplateModule[]> {
  const content = await readFile(MODULES_PATH, "utf-8");
  const parsed = parse(content) as ModulesFile;
  return parsed.modules;
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
 * Generate Modules section
 */
function generateFeaturesSection(modules: TemplateModule[]): string {
  const lines: string[] = [];
  lines.push("## Modules\n");
  lines.push("Pick what you need:\n");

  for (const mod of modules) {
    lines.push(`- **${mod.name}** - ${mod.description}`);
  }

  lines.push("");
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
 * Generate What You Get section
 */
/**
 * モジュールのディレクトリ単位の概要のみを表示する。個別パターンは列挙しない。
 *
 * 背景: 個別パターンを列挙すると、既存モジュール内にファイルを1つ追加するだけで
 * docs:check が失敗してしまう。パターン詳細は modules.jsonc が正規の置き場であり、
 * README に二重管理する必要はない。
 *
 * モジュール追加（新フォルダ単位）はREADME変更を伴うが、
 * 既存モジュール内のパターン追加はREADMEに影響しない。
 */
function generateFilesSection(modules: TemplateModule[]): string {
  const lines: string[] = [];
  lines.push("## What You Get\n");
  lines.push("Files generated based on selected modules:\n");

  for (const mod of modules) {
    const dirName = mod.id === "." ? "Root (`./`)" : `\`${mod.id}/\``;
    lines.push(`- **${dirName}** — ${mod.description}`);
  }

  lines.push("");
  lines.push(
    "> See [`.devenv/modules.jsonc`](./.devenv/modules.jsonc) for the full list of tracked file patterns.",
  );
  lines.push("");

  return lines.join("\n");
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

  // Load modules.jsonc
  const modules = await loadModules();
  console.log(`  📦 Loaded ${modules.length} modules`);

  // Generate sections
  const usageSection = generateUsageSection();
  const featuresSection = generateFeaturesSection(modules);
  const commandsSection = await generateCommandsSection();
  const aiAgentsSection = generateAiAgentsSection();
  const filesSection = generateFilesSection(modules);

  // Update README
  let readme = await readFile(README_PATH, "utf-8");
  const originalReadme = readme;

  readme = updateSection(readme, MARKERS.usage.start, MARKERS.usage.end, usageSection);
  readme = updateSection(readme, MARKERS.features.start, MARKERS.features.end, featuresSection);
  readme = updateSection(readme, MARKERS.commands.start, MARKERS.commands.end, commandsSection);
  readme = updateSection(readme, MARKERS.aiAgents.start, MARKERS.aiAgents.end, aiAgentsSection);
  readme = updateSection(readme, MARKERS.files.start, MARKERS.files.end, filesSection);

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
