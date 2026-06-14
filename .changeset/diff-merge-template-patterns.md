---
"ziku": patch
---

`ziku diff` がテンプレ追加 wildcard を `ziku status` と同じ分類で扱うよう修正した。

これまで `diff` は `config.include` を直接使っていたため、テンプレ側が追加した wildcard（例: `.claude/rules/*.md`）にのみマッチしローカル `ziku.jsonc` 未登録のファイルが、`status` では "modified（push pending）"、`diff` では "untracked" と食い違って分類されていた。

- `diff` でも `status` と同じ `mergeTemplatePatterns` を通し、テンプレ追加パターンを取り込んでから差分・未追跡を判定するようにした。
- テンプレが新パターンを追加している場合は、`status` と同様に追加パターンを通知する。
