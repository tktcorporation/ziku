---
"ziku": minor
---

Add `ziku status` command to summarize pending pull/push and recommend the next action.

`status` performs a 3-way comparison between the local files, `lock.json`'s `baseHashes`, and the current template, then groups changes into three buckets and proposes a single next action:

- ⬇ **Pull pending** — template has changes (`autoUpdate`, `newFiles`, `deletedFiles`)
- ⬆ **Push pending** — local has changes (`localOnly`, `deletedLocally`)
- ⚠ **Conflict** — both sides changed (`conflicts`)

The recommendation engine considers `lock.pendingMerge` first (suggests `ziku pull --continue`), then conflicts (`ziku pull` for 3-way merge), then the pull/push split (`ziku pull` first if both are non-empty), so the user can sync without thinking about ordering.

`status` is purely observational, mirroring `git status` — no flags beyond the directory argument and always exits 0. CI gating ("require sync before merge") will be addressed by future commands such as `pull --dry-run` or `diff --exit-code` rather than overloading `status`.

Internally, the shared `analyzeSync` helper consolidates the `hashFiles ×2 → classifyFiles` pattern that `pull` and `push` already use, so the three commands now share a single source of truth for 3-way comparison.
