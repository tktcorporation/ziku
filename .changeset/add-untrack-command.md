---
"ziku": minor
---

`ziku untrack <patterns...>` コマンドを追加した。`ziku track` の逆操作で、`.ziku/ziku.jsonc` の `include` から指定したパターンを削除する。

これまで同期対象から外すには `ziku.jsonc` を手編集する必要があった。`untrack` は `track` と対称的に動作し、include キーのみを部分更新するため exclude やコメントは保持される。指定パターンのうち追跡中でないものはスキップして警告し、設定は変更しない。テンプレートには影響しない（反映するには `ziku push` でテンプレートの `ziku.jsonc` を更新する）。
