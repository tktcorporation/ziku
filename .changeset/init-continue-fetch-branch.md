---
"ziku": patch
---

`ziku init` と `ziku pull --continue` も、テンプレートをリポジトリの既定ブランチから取得する。

- `ziku init`: 配置するファイルを取り寄せたブランチと、`.ziku/lock.json` の `base.ref` に記録するコミット SHA が同じブランチを指す。既定ブランチが `master` のリポジトリで初期化しても、次回以降の 3-way マージの共通祖先が実際に配置した内容と一致する。
- `ziku pull --continue`: 中断時にコミット SHA を確定できず取得先を ref から辿り直す場合も、既定ブランチから取り寄せる。

どちらも既定ブランチを解決できないときは取得を中断し、GitHub への到達性（ネットワーク・トークン）を確かめるか `.ziku/lock.json` の `source.ref` で取得先を明示するよう案内する。
