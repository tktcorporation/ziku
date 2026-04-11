---
"ziku": patch
---

依存関係を更新し、pnpm セキュリティ設定を強化する。

## 依存関係のアップデート

**dependencies:**

- `@clack/prompts`: 1.0.1 → 1.2.0
- `citty`: 0.1.6 → 0.2.2
- `diff`: 8.0.3 → 8.0.4
- `giget`: 2.0.0 → 3.2.0（全依存関係をバンドル済みで軽量化）
- `tinyglobby`: 0.2.15 → 0.2.16
- `zod`: 4.1.13 → 4.3.6

**devDependencies:**

- `@changesets/changelog-github`: 0.5.2 → 0.6.0
- `@changesets/cli`: 2.29.8 → 2.30.0
- `@types/node`: 22.19.2 → 22.19.17
- `@vitest/coverage-v8`: 4.1.3 → 4.1.4
- `memfs`: 4.51.1 → 4.57.1
- `oxfmt`: 0.19.0 → 0.44.0
- `oxlint`: 1.57.0 → 1.59.0
- `tsdown`: 0.18.1 → 0.21.7
- `vitest`: 4.1.3 → 4.1.4

## セキュリティ設定の強化

`.npmrc` を新規作成し、以下の pnpm セキュリティ設定を追加:

- `min-release-age=3 days`: 公開から 3 日未満のパッケージバージョンをインストール対象から除外。新バージョン公開直後のサプライチェーン攻撃を緩和する。
- `ignore-scripts=true`: `pnpm.onlyBuiltDependencies` に明示されたパッケージ（`@ast-grep/cli`）以外のインストールスクリプトを無効化。
