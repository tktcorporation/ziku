# E2E テスト駆動ライフサイクルドキュメント

## 背景

現在のライフサイクルドキュメント（`docs/architecture/file-lifecycle.md`）は各コマンドの `*Lifecycle` 定数（手動メンテナンス）から生成される。テストで検証されていないため、実装とドキュメントの乖離リスクがある。

**新設計:** E2E テスト内の `LIFECYCLE_SPECS` がライフサイクルの唯一の定義（SSOT）。テスト実行時に JSON を出力し、`npm run docs` がその JSON からドキュメントを生成する。

## 前提

modules.jsonc 廃止リファクタ完了後に実施する。modules.jsonc が残っている状態でやると、ライフサイクル仕様が変わるたびにテストとドキュメントを二重修正することになる。

## 変更内容

### 1. LIFECYCLE_SPECS をテスト内に定義

```typescript
// src/commands/__tests__/e2e-lifecycle.test.ts
const LIFECYCLE_SPECS: CommandLifecycleSpec[] = [
  {
    command: "init",
    description: "ユーザープロジェクトの初期化",
    ops: [
      { file: "template files", location: "template", op: "read", note: "テンプレートのディレクトリ構造を列挙" },
      { file: ".ziku/ziku.jsonc", location: "local", op: "create", note: "source + 選択ディレクトリを保存" },
      { file: ".ziku/lock.json", location: "local", op: "create", note: "ベースコミット SHA + ハッシュを記録" },
      { file: "synced files", location: "local", op: "create", note: "テンプレートからファイルをコピー" },
    ],
  },
  // push, pull, diff も同様
];
```

### 2. テストが LIFECYCLE_SPECS の正しさを検証

各 op に対して実際にコマンドを実行し、ファイル操作が宣言通りに行われることをアサート。

### 3. テスト完了後に JSON 出力

```typescript
afterAll(() => {
  writeFileSync("src/docs/lifecycle-specs.json", JSON.stringify(LIFECYCLE_SPECS, null, 2));
});
```

### 4. ドキュメント生成スクリプトの変更

- `src/docs/lifecycle.ts`: `lifecycle-specs.json` を読み込んでドキュメント生成
- 各コマンドの `*Lifecycle` 定数を削除（init.ts, push.ts, pull.ts, diff.ts）
- `src/docs/lifecycle-types.ts`: テストと共有する型定義のみ残す

### 5. CI フロー

```bash
pnpm test              # E2E テスト pass + lifecycle-specs.json 生成
pnpm run docs          # JSON からドキュメント生成
pnpm run docs:check    # ドキュメントが最新か CI で検証
```

テストが fail → JSON 未更新 → docs:check も fail → CI 全体が fail。

## 変更対象ファイル

| ファイル | 変更 |
|---|---|
| `src/commands/__tests__/e2e-lifecycle.test.ts` | LIFECYCLE_SPECS 定義 + JSON 出力 |
| `src/docs/lifecycle-specs.json` | 新規（テスト出力、git 管理対象） |
| `src/docs/lifecycle.ts` | JSON 入力からドキュメント生成に変更 |
| `src/commands/{init,push,pull,diff}.ts` | *Lifecycle 定数削除 |
| `scripts/generate-readme.ts` | lifecycle import 先変更 |

## 検証

```bash
pnpm test && pnpm run docs && pnpm run docs:check
```
