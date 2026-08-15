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
import type { CommandDef } from "citty";
import { renderUsage } from "citty";
import { match } from "ts-pattern";
import { z } from "zod";
import { SUBCOMMAND_NAMES, type SubCommandName } from "../src/commands/names";
import { subCommands } from "../src/commands/registry";
import { zikuConfigSchema } from "../src/modules/schemas";
import {
  generateLifecycleDocument,
  generateComponentDiagram,
  lifecycle,
} from "../src/docs/lifecycle";
import { DEFAULT_TEMPLATE_REPOS } from "../src/utils/git-remote";
import { LOCK_FILE } from "../src/utils/lock";
import { MARKERS, updateSection } from "../src/utils/readme";
import { ZIKU_CONFIG_FILE, ZIKU_CONFIG_SCHEMA_URL } from "../src/utils/ziku-config";

const README_PATH = resolve(import.meta.dirname, "../README.md");
const LIFECYCLE_DOC_PATH = resolve(import.meta.dirname, "../docs/architecture/file-lifecycle.md");
const ZIKU_SCHEMA_PATH = resolve(import.meta.dirname, "../schema/ziku.json");

/**
 * この生成器が組み直す区画。
 *
 * FEATURES / COMMANDS / FILES は ziku 本体もテンプレートの README で書き換えるので、名前は
 * {@link MARKERS} から取り込む。ここで名前を書き写すと、片方だけを変えたときにもう片方が
 * 「マーカーが無い」として無言で何も書かなくなる。GETTING_STARTED / LIFECYCLE はこの
 * リポジトリのドキュメントにしか無いので、ここだけが持つ。
 */
const DOC_MARKERS = {
  ...MARKERS,
  gettingStarted: {
    start: "<!-- GETTING_STARTED:START -->",
    end: "<!-- GETTING_STARTED:END -->",
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

  // lifecycle 配列からコマンドテーブルを自動生成。役割は各コマンドが宣言する
  // audience フィールドを直接使う（唯一の SSOT）。
  const commandRows = lifecycle.map(
    (cmd) => `| **\`${cmd.name}\`** | ${cmd.audience} | ${cmd.description} |`,
  );

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

/** 登録簿に載っているコマンド定義。args スキーマはコマンドごとに違う。 */
type RegisteredCommand = (typeof subCommands)[SubCommandName];

/**
 * usage の描画に必要な部分だけを写した定義を返す。
 *
 * `CommandDef<T>` は `run` / `setup` / `cleanup` の引数を通じて `T`（args スキーマ）に反変で、
 * コマンドごとに `T` が違うため、既定の args スキーマで `CommandDef` を受ける `renderUsage` へ
 * そのままは渡せない。
 * 描画が読むのは meta / args / subCommands だけなので、その 3 つを写して渡す。
 */
function usageDefinitionOf(cmd: RegisteredCommand): CommandDef {
  return { meta: cmd.meta, args: cmd.args, subCommands: cmd.subCommands };
}

/**
 * README の `## Commands` にコマンドを並べる順。
 *
 * テンプレートを用意する側の作業（setup）から、使う側の作業（init 以降）へ読み進められる
 * 並びにする。`Record<SubCommandName, number>` なので、コマンドを足すと順位の指定が必須になり、
 * 並びを決めていないコマンドが黙って末尾に落ちることがない。
 */
const COMMAND_DOC_ORDER: Record<SubCommandName, number> = {
  setup: 0,
  init: 1,
  push: 2,
  pull: 3,
  diff: 4,
  status: 5,
  track: 6,
  aggregate: 7,
};

/**
 * Generate Commands section
 *
 * 描くコマンドはサブコマンドの登録簿（`src/commands/registry.ts`）から引く。ここで名前を
 * 並べ直すと、CLI に登録したコマンドが README から黙って落ちる。
 */
async function generateCommandsSection(): Promise<string> {
  const commandSection = async (name: SubCommandName, cmd: RegisteredCommand) => [
    `### \`${name}\`\n`,
    `${getCommandDescription(cmd.meta)}\n`,
    "```",
    cleanUsageOutput(await renderUsage(usageDefinitionOf(cmd))),
    "```\n",
  ];

  const sections: string[] = ["## Commands\n"];
  for (const name of SUBCOMMAND_NAMES.toSorted(
    (a, b) => COMMAND_DOC_ORDER[a] - COMMAND_DOC_ORDER[b],
  )) {
    sections.push(...(await commandSection(name, subCommands[name])));
  }

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
 * ドキュメントのマーカー間を差し替える。マーカーが無ければ生成漏れとして止める。
 *
 * 対象はこのリポジトリの README と docs で、{@link DOC_MARKERS} の区画はすべて存在する前提。
 * 黙って元の内容を返すと、マーカー名を片方だけ変えたときに「生成は成功したのに中身が古いまま」
 * の状態が `docs:check` まで通り、差分が出ないことを最新である証拠と読み違える。
 *
 * @param docPath 差し替え対象のファイル。どのドキュメントの区画が欠けているかを示す。
 */
function replaceSection(
  content: string,
  marker: { readonly start: string; readonly end: string },
  newSection: string,
  docPath: string,
): string {
  return match(updateSection(content, marker.start, marker.end, newSection))
    .with({ _tag: "Replaced" }, (replaced) => replaced.content)
    .with({ _tag: "MarkerNotFound" }, (missing) => {
      console.error(`\n❌ ${missing.startMarker} (and its END marker) not found in ${docPath}.`);
      console.error("   The section would be silently skipped, leaving stale content.\n");
      process.exit(1);
    })
    .exhaustive();
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

  readme = replaceSection(readme, DOC_MARKERS.gettingStarted, gettingStartedSection, README_PATH);
  readme = replaceSection(readme, DOC_MARKERS.features, featuresSection, README_PATH);
  readme = replaceSection(readme, DOC_MARKERS.commands, commandsSection, README_PATH);
  readme = replaceSection(readme, DOC_MARKERS.files, filesSection, README_PATH);

  const readmeUpdated = readme !== originalReadme;

  // Update lifecycle doc (write → format → read back canonical form)
  {
    const tempLifecycleDoc = replaceSection(
      lifecycleDoc,
      DOC_MARKERS.lifecycle,
      lifecycleSection,
      LIFECYCLE_DOC_PATH,
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
