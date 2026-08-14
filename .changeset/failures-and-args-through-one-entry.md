---
"ziku": patch
---

GitHub API を呼ぶ操作の失敗分類を呼ばれる側へ移す。`setup --remote` と `init` のリポジトリ作成が、権限不足やレート制限を「ziku の不具合」としてスタックトレース付きで報告していた。
