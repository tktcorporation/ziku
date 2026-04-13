# ast-grep ルール: Effect のエラー握りつぶし禁止

## Context

`Effect.orElseSucceed(() => null)` のようなパターンは、Effect のエラーチャネルを無意味な値で握りつぶし、呼び出し側がエラーの存在を型レベルで認識できなくなる。今回の ENOENT バグもこのパターンが根本原因だった。

**原則**: エラーは Effect のエラーチャネルに残し、何に変換するかは呼び出し側（親）の責務とする。

## 実装内容

### 1. ast-grep ルール作成

**ファイル**: `.ast-grep/rules/no-meaningless-fallback.yml`

検出対象:

- `Effect.orElseSucceed(() => null)`
- `Effect.orElseSucceed((): $T => undefined)`
- `Effect.orElseSucceed(() => undefined as $T)`
- `Effect.orElseSucceed(() => {})` — 空ブロック（void 握りつぶし）

検出しない:

- `Effect.orElseSucceed(() => false)` / `true` — boolean は意味のある値
- `Effect.orElseSucceed(() => { log.warn(...); return null; })` — 非空ブロック（サイドエフェクトあり）は AST パターン上マッチしない
- `catchTag("...", () => Effect.succeed(""))` — 親が明示的にフォールバック戦略を選択しているので OK

### 2. 既存違反の修正

| ファイル                          | 行          | 現状                                                      | 修正方針                                                     |
| --------------------------------- | ----------- | --------------------------------------------------------- | ------------------------------------------------------------ |
| `src/commands/pull.ts`            | 105         | `loadLock → orElseSucceed(() => null)`                    | `Effect.option` で `Option<LockState>` にする                |
| `src/commands/pull.ts`            | 135         | `loadTemplateConfig → orElseSucceed(() => null)`          | `Effect.option` で `Option<Config>` にする                   |
| `src/utils/git-remote.ts`         | 75          | `parseGitHubRepo → orElseSucceed(() => null)`             | `Effect.option` で `Option<GitHubRepo>` にする               |
| `src/services/command-context.ts` | 111         | `resolveLatestCommitSha → orElseSucceed(() => undefined)` | `Effect.option` で `Option<string>` にする                   |
| `src/utils/github.ts`             | 188,211,323 | `orElseSucceed((): string \| undefined => undefined)`     | `Effect.option` にして、呼び出し側で `Option.getOrUndefined` |

### 3. 正当な握りつぶしには `ast-grep-ignore` を付ける

| ファイル               | 行  | 理由                                                                            |
| ---------------------- | --- | ------------------------------------------------------------------------------- |
| `src/ui/prompts.ts`    | 422 | エディタ起動の fire-and-forget。失敗しても UX 上スキップが正しい                |
| `src/commands/pull.ts` | 362 | `--continue` のコンフリクトマーカーチェック。読めないファイルはスキップが正しい |

### 4. 検証

```bash
pnpm exec ast-grep scan   # 新ルールで 0 violation
pnpm lint                  # 全体 lint pass
npx vitest run             # 全テスト pass
```

## 主要ファイル

- `.ast-grep/rules/no-meaningless-fallback.yml` — 新規ルール
- `src/commands/pull.ts` — 2箇所修正 + 1箇所 ignore
- `src/services/command-context.ts` — 1箇所修正
- `src/utils/git-remote.ts` — 1箇所修正
- `src/utils/github.ts` — 3箇所修正
- `src/ui/prompts.ts` — 1箇所 ignore
