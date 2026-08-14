---
"ziku": patch
---

`ziku init` が自分で組み立てて書いたファイルを、テンプレート由来かどうかに関わらず同期ベースへ記録するようにする。

`.devcontainer/devcontainer.env.example` のようにテンプレートに存在しないファイルはベースに載らず、次回の分類が「ローカルだけが作った」と読んでいた。その結果 `ziku push --yes` が ziku 自身の生成物をテンプレートへ送り、そこから `ziku pull` で全プロジェクトへ配られていた。
