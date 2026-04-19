---
"ziku": minor
---

Add label-based selective sync to `pull`, `push`, and `diff`.

`.ziku/ziku.jsonc` now supports an optional `labels` field that groups include/exclude patterns under named groups. Use `--labels <a,b>` to sync only the selected groups, or `--skip-labels <c>` to exclude groups. Top-level `include`/`exclude` patterns are always applied as a common pool (Ansible `always` semantics).

Out-of-scope files are left untouched — their `baseHashes` entries in `lock.json` are preserved, and `baseRef` is not advanced during a scoped pull. Template-side labels are auto-merged into the local config on pull, mirroring the existing behavior for flat patterns.
