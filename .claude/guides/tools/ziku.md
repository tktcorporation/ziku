# ziku — `.claude` 設定のテンプレート同期

`npx ziku`（OSS: [`tktcorporation/ziku`](https://github.com/tktcorporation/ziku)）は、リポジトリの `.claude/` 配下の設定（skills / hooks / rules / guides など）を**テンプレートリポジトリ `tktcorporation/.github` と双方向に同期する CLI**。

## なぜ使うのか

複数のリポジトリで同じ Claude Code 設定（共通スキル・hook・rule）を使い回したい。各リポジトリで手コピーするとすぐにズレるため、テンプレートを単一の正本（source of truth）にして `ziku` で配布・取り込みする。

## 設定ファイル

| ファイル           | 役割                                                                      |
| ------------------ | ------------------------------------------------------------------------- |
| `.ziku/ziku.jsonc` | 同期対象の `include` 列挙（と `exclude`）。同期したいファイルはここに載る |
| `.ziku/lock.json`  | base-ref とファイルハッシュ。pull/push のたびに更新される（手で触らない） |

## サブコマンド

| コマンド                   | 動作                                                                       |
| -------------------------- | -------------------------------------------------------------------------- |
| `npx ziku init`            | 初期化（`.ziku/` を作成）                                                  |
| `npx ziku track <path...>` | ファイルを `include` に登録して同期対象にする                              |
| `npx ziku status`          | ローカルとテンプレートの差分を表示                                         |
| `npx ziku pull`            | テンプレート側の更新を取り込む（auto-merge / コンフリクト解決あり）        |
| `npx ziku push`            | track 済みファイルをテンプレートリポジトリへ反映（テンプレ側に PR が立つ） |

## 落とし穴

- **wildcard include は直下のみ**: `.claude/hooks/*.sh` や `.claude/rules/*.md` はサブディレクトリにマッチしない。プロジェクト固有ファイル（テンプレに流したくないもの）は `hooks/project/` `rules/data-analysis/` のようにサブディレクトリへ退避して同期対象から外す。
- **社内固有の呼称をテンプレに流さない**: push するファイルから社内限定の略語・呼称を排除し、架空例に置き換えてから push する（初見レビュアーに通じる状態を保つ）。
- `pull` の auto-merge はローカルの差分を巻き込むことがある。push 前に `status` で差分を確認する。

## 典型ワークフロー

```bash
# 同期対象に追加
npx ziku track .claude/skills/<skill-name>

# テンプレの最新を取り込む
npx ziku pull

# ローカルの変更をテンプレへ反映（PR が立つ）
npx ziku push
```
