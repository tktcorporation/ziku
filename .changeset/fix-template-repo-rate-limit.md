---
"ziku": patch
---

Fix false "template repository not found" errors caused by GitHub API rate limiting, and tighten the check into a typed discriminated union so each outcome is handled explicitly.

`checkRepoExists` previously returned `Promise<boolean>`, which conflated "the repo is confirmed missing (404)" with "we couldn't tell" (403 rate-limit, 5xx, network error). When the anonymous 60 req/h quota was exhausted, GitHub returns `403 + x-ratelimit-remaining: 0`, and `ziku init` mistook that for a missing repo.

The probe now returns a tagged `RepoExistence`:

- `Exists` — HEAD returned 2xx
- `NotFound` — explicit 404
- `RateLimited` — 403 with `x-ratelimit-remaining: 0`, including the reset time and whether the call was authenticated, so users get an actionable hint (set `GITHUB_TOKEN` / wait for reset)
- `Unknown` — 5xx, unexpected 403, or network error; the init/setup flow logs a warning and keeps going so the download step surfaces the real error if any

Callers in `init` / `setup` now use `match().exhaustive()` to handle every case explicitly, so future RepoExistence variants will surface as type errors. The probe also sends `Authorization: Bearer <token>` when a GitHub token is available (via `GITHUB_TOKEN`, `GH_TOKEN`, or `gh auth token`), which raises the per-host quota from 60 req/h to 5000 req/h.
