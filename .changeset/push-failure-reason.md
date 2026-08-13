---
"ziku": patch
---

`ziku push` の失敗を、理由で分岐できる判別 union (`FailureReason`) で表す。

- 自動マージできなかったファイルを push 対象に選んだとき — 対象ファイルを挙げ、`ziku pull` でテンプレートの変更を取り込んでから push し直すよう案内する
- タグ・コミットに固定されたテンプレートへ PR を出そうとしたとき — `.ziku/lock.json` の `source.ref` をブランチへ向け直すよう案内する
- 解決待ちのマージが残ったまま push したとき — `ziku pull` が同じ状態で出すのと同じ案内（解決待ちのファイルと `ziku pull --continue`）を返す

GitHub API やファイル書き込みの想定外の失敗は、文言に潰さず原因ごと表示する。
