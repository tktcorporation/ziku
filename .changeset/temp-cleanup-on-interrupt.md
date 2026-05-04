---
"ziku": patch
---

Ctrl+C や `process.exit()` で中断された場合に `.ziku-temp` / `.ziku-temp-base` がターゲットディレクトリに残る問題を修正。

二段構えで漏れを防ぐ:

- **Effect.Scope による構造的保証**: 新規 API `acquireTempTemplate` を `Effect.addFinalizer` で実装。`resolveTemplateDirScoped` / `command-context` 経由で取得した temp dir は、Scope クローズ時 (成功・失敗・Fiber 中断いずれでも) に必ず削除される。
- **同期 exit hook (最終防衛線)**: `src/utils/temp-tracker.ts` がアクティブな temp dir を Set で追跡し、`process` の `exit` / `SIGINT` / `SIGTERM` で同期削除する。Effect 機構が走らない `process.exit()` 経路を埋める。
