# 設計硬化 plan — ドメイン知識を型に載せる

ziku のコアドメイン型が primitive と optional の組み合わせで表現されているため、「起きてはいけない状態」が型として作れてしまい、それがデータ破壊バグとして顕在化している。型を判別 union と brand に置き換え、同じ場所にあるバグを構造的に消す。

この plan は実装完了時点で削除する（`.claude/rules/doc-placement.md` の寿命の節）。

## 1. 前提となる設計判断

### 1.1 lock.json は破壊的変更にする

`LockState` を判別 union にすると旧形式の lock.json は読めなくなる。旧形式のマイグレーションコードを持たず、次のメジャーバージョンで切る。

理由: lock.json は `ziku init` で再生成できる派生ファイルであり、恒久的に保持すべき唯一の情報は `source` だけ。マイグレーション経路を残すと、旧形式が表現できる矛盾状態（§2.2 で消したい状態そのもの）を新形式へ変換するコードが必要になり、消したはずの状態が変換関数の中で生き残る。

pull 中断中のユーザーには「lock を削除して init し直す」経路しか無くなるが、その状態はマーカー入りのローカルファイルを手で解決すれば復旧できる。

### 1.2 既にリポジトリ内にある良い手本に揃える

`RepoExistence`（`src/utils/github.ts`）と `Recommendation`（`src/utils/status.ts`）は `_tag` / `kind` 付き判別 union で定義され、呼び出し側が `match().exhaustive()` している。コアドメイン型をこの水準に引き上げる。新しい設計様式を持ち込むのではなく、既存の良い部分を全体へ広げる。

### 1.3 brand は「取り違えが実際に起きた／起きうる」値にだけ付ける

`src/utils/merge/types.ts` の `BaseContent` / `LocalContent` / `TemplateContent` は、引数取り違えの実バグを受けて導入され機能している。一方 `filePathSchema`（`src/modules/schemas.ts`）は定義だけされて一度も使われていない。

brand を足す基準は「同じ表現を持つ別種の値が実際に混ざっている箇所があるか」。基準を満たさない brand は定義しない。使われていない `filePathSchema` / `nonNegativeIntSchema` は削除する。

## 2. Phase 1 — コアドメイン型

### 2.1 `MergeResult` → `MergeOutcome`（判別 union）

現在の `{ content: string; hasConflicts: boolean }` は、`content` と `hasConflicts` が独立しているため「マーカー入りテキストなのに hasConflicts が false」という値が型として作れる。この不変条件が破れると、コンフリクトマーカーがそのままテンプレートへの PR に載る。

```
type MergeOutcome =
  | { _tag: "Clean"; content: MergedContent }
  | { _tag: "Conflicted"; content: ConflictedContent; regions: ConflictRegion[] }
```

`MergedContent` は「マーカーを含まないことが検証済み」、`ConflictedContent` は「マーカーを含むことが確定」を表す brand。テンプレートへ送る経路（push の `mergedContents`）が `MergedContent` しか受け取らない形にすれば、マーカー混入は型エラーになる。

`regions` を持たせることで、`pull --continue` がディスクを再スキャンして数え直す必要がなくなり、ユーザーへ「どの行が未解決か」を提示できる。

### 2.2 `LockState` → 判別 union

現在の `baseRef?` / `baseHashes?` / `pendingMerge?` の組み合わせは、意味を成さない状態を表現できる。

| 表現できてしまう状態                    | なぜ不正か                                                    |
| --------------------------------------- | ------------------------------------------------------------- |
| `source: {path}` + `baseRef` あり       | ローカルソースにコミット SHA。参照側が黙って無視する          |
| `baseRef` あり + `baseHashes` なし      | base ツリーはあるが比較基準が無い                             |
| `pendingMerge` あり + `baseHashes` なし | 中断状態なのに base が無い                                    |
| `pendingMerge.conflicts` が空配列       | 「解決待ちだが対象ゼロ」。stale lock として実際に発生している |

```
type LockState = { version; installedAt; source } & (
  | { sync: "pending"; }                                   // init 直後、baseHashes 未確定
  | { sync: "synced"; base: SyncBase }
  | { sync: "merging"; base: SyncBase; merge: PendingMerge }
)
```

`SyncBase` は `source` の種別に対応させる（GitHub なら `{ hashes; ref: CommitSha }`、ローカルなら `{ hashes }`）。`PendingMerge.conflicts` は空配列を作れない非空配列型にする。

これにより pull の再実行ガード（現在 `src/commands/pull.ts` に欠落）は、`sync: "merging"` を受け取る関数が存在しないという形で型が担保する。実行時 if での防御をやめる。

### 2.3 `TemplateSource` → discriminated union、`ref` の多義性を解消

現在 `_tag` が無いため、判別方法が `"path" in source` / `isLocalSource` / `isGitHubSource` / ts-pattern の 4 系統に分裂している。`z.discriminatedUnion("kind", ...)` に統一し、`isLocalSource` / `isGitHubSource` は削除して `match().exhaustive()` に寄せる。

`ref` は giget 記法上ブランチ・タグ・コミット SHA のいずれも取りうるが、消費側は用途ごとに要求が違う。

- `resolveLatestCommitSha` — ブランチ名を期待する
- `repos.getBranch`（PR の base branch 決定） — ブランチ名でないと 404
- `downloadBaseForMerge` — コミット SHA を期待する

同じ `string` に載せているため、`source.ref` を `resolveLatestCommitSha` に渡し忘れて常に `main` を見るバグが入っている。`ref` を `{ branch } | { tag } | { commit }` の union にし、ブランチ名を要求する API はブランチ以外を型で弾く。

### 2.4 `FileDiff` → 判別 union

`type` と `localContent?` / `templateContent?` が独立しているため、下流が `?? ""` で不在を誤魔化している（`src/utils/diff.ts`、`src/ui/diff-view.ts`）。

```
type FileDiff = { path: RepoRelPath } & (
  | { type: "added"; local: FileContent }
  | { type: "deleted"; template: FileContent }
  | { type: "modified"; local: FileContent; template: FileContent }
  | { type: "unchanged"; local: FileContent; template: FileContent }
)
```

`DiffResult.summary` は `files` から算出できる派生値なので、フィールドとして保持せず関数で導出する。両者が食い違う状態を消す。

### 2.5 パスの brand

同じ `string` に 4 種類の値が入っている。

| 種別          | 例                                                      |
| ------------- | ------------------------------------------------------- |
| `AbsPath`     | プロジェクトルート、テンプレート展開先                  |
| `RepoRelPath` | ハッシュマップのキー、`FileDiff.path`、分類結果の全要素 |
| `GlobPattern` | `ziku.jsonc` の include / exclude                       |

glob パターンとファイルパスの同一視は既に機能上の欠陥になっている。`src/utils/config-merge.ts` の新規追跡パターン抽出は `Set<pattern>.has(path)` で突き合わせるため、`ziku track '.claude/rules/*.md'` のように glob を追跡したユーザーでは常に空を返し、パターンがテンプレートへ伝播しない。

3 つを brand し、変換点（`join` / `resolve` / パターン解決）をラッパー関数 1 本に集約する。`include` にリテラルパスを混ぜる既存の運用（`withConfigTracked`、push の未追跡ファイル追記）は、`GlobPattern` がリテラルパスを許容することを型の JSDoc に明記した上で維持する。glob 対パスの照合は文字列一致ではなくパターンマッチで行う。

### 2.6 ハッシュと SHA の brand

`ContentHash`（SHA-256）、`CommitSha`、`BlobSha` の 3 種が全部 `string` で、`Record<string, string>` としても区別されない。同じ形の `Record` が「パス→内容ハッシュ」「パス→blob SHA」「パス→ファイル内容」に使われている。3 つを brand し、`HashMap = Record<RepoRelPath, ContentHash>` を型エイリアスとして定義する。

## 3. Phase 2 — マージとコンフリクトの正しさ

### 3.1 JSON の構造検証が発火していない

`src/utils/merge/file-detection.ts` は `jsonc-parser` の `parse` を `Effect.try` で囲んで例外を捕まえようとしているが、`jsonc-parser` の `parse` は不正入力でも例外を投げず `errors` 配列に積む設計。`errors` を渡していないため、`.json` / `.jsonc` に対して検証は常に成功を返す。

結果、行レベル diff3 が構文的に壊れた JSON をクリーンマージとして出力しても、そのまま「Auto-merged」として確定し lock が前進する。`errors` 配列を渡して長さを見る。TOML / YAML は例外を投げるので現状のまま機能している。

### 3.2 テンプレ削除 × ローカル編集が conflict にならない

`src/utils/merge/classify.ts` の `deletedFiles` 判定は `hasBase && !hasTemplate` だけを見て `hasLocal` を見ない。テンプレートが削除したファイルをローカルが編集していても conflict にならず、`pull --force` が確認なく削除する。

逆向き（ローカル削除 × テンプレ変更）は正しく conflict にしているので、非対称を解消する。ローカルが base から変更されている場合は削除候補ではなく conflict として扱い、ユーザーに判断させる。

### 3.3 マーカー検出をペア構造ベースにする

`hasConflictMarkers` は行頭の前方一致だけを見るため、Markdown の setext 見出し下線や区切り線 `========` を未解決マーカーと誤検出する。誤検出すると `pull --continue` が永久に通らず、`pendingMerge` が残るため `push` もブロックされ、lock の手編集以外に復旧手段が無くなる。

`<<<<<<<` → `=======` → `>>>>>>>` の順序と対応を検査し、対応の取れたブロックだけを未解決と判定する。§2.1 の `ConflictRegion` を lock に保存しておけば、`--continue` 時にディスクを再スキャンする範囲を絞れる。

### 3.4 マーカーの生成品質

- ファイル全体フォールバック時、`join("\n")` が末尾改行付きの内容と結合して `=======` の直前に空行を挿入し、ファイル末尾の改行が失われる
- ラベルが固定文字列 `LOCAL` / `TEMPLATE` で、どの ref と衝突したのかが読めない
- base セクション（git の `diff3` conflict style 相当）を出力していない。`diff3Merge` は base 側の行を返しているが捨てている
- 元ファイルに既にマーカーが含まれる場合にマーカーを伸長する処理が無い（git は `<<<<<<<<` のように延長する）

ラベルにテンプレートの ref を載せ、base セクションを出力する。マーカー長は内容に含まれる最長のマーカー列より長くする。

### 3.5 CRLF・BOM・バイナリ

正規化・判定がリポジトリ全体で存在しない。

- CRLF: `split("\n")` の残留 `\r` により片側が LF なら全行差分になる。生成されるマーカー行は常に LF なので行末が混在する
- BOM: 先頭文字として残り、片側だけ BOM 付きなら 1 行目が常に差分。ハッシュ段階から差分として出る
- バイナリ: 判定が無く utf-8 として読むため、不正バイトが U+FFFD に置換される。異なるバイナリが同一ハッシュになりうるうえ、push すると破壊されたバイト列が PR に載る

マージ入口で改行コードを検出して正規化し、出力時に元の改行コードへ戻す。BOM は同様に剥がして復元する。バイナリはマージ対象から外し、内容比較はバイト列で行う。

## 4. Phase 3 — コマンド層の統合

### 4.1 分類手順の SSOT

`src/utils/sync-analysis.ts` の `analyzeSync` は「pull/push/status で重複していた手順を集約する」と宣言しているが、実際に使っているのは status だけで、pull と push は同じ手順を手書きしている。pull / push を `analyzeSync` に寄せる。

### 4.2 コンフリクト解決ループの統合

`resolveConflicts` が pull と push に同名・別セマンティクスで存在し、base が取得できなかったときの挙動が逆になっている。pull は base を空として 3-way マージし、マーカー入りの内容をローカルへ書き込む。push は 1 行も読まずに未解決として送信対象から外す。

base の不在は「2-way でしか判断できない」という同一の状況なので、扱いも一致させる。base を空文字列として扱う暗黙の代入をやめ、`MergeInput` に base の有無を明示的に持たせて、base 不在時は自動マージを行わず未解決として扱う。ローカルテンプレート運用（base の内容を復元できない）で、両側編集のたびにファイル全文がマーカーで囲まれる現象もこれで消える。

### 4.3 `.ziku/ziku.jsonc` の特別扱いを 1 箇所に集約

「常に追跡する / union マージする / 削除は伝播しない」という同一のルールが 8 箇所に散在している（include への強制追加、ハッシュ対象への復帰、diff 対象への強制追加、分類からの除外が pull と push と status で個別に、未追跡探索からの除外、union マージ本体）。

型として他の追跡ファイルと区別が無いことが原因。追跡対象を「通常の同期ファイル」と「ziku 自身の設定ファイル」の判別 union として表現し、分岐を 1 箇所にする。

### 4.4 パターン集合演算の重複

「ローカルを先、テンプレートの追加分を後ろ」という同一セマンティクスが 3 実装ある（`mergeTemplatePatterns`、`mergeConfigPatterns`、未使用の `mergePatterns`）。pull は 1 コマンド内で 2 つを呼んでいる。1 本に統合する。

### 4.5 巨大コマンドの分解

`push.ts` の `run()` は 210 行の手続きに引数解釈・対話・分類・マージ・PR 作成・設定永続化が同居し、部分的なユニットテストができない。テストが 2125 行に膨れているのはこの構造の帰結。

「何を push するか決める純粋な計算」と「実際に送る I/O」と「ユーザーに聞く UI」を分離する。`init.ts` も同様。

## 5. Phase 4 — diff 表示

- 3 行以上の連続置換で word diff が無関係な行同士をペアにする（直前が `-`、直後が `+` という条件しか見ていないため、`-a -b -c +A +B +C` で `-c` と `+A` が対になる）。ハンク単位で削除行群と追加行群を対応付ける
- 統計カウントが `line.startsWith("-") && !line.startsWith("---")` のため、YAML の文書区切りや Markdown の front matter 区切り `---` の増減がカウントされない。テンプレートは `.claude/rules/*.md` を含むので実際に踏む
- `unchanged` なファイルに赤い "deleted" ラベルが付く（三項演算子が added / modified 以外を全部 deleted にしている）
- `deleted` タイプの diff 本文が生成されず、削除を push するかどうかを内容を見ずに決めさせている
- context 行数が jsdiff の既定 4。git の 3 に合わせる
- 全ファイルの色付き diff をプロンプト起動時に先行生成し、ファイルリストをページングなしで全件描画する。端末高を超えると再描画が崩れる

### 5.1 デッドコードの削除

`formatDiff` / `colorizeUnifiedDiff` / `getPushableFiles` は呼び出し元がテストのみで、`ui/renderer.ts` と機能が重複している。`readme.ts` は廃止済みの `.ziku/modules.jsonc` を読んでおり、push 時の README 更新は常に何もしていない。`matchesPatterns` / `mergePatterns` / `compareDirectories` / `isIgnored` も未使用。削除する。

## 6. Phase 5 — エラー型と CLI の一貫性

### 6.1 `ZikuError` を判別 union に置き換える

`ZikuError` は `hint?: string` を足しただけの `Error` サブクラスで、呼び出し側が分岐できない。TaggedError を 7 個定義しながら 3 個（`ValidationError` / `GitHubApiError` / `GitError`）が未使用なのはこの歪みの表れで、Zod 検証失敗が `FileNotFoundError` に潰されて「ファイルが無い」と誤報告される原因にもなっている。

失敗理由の判別 union を定義し、ユーザー向けメッセージへの変換を `match().exhaustive()` 1 箇所にする。`runCommandEffect` が error channel を `ZikuError` 1 本に潰している関門も、この union を通す形に変える。

`withFinally` は `catch: (e) => e` で error channel を `unknown` にし、失敗を throw に戻すため、各コマンドの中核が非型付きになっている。`Effect.ensuring` に置き換えて型を保つ。

### 6.2 フラグの意味を揃える

`-f` が 3 通りの意味を持つ（init は破壊的上書き、pull は確認スキップ、push は `--yes` の別名）。push の `--yes` は確認スキップに加えて未追跡ファイルの追跡選択自体をスキップし、対象から静かに落とす。

- 破壊的操作の承認は `--force`、対話の省略は `--yes` に統一する
- setup に `--dryRun` を追加する（現状ファイル書き込みと PR 作成をプレビューできない）
- `track` が citty をバイパスして `process.argv` を自前パースしているのをやめる
- 引数なし実行のメニューに `track` / `setup` を追加する
- サブコマンド名でも `-` 始まりでもない第 1 引数を init として解釈する挙動により、`ziku pul` のようなタイポが存在しないディレクトリを作る。サブコマンド候補に近い文字列は候補提示して中断する
