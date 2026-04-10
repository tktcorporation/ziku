---
title: "Your dev templates die the day you scaffold them. Here's how to keep them alive."
published: false
description: "ziku is a CLI tool that bi-directionally syncs .claude/, .mcp.json, CI workflows, and other config files between template repos and projects."
tags: devtools, opensource, cli, productivity
---

## The problem nobody talks about

You create a beautiful template repo. ESLint config, CI workflows, `.claude/rules/`, `.mcp.json`, devcontainer setup — everything dialed in. You scaffold a new project from it. Life is good.

Three months later:

- Project A has a better CI workflow you wrote last week
- Project B has refined Claude rules that took you hours to tune
- Project C still uses the original, now-outdated config
- The template repo? Frozen in time. Nobody updated it.

**Templates go stale the moment you scaffold them.**

This isn't a new complaint. [GitHub Community Discussion #23528](https://github.com/orgs/community/discussions/23528) has been open since 2020, asking how to sync template changes — with no official solution. Cookiecutter's [Issue #784](https://github.com/cookiecutter/cookiecutter/issues/784) has been open since 2016. The pain is real and widespread.

## Existing solutions and their gaps

| Approach | Template → Project | Project → Template | Limitations |
|---|---|---|---|
| GitHub Template Repos | Initial copy only | None | No ongoing relationship after creation |
| Git Submodules | `git pull` | `git push` | Confined to a single subdirectory |
| cookiecutter + cruft | `cruft update` | Manual | No built-in reverse sync; Python-only |
| copier | `copier update` | Manual | No push command; requires tagged versions |
| GitHub Actions (template-sync) | Auto PR | None | One-way only; CI-dependent |

The common gap: **none of them close the feedback loop.** Improvements in your project never flow back to the template automatically.

## ziku: bi-directional template sync

[ziku](https://github.com/tktcorporation/ziku) (軸 — Japanese for "axis") treats the template as a living axis that every project revolves around. Changes flow both ways:

```
Template ←── push ──── Project A
    │                      │
    ├── pull ──→ Project B (gets A's improvements)
    │
    └── pull ──→ Project C (gets A's improvements)
```

Key characteristics:

- **`push`** — Send your project's improvements back to the template (auto-creates a GitHub PR)
- **`pull`** — Pull latest template updates with **3-way merge** (your local customizations are preserved)
- **Pattern-based** — Sync scattered files across any directory using glob patterns
- **Zero config to start** — `npx ziku` and you're running. No install needed.

## Quick walkthrough

### 1. Set up the template

Create a repo (e.g., `your-org/.github` or `your-org/.ziku`) and initialize it:

```bash
npx ziku setup
```

This creates `.ziku/ziku.jsonc`. Define what to sync:

```jsonc
{
  "$schema": "https://raw.githubusercontent.com/tktcorporation/ziku/main/schema/ziku.json",
  "include": [
    ".claude/settings.json",
    ".claude/rules/*.md",
    ".claude/skills/**",
    ".devcontainer/**",
    ".mcp.json"
  ]
}
```

### 2. Apply the template to a project

```bash
npx ziku init          # auto-detects from git remote
npx ziku --from my-org/my-templates   # or specify explicitly
```

```
┌   ziku  v1.0.3
│
●  Template: your-org/.github
│
◇  Applying templates...
│
│  + .claude/rules/pr-workflow.md
│  + .claude/skills/ui-craft/SKILL.md
│  + .mcp.json
│  + .ziku/ziku.jsonc
│  + .ziku/lock.json
│
│  5 added
│
└  Setup complete!
```

### 3. Push improvements back

You refined `.claude/rules/pr-workflow.md` in your project. Push it back:

```bash
npx ziku push -m "Add CI watch steps to pr-workflow"
```

```
┌   ziku push  v1.0.3
│
◇  Files that would be included in PR:
│
│  ~ .claude/rules/pr-workflow.md
│
◇  Created PR: your-org/.github#12
│
└  Done!
```

A PR is created on the template repo. Merge it, and every other project can `pull` the improvement.

### 4. Pull template updates

```bash
npx ziku pull
```

```
┌   ziku pull  v1.0.3
│
│  ~ .claude/rules/pr-workflow.md (3-way merge)
│
│  ~1 modified
│
└  Pull complete!
```

The 3-way merge means **your project-specific customizations are preserved**. If there's a conflict, you get familiar Git-style conflict markers, and resolve with `pull --continue`.

### 5. Track new files

Created a new skill or config file? Add it to the sync:

```bash
npx ziku track '.claude/skills/my-new-skill/**'
npx ziku push -m "Add my-new-skill"
```

When other projects `pull`, they get both the new files and the updated pattern — the sync whitelist itself stays in sync.

## What makes ziku different

### Bi-directional by design

This is the core differentiator. Most tools only solve template → project. ziku's `push` command creates a PR on the template repo, making it trivial to contribute improvements back. The template stays alive because every project feeds it.

### 3-way merge for structured files

`pull` doesn't blindly overwrite. It performs a 3-way merge (base → local → template), and understands JSON, YAML, and TOML structure. Your project-specific tweaks to a shared `.mcp.json` won't be lost when the template adds a new field.

### Pattern-based, not directory-based

Unlike git submodules (locked to one directory), ziku uses glob patterns:

```jsonc
{
  "include": [
    ".claude/rules/*.md",        // scattered in .claude/
    ".mcp.json",                 // root level
    ".github/workflows/**",      // deep in .github/
    ".devcontainer/**"           // another directory entirely
  ]
}
```

Sync files wherever they live — no restructuring your project.

### Works with local templates too

No GitHub? No problem. Point to a local directory:

```bash
npx ziku init --from-dir ../my-template
npx ziku push   # copies files directly, no PR
```

Great for monorepos or air-gapped environments.

## Use case: keeping AI agent configs in sync

With the rise of coding agents (Claude Code, Cursor, GitHub Copilot), teams are accumulating `.claude/rules/`, `.cursor/rules/`, `.mcp.json`, and other AI config files. These take real effort to tune — and every project ends up with a slightly different (and slightly worse) version.

ziku was built for exactly this scenario:

```
.claude/
├── settings.json
├── rules/
│   └── pr-workflow.md
└── skills/
    └── ui-craft/SKILL.md
.mcp.json
```

One team member improves a rule → `push` → template updated → everyone else `pull`s → all projects benefit. The feedback loop is closed.

## Getting started

```bash
# That's it. No global install.
npx ziku
```

Repo: [github.com/tktcorporation/ziku](https://github.com/tktcorporation/ziku)

If you have questions, bugs, or ideas — [open an issue](https://github.com/tktcorporation/ziku/issues). Contributions welcome.
