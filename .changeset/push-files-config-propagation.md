---
"ziku": patch
---

`ziku push --files=<path>` でファイル本体だけを指定すると、事前に `ziku track` 済みの include パターンが `.ziku/ziku.jsonc` の除外により push 候補から漏れる不具合を修正した。

これまで `ziku track <path>` → `ziku push --files=<path>` の順で操作すると、ファイル本体はテンプレートに反映される一方、`.ziku/ziku.jsonc` は `--files` に含めていないため push 対象から漏れていた。ファイルは実在するのに include パターンがテンプレートへ伝わらず、他プロジェクトの `ziku pull` がそのファイルを一切検出できなくなっていた（#90）。

- push されるファイルに対応する include パターンが `.ziku/ziku.jsonc` の未選択により漏れる場合、テンプレートの `.ziku/ziku.jsonc` へ関連パターンだけを自動的に同梱するようにした。無関係なローカル限定パターンまで一緒にテンプレートへ漏らすことはない。
- `--dryRun` のプレビューでも、実 push で自動同梱される旨を事前に警告する。
