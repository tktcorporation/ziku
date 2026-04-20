---
"ziku": patch
---

Fix false "template repository not found" errors caused by GitHub API rate limiting.

`checkRepoExists` previously treated any non-2xx response (including 403 rate-limit responses) as "repo does not exist", which caused `ziku init` to fail with a misleading error when the anonymous GitHub API quota (60 req/h) was exhausted. The existence probe now:

- sends `Authorization: Bearer <token>` when a GitHub token is available, so the 5000 req/h authenticated quota is used when possible
- only returns `false` for an explicit `404`; other non-ok responses (403, 5xx, etc.) are treated as "unknown" and optimistically allow the init flow to continue so that giget surfaces the real error if one occurs
