---
"ziku": patch
---

Ctrl+C や `process.exit()` で中断された場合に `.ziku-temp` / `.ziku-temp-base` がターゲットディレクトリに残る問題を修正。

`src/utils/temp-tracker.ts` を新設し、アクティブな一時ディレクトリを追跡。`process` の `exit` / `SIGINT` / `SIGTERM` で同期的に削除するハンドラを登録するようにした。`downloadTemplateToTemp()` と `fetchTemplates()` はダウンロード前にトラッカーへ登録し、通常終了時の cleanup で登録解除する。
