---
"ziku": patch
---

`.ziku/ziku.jsonc` の読み込み失敗を、ファイル不在・JSONC の構文エラー・スキーマ違反の 3 つに分けて報告する。

これまでは 3 つとも「Failed to parse .ziku/ziku.jsonc」として報告し、Zod の内部表現をそのまま出していたため、構文が壊れていないファイルの中で構文ミスを探すことになっていた。

- ファイル不在: `.ziku/ziku.jsonc not found.` + `ziku init` の案内
- 構文エラー: `Failed to parse .ziku/ziku.jsonc` + 壊れている行・桁
- スキーマ違反: `Failed to read .ziku/ziku.jsonc` + 不正なフィールドごとの 1 行（例: `include: Invalid input: expected array, received string`）+ 作り直しの案内

この分類は `ziku diff` / `ziku pull` / `ziku push` / `ziku status` / `ziku track` で共通。
