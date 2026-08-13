---
"ziku": minor
---

`track` と `setup` の引数処理を他コマンドと揃える。

`track` はパターンを citty の位置引数として受け取る。`--dir foo` のようなフラグの値がパターンに混ざらず、`--dir=foo` 形式も使える。

`setup` に `--dryRun` / `-n` を追加する。ローカルモードでは書き込む `.ziku/ziku.jsonc` の内容を、リモートモードでは PR で追加する内容を、実行せずに表示する。`--from` は `owner` と `owner/repo` の 2 形式だけを受け付け、`a/`・`/b`・空文字列・`a/b/c` を入口で弾く。
