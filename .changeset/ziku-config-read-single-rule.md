---
"ziku": patch
---

テンプレートの `.ziku/ziku.jsonc` がスキーマを破っているとき、構文エラーではなくスキーマ違反として報告する。

`"include": "a"` のように構文は通るが ziku の設定として解釈できないテンプレートは、`ziku init` / `ziku pull` / `ziku push` / `ziku status` が `Failed to parse` と Zod の内部表現をそのまま出していた。壊れていない JSONC の中で構文ミスを探すことになるので、ローカル側の設定と同じく `Failed to read <path>` + 不正なフィールドごとの 1 行（例: `include: Invalid input: expected array, received string`）で報告する。

`.ziku/ziku.jsonc` を読む 3 つの入口（ローカル設定・union マージ・テンプレート設定）が、ファイル不在・構文エラー・スキーマ違反・成功の 4 分類を 1 箇所から受け取る。

`.ziku/ziku.jsonc` が exclude で走査から消えたときの復帰条件を、ハッシュ計算と差分検出で揃える。
