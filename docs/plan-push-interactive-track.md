# 設計案: push 時の未追跡ファイル対話フロー（検知 → 選択 → track → push）

> ステータス: 提案（issue 草案 / 未実装）
> スコープ: 提案①のみ。②ディレクトリ単位 track の一級市民化 / ③テンプレ側 CI チェックは「関連・将来作業」として末尾に記載。

## 背景 / 起きた問題

`ziku pull` で新しい skill（`pr-impact-review` / `pr-first-reader-check`）が降りてこない事象が報告された。

調査の結果、原因はテンプレート側 `tktcorporation/.github` の `.ziku/ziku.jsonc` の `include` に新 skill のパスが追記されていなかったこと（skill 本体は追加済みだが `include` が更新漏れ）だった。

この事象は単発のミスではなく、**ziku が `include` ホワイトリスト（`ziku.jsonc`）と実ファイル（ディスク）という 2 つの状態を持ち、両者がズレても誰も突き合わせない**という構造に起因する。今回はその drift が「テンプレート側」で顕在化した版である。

そして**ローカル側でも同じ drift が放置されている**。`ziku push` は監視フォルダ内の未追跡ファイルを検知しているにもかかわらず、`log.info` で素通りさせるだけで push 対象に含めない（後述）。ユーザーの期待は「push 時に未追跡を検知したら track に誘導し、`include` と追跡対象を揃えてから push する」だが、現状そうなっていない。

## 提案①の射程（重要な限界 — レビュー M1 反映）

提案①が塞ぐのは **ローカル側 drift**であり、**冒頭の主問題（テンプレ側 `include` 漏れ）を単独では塞がない**。両者を混同しないこと。

- push される対象は `pushableFiles`（= `include` にマッチする SYNCED_FILES）から作られる（`push.ts:468-473`）。`.ziku/ziku.jsonc` 自体がテンプレートへ反映されるのは**それが `include` にマッチする場合だけ**で、通常 `.ziku/` は自己追跡しない（`generateZikuJsonc` は `$schema`/`include`/`exclude` のみ生成）。
- したがって提案①で「同一 push でテンプレートへ反映される」のは**新規ファイルの本体**だけ。**テンプレ側 `ziku.jsonc` の `include` 更新は送られない**。
- 結果、テンプレ側にファイル本体が届いても `include` が未カバーなら、他プロジェクトの `pull` は依然それを取得できない（= 冒頭の skill バグはそのまま）。

→ **冒頭の主問題の真の再発防止は提案②（ディレクトリ glob で最初から追跡）＋③（テンプレ側 CI チェック）側にある。** 提案①の価値は「ローカルで生まれた新規ファイルを取りこぼさず追跡＆テンプレへ送り込む UX」に限定される。この非対称性を受け入れ条件にも明記する。

## 現状の実装

### push の未追跡ファイル処理（素通り）

`src/commands/push.ts:427-433`

```ts
if (!args.yes) {
  const untrackedByFolder = await detectUntrackedFiles({ targetDir, patterns });
  if (untrackedByFolder.length > 0) {
    const untrackedCount = untrackedByFolder.reduce((sum, f) => sum + f.files.length, 0);
    log.info(`${untrackedCount} untracked file(s) detected (not included in push)`);
  }
}
```

- 検知（`detectUntrackedFiles`）までは実装済み。**警告ログを出すだけで、track もしないし push 対象にも含めない。**
- `--yes`（非対話）時はこのブロックごとスキップされ、**警告すら出ない。**

### 既存の再利用可能な部品

| 部品                                            | 場所                                               | 役割                                                                                                     |
| ----------------------------------------------- | -------------------------------------------------- | -------------------------------------------------------------------------------------------------------- |
| `detectUntrackedFiles({ targetDir, patterns })` | `src/utils/untracked.ts:114`                       | ホワイトリスト外ファイルをフォルダ単位で検出。`.gitignore` も考慮済み。戻り値 `UntrackedFilesByFolder[]` |
| `getTotalUntrackedCount`                        | `src/utils/untracked.ts:187`                       | 未追跡ファイル総数                                                                                       |
| `addIncludePattern(rawContent, patterns)`       | `src/utils/ziku-config.ts`（`track.ts:92` で使用） | JSONC を解析し `include` にパターンを追記。重複はスキップ                                                |
| `saveZikuConfig(targetDir, content)`            | 同上（`track.ts:99`）                              | `ziku.jsonc` を保存                                                                                      |
| `logUntrackedFiles` + track 例の提示            | `src/commands/diff.ts:125-139`                     | 未追跡一覧と `npx ziku track "..."` の案内表示（流用可能）                                               |
| `@clack/prompts` ラッパー                       | `src/ui/renderer.ts`                               | `p.multiselect` / `p.confirm` 等の対話 UI                                                                |

## 前例調査（プラクティス）

| ツール         | 管理ディレクトリ内の新規ファイルの扱い                                                                                                                           | 示唆                                                                     |
| -------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------ |
| git            | 自動追加は決してしない。`git add -i` で番号選択して untracked を明示ステージ                                                                                     | 暗黙追加は避ける。ただし**選択 UI は提供する**（explicit over implicit） |
| chezmoi        | `re-add` は新規ファイルを拾わない。ディレクトリに `--exact` を付けると配下の追加/削除が自動同期（[issue #2298](https://github.com/twpayne/chezmoi/issues/2298)） | ファイル単位の明示とディレクトリ単位の自動を使い分ける                   |
| copier / cruft | テンプレートに増えた新ファイルは update で降りてこない（[cruft #67](https://github.com/cruft/cruft/issues/67)）                                                  | ziku と同じ欠落。業界的に既知の弱点                                      |

結論: **「黙って auto-include」は git 哲学に反する。落とし所は「検知 → 選ばせる → 選択を `include` に永続化 → push」**。ユーザーの直感（push 時に track へ誘導）は git interactive add / chezmoi `--exact` に裏打ちされている。

## 提案する設計（提案①）

`ziku push` の未追跡ファイル処理を、警告ログから**対話フロー**に置き換える。

### 対話モード（`--yes` なし）のフロー

> **重要（レビュー C1 反映）**: 未追跡の検知・選択・追記は、現状 `push.ts:391-425` にある「`hashFiles` → `classifyFiles` → `pushableFilePaths` 構築 → `resolveConflicts`」ブロック**より前**に置く必要がある。`patterns` を再読込するだけでは push 対象に乗らない（`pushableFiles` は `pushableFilePaths.has(f.path)` でフィルタされるため、`push.ts:441-445`）。下記の順序を厳守する。

1. `detectUntrackedFiles` で未追跡ファイルを検知（既存）。0 件なら何もしない（現状どおり）。
2. 1 件以上あれば、フォルダ単位で一覧を提示し、`p.multiselect` で**追加対象を選択**させる（git add -i 相当の体験）。
   - デフォルト選択は「なし」（明示的に選ばせる）。
   - キャンセル/全解除なら従来どおり「除外して push」。
3. 選択があれば、追記パターンを**メモリ上の `include` にマージ**して `patterns` を再構築する（永続化は後述の順序制約に従い push 成功後）。
4. 再構築した `patterns` で、以下を**再計算**する（`patterns` 差し替えだけでは不十分）:
   - `hashFiles`（template / local）の再計算（`push.ts:394-395`）
   - `classifyFiles` 再実行 → `pushableFilePaths` の再構築（`push.ts:397-405`）。新規追跡ファイルは定義上 `classification.localOnly` に入るため、ここで `pushableFilePaths` に投入されることが必須。
   - 追記ファイルがテンプレートと衝突しうる場合は `resolveConflicts` も対象に含める（`push.ts:416-424`）
5. 以降は既存の push フロー（`detectDiff` → `pushableFiles` フィルタ、`push.ts:437-445`）へ。

実装上は、1〜2（検知・選択）を 391 行ブロックの手前に挿入し、選択結果を `config.include` にマージしてから既存の 391-445 相当を回す形にするのが素直。あるいは「追記があった場合のみ 391-445 相当を関数化して二度目を回す」でもよいが、二度計算のコストと複雑さを踏まえると前者（手前挿入）を推奨。

### 非対話モード（`--yes` / CI）の挙動 ← 決定済み: **「追加せず明示通知」**

- 未追跡ファイルは**追加しない**（安全側 = explicit over implicit / git 哲学準拠）。
  - 実務的根拠（レビュー m2 反映）: `--yes` は CI が PR を自動生成する経路で使われる。ここで未追跡を自動 include すると、**レビューされない設定変更（`include` の自動膨張）が PR に混入**する。設定の変更は人間の明示操作（`ziku track`）に限定すべき。
- ただし `--yes` 時でも**必ず明示通知**する（現状は警告すら出ない問題を解消）。
  - 例: `N untracked file(s) were excluded from this push. Run \`ziku track "<pattern>"\` to include them.`
  - `diff.ts` の `logUntrackedFiles`（track 例つき）を流用し、対話モード/非対話モード共通の通知関数に整理する。
- 通知の有無は終了コードに影響させない（push 自体は成功扱い）。

### パターン粒度の論点（実装時に確定）

選択ファイルを `include` に追記する際の表現:

- **個別ファイルパス**で追記（例: `.claude/skills/foo/SKILL.md`）— 確実だが、また同じフォルダに新ファイルが増えると再度未追跡になる。
- **ディレクトリ glob** に丸める（例: `.claude/skills/**`）— 配下の新ファイルが自動で追跡対象になり drift が再発しない。提案②と地続き。

→ 当面は「**選択されたファイルが属するフォルダを glob で提案しつつ、ユーザーが個別/フォルダを選べる**」二段構えを推奨（git の hunk 選択に近い柔軟性）。最小実装では個別パス追記から始めてもよい。

> **注意（レビュー m3 反映）**: `addIncludePattern` の重複判定は**文字列完全一致のみ**（`ziku-config.ts:66` の `existing.includes(p)`）。`.claude/skills/**` を追記する際、既に `.claude/skills/foo/SKILL.md` が個別追跡されていても重複検出されず両方が併存する（実害は小さいが冗長）。glob 提案時に「より広いパターンが既存の個別パターンを包含する場合の整理（個別パターンの除去 or 提案抑止）」を実装方針に含める。

## 影響範囲

- `src/commands/push.ts` — 未追跡の検知・選択・追記を **`push.ts:391` ブロックの手前**に挿入し、選択結果を `config.include` にマージしてから `hashFiles`/`classifyFiles`/`pushableFilePaths`/`detectDiff` を回す（C1）。現状の `push.ts:427-433` の警告ブロックは廃止/移動。
- `src/utils/untracked.ts` — 必要なら「フォルダ→glob 提案」ヘルパーを追加。
- `src/commands/diff.ts:124-142` の `logUntrackedFiles` — **現状は `diff.ts` 内のローカル関数で未 export**。共通通知関数として `untracked.ts` 等へ移動し export 化してから push/diff 双方で利用（m1）。
- `src/utils/ziku-config.ts` の `addIncludePattern` / `saveZikuConfig` — 既存 API を流用（変更不要の見込み）。ただし重複判定は完全一致のみ（m3）。
- UI: push の選択 UI は `src/ui/prompts.ts` の既存 `selectPushFiles` 系（`push.ts:24, 531`）が前例として最も近い。これに倣い `p.multiselect`（`src/ui/renderer.ts` 経由）で実装する（m1）。

## エッジケース

- 未追跡 0 件 → 従来どおり無処理。
- 全部選択解除/キャンセル → 何も追記せず push 続行（除外通知あり）。
- `addIncludePattern` が重複でノーオペ（既に同パターンが存在）→ 追記スキップ、push 対象判定は実ファイルベースで継続。
- `.gitignore` 対象ファイル → `detectUntrackedFiles` が既に除外済み。
- 追記したが diff に変化が出ない（テンプレ側と同一内容）→ `pushableFiles.length === 0` の既存分岐に乗る。
- **追記の永続化と push の順序（レビュー M2 反映）**: `resolveConflicts` は未解決衝突で `ZikuFailure` を throw して push 全体を中断する（`push.ts:616-630`）。また `pushToGitHub`/`pushToLocal` も失敗しうる（`push.ts:150, 220`）。「先に `ziku.jsonc` を書き込み → 後で push 失敗」だと **`ziku.jsonc` だけ追記された状態が残り**、「暗黙の部分適用を避ける」意図と矛盾する。対策として **`include` のマージはメモリ上で行い再計算に使い、`saveZikuConfig` による永続化は push 成功後に実行する**（失敗時はファイルを書き換えない）。これにより C1 の「同一 push に乗せる（メモリ上の patterns で計算）」と M2 の「失敗時に副作用を残さない」を両立する。
- `ziku.jsonc` 書き込み失敗（push 成功後の永続化段階）→ Effect のエラー型で扱い、ユーザーに「ファイルはテンプレートへ push 済みだが `ziku.jsonc` 追記に失敗。`ziku track` で手動追加を」と案内（部分適用を明示）。
- **pendingMerge 中の push（レビュー m4 反映）**: `push.ts:365-372` の pendingMerge ブロックが前段で early-throw するため、未追跡フローには到達しない。既存の中断が優先され、本フローと衝突しない。

## テスト方針

- `src/commands/__tests__/push.test.ts` に追加:
  - 対話モードで選択 → `include` 追記 → push 対象に乗る。**`pushableFiles` に新規ファイルが含まれること**を assert（C1: `pushableFilePaths` 再構築の検証）。
  - 対話モードで未選択 → 追記なし・除外通知あり・push 続行。
  - **push 失敗時（`resolveConflicts` throw / push 失敗をモック）に `saveZikuConfig` が呼ばれない**こと（M2: 部分適用なしの検証）。
  - push 成功時にのみ `ziku.jsonc` が永続化されること（M2）。
  - `--yes` モード → 追記なし・**除外通知が出る**（現状は出ない退行を防ぐ回帰テスト）。
- `detectUntrackedFiles` / `getTotalUntrackedCount` は既存テスト（`src/utils/__tests__/untracked.test.ts`）を維持。
- `@clack/prompts` はモックして選択結果を注入。

## 受け入れ条件

- [ ] 対話 push で未追跡を検知すると選択プロンプトが出る。
- [ ] 選択したファイルが（push 成功後に）ローカル `ziku.jsonc` の `include` に追記され、その**本体**が同一 push でテンプレートへ反映される。
- [ ] 追記によって `pushableFilePaths` が再構築され、新規ファイルが push 対象に乗る（`patterns` 差し替えのみで終わらせない / C1）。
- [ ] push 失敗時にローカル `ziku.jsonc` が書き換わらない（部分適用なし / M2）。
- [ ] `--yes` push でも未追跡があれば除外通知（track 案内つき）が出る。
- [ ] 既存の push/pull/diff/status の挙動に回帰がない（lint / test / build green）。
- [ ] **非対象として明記**: テンプレ側 `ziku.jsonc` の `include` 自動更新は本スコープ外（M1）。冒頭 skill バグの再発防止は②③で別途対応。

## 関連・将来作業（本スコープ外）

- **提案②: ディレクトリ単位 track の一級市民化**（chezmoi `--exact` 相当）。`ziku track ".claude/skills/**"` を推奨パターンとして打ち出し、配下の新ファイルを自動追跡。今回の skill バグの真の再発防止。
- **提案③: テンプレ側 CI チェック**。`tktcorporation/.github` に「`include` 未カバーのファイルがあれば fail」する軽量チェックを追加し、設定漏れを構造的に検出（`status` のロジック流用）。

## 参考

- git interactive staging: https://git-scm.com/book/en/v2/Git-Tools-Interactive-Staging
- chezmoi `add` / ディレクトリ exact: https://www.chezmoi.io/reference/commands/add/ , https://github.com/twpayne/chezmoi/issues/2298
- cruft 新ファイル未反映: https://github.com/cruft/cruft/issues/67
