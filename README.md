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
- **`pull`** — Sync latest template updates with 3-way merge
- **`diff`** — See what's changed
- **`track`** — Add file patterns to the sync whitelist

Your template stays alive, fed by every project that uses it.

<!-- GETTING_STARTED:START -->

## Getting Started

### 1. Set up your template repository

ziku uses a GitHub repository as the template source. By default, it looks for `{your-org}/.ziku`, then `{your-org}/.github` based on your git remote.

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

# Or apply to a specific directory
npx ziku ./my-project
```

ziku copies the matching files into your project. `.ziku/ziku.jsonc` (config) and `.ziku/lock.json` (sync state) are created locally to track what was installed.

### 4. Keep it in sync

```bash
# Push local improvements back to the template
npx ziku push -m "Add new workflow"

# Pull latest template updates
npx ziku pull

# Check what's different
npx ziku diff

# Add file patterns to track
npx ziku track '.eslintrc.*'
```

<!-- GETTING_STARTED:END -->

<!-- FEATURES:START -->

## Modules

ziku lets you organize synced files into **modules** — named groups of file patterns defined in `.ziku/modules.jsonc`. During `ziku init`, users pick which modules to apply.

You can define any modules that match your team's stack. For example:

| Module | What you might include |
|---|---|
| **Linter / Formatter** | `.eslintrc.*`, `.prettierrc`, `biome.json` |
| **CI / CD** | `.github/workflows/**`, `.gitlab-ci.yml` |
| **DevContainer** | `.devcontainer/devcontainer.json` |
| **AI Tooling** | `.claude/`, `.cursor/rules/`, `.mcp.json` |
| **IaC** | `terraform/modules/**`, `docker-compose.yml` |

```jsonc
// .ziku/modules.jsonc — define as many modules as you need
{
  "modules": [
    {
      "name": "Linter",
      "description": "Shared linter and formatter settings",
      "patterns": [".eslintrc.*", ".prettierrc"]
    },
    {
      "name": "CI",
      "description": "GitHub Actions workflow templates",
      "patterns": [".github/workflows/**"]
    }
  ]
}
```

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

Add file patterns to the tracking whitelist in ziku.jsonc

```
Add file patterns to the tracking whitelist in ziku.jsonc (track)

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

The files you get depend on the patterns configured in your template's `.ziku/modules.jsonc`. After running `ziku init`, your selected patterns are saved in `.ziku/ziku.jsonc` — you can customize them anytime with `ziku track`.

ziku also creates:

- `.ziku/ziku.jsonc` — Your sync configuration (which template, which patterns)
- `.ziku/lock.json` — Sync state (hashes, base refs) for change detection

<!-- FILES:END -->

## Contributing

See [CONTRIBUTING.md](./CONTRIBUTING.md).

## License

[MIT](./LICENSE) License &copy; [tktcorporation](https://github.com/tktcorporation)
