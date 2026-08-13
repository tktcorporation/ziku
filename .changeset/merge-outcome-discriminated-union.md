---
"ziku": patch
---

3-way マージの結果を判別 union (`MergeOutcome`) にし、コンフリクトマーカーを含む内容がテンプレートへ送られないことを型で保証する。

マージ結果の内容は「マーカー非混入を検証済み」の `MergedContent` と「マーカーを含むと確定」の `ConflictedContent` に分かれ、`MergedContent` は内容を走査する `classifyMergeOutcome` からしか作れない。`push` がテンプレートへ送る内容はマージ結果由来なら `MergedContent` からしか変換できないため、未解決のマーカーが PR に載る経路が存在しない。

`pull` は未解決ブロックの行番号を提示する。マーカーの検出は 1 つの関数 (`findConflictRegions`) に集約され、マージ直後の結果と `--continue` 時のディスク上のファイルを同じ規則で判定する。
