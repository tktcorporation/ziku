---
"ziku": minor
---

`ziku aggregate` が既定で候補を「直近90日以内に push されたリポジトリ」かつ「先頭30件」に絞って問い合わせるようになった。未認証 GitHub API は 60 req/hour のレート制限があり、owner 配下を無条件に全量列挙すると、候補ごとの後続処理（lock.json 取得・commit SHA 解決・内容ダウンロード）に入る前にクォータを使い切っていた。絞り込みは `--recent-days` / `--max-candidates` で変更できる。

`AggregateSummary`（JSON レポートのスキーマ）に必須フィールド `candidatesScanned`（実際に問い合わせた候補数）が増えた。JSON レポートを下流のツール・エージェントが消費する前提のコマンドであるため、これ以前のスキーマで検証していた消費側は追随が必要。
