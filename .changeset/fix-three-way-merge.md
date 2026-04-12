---
"ziku": patch
---

fix: 3-way merge のサイレント上書き・内容二重化を修正 (#51)

`diff` ライブラリの `applyPatch` を `node-diff3` の `diff3Merge` に置換し、git merge-file と同等の conflict 検出を実現。
