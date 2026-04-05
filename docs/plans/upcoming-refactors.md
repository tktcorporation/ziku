# 今後のリファクタ計画

## 1. ~~modules.jsonc 廃止~~ ✅ 完了

ziku.jsonc に統一。source は lock.json に分離。init はディレクトリ単位選択。
pull 時にテンプレートの ziku.jsonc から新パターンを自動マージ。

## 2. E2E テスト駆動ライフサイクルドキュメント

**目的:** テストがライフサイクルの唯一の定義（SSOT）になり、ドキュメントと実装が絶対に乖離しない。

**変更内容:**
- E2E テスト内の `LIFECYCLE_SPECS` からドキュメント生成
- 各コマンドの `*Lifecycle` 定数を削除
- `npm run docs` がテスト出力 JSON を読んでドキュメント生成

## 3. EffectTS DI リファクタ

**目的:** `isLocalSource` / `isGitHubSource` の分岐を各コマンドから消す。

**変更内容:**
- `TemplateSource` Service を定義（getTemplateDir, resolveBaseRef, cleanup）
- `GitHubSourceLive` / `LocalSourceLive` の Layer 実装
- init/push/pull/diff が Service 経由でテンプレートにアクセス
- テストでは `TestSourceLive` を注入

**前提:** modules.jsonc 廃止後の方がスコープが小さくなる
