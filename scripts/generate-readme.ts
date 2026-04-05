#!/usr/bin/env npx tsx
/**
 * Auto-generate README.md sections from source code
 *
 * Usage:
 *   pnpm run docs
 *   pnpm run docs:check  # Check only (for CI)
 *
 * Generated sections:
 *   - Getting Started (from init command constants + DEFAULT_TEMPLATE_REPOS)
 *   - Commands (from citty renderUsage)
 *   - What You Get / Files (from ZIKU_CONFIG_FILE, LOCK_FILE constants)
 *
 * Non-generated sections (manually maintained):
 *   - Why (conceptual intro)
 *   - Contributing / License
 */

// Prevent environment-dependent renderUsage output differences
process.env.NO_COLOR = "1";
process.env.FORCE_COLOR = "0";
process.env.COLUMNS = "80";

import { execFileSync } from "node:child_process";
import { readFile, writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import { stripVTControlCharacters } from "node:util";
import type { ArgsDef, CommandDef } from "citty";
import { renderUsage } from "citty";
import { z } from "zod";
import { diffCommand } from "../src/commands/diff";
import { initCommand } from "../src/commands/init";
import { pullCommand } from "../src/commands/pull";
import { pushCommand } from "../src/commands/push";
import { setupCommand } from "../src/commands/setup";
import { trackCommand } from "../src/commands/track";
import { zikuConfigSchema } from "../src/modules/schemas";
import { generateLifecycleDocument } from "../src/docs/lifecycle";
import { DEFAULT_TEMPLATE_REPOS } from "../src/utils/git-remote";
import { LOCK_FILE } from "../src/utils/lock";
import { ZIKU_CONFIG_FILE, ZIKU_CONFIG_SCHEMA_URL } from "../src/utils/ziku-config";

const README_PATH = resolve(import.meta.dirname, "../README.md");
const LIFECYCLE_DOC_PATH = resolve(import.meta.dirname, "../docs/architecture/file-lifecycle.md");
const ZIKU_SCHEMA_PATH = resolve(import.meta.dirname, "../schema/ziku.json");

// Marker definitions
const MARKERS = {
  gettingStarted: {
    start: "<!-- GETTING_STARTED:START -->",
    end: "<!-- GETTING_STARTED:END -->",
  },
  // NOTE: FEATURES (Modules section) is manually maintained — not auto-generated.
  commands: {
    start: "<!-- COMMANDS:START -->",
    end: "<!-- COMMANDS:END -->",
  },
  files: {
    start: "<!-- FILES:START -->",
    end: "<!-- FILES:END -->",
  },
  lifecycle: {
    start: "<!-- LIFECYCLE:START -->",
    end: "<!-- LIFECYCLE:END -->",
  },
} as const;

/**
 * Generate Getting Started section from source code constants
 *
 * DEFAULT_TEMPLATE_REPOS からテンプレート検索順を生成し、
 * ziku.jsonc の例を生成する。
 * コード側の定数変更に README が自動追従する。
 */
function generateGettingStartedSection(): string {
  // ziku.jsonc の例を生成（テンプレート側のパターン定義）
  const exampleZikuJsonc = JSON.stringify(
    {
      $schema: ZIKU_CONFIG_SCHEMA_URL,
      include: [
        ".claude/settings.json",
        ".claude/rules/*.md",
        ".claude/skills/**",
        ".mcp.json",
        ".devcontainer/**",
      ],
    },
    null,
    2,
  );

  // テンプレートリポジトリの検索順をコード定数から生成
  const repoList = DEFAULT_TEMPLATE_REPOS.map((r) => `\`{your-org}/${r}\``).join(", then ");

  const lines: string[] = [
    "## Getting Started\n",
    "### 1. Set up your template repository\n",
    `ziku uses a GitHub repository as the template source. By default, it looks for ${repoList} based on your git remote.\n`,
    "If the repository doesn't exist yet, `npx ziku` will offer to create it for you interactively. You can also create it manually or specify a different source:\n",
    "```bash",
    "# Auto-detect from git remote (recommended)",
    "npx ziku",
    "",
    "# Use a specific template repository",
    "npx ziku --from my-org/my-templates",
    "```\n",
    "### 2. Add `.ziku/ziku.jsonc` to your template\n",
    "The template repository needs a `.ziku/ziku.jsonc` file that defines which file patterns ziku manages. During `ziku init`, users select which directories to sync based on these patterns. You can create this file with `ziku setup`.\n",
    "Example `ziku.jsonc`:\n",
    "```jsonc",
    exampleZikuJsonc,
    "```\n",
    "### 3. Apply the template to your project\n",
    "```bash",
    "npx ziku",
    "",
    "# Or apply to a specific directory",
    "npx ziku ./my-project",
    "```\n",
    `ziku copies the matching files into your project. \`${ZIKU_CONFIG_FILE}\` (patterns) and \`${LOCK_FILE}\` (sync state + source) are created locally to track what was installed.\n`,
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
    "",
    "# Add file patterns to track",
    "npx ziku track '.eslintrc.*'",
    "```\n",
  ];

  return lines.join("\n");
}

/**
 * Generate "What You Get" section from code constants
 */
function generateFilesSection(): string {
  const lines: string[] = [
    "## What You Get\n",
    `The files you get depend on the patterns configured in your template's \`${ZIKU_CONFIG_FILE}\`. After running \`ziku init\`, your selected patterns are saved in your own \`${ZIKU_CONFIG_FILE}\` — you can customize them anytime with \`ziku track\`.\n`,
    "ziku also creates:\n",
    `- \`${ZIKU_CONFIG_FILE}\` — Your sync patterns (which files to include/exclude)`,
    `- \`${LOCK_FILE}\` — Sync state + template source (hashes, base refs, source info)\n`,
  ];
  return lines.join("\n");
}

/**
 * Get description from command meta (handles Resolvable type)
 */
function getCommandDescription(meta: unknown): string {
  if (typeof meta === "object" && meta !== null && "description" in meta) {
    const description = String((meta as Record<string, string>).description ?? "");
    return description;
  }
  return "";
}

/**
 * Generate Commands section
 */
async function generateCommandsSection(): Promise<string> {
  const commandSection = async <T extends ArgsDef>(name: string, cmd: CommandDef<T>) => [
    `### \`${name}\`\n`,
    `${getCommandDescription(cmd.meta)}\n`,
    "```",
    cleanUsageOutput(await renderUsage(cmd)),
    "```\n",
  ];

  const sections: string[] = [
    "## Commands\n",
    ...(await commandSection("setup", setupCommand)),
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
  const zikuJsonSchema = JSON.stringify(z.toJSONSchema(zikuConfigSchema), null, 2);

  // Generate sections
  const gettingStartedSection = generateGettingStartedSection();
  const commandsSection = await generateCommandsSection();
  const filesSection = generateFilesSection();
  const lifecycleSection = generateLifecycleDocument();

  // Read originals
  let readme = await readFile(README_PATH, "utf-8");
  const originalReadme = readme;

  let lifecycleDoc = await readFile(LIFECYCLE_DOC_PATH, "utf-8");
  const originalLifecycleDoc = lifecycleDoc;

  const originalSchemas: Record<string, string> = {};
  for (const path of [ZIKU_SCHEMA_PATH]) {
    try {
      originalSchemas[path] = await readFile(path, "utf-8");
    } catch {
      originalSchemas[path] = "";
    }
  }

  // Update README sections
  readme = updateSection(
    readme,
    MARKERS.gettingStarted.start,
    MARKERS.gettingStarted.end,
    gettingStartedSection,
  );
  readme = updateSection(readme, MARKERS.commands.start, MARKERS.commands.end, commandsSection);
  readme = updateSection(readme, MARKERS.files.start, MARKERS.files.end, filesSection);

  const readmeUpdated = readme !== originalReadme;

  // Update lifecycle doc (write → format → read back canonical form)
  {
    const tempLifecycleDoc = updateSection(
      lifecycleDoc,
      MARKERS.lifecycle.start,
      MARKERS.lifecycle.end,
      lifecycleSection,
    );
    await writeFile(LIFECYCLE_DOC_PATH, tempLifecycleDoc);
    execFileSync("npx", ["oxfmt", "--write", LIFECYCLE_DOC_PATH], { stdio: "ignore" });
    lifecycleDoc = await readFile(LIFECYCLE_DOC_PATH, "utf-8");
  }
  const lifecycleDocUpdated = lifecycleDoc !== originalLifecycleDoc;

  // Generate formatted JSON Schema (write, run formatter, read back canonical form)
  const schemaEntries: [string, string][] = [
    [ZIKU_SCHEMA_PATH, zikuJsonSchema],
  ];
  const schemaUpdates: string[] = [];
  for (const [path, content] of schemaEntries) {
    await writeFile(path, `${content}\n`);
    execFileSync("npx", ["oxfmt", "--write", path], { stdio: "ignore" });
    const formatted = await readFile(path, "utf-8");
    if (originalSchemas[path] !== formatted) {
      schemaUpdates.push(path.split("/").pop() ?? path);
    }
  }

  const updated = readmeUpdated || lifecycleDocUpdated || schemaUpdates.length > 0;

  if (isCheck) {
    // Restore original schemas if they were overwritten for formatting
    for (const [path, original] of Object.entries(originalSchemas)) {
      if (original) {
        await writeFile(path, original);
      }
    }
    // Restore lifecycle doc
    if (lifecycleDocUpdated) {
      await writeFile(LIFECYCLE_DOC_PATH, originalLifecycleDoc);
    }

    if (updated) {
      if (readmeUpdated) console.error("  - README.md is out of date");
      if (lifecycleDocUpdated)
        console.error("  - docs/architecture/file-lifecycle.md is out of date");
      for (const name of schemaUpdates) {
        console.error(`  - schema/${name} is out of date`);
      }
      console.error("\n❌ Documentation is out of date.");
      console.error("   Run `pnpm run docs` to update.\n");
      process.exit(1);
    }
    console.log("\n✅ Documentation is up to date.\n");
    return;
  }

  // Schema files are already written and formatted above
  if (readmeUpdated) {
    await writeFile(README_PATH, readme);
    console.log("  ✅ README.md updated.");
  }
  if (lifecycleDocUpdated) {
    await writeFile(LIFECYCLE_DOC_PATH, lifecycleDoc);
    console.log("  ✅ docs/architecture/file-lifecycle.md updated.");
  }
  for (const name of schemaUpdates) {
    console.log(`  ✅ schema/${name} updated.`);
  }
  if (updated) {
    console.log("");
  } else {
    console.log("\n✅ Documentation is already up to date.\n");
  }
}

main().catch((error: unknown) => {
  console.error("Error:", error instanceof Error ? error.message : String(error));
  process.exit(1);
});
