# 今後のリファクタ計画

## 1. modules.jsonc 廃止（次のPR）

**目的:** パターン管理の複雑さを解消。テンプレートリポのファイル = 同期対象。

**変更内容:**
- modules.jsonc を削除。テンプレートリポにはファイルだけが存在する
- init 時の選択はディレクトリ単位（トップレベルディレクトリを選択 UI に表示）
- ziku.jsonc は source + 選択ディレクトリ（or 全部）を持つ
- track コマンド不要に（テンプレートに追加するだけ）
- setup コマンドの modules.jsonc 生成も不要に

**削除対象:**
- `src/modules/loader.ts` のほぼ全関数
- `src/commands/setup.ts` の modules.jsonc 生成部分
- `src/commands/track.ts`（コマンド自体）
- `src/modules/schemas.ts` の moduleSchema, TemplateModule
- テスト: loader.test.ts, setup 関連, track 関連

**影響範囲:** init, push, pull, diff, schemas, lifecycle docs, README

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
