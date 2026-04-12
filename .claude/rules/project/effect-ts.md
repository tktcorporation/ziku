# EffectTS コーディング規約

## 原則: Effect でエラーを扱う

try/catch/throw の禁止は `ast-grep` ルール (`no-try-catch`) で強制される。
このファイルでは lint で扱えない設計ガイダンスを定める。

## エラー型

`src/errors.ts` の TaggedError を使う。`ZikuError` クラス（throw 用）は新規コードでは使わない。

```typescript
// エラー定義
class LockNotFoundError extends Data.TaggedError("LockNotFoundError")<{
  readonly path: string;
}> {}

// 使用
const lock =
  yield *
  Effect.tryPromise({
    try: () => loadLock(dir),
    catch: (e) =>
      e instanceof Error && e.message.includes("ENOENT")
        ? new LockNotFoundError({ path: dir })
        : new ParseError({ message: String(e) }),
  });
```

## コーディングスタイル

- `Effect.gen` を標準スタイルとする（pipe チェーンより可読性が高い）
- `Effect.runPromise` は命令層（コマンドのエントリポイント）でのみ呼ぶ
- ユーティリティ関数は `Effect<A, E, R>` を返す（内部で runPromise しない）

## リソースクリーンアップ

```typescript
// withFinally() ヘルパーは新規コードでは非推奨
// Effect.acquireRelease or Effect.ensuring を使う
const program = Effect.gen(function* () {
  yield* doWork();
}).pipe(Effect.ensuring(Effect.sync(() => cleanup())));
```
