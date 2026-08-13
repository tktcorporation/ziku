---
"ziku": patch
---

`ziku pull` / `ziku status` の失敗を、理由で分岐できる判別 union (`FailureReason`) で表す。

`ziku pull` のマージ中断まわりは、ユーザーが取る行動ごとに 3 つの理由に分かれる。

- 解決待ちのマージが残ったまま `ziku pull` を実行した — 解決待ちのファイルを挙げ、`ziku pull --continue` へ誘導する
- 解決待ちが無いのに `ziku pull --continue` を実行した — `ziku pull` から始めるよう案内する
- コンフリクトマーカーが残ったまま `ziku pull --continue` を実行した — 残っているファイルと行番号を挙げ、編集してから再実行するよう案内する

`ziku pull --continue` を未初期化のディレクトリで実行したときは、`ziku init` を案内する。
