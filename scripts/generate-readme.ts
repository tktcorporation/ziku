#!/usr/bin/env pnpm tsx
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
import {
  generateLifecycleDocument,
  generateComponentDiagram,
  lifecycle,
} from "../src/docs/lifecycle";
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
  features: {
    start: "<!-- FEATURES:START -->",
    end: "<!-- FEATURES:END -->",
  },
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

  const repoList = DEFAULT_TEMPLATE_REPOS.map((r) => `\`{your-org}/${r}\``).join(", then ");

  const lines: string[] = [
    "## Getting Started\n",
    "ziku has two roles: **template author** (setup) and **template user** (init). If someone else has already set up the template, skip to Step 2.\n",
    "### Step 1: Create the template (`setup`) — template author\n",
    "`ziku setup` initializes a template repository by creating `.ziku/ziku.jsonc`. This file defines which file patterns ziku manages.\n",
    "```bash",
    "# In your template repository",
    "npx ziku setup",
    "```\n",
    "This creates `.ziku/ziku.jsonc` with default patterns. Edit it to match your needs:\n",
    "```jsonc",
    exampleZikuJsonc,
    "```\n",
    "You can also set up a remote template repository:\n",
    "```bash",
    "# Create a PR to add .ziku/ziku.jsonc to a remote repo",
    "npx ziku setup --remote --from my-org/my-templates",
    "```\n",
    `By default, ziku looks for ${repoList} based on your git remote. If the repository doesn't exist, \`npx ziku\` will offer to create it interactively.\n`,
    "### Step 2: Apply the template (`init`) — template user\n",
    "`ziku init` (or just `npx ziku`) downloads the template and lets you select which directories to sync.\n",
    "```bash",
    "# Auto-detect template from git remote",
    "npx ziku",
    "",
    "# Use a specific template",
    "npx ziku --from my-org/my-templates",
    "",
    "# Use a local directory as template (no GitHub needed)",
    "npx ziku --from-dir ../my-template",
    "```\n",
    `ziku copies the matching files into your project and creates:\n`,
    `- \`${ZIKU_CONFIG_FILE}\` — selected sync patterns (same format as the template)`,
    `- \`${LOCK_FILE}\` — template source + sync state (hashes, refs)\n`,
    "### Step 3: Keep it in sync\n",
    "```bash",
    "# Push local improvements back to the template",
    'npx ziku push -m "Add new workflow"',
    "",
    "# Pull latest template updates (includes new patterns)",
    "npx ziku pull",
    "",
    "# Check what's different",
    "npx ziku diff",
    "",
    "# Add file patterns to the sync whitelist",
    "npx ziku track '.eslintrc.*'",
    "```\n",
    "`push` works with both GitHub (creates a PR) and local templates (copies files directly). `pull` also syncs new patterns added to the template's `ziku.jsonc`.\n",
  ];

  return lines.join("\n");
}

/**
 * Generate "How it Works" section from code constants
 *
 * テンプレートとユーザープロジェクトの ziku.jsonc の関係、
 * ディレクトリ選択の仕組み、lock.json の役割を説明する。
 */
/**
 * lifecycle データから README の「How it Works」セクションを生成。
 *
 * lifecycle.ts の generateComponentDiagram (mermaid 図) と lifecycle 配列を
 * 共有することで、file-lifecycle.md と README が同一のデータソースから生成される。
 */
function generateFeaturesSection(): string {
  const exampleUserJsonc = JSON.stringify(
    {
      include: [".claude/rules/*.md", ".mcp.json", ".github/workflows/**"],
    },
    null,
    2,
  );

  // lifecycle 配列からコマンドテーブルを自動生成
  // setupLifecycle の name は "setup"、ops に template/create があれば template author
  const commandRows = lifecycle.map((cmd) => {
    const isTemplateAuthor = cmd.ops.some((op) => op.location === "template" && op.op === "create");
    const role = isTemplateAuthor ? "Template author" : "Template user";
    return `| **\`${cmd.name}\`** | ${role} | ${cmd.description} |`;
  });

  const lines: string[] = [
    "## How it Works\n",
    generateComponentDiagram(),
    "",
    `> For detailed file operations per command, see [File Lifecycle](docs/architecture/file-lifecycle.md).\n`,
    "### The config file\n",
    `Both the template and user project share the same \`${ZIKU_CONFIG_FILE}\` format — just \`include\` and \`exclude\` patterns:\n`,
    "```jsonc",
    exampleUserJsonc,
    "```\n",
    "### Command overview\n",
    "| Command | Who runs it | What it does |",
    "|---|---|---|",
    ...commandRows,
    "",
    `Template source info (owner/repo or local path) is stored in \`${LOCK_FILE}\`, separate from patterns. When you \`pull\`, new patterns added to the template's \`${ZIKU_CONFIG_FILE}\` are automatically merged into yours.\n`,
    `> For detailed file operations per command, see [File Lifecycle](docs/architecture/file-lifecycle.md).\n`,
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
    const description = (meta as Record<string, string>).description ?? "";
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

/** 各ドキュメントの更新前後のスナップショット */
interface DocSnapshot {
  readme: string;
  originalReadme: string;
  readmeUpdated: boolean;
  lifecycleDoc: string;
  originalLifecycleDoc: string;
  lifecycleDocUpdated: boolean;
  originalSchemas: Record<string, string>;
  schemaUpdates: string[];
  updated: boolean;
}

/** ドキュメントを生成・更新し、更新前後のスナップショットを返す */
async function generateAndApplyDocs(): Promise<DocSnapshot> {
  const zikuJsonSchema = JSON.stringify(z.toJSONSchema(zikuConfigSchema), null, 2);

  const gettingStartedSection = generateGettingStartedSection();
  const featuresSection = generateFeaturesSection();
  const commandsSection = await generateCommandsSection();
  const filesSection = generateFilesSection();
  const lifecycleSection = generateLifecycleDocument();

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

  readme = updateSection(
    readme,
    MARKERS.gettingStarted.start,
    MARKERS.gettingStarted.end,
    gettingStartedSection,
  );
  readme = updateSection(readme, MARKERS.features.start, MARKERS.features.end, featuresSection);
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
    execFileSync("pnpm", ["oxfmt", "--write", LIFECYCLE_DOC_PATH], { stdio: "ignore" });
    lifecycleDoc = await readFile(LIFECYCLE_DOC_PATH, "utf-8");
  }
  const lifecycleDocUpdated = lifecycleDoc !== originalLifecycleDoc;

  // Generate formatted JSON Schema (write, run formatter, read back canonical form)
  const schemaEntries: [string, string][] = [[ZIKU_SCHEMA_PATH, zikuJsonSchema]];
  const schemaUpdates: string[] = [];
  for (const [path, content] of schemaEntries) {
    await writeFile(path, `${content}\n`);
    execFileSync("pnpm", ["oxfmt", "--write", path], { stdio: "ignore" });
    const formatted = await readFile(path, "utf-8");
    if (originalSchemas[path] !== formatted) {
      schemaUpdates.push(path.split("/").pop() ?? path);
    }
  }

  const updated = readmeUpdated || lifecycleDocUpdated || schemaUpdates.length > 0;

  return {
    readme,
    originalReadme,
    readmeUpdated,
    lifecycleDoc,
    originalLifecycleDoc,
    lifecycleDocUpdated,
    originalSchemas,
    schemaUpdates,
    updated,
  };
}

/** --check モード: ドキュメントが最新か検証し、変更があれば元に戻してエラー終了 */
async function runCheck(snapshot: DocSnapshot): Promise<void> {
  // Restore original schemas if they were overwritten for formatting
  for (const [path, original] of Object.entries(snapshot.originalSchemas)) {
    if (original) {
      await writeFile(path, original);
    }
  }
  if (snapshot.lifecycleDocUpdated) {
    await writeFile(LIFECYCLE_DOC_PATH, snapshot.originalLifecycleDoc);
  }

  if (snapshot.updated) {
    if (snapshot.readmeUpdated) console.error("  - README.md is out of date");
    if (snapshot.lifecycleDocUpdated)
      console.error("  - docs/architecture/file-lifecycle.md is out of date");
    for (const name of snapshot.schemaUpdates) {
      console.error(`  - schema/${name} is out of date`);
    }
    console.error("\n❌ Documentation is out of date.");
    console.error("   Run `pnpm run docs` to update.\n");
    process.exit(1);
  }
  console.log("\n✅ Documentation is up to date.\n");
}

/** 書き込みモード: 更新されたドキュメントを保存 */
async function runWrite(snapshot: DocSnapshot): Promise<void> {
  if (snapshot.readmeUpdated) {
    await writeFile(README_PATH, snapshot.readme);
    console.log("  ✅ README.md updated.");
  }
  if (snapshot.lifecycleDocUpdated) {
    await writeFile(LIFECYCLE_DOC_PATH, snapshot.lifecycleDoc);
    console.log("  ✅ docs/architecture/file-lifecycle.md updated.");
  }
  for (const name of snapshot.schemaUpdates) {
    console.log(`  ✅ schema/${name} updated.`);
  }
  if (snapshot.updated) {
    console.log("");
  } else {
    console.log("\n✅ Documentation is already up to date.\n");
  }
}

/**
 * Main
 */
async function main(): Promise<void> {
  const isCheck = process.argv.includes("--check");

  console.log("📝 Generating documentation...\n");

  const snapshot = await generateAndApplyDocs();

  if (isCheck) {
    await runCheck(snapshot);
  } else {
    await runWrite(snapshot);
  }
}

main().catch((error: unknown) => {
  console.error("Error:", error instanceof Error ? error.message : String(error));
  process.exit(1);
});
