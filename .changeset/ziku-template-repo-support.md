---
"ziku": minor
---

Support `.ziku` as template repository name in addition to `.github`

- Template auto-detection now checks both `.ziku` and `.github` repositories (`.ziku` preferred)
- `--from owner` resolves to the first existing repo among `.ziku` / `.github`
- Setup-aware candidate selection: repos with `.ziku/modules.jsonc` are prioritized
- Interactive UI shows `(ready)` / `(not set up)` hints for each candidate
