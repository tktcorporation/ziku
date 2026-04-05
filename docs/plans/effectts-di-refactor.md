# EffectTS DI リファクタ

## 背景

init/push/pull/diff の各コマンドで `isLocalSource` / `isGitHubSource` による分岐が散在している。テンプレートソースの取得（ローカル or GitHub ダウンロード）、baseRef の解決、クリーンアップの3つの操作がコマンドごとに重複実装されている。

**新設計:** EffectTS の Service + Layer でテンプレートソースを抽象化し、各コマンドは具体的なソース種別を知らずに操作できるようにする。

## 前提

modules.jsonc 廃止 + E2E テスト駆動ドキュメントの完了後に実施する。ソースの抽象化はファイル取得パターンが確定してからの方がスコープが小さい。

## 設計

### Service 定義

```typescript
// src/services/template-source.ts
import { Context, Effect, Layer } from "effect";

class TemplateSource extends Context.Tag("TemplateSource")<
  TemplateSource,
  {
    /** テンプレートディレクトリのパスを取得（ダウンロード or ローカルパス） */
    readonly getTemplateDir: Effect.Effect<string>
    /** 同期ベースとなるコミット SHA を取得（GitHub のみ、ローカルは undefined） */
    readonly resolveBaseRef: Effect.Effect<string | undefined>
    /** 一時ディレクトリのクリーンアップ（ローカルの場合は no-op） */
    readonly cleanup: Effect.Effect<void>
    /** テンプレート情報の表示文字列（ログ用） */
    readonly displayName: string
  }
>() {}
```

### GitHub 実装

```typescript
// src/services/github-source.ts
const GitHubSourceLive = (owner: string, repo: string, ref?: string) =>
  Layer.effect(
    TemplateSource,
    Effect.gen(function* () {
      const { templateDir, cleanup } = yield* Effect.tryPromise(() =>
        downloadTemplateToTemp(...)
      );
      return {
        getTemplateDir: Effect.succeed(templateDir),
        resolveBaseRef: Effect.tryPromise(() => resolveLatestCommitSha(owner, repo)),
        cleanup: Effect.sync(cleanup),
        displayName: `${owner}/${repo}`,
      };
    }),
  );
```

### ローカル実装

```typescript
// src/services/local-source.ts
const LocalSourceLive = (path: string) =>
  Layer.succeed(TemplateSource, {
    getTemplateDir: Effect.succeed(path),
    resolveBaseRef: Effect.succeed(undefined),
    cleanup: Effect.void,
    displayName: `${path} (local)`,
  });
```

### テスト実装

```typescript
// テスト内
const TestSourceLive = (templateDir: string) =>
  Layer.succeed(TemplateSource, {
    getTemplateDir: Effect.succeed(templateDir),
    resolveBaseRef: Effect.succeed("test-sha"),
    cleanup: Effect.void,
    displayName: "test-template",
  });
```

### コマンドでの使用

```typescript
// src/commands/init.ts（Effect.gen スタイル）
const program = Effect.gen(function* () {
  const source = yield* TemplateSource;
  const templateDir = yield* source.getTemplateDir;
  
  // ディレクトリ選択、ファイルコピー...
  
  const baseRef = yield* source.resolveBaseRef;
  // lock.json 保存...
  
  yield* source.cleanup;
});

// 実行時に Layer を提供
const layer = isLocalSource(config.source)
  ? LocalSourceLive(config.source.path)
  : GitHubSourceLive(config.source.owner, config.source.repo);

Effect.runPromise(program.pipe(Effect.provide(layer)));
```

## 変更対象ファイル

| ファイル | 変更 |
|---|---|
| `src/services/template-source.ts` | 新規: Service 定義 |
| `src/services/github-source.ts` | 新規: GitHub Layer |
| `src/services/local-source.ts` | 新規: ローカル Layer |
| `src/commands/init.ts` | Effect.gen + Service 使用に変更 |
| `src/commands/push.ts` | 同上 |
| `src/commands/pull.ts` | 同上 |
| `src/commands/diff.ts` | 同上 |
| テスト | TestSourceLive で DI |

## メリット

- `isLocalSource` / `isGitHubSource` の分岐が各コマンドから消える
- テストで TemplateSource をモック注入するだけで済む（downloadTemplate のモック不要）
- 新しいソース種別（S3、ローカル tarball 等）の追加が Layer 1つで完了
- Effect.gen のジェネレータスタイルで非同期処理が読みやすくなる

## 検証

```bash
pnpm test          # 全テスト pass
pnpm lint          # Effect の try/catch ルール違反なし
```
