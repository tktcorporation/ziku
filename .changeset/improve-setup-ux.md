---
"ziku": minor
---

Improve setup UX when template repository is missing or lacks `.ziku` configuration.

- Check template repo existence before downloading, with interactive recovery options
- When template repo not found: prompt to create it or specify another source
- When template has no `.ziku/modules.jsonc`: offer to scaffold via PR or use built-in defaults
- Remove hardcoded default template fallback (`tktcorporation/.github`)
- Non-interactive mode errors clearly instead of silently falling back
