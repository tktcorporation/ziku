---
"ziku": patch
---

`ziku push --dryRun` のプレビューが `--files` を反映しない不具合を修正した。

これまで dry-run の「Files that would be pushed」は `--files` で絞る前の全候補を表示しており、実 push（`--files` で正しく絞られる）とプレビューが食い違っていた。スコープの事前確認が機能せず、誤 push の温床になっていた。

- dry-run プレビューでも実 push と同じフィルタ規則を適用し、**実際に push される集合**を表示するようにした（`--files` 指定・未解決の衝突の除外・削除の既定除外）。
- `--files` 指定時は存在しないパスを `Files not found` として警告し、絞り込み後の集合を表示する。
- `--files` で未解決の衝突を明示指定した場合は、実 push が中断することを dry-run でも予告する。
