# Contributing

## 開発環境セットアップ

```bash
cd packages/ziku

# 依存関係のインストール
pnpm install

# 開発モード（stub）
pnpm run dev

# ビルド
pnpm run build

# テスト
pnpm run test

# 型チェック
pnpm run typecheck

# リント
pnpm run lint
```

## ドキュメント更新

README の一部は自動生成されています。コマンドオプションやモジュールを変更した場合は以下を実行してください：

```bash
pnpm run docs
```

## リリース

[Changesets](https://github.com/changesets/changesets) を使用した自動リリースフローです。

### 手順

```bash
# 1. changeset 作成（対話式で patch/minor/major を選択）
pnpm changeset

# 2. コミット & プッシュ
git add . && git commit -m "chore: add changeset" && git push
```

これで CI が自動的に：

1. バージョン更新 & CHANGELOG 生成 → コミット
2. npm publish（OIDC Trusted Publishing）

を実行します。

### バージョニング

- `patch`: バグ修正（0.1.0 → 0.1.1）
- `minor`: 機能追加（0.1.0 → 0.2.0）
- `major`: 破壊的変更（0.1.0 → 1.0.0）
