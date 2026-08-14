---
"ziku": patch
---

pull の判断層を `pull-plan.ts` へ分離する。

- 削除方針の解決・削除候補の分離・lock へ書く同期ベースの決定・lock を書き直すかの判定・`--continue` のベース確定を `src/commands/pull-plan.ts` へ移し、ファイルシステムも GitHub API もプロンプトも用意せずに検証できるようにする（push の `push-plan.ts` / init の `init-plan.ts` と同じ分け方）。
- テンプレートからローカルへ内容を置くコピーを 1 本にまとめ、取り込み（autoUpdate / newFiles）と `--continue` の「テンプレートを取る」が同じ経路を通るようにする。
- pull のヘルパーが Effect を返すようにし、1 ファイルごとに Effect の実行環境を起こしていた箇所を無くす。

内部構造の変更のみで、CLI の挙動・出力は変わらない。
