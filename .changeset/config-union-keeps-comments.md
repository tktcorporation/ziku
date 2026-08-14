---
"ziku": minor
---

`.ziku/ziku.jsonc` の加法 union マージが、コメントと `$schema` / `include` / `exclude` 以外のキーを残すようにする。

`ziku pull` / `ziku push` は、これまでファイルを作り直して union の結果を書いていたため、`.jsonc` に書いた注釈が同期のたびに消えていた。書き換えは include / exclude だけの部分編集で行い、pull はローカルの内容を、テンプレートへ送る内容はテンプレートの内容を土台にする。取り込むパターンが無いときは元の内容をそのまま使うので、書式も変わらない。
