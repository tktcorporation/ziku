# File Lifecycle

> このドキュメントは `npm run docs` で自動生成されます。直接編集しないでください。

ziku が管理するファイルと、各コマンドでの振る舞いを整理したドキュメント。

<!-- LIFECYCLE:START -->

## コンポーネント関係図

```mermaid
graph TB

  subgraph Template["Template Repository"]
    ZIKU_TPL[".ziku/ziku.jsonc"]
    T_FILES["synced files"]
  end

  subgraph User["User Project"]
    ZIKU[".ziku/ziku.jsonc"]
    LOCK[".ziku/lock.json"]
    U_FILES["synced files"]
  end

  setup([setup]) -->|create| ZIKU_TPL
  init([init]) -->|read| ZIKU_TPL
  init -->|create| ZIKU & LOCK & U_FILES
  push([push]) -->|read| ZIKU & LOCK
  push -->|update| T_FILES
  pull([pull]) -->|read| ZIKU & LOCK
  pull -->|update| U_FILES & ZIKU & LOCK
  diff([diff]) -.->|read| ZIKU & LOCK & U_FILES
  status([status]) -.->|read| ZIKU & LOCK & U_FILES
  track([track]) -.->|update| ZIKU

```

## ファイルごとのライフサイクル

### `.ziku/ziku.jsonc`

**場所:** 両方（テンプレート + ユーザー）  
**役割:** 同期対象パターン定義（include/exclude）。テンプレートとユーザーで同一フォーマット

| フェーズ | 詳細                                                                               |
| -------- | ---------------------------------------------------------------------------------- |
| 生成     | `ziku setup` でデフォルトパターンを含む初期ファイルをテンプレートに作成            |
| 読み取り | `ziku init` でテンプレートのパターンを読み、ディレクトリ選択 UI のデータとして使用 |
| 生成     | `ziku init` で選択結果をユーザープロジェクトに保存                                 |
| 読み取り | `pull` / `push` / `diff` でパターンを取得                                          |
| 更新     | `ziku track` で新しいパターンを追加                                                |

### `.ziku/lock.json`

**場所:** ユーザープロジェクト  
**役割:** 同期状態 + ソース情報（source, baseRef, baseHashes, pendingMerge）

| フェーズ | 詳細                                                                   |
| -------- | ---------------------------------------------------------------------- |
| 生成     | `ziku init` でソース情報 + テンプレートのコミット SHA とハッシュを記録 |
| 読み取り | `pull` / `push` / `diff` でソースと前回同期状態との差分検出に使用      |
| 更新     | `ziku pull` で最新のベースに更新                                       |

### synced files

**場所:** 両方  
**役割:** パターンに一致する実際のファイル群（.claude/rules/\*.md など）

| フェーズ | 詳細                                                     |
| -------- | -------------------------------------------------------- |
| 生成     | `ziku init` でテンプレートからコピー                     |
| 更新     | `ziku pull` で 3-way マージにより同期                    |
| 更新     | `ziku push` でローカル変更を PR としてテンプレートに送信 |

## コマンドごとのファイル操作

### `setup`

Initialize a template repository

| 操作 | ファイル           | 場所     | 詳細                                                  |
| ---- | ------------------ | -------- | ----------------------------------------------------- |
| 作成 | `.ziku/ziku.jsonc` | template | デフォルト include パターンで生成（既存ならスキップ） |

### `init (user project)`

Initialize user project from template

| 操作     | ファイル           | 場所     | 詳細                                               |
| -------- | ------------------ | -------- | -------------------------------------------------- |
| 読み取り | `.ziku/ziku.jsonc` | template | テンプレートの include パターンを取得              |
| 作成     | `.ziku/ziku.jsonc` | local    | 選択パターンを保存                                 |
| 作成     | `.ziku/lock.json`  | local    | ソース情報 + ベースコミット SHA + ハッシュを記録   |
| 作成     | synced files       | local    | テンプレートからパターンに一致するファイルをコピー |

### `pull`

Pull latest template updates to local project

| 操作     | ファイル           | 場所     | 詳細                                   |
| -------- | ------------------ | -------- | -------------------------------------- |
| 読み取り | `.ziku/ziku.jsonc` | local    | patterns を取得                        |
| 読み取り | `.ziku/lock.json`  | local    | source, baseHashes, baseRef を取得     |
| 読み取り | synced files       | template | テンプレートをダウンロードして差分比較 |
| 更新     | synced files       | local    | 自動更新・新規追加・3-way マージ・削除 |
| 更新     | `.ziku/ziku.jsonc` | local    | テンプレートの新パターンをマージ       |
| 更新     | `.ziku/lock.json`  | local    | 新しい baseHashes, baseRef で上書き    |

### `push`

Push local changes to template (GitHub: PR / local: direct copy)

| 操作     | ファイル           | 場所     | 詳細                                               |
| -------- | ------------------ | -------- | -------------------------------------------------- |
| 読み取り | `.ziku/ziku.jsonc` | local    | patterns を取得                                    |
| 読み取り | `.ziku/lock.json`  | local    | source, baseRef, baseHashes を取得                 |
| 読み取り | synced files       | local    | ローカルの変更を検出                               |
| 読み取り | synced files       | template | テンプレートと差分検出・3-way マージ               |
| 更新     | synced files       | template | GitHub: PR を作成 / ローカル: ファイルを直接コピー |
| 更新     | `.ziku/lock.json`  | local    | baseHashes を更新                                  |

### `diff`

Show differences between local and template

| 操作     | ファイル           | 場所     | 詳細                               |
| -------- | ------------------ | -------- | ---------------------------------- |
| 読み取り | `.ziku/ziku.jsonc` | local    | patterns を取得                    |
| 読み取り | `.ziku/lock.json`  | local    | source を取得                      |
| 読み取り | synced files       | local    | ローカルファイルを読み取り         |
| 読み取り | synced files       | template | テンプレートをダウンロードして比較 |

### `status`

Show pending pull/push counts and recommend next action

| 操作     | ファイル           | 場所     | 詳細                                         |
| -------- | ------------------ | -------- | -------------------------------------------- |
| 読み取り | `.ziku/ziku.jsonc` | local    | patterns を取得                              |
| 読み取り | `.ziku/lock.json`  | local    | baseHashes と pendingMerge を取得            |
| 読み取り | synced files       | local    | ローカルファイルのハッシュを計算             |
| 読み取り | synced files       | template | テンプレートをダウンロードしてハッシュを計算 |

### `track`

Add file patterns to the sync whitelist

| 操作     | ファイル           | 場所  | 詳細                            |
| -------- | ------------------ | ----- | ------------------------------- |
| 読み取り | `.ziku/ziku.jsonc` | local | 現在の include パターンを取得   |
| 更新     | `.ziku/ziku.jsonc` | local | 新しいパターンを include に追加 |

## 補足

### init (user project)

`ziku.jsonc` はテンプレートとユーザープロジェクトの両方に存在する。同一フォーマット（include/exclude パターンのみ）で、source 情報は含まない。

テンプレートの取得元（owner/repo またはローカルパス）は `lock.json` に保存される。これにより `ziku.jsonc` はテンプレート・ユーザー間で完全に同一フォーマットになる。

### pull

テンプレートの `ziku.jsonc` に新しいパターンが追加された場合、pull 時にユーザーの `ziku.jsonc` へ自動マージされる。既存パターンはそのまま維持される。

テンプレートで削除されたファイルは `--force` で自動削除、またはユーザーが選択的に削除できる。

### status

`status` は読み取り専用。ファイルや lock.json を一切変更しない。

`status` は git status と同じく常に exit 0 で終了する（観察コマンドの責務）。CI でゲートしたい場合は将来 `pull --dry-run` や `diff --exit-code` 等の専用コマンドに任せる予定。

### track

`ziku track` で追加したパターンはローカルの `ziku.jsonc` にのみ反映される。テンプレートに反映するには `ziku push` でテンプレートの `ziku.jsonc` を更新する。

<!-- LIFECYCLE:END -->
