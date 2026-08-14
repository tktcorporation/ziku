---
"ziku": patch
---

gitignore されたファイルが同期の対象から外れる。`.env` のようなマシン固有の設定や資格情報は、テンプレート側に同名のファイルがあっても `ziku pull` がローカルの内容を書き換えず、`ziku push` がテンプレートへ送ることもない。`ziku init` が「ローカルに既にあるなら置き換えない」として扱ってきた範囲と、pull / push / status / diff が扱う範囲が一致する。

`ziku status` が数えた push 候補を `ziku push` がそのまま送れる。走査範囲がコマンドごとに違って、status が「push しろ」と勧め続けるのに push は「送るものが無い」と答える、という収束しない状態が起きなくなる。

`ziku push` は、テンプレート側の `ziku.jsonc` にしかない include パターン配下のファイルを未追跡として報告しない。`ziku pull` が同期しているファイルと、`ziku push` が追跡済みと見なすファイルが同じ集合になる。

`.ziku/ziku.jsonc` は、プロジェクトが `.ziku/` を gitignore していても同期の対象に残る。
