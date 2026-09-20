# CLAUDE.md

Guidance for agents working in this repository. See `AGENTS.md` for how this file fits with
`.claude/skills/` and `.claude/rules/`.

## Project overview

ziku is a bi-directional dev-environment template sync tool (CLI, published as `ziku` on npm).
It keeps a project's `.claude/`, `.cursor/`, `.codex/`, and similar agent-tooling files in sync
with a shared GitHub template repository: `init` scaffolds a new project from the template,
`pull` merges upstream template changes into a project (three-way merge, tracked via
`.ziku/lock.json`), and `push` sends a project's own improvements back to the template.

## Commands

```bash
pnpm build           # tsdown build to dist/
pnpm dev              # tsdown --watch
pnpm test             # vitest (watch)
pnpm test:run         # vitest run
pnpm test:coverage    # vitest run --coverage
pnpm lint              # oxlint . && ast-grep scan
pnpm format:check     # oxfmt --check .
pnpm typecheck         # oxlint --type-aware --type-check
pnpm check             # format:check && lint && typecheck && build && test:run && docs:check
pnpm docs               # regenerate README.md / docs site from source (scripts/generate-readme.ts, scripts/generate-site.ts)
pnpm docs:check        # verify the generated docs are up to date (CI gate)
```

`scripts/docs-lifecycle/` is a standalone bun-managed subproject (its own `package.json` /
`bunfig.toml`) that checks doc freshness and link health; run it with `bun run scripts/docs-lifecycle/run.ts`
(wrapped by `mise run lint-docs`). `tools/agent-fleet/` is a similar standalone bun subproject
(a terminal UI for watching parallel agent sessions); it has its own `typecheck`/`test` and isn't
part of the root `pnpm check`. Both are template-synced tooling with their own tsconfig/bunfig,
so the root `.oxlintrc.json` excludes them (see its `ignorePatterns`) rather than linting them
against this repo's own rules.

## Architecture

```
src/
├── index.ts          — CLI entry point (citty), wires up the subcommands below
├── commands/          — one file per CLI subcommand: init, pull, push, diff, aggregate, status, track, setup
├── modules/            — shared schemas (lock file, config) used across commands
├── utils/               — core logic: git/GitHub access, 3-way merge, hashing, jsonc parsing,
│                        pattern matching for tracked paths, sync-scope resolution
├── services/            — command-context construction (shared setup for commands)
├── ui/                  — terminal UI (prompts, rendering)
└── docs/                 — content used by the generated docs site
```

`.ziku/lock.json` (in a project that has run `ziku init`) records the sync state: the template
source, `sync` status (`pending`/`merging`/`synced`), and a `base.hashes` map (sha256 per tracked
path) used to three-way-merge the next `pull`. `.ziku/ziku.jsonc` lists which paths are synced.
