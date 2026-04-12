# Dev Container 環境での Dev Server ルール

## 前提

この開発環境は Dev Container（Devin 等）上で動作する。
コンテナ内で起動した Dev Server はデフォルトでは `127.0.0.1` にバインドされ、コンテナ外（ブラウザ等）からアクセスできない。

## ルール: Dev Server は必ずホストを公開する

Dev Server を起動・設定するときは、**コンテナ外からアクセスできる状態にすること。**

### 方法（優先順）

1. **設定ファイルで `host: true`（= `0.0.0.0`）を指定する**（推奨）
   - Vite / VitePress: `server.host: true` または `vite.server.host: true`
   - Webpack Dev Server: `devServer.host: '0.0.0.0'`
   - Next.js: `--hostname 0.0.0.0`
   - 設定ファイルに書くことで、誰が起動しても同じ挙動になる

2. **CLI フラグで `--host` を付ける**（設定ファイルを変更できない場合）
   - `vitepress dev docs --host`
   - `vite dev --host`
   - package.json の scripts に含めてもよい

### 新規設定例

```typescript
// VitePress: docs/.vitepress/config.ts
export default defineConfig({
  vite: {
    server: {
      host: true,
    },
  },
});

// Vite: vite.config.ts
export default defineConfig({
  server: {
    host: true,
  },
});
```

## やってはいけないこと

- `localhost` / `127.0.0.1` のままサーバーを起動して「アクセスできません」と報告する
- `host: '0.0.0.0'` のハードコードで動くが、`host: true` のほうが意図が明確なので後者を使う
