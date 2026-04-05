<p align="center">
<br>
<h1 align="center">ziku</h1>
<p align="center">
A bi-directional dev environment template that evolves with you.
</p>
<br>
<p align="center">
<a href="https://www.npmjs.com/package/ziku"><img src="https://img.shields.io/npm/v/ziku?color=a1b858&label=" alt="npm version"></a>
<a href="https://www.npmjs.com/package/ziku"><img src="https://img.shields.io/npm/dm/ziku?color=50a36f&label=" alt="npm downloads"></a>
<a href="https://github.com/tktcorporation/.github/blob/main/LICENSE"><img src="https://img.shields.io/github/license/tktcorporation/.github?color=blue&label=" alt="license"></a>
</p>
<br>
</p>

> _ziku_ (軸) — the axis around which things revolve. Your template is the axis; every project builds on it, and improvements flow back to keep it turning.

## Why

Templates go stale the moment you scaffold them. Each project improves upon the original — better configs, new workflows, refined settings — but those improvements never flow back.

**ziku** solves this with bi-directional sync:

- **`init`** — Pull the latest template into your project
- **`push`** — Push your improvements back to the template
- **`diff`** — See what's changed

Your template stays alive, fed by every project that uses it.

<!-- GETTING_STARTED:START -->

## Getting Started

### 1. Set up your template repository

ziku uses a GitHub repository as the template source. By default, it looks for `{your-org}/.ziku` based on your git remote.

If the repository doesn't exist yet, `npx ziku` will offer to create it for you interactively. You can also create it manually or specify a different source:

```bash
# Auto-detect from git remote (recommended)
npx ziku

# Use a specific template repository
npx ziku --from my-org/my-templates
```

### 2. Add `.ziku/modules.jsonc` to your template

The template repository needs a `.ziku/modules.jsonc` file that defines which file patterns ziku manages. If this file is missing, ziku will offer to create a PR that adds one with a default configuration.

Example `modules.jsonc`:

```jsonc
{
  "$schema": "https://raw.githubusercontent.com/tktcorporation/ziku/main/schema/modules.json",
  "include": [
    ".editorconfig",
    ".mcp.json",
    ".mise.toml",
    ".github/**"
  ]
}
```

### 3. Apply the template to your project

```bash
npx ziku
```

ziku copies the matching files into your project. A `.ziku/config.json` and `.ziku/modules.jsonc` are created locally to track what was installed.

### 4. Keep it in sync

```bash
# Push local improvements back to the template
npx ziku push -m "Add new workflow"

# Pull latest template updates
npx ziku pull

# Check what's different
npx ziku diff
```

<!-- GETTING_STARTED:END -->

<!-- USAGE:START -->

## Usage

```bash
# Apply template to current directory
npx ziku

# Apply to a specific directory
npx ziku ./my-project

# Push your improvements back
npx ziku push -m "Add new workflow"

# Check what's different
npx ziku diff
```

<!-- USAGE:END -->

<!-- FEATURES:START -->

## Modules

Pick what you need:

- **Root** - MCP, mise, and other root-level config files
- **DevContainer** - VS Code DevContainer with Docker-in-Docker
- **GitHub** - GitHub Actions and labeler workflows
- **Claude** - Claude Code project settings

<!-- FEATURES:END -->

<!-- COMMANDS:START -->

## Commands

### `init`

Apply dev environment template to your project

```
Apply dev environment template to your project (ziku vdev)

USAGE `ziku [OPTIONS] [DIR]`

ARGUMENTS

  `DIR="."`    Target directory

OPTIONS

                   `--force`    Overwrite existing files
                 `-y, --yes`    Non-interactive mode (accept all defaults)
             `-m, --modules`    Comma-separated module names to apply (non-interactive)
  `-s, --overwrite-strategy`    Overwrite strategy: overwrite, skip, or prompt
                    `--from`    Template source as owner/repo (e.g., my-org/my-templates)
```

### `push`

Push local changes to the template repository as a PR

```
Push local changes to the template repository as a PR (push)

USAGE `push [OPTIONS] [DIR]`

ARGUMENTS

  `DIR="."`    Project directory

OPTIONS

   `-n, --dryRun`    Preview only, don't create PR
  `-m, --message`    PR title
  `-y, -f, --yes`    Skip confirmation prompts
         `--edit`    Edit PR title and description before creating
        `--files`    Comma-separated file paths to include in PR (skips file selection prompt)
```

### `pull`

Pull latest template updates

```
Pull latest template updates (pull)

USAGE `pull [OPTIONS] [DIR]`

ARGUMENTS

  `DIR="."`    Project directory

OPTIONS

  `-f, --force`    Skip confirmations
   `--continue`    Continue after resolving merge conflicts
```

### `diff`

Show differences between local and template

```
Show differences between local and template (diff)

USAGE `diff [OPTIONS] [DIR]`

ARGUMENTS

  `DIR="."`    Project directory

OPTIONS

  `-v, --verbose`    Show detailed diff
```

### `track`

Add file patterns to the tracking whitelist in modules.jsonc

```
Add file patterns to the tracking whitelist in modules.jsonc (track)

USAGE `track [OPTIONS] [PATTERNS]`

ARGUMENTS

  `PATTERNS`    File paths or glob patterns to track (e.g., .cloud/rules/*.md)

OPTIONS

  `-d, --dir="."`    Project directory (default: current directory)
     `-l, --list`    List all currently tracked patterns
```

<!-- COMMANDS:END -->


<!-- FILES:START -->

## What You Get

Files generated based on selected modules:

- **Root (`./`)** — MCP, mise, and other root-level config files
- **`.devcontainer/`** — VS Code DevContainer with Docker-in-Docker
- **`.github/`** — GitHub Actions and labeler workflows
- **`.claude/`** — Claude Code project settings

> See [`.ziku/modules.jsonc`](./.ziku/modules.jsonc) for the full list of tracked file patterns.

<!-- FILES:END -->

## Contributing

See [CONTRIBUTING.md](./CONTRIBUTING.md).

## License

[MIT](./LICENSE) License &copy; [tktcorporation](https://github.com/tktcorporation)
