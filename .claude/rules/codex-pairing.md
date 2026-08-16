# Codex ペアプロ活用ルール

Codex CLI (`codex`) はセカンドオピニオンを得るためのツール。判断が分かれる場面では Codex に壁打ちする。

## 必ず使う場面（MUST）

- **PR 作成・push 前のレビュー**: `codex review --uncommitted` / `codex review --base <default-branch>`
- **設計方針が2つ以上あり迷う**: `codex exec "2案のトレードオフを分析して: ..."`
- **バグ原因が10分以上特定できない**: `codex exec "このエラーの原因を調査して: ..."`

## 積極的に使う場面（SHOULD）

リファクタ案比較、エッジケース洗い出し、SQL妥当性チェック、既存コード解読

## 使い方

`-c sandbox_mode='"danger-full-access"'` は Codex 側のサンドボックスを無効化する指定で、次節の条件に当てはまる環境でだけ付ける。当てはまらない環境では外して使う。

```bash
codex exec -c sandbox_mode='"danger-full-access"' "プロンプト"                        # 非インタラクティブ実行
codex review -c sandbox_mode='"danger-full-access"' --uncommitted                     # ワークツリーのレビュー
codex exec -c sandbox_mode='"danger-full-access"' "エッジケースを洗い出して" < file   # ファイル渡し

# default branch 差分のレビュー。ブランチ名は origin/HEAD から導出する（worktree.md 参照）
default_branch="$(git symbolic-ref --short refs/remotes/origin/HEAD | sed 's@^origin/@@')"
codex review -c sandbox_mode='"danger-full-access"' --base "$default_branch"
```

### サンドボックスを無効化する条件

kernel が nested user namespace を許可しない環境では、Codex 内蔵の bubblewrap が `bwrap: No permissions to create a new namespace` で exit 1 し、`codex review` の子コマンド（`git status` 等）が全滅する。この症状が出て、かつ実行環境そのものが host から隔離されている（コンテナ・VM の内側にいる）なら、隔離は外側が担っているので Codex 側のサンドボックスは無効化してよい。

どちらか一方でも満たさないなら付けない。症状が出ない環境では Codex のファイルシステム隔離をそのまま使う。

`-c` で config を上書きする方式に統一する理由: `--dangerously-bypass-approvals-and-sandbox` フラグは `codex exec` 限定で、`codex review` には対応フラグが無く `-c` でしか sandbox を切り替えられない。書き分けると writeup と allowlist が増えるので、両サブコマンドで通る `-c sandbox_mode='"danger-full-access"'` に揃える。`approval_policy` は非インタラクティブ実行で default `never` のため省略。

フラグを忘れたときの症状: `codex exec "say hello"` のような子コマンドを spawn しない呼び出しは通るが、`codex review --uncommitted` は exit 1。再現したらフラグの付け忘れを疑う。

**注意**: インタラクティブモード（引数なし `codex`）は使わない。大きなプロンプトは `timeout 120` を付ける。Codex の出力は参考意見、最終判断は自分が行う。
