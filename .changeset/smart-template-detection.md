---
"ziku": minor
---

Improve template source detection for `ziku init`

- Detect template candidates from both authenticated GitHub user and git remote owner
- Interactive mode presents candidates for selection when multiple are found
- `--from` now accepts owner name only (e.g., `--from my-org`) and auto-completes to `{owner}/.github`
- Non-interactive mode (`--yes`) auto-uses a single candidate, errors with disambiguation hint when multiple found
