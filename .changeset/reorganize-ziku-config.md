---
"ziku": minor
---

Reorganize config files: split `.ziku.json` into `.ziku/ziku.jsonc` (user config) and `.ziku/lock.json` (sync state)

- User settings (source, include/exclude patterns) are now in `.ziku/ziku.jsonc` with JSONC support
- Machine state (version, baseRef, baseHashes, pendingMerge) is now in `.ziku/lock.json`
- Fix oxlint config not being auto-detected (rename to `.oxlintrc.json`)
- Add strict TypeScript lint rules (no-unsafe-type-assertion, no-unsafe-argument, etc.)
