/**
 * AI Agent Guide
 *
 * This file serves as the single source of truth for AI-facing documentation.
 * It is used both for:
 *   - `ziku ai-docs` command output
 *   - README.md "For AI Agents" section generation
 */

import { version } from "../../package.json";

export interface DocSection {
  title: string;
  content: string;
}

/**
 * Generate the complete AI agent guide as markdown
 */
export function generateAiGuide(): string {
  const sections = getDocSections();
  return sections.map((s) => `## ${s.title}\n\n${s.content}`).join("\n\n");
}

/**
 * Generate the AI agent guide with header for CLI output
 */
export function generateAiGuideWithHeader(): string {
  const header = `# ziku v${version} - AI Agent Guide

This guide explains how AI coding agents (Claude Code, Cursor, etc.) can use this tool effectively.
`;

  return header + "\n" + generateAiGuide();
}

/**
 * Get individual documentation sections
 * Used by both CLI output and README generation
 */
export function getDocSections(): DocSection[] {
  return [
    {
      title: "Quick Reference",
      content: `\`\`\`bash
# Non-interactive init for AI agents
npx ziku init --yes                           # All modules, overwrite strategy
npx ziku init --modules .,devcontainer        # Specific modules only
npx ziku init --modules .github -s skip       # Specific modules with skip strategy
npx ziku init --yes --overwrite-strategy skip # All modules with skip strategy

# Non-interactive push workflow for AI agents
npx ziku push --yes --files "path1,path2" -m "feat: ..."  # Push specific files only

# Add files to tracking (non-interactive)
npx ziku track ".cloud/rules/*.md"            # Add pattern (auto-detect module)
npx ziku track ".cloud/config.json" -m .cloud # Specify module explicitly
npx ziku track --list                         # List tracked modules/patterns

# Show differences and detect untracked files
npx ziku diff              # Show differences (also reports untracked files)

# Pull latest template changes
npx ziku pull              # Sync template updates
npx ziku pull --continue   # Resume after resolving conflicts

# Other commands
npx ziku init [dir]        # Apply template (interactive)
npx ziku ai-docs           # Show this guide
\`\`\``,
    },
    {
      title: "Init Command for AI Agents",
      content: `> **AI agents:** This command is interactive by default, but all prompts can be skipped with \`--yes\` or \`--modules\` + \`--overwrite-strategy\`.

The \`init\` command supports non-interactive options for AI agents:

### Options

| Option | Alias | Description |
|--------|-------|-------------|
| \`--yes\` | \`-y\` | Select all modules with overwrite strategy |
| \`--modules <ids>\` | \`-m\` | Comma-separated module IDs to apply |
| \`--overwrite-strategy <strategy>\` | \`-s\` | Strategy for existing files: \`overwrite\`, \`skip\`, or \`prompt\` |
| \`--force\` | | Force overwrite (overrides strategy to \`overwrite\`) |

### Examples

\`\`\`bash
# Apply only specific modules (skips module selection prompt)
npx ziku init --modules .github,.claude

# Apply specific modules and skip existing files
npx ziku init --modules devcontainer -s skip

# Apply all modules but skip existing files
npx ziku init --yes --overwrite-strategy skip

# Re-init when .devenv.json exists, replacing only specific modules
npx ziku init --modules . -s overwrite
\`\`\`

### Behavior

- \`--modules\` or \`--yes\`: Skips the module selection prompt entirely
- \`--overwrite-strategy\`: Sets how to handle existing files (default: \`overwrite\` in non-interactive mode)
- When neither is provided, interactive prompts are shown
- \`.devenv.json\` is always updated regardless of strategy`,
    },
    {
      title: "Important: Untracked Files and the Track Command",
      content: `**The \`push\` and \`diff\` commands only operate on files that are in the sync whitelist (tracked patterns).**
If you create new files or directories that don't match any existing pattern, they will appear as **untracked** and will NOT be included in diffs or push operations.

To sync these files to the template, you **must** first add them to tracking:

\`\`\`bash
# 1. Check for untracked files
npx ziku diff

# 2. Add untracked files to the whitelist
npx ziku track "<file-or-glob-pattern>"

# 3. Now push will include these files
npx ziku push --yes --files "path1,path2" -m "feat: add new files"
\`\`\`

**Key points:**
- \`diff\` will report untracked files and suggest using \`track\`
- \`track\` is non-interactive and designed for AI agents — no prompts required
- After running \`track\`, the newly tracked files will be available for \`push\``,
    },
    {
      title: "Push Workflow for AI Agents",
      content: `> **AI agents:** This command is interactive by default, but all prompts can be skipped with \`--yes\` and \`--files\`.

When contributing template improvements:

\`\`\`bash
# Push specific files (non-interactive)
npx ziku push --yes --files ".claude/statusline.sh,.claude/settings.json" -m "feat: add statusline"
\`\`\`

### Options

| Option | Alias | Description |
|--------|-------|-------------|
| \`--files\` | | Comma-separated file paths to include (only files with actual changes are eligible) |
| \`--yes\` | \`-y\` | Skip confirmation prompts |
| \`-m\` | \`--message\` | Set the PR title |
| \`--edit\` | | Edit PR title and description before creating |
| \`-n\` | \`--dryRun\` | Preview only, don't create PR |

### Workflow

1. Use \`npx ziku diff\` to review changes first
2. Use \`--files\` to specify exactly which files to include
3. Files not found in pushable changes will be warned but won't block the push
4. Set \`GITHUB_TOKEN\` or \`GH_TOKEN\` environment variable for authentication`,
    },
    {
      title: "Environment Variables",
      content: `| Variable | Description |
|----------|-------------|
| \`GITHUB_TOKEN\` | GitHub personal access token (required for push) |
| \`GH_TOKEN\` | Alternative to GITHUB_TOKEN |

The token needs \`repo\` scope for creating PRs.`,
    },
    {
      title: "Track Command for AI Agents",
      content: `The \`track\` command allows AI agents to add files or patterns to the sync whitelist non-interactively.
This is useful when you create new files or directories that should be part of the template.

### Add patterns to an existing module

\`\`\`bash
# Auto-detects module from path (.claude module)
npx ziku track ".claude/commands/*.md"

# Explicit module
npx ziku track ".devcontainer/new-script.sh" --module .devcontainer
\`\`\`

### Create a new module with patterns

When the module doesn't exist yet, it is automatically created:

\`\`\`bash
# Creates ".cloud" module and adds the pattern
npx ziku track ".cloud/rules/*.md"

# With custom name and description
npx ziku track ".cloud/rules/*.md" \\
  --module .cloud \\
  --name "Cloud Rules" \\
  --description "Cloud configuration and rule files"
\`\`\`

### List current tracking configuration

\`\`\`bash
npx ziku track --list
\`\`\`

### Options

| Option | Alias | Description |
|--------|-------|-------------|
| \`--module <id>\` | \`-m\` | Module ID to add patterns to (auto-detected if omitted) |
| \`--name <name>\` | | Module display name (for new modules) |
| \`--description <desc>\` | | Module description (for new modules) |
| \`--dir <path>\` | \`-d\` | Project directory (default: current directory) |
| \`--list\` | \`-l\` | List all tracked modules and patterns |`,
    },
    {
      title: "Best Practices for AI Agents",
      content: `1. **Use \`--modules\` and \`--overwrite-strategy\`** for granular non-interactive init (e.g., \`init --modules .github,.claude -s skip\`)
2. **Use \`--files\` for targeted pushes** — specify exactly which files to include (e.g., \`push --yes --files "path1,path2" -m "feat: ..."\`)
3. **Review the diff first** with \`npx ziku diff\` — this also reports untracked files
4. **Check for untracked files** — if \`diff\` reports untracked files, use \`track\` to add them before pushing
5. **Use \`track\` command** to add new files to the sync whitelist (non-interactive, no prompts)
6. **Use \`pull\` to sync template updates** — resolves conflicts with 3-way merge when possible
7. **Set meaningful PR titles** that follow conventional commits (e.g., \`feat:\`, \`fix:\`, \`docs:\`)
8. **Use \`--files\` to select specific changes** — only include relevant files in the PR
9. **Use environment variables** for tokens (\`GITHUB_TOKEN\` or \`GH_TOKEN\`)`,
    },
    {
      title: "Track + Push: Adding New Files to Template",
      content: `When you create new files that should be part of the template, use \`track\` then \`push\`.
The \`push\` command **automatically detects** changes made by \`track\` to the local \`modules.jsonc\`
and includes them in the PR.

### Workflow

\`\`\`bash
# 1. Create files locally
mkdir -p .cloud/rules
echo "naming conventions..." > .cloud/rules/naming.md

# 2. Add to tracking (updates local .devenv/modules.jsonc)
npx ziku track ".cloud/rules/*.md"

# 3. Push detects local module additions automatically
npx ziku push --yes --files ".cloud/rules/naming.md" -m "feat: add naming rules"
\`\`\`

### What happens internally

1. \`track\` adds patterns to **local** \`.devenv/modules.jsonc\` (creates new modules if needed)
2. \`push\` downloads the template and compares its \`modules.jsonc\` with local
3. New modules and patterns are detected and merged into the detection scope
4. The PR includes both the files AND the updated module definitions

### Key behavior

- **No need to manually edit modules.jsonc** — \`track\` handles it
- **push detects local changes** — no extra flags needed; just run \`push\` after \`track\`
- **New modules are auto-created** — if \`.cloud\` doesn't exist in the template, it's added
- **Existing module patterns can also be extended** — \`track\` works for both new and existing modules`,
    },
  ];
}

/**
 * Generate README section for AI agents
 * Returns content suitable for embedding in README.md
 */
export function generateReadmeSection(): string {
  const lines: string[] = [];
  lines.push("## For AI Agents\n");
  lines.push("AI coding agents can use the non-interactive workflow:\n");
  lines.push("```bash");
  lines.push("# Push specific files as a PR");
  lines.push('npx ziku push --yes --files "path1,path2" -m "feat: add config"');
  lines.push("");
  lines.push("# Add new files to tracking, then push");
  lines.push('npx ziku track ".cloud/rules/*.md"');
  lines.push('npx ziku push --yes --files ".cloud/rules/naming.md" -m "feat: add rules"');
  lines.push("```\n");
  lines.push("For detailed documentation, run:\n");
  lines.push("```bash");
  lines.push("npx ziku ai-docs");
  lines.push("```\n");
  return lines.join("\n");
}
