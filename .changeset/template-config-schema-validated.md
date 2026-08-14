---
"ziku": patch
---

`ziku.jsonc` の読み取りをスキーマ検証で通す。

`"include": "not-an-array"` や `"include": [1, 2]` のように、JSONC としては通るがスキーマを破った設定は、パターン列を組み立てる時点の実行時エラーになるか、数値を glob として扱う同期になっていた。読み取りの入口で `zikuConfigSchema` を通し、違反箇所を示す `ConfigInvalid` として報告する。
