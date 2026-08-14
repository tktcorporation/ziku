---
"ziku": patch
---

push / pull の型が主張している保証を、実装と一致させる。

- `asPushContent` が 3-way マージの結果（`MergedContent` / `ConflictedContent`）を受け取らないようにし、「マーカー入りの内容は送信対象へ入れられない」という `PushContent` の JSDoc の保証を型で閉じる。
- pull の `ziku.jsonc` union マージの結果を、optional の直積から `Skip` / `BaseOnly` / `Write` の判別 union にする。「書き込むが base を揃えない」という、どの経路も作らない組み合わせを表現できなくする。
- pull が lock へ書く次のベースの計算を 1 箇所へまとめ、解決待ちでの中断と通常フローの確定が同じ計算を通るようにする。
- push の送信対象を絞る集合の型を `ReadonlySet<RepoRelPath>` へ揃え、同じファイル内で `string` と混在していた状態を解消する。

内部の型と構造の変更のみで、CLI の挙動・出力は変わらない。
