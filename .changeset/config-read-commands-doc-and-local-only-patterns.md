---
"ziku": patch
---

`ziku.jsonc` の読み取り・README の `## Commands` 生成・ローカル限定パターンの status 表示を、それぞれ 1 本の情報源から導く。

README のファイル一覧は、他の入口と同じ分類（`readZikuConfig` / `classifyZikuConfigText`）から include パターンを取る。README 生成だけが読み取りと失敗の分類を自前で組み直していたため、`ziku.jsonc` の読み方が変わると README 生成だけが取り残され、実際の同期対象と食い違うファイル一覧を「正しい一覧」として書き出しうる。

README の `## Commands` は、CLI へ登録したサブコマンドの登録簿から生成する。usage を手書きで並べていたため、サブコマンドを足しても `## Commands` からは黙って落ち、生成物と commit 済みを比べる `docs:check` でも差分が出ない。

`ziku status` は、ローカルの `.ziku/ziku.jsonc` にだけあるパターンが残っている状態を「同期済み」と言わない。テンプレートへ届いていないこと、そのパターンに一致するファイルを push すれば一緒に届くことを示す。送信の可否は変えない（加法 union ではテンプレート側のパターン削除とローカル独自のパターンを区別できないため、設定ファイル単体は送らないままにする）。
