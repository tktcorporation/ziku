# @tktco/ziku

## 0.26.1

### Patch Changes

- [#19](https://github.com/tktcorporation/ziku/pull/19) [`b8726ea`](https://github.com/tktcorporation/ziku/commit/b8726ea7fb65fbd4e80b0f5aa211707c2542cbbf) Thanks [@tktcorporation](https://github.com/tktcorporation)! - Fix release workflow npm upgrade, add ast-grep try/catch lint rule, resolve oxlint warnings

## 0.26.0

### Minor Changes

- [#17](https://github.com/tktcorporation/ziku/pull/17) [`357c8e4`](https://github.com/tktcorporation/ziku/commit/357c8e461379e4112c31bac4a739179df0655d78) Thanks [@tktcorporation](https://github.com/tktcorporation)! - Reorganize config files: split `.ziku.json` into `.ziku/ziku.jsonc` (user config) and `.ziku/lock.json` (sync state)

  - User settings (source, include/exclude patterns) are now in `.ziku/ziku.jsonc` with JSONC support
  - Machine state (version, baseRef, baseHashes, pendingMerge) is now in `.ziku/lock.json`
  - Fix oxlint config not being auto-detected (rename to `.oxlintrc.json`)
  - Add strict TypeScript lint rules (no-unsafe-type-assertion, no-unsafe-argument, etc.)

- [#13](https://github.com/tktcorporation/ziku/pull/13) [`fc73f2f`](https://github.com/tktcorporation/ziku/commit/fc73f2fb92fbf3c364d30b275ae33ec2739ee483) Thanks [@tktcorporation](https://github.com/tktcorporation)! - Improve template source detection for `ziku init`

  - Detect template candidates from both authenticated GitHub user and git remote owner
  - Interactive mode presents candidates for selection when multiple are found
  - `--from` now accepts owner name only (e.g., `--from my-org`) and auto-completes to `{owner}/.github`
  - Non-interactive mode (`--yes`) auto-uses a single candidate, errors with disambiguation hint when multiple found

- [#15](https://github.com/tktcorporation/ziku/pull/15) [`ba32fee`](https://github.com/tktcorporation/ziku/commit/ba32fee60a9b4aba04bf88e181bd2a75e90d4617) Thanks [@tktcorporation](https://github.com/tktcorporation)! - Support `.ziku` as template repository name in addition to `.github`

  - Template auto-detection now checks both `.ziku` and `.github` repositories (`.ziku` preferred)
  - `--from owner` resolves to the first existing repo among `.ziku` / `.github`
  - Setup-aware candidate selection: repos with `.ziku/modules.jsonc` are prioritized
  - Interactive UI shows `(ready)` / `(not set up)` hints for each candidate

## 0.25.0

### Minor Changes

- [#8](https://github.com/tktcorporation/ziku/pull/8) [`1e10b40`](https://github.com/tktcorporation/ziku/commit/1e10b4044d3df652a4a63fd4269312f0dbbaff22) Thanks [@tktcorporation](https://github.com/tktcorporation)! - Support running `ziku init` inside a template repository to generate `.ziku/modules.jsonc` locally with interactive module preset selection

- [#11](https://github.com/tktcorporation/ziku/pull/11) [`5e831ea`](https://github.com/tktcorporation/ziku/commit/5e831ea73e960f9b13b45582244d2400496788a5) Thanks [@tktcorporation](https://github.com/tktcorporation)! - Effect TS / ts-pattern / 厳格 oxlint ルールの導入。ユーティリティ層の try/catch を Effect パターンに置換し、全 switch 文を ts-pattern の exhaustive match に変更。

- [#10](https://github.com/tktcorporation/ziku/pull/10) [`d611f4a`](https://github.com/tktcorporation/ziku/commit/d611f4afd1511e03b378aba5c533608d6bc9a923) Thanks [@tktcorporation](https://github.com/tktcorporation)! - Refactor modules.jsonc to flat include/exclude format for local repos, keeping grouped format for template repos

## 0.24.0

### Minor Changes

- [#5](https://github.com/tktcorporation/ziku/pull/5) [`163789e`](https://github.com/tktcorporation/ziku/commit/163789e37a454b5b6e927a09347b1d39319511b6) Thanks [@tktcorporation](https://github.com/tktcorporation)! - Rename .devenv / devenv to .ziku / ziku throughout the codebase

### Patch Changes

- [#6](https://github.com/tktcorporation/ziku/pull/6) [`4814d9f`](https://github.com/tktcorporation/ziku/commit/4814d9fac0d7f0cd5e60ef3f4d21500de6a4f138) Thanks [@tktcorporation](https://github.com/tktcorporation)! - Add auto-generated Getting Started guide to README and generate JSON Schema for modules.jsonc from Zod schema

## 0.23.0

### Minor Changes

- [#2](https://github.com/tktcorporation/ziku/pull/2) [`e4ee35b`](https://github.com/tktcorporation/ziku/commit/e4ee35baf2aa9294faafbbc537bdcf1a00eece53) Thanks [@tktcorporation](https://github.com/tktcorporation)! - Improve setup UX when template repository is missing or lacks `.devenv` configuration.

  - Check template repo existence before downloading, with interactive recovery options
  - When template repo not found: prompt to create it or specify another source
  - When template has no `.devenv/modules.jsonc`: offer to scaffold via PR or use built-in defaults
  - Remove hardcoded default template fallback (`tktcorporation/.github`)
  - Non-interactive mode errors clearly instead of silently falling back

- [#1](https://github.com/tktcorporation/ziku/pull/1) [`aa192c9`](https://github.com/tktcorporation/ziku/commit/aa192c99a0c749189c9785a910db8f67a9cd357d) Thanks [@tktcorporation](https://github.com/tktcorporation)! - Remove `push --prepare` and `--execute` manifest workflow. Use `push --files` with `--yes` for non-interactive push instead.

- [#4](https://github.com/tktcorporation/ziku/pull/4) [`bf72668`](https://github.com/tktcorporation/ziku/commit/bf7266802352b9e73c10a5cac352f76e7566334d) Thanks [@tktcorporation](https://github.com/tktcorporation)! - Remove `ai-docs` command in favor of built-in `--help` flags. Each interactive command now shows non-interactive usage hints automatically.

## 0.22.6

### Patch Changes

- [#174](https://github.com/tktcorporation/.github/pull/174) [`5f465cf`](https://github.com/tktcorporation/.github/commit/5f465cf801858841de3544af24c86f54f6843432) Thanks [@tktcorporation](https://github.com/tktcorporation)! - fix: pull のオートマージが base ダウンロード時にテンプレートを上書きしてマージが空振りするバグを修正

  downloadTemplateToTemp が常に同じ一時ディレクトリ (.ziku-temp) を使用していたため、
  base バージョンのダウンロード時に先にダウンロードしたテンプレートを上書きしていた。
  これにより base === template となり、パッチが空になってローカルファイルが変更されずに
  「Auto-merged」と表示される問題が発生していた。

  label 引数を追加し、base ダウンロード時に別ディレクトリ (.ziku-temp-base) を使用するよう修正。
  合わせて merge.ts を merge/ ディレクトリに分割してリファクタリング。

## 0.22.5

### Patch Changes

- [#172](https://github.com/tktcorporation/.github/pull/172) [`e5e0ef7`](https://github.com/tktcorporation/.github/commit/e5e0ef7cdb3e145771c9fce7b6f79ffcb7dd85aa) Thanks [@tktcorporation](https://github.com/tktcorporation)! - fix: 構造マージが検出した conflict を fuzz がサイレントに auto-merge する問題を修正

  JSON/TOML/YAML の構造マージがキーレベルで conflict を検出した場合、
  テキストマージの fuzz factor をスキップするようにした。

  これにより、配列の異なる要素追加や同じキーの異なる値変更など
  構造レベルの conflict が検出された場合、必ずコンフリクトマーカーが
  生成されるようになる。

## 0.22.4

### Patch Changes

- [#170](https://github.com/tktcorporation/.github/pull/170) [`bc9f6eb`](https://github.com/tktcorporation/.github/commit/bc9f6eb599de0476f559857570ee040ca21329ee) Thanks [@tktcorporation](https://github.com/tktcorporation)! - fix: JSONC コメント/フォーマットのみの変更がテンプレートにある場合に、構造マージからテキストマージへフォールバックする

  JSON 構造マージはパースされた値のみ比較するため、JSONC コメントやフォーマットの変更を検出できなかった。
  結果としてマージ結果がローカルと同一になり、テンプレートの変更が反映されないまま baseRef が更新されていた。
  構造マージ結果がローカルと同一の場合はテキストマージにフォールバックし、コメント/フォーマット差分を
  コンフリクトマーカーで可視化するように修正。

  また、テキストマージ後の構造検証に JSON/JSONC ファイルを追加し、fuzz 適用後に壊れた JSON が
  生成された場合もコンフリクトマーカーにフォールバックするようにした。

## 0.22.3

### Patch Changes

- [#166](https://github.com/tktcorporation/.github/pull/166) [`eab9508`](https://github.com/tktcorporation/.github/commit/eab9508e9cd335d4bebc2eed465c862564877fd0) Thanks [@tktcorporation](https://github.com/tktcorporation)! - fix: 差分行数の計算を unified diff ベースに修正

  push サマリーの行数表示が実際の変更量と大きくズレる問題を修正。
  "modified" ファイルで行数の差（local - template）を表示していたのを、
  unified diff の実際の変更行数に修正。
  また "added"/"deleted" で末尾改行による off-by-one エラーも修正。

## 0.22.2

### Patch Changes

- [#160](https://github.com/tktcorporation/.github/pull/160) [`c164820`](https://github.com/tktcorporation/.github/commit/c164820b23a19584a423471c1cf14f560ece071f) Thanks [@tktcorporation](https://github.com/tktcorporation)! - 構造マージ（JSON/TOML/YAML）でコンフリクト時にローカル値をサイレントに保持していた問題を修正。コンフリクトがある場合はテキストマージにフォールバックし、コンフリクトマーカー（<<<<<<< LOCAL / ======= / >>>>>>> TEMPLATE）を挿入してユーザーに手動解決を強制する。

## 0.22.1

### Patch Changes

- [#155](https://github.com/tktcorporation/.github/pull/155) [`2592ee9`](https://github.com/tktcorporation/.github/commit/2592ee9e6d821a6279e0595ea1a8bd0b4990d58f) Thanks [@tktcorporation](https://github.com/tktcorporation)! - giget キャッシュディレクトリに書き込み権限がない環境（Codespaces 等）で EACCES エラーが発生する問題を修正

## 0.22.0

### Minor Changes

- [#152](https://github.com/tktcorporation/.github/pull/152) [`7b6c868`](https://github.com/tktcorporation/.github/commit/7b6c868383127efe590ff485397ce147b2d8a21b) Thanks [@tktcorporation](https://github.com/tktcorporation)! - TOML/YAML ファイルの構造マージと post-merge バリデーションを追加
  - TOML ファイル (.toml) のキーレベル構造マージを追加。`[tools]` セクション重複等の破損を防止
  - YAML ファイル (.yml/.yaml) のキーレベル構造マージを追加
  - テキストマージ後に構造ファイルのパース検証を追加。fuzz patch が「成功」しても壊れた出力を生成した場合、コンフリクトマーカーにフォールバック

## 0.21.3

### Patch Changes

- [#149](https://github.com/tktcorporation/.github/pull/149) [`503b659`](https://github.com/tktcorporation/.github/commit/503b6599b3cc659cdd4c9d3f17b4d4d0945de8dd) Thanks [@tktcorporation](https://github.com/tktcorporation)! - fix: push の 3-way マージで local/template 引数が逆転していたバグを修正

  `ziku push` の automerge 時に `threeWayMerge` の `local` と `template` 引数が
  逆に渡されていたため、ユーザーの JSONC コメントやフォーマットが失われ、
  コンフリクト時にテンプレート側の値が優先される問題を修正。

  上流修正として `threeWayMerge` を named parameters + Zod branded types に変更し、
  同じ種類の取り違えをコンパイル時に検出できるようにした。

  また、`check` スクリプトに `typecheck`（oxlint --type-check）を追加し、
  ローカルの全チェック実行で型チェックも漏れなく実行されるようにした。

## 0.21.2

### Patch Changes

- [#143](https://github.com/tktcorporation/.github/pull/143) [`049c7f4`](https://github.com/tktcorporation/.github/commit/049c7f462ed38d4bc5bbc7a7d18b1f82cd4177fe) Thanks [@tktcorporation](https://github.com/tktcorporation)! - fix: push のファイル選定を classifyFiles 駆動に統一し、テンプレート変更のリバートを構造的に防止
  - push のデータフローを pull と統一: classifyFiles の結果を一次情報として pushable files を決定
  - localOnly + conflicts のみを push 対象とし、autoUpdate/newFiles/deletedFiles を構造的に除外
  - detectDiff はコンテンツ提供と表示目的のみに限定
  - baseHashes がない場合でも空 {} で classifyFiles を実行し、全差異を conflicts として扱う

## 0.21.1

### Patch Changes

- [#140](https://github.com/tktcorporation/.github/pull/140) [`e0c0923`](https://github.com/tktcorporation/.github/commit/e0c09236d373a0714dcac3ab677de6f838c70043) Thanks [@tktcorporation](https://github.com/tktcorporation)! - Show "Auto-merged" success message when conflict files are resolved by 3-way merge

## 0.21.0

### Minor Changes

- [#133](https://github.com/tktcorporation/.github/pull/133) [`5d155c6`](https://github.com/tktcorporation/.github/commit/5d155c664ca4c815faf1e63f30ee75dbc17831ca) Thanks [@tktcorporation](https://github.com/tktcorporation)! - パッケージ名を `ziku` に変更し、`npx ziku` で直接呼び出せるようにした。
  `@tktco/ziku` は後方互換のためのラッパーとして維持。

## 0.20.0

### Minor Changes

- [#129](https://github.com/tktcorporation/.github/pull/129) [`3e680ca`](https://github.com/tktcorporation/.github/commit/3e680caa93a4605eadeb79c1bea242ab91b020a7) Thanks [@tktcorporation](https://github.com/tktcorporation)! - push コマンドから `--select` / `--no-select` オプションを削除。ファイル選択は常にインタラクティブに行われるようになり、非インタラクティブなファイル指定には `--files` オプションを使用する設計に変更。

## 0.19.0

### Minor Changes

- [#123](https://github.com/tktcorporation/.github/pull/123) [`b014816`](https://github.com/tktcorporation/.github/commit/b014816f0a74f301a5c1a3034f2e98cf81863b0e) Thanks [@tktcorporation](https://github.com/tktcorporation)! - `ziku push` に `--files` フラグを追加。カンマ区切りでファイルパスを指定し、ノンインタラクティブに特定ファイルのみをプッシュ可能に。AI エージェントが `--no-select --yes` で全差分をプッシュしてしまう問題を解決。

## 0.18.0

### Minor Changes

- [#113](https://github.com/tktcorporation/.github/pull/113) [`bb05918`](https://github.com/tktcorporation/.github/commit/bb05918003084fedeb6c0806531077f53fc5ea0a) Thanks [@tktcorporation](https://github.com/tktcorporation)! - push で --select をデフォルトの動作に変更。ファイル選択プロンプトがデフォルトで表示されるようになり、意図しないファイルの push を防止。従来の動作は --no-select で利用可能。

## 0.17.2

### Patch Changes

- [#110](https://github.com/tktcorporation/.github/pull/110) [`0154ead`](https://github.com/tktcorporation/.github/commit/0154ead9176bae8e2494db67bdf67c1f465b0292) Thanks [@tktcorporation](https://github.com/tktcorporation)! - Improve `ziku push` UX to feel more like `git push`

  - Show git-style "To owner/repo → branch" header with file stats (`+N -M`) in push summary
  - Highlight commit hash (baseRef) in conflict warnings so users know exactly which version conflicts with
  - Post-push success output now shows branch name and PR number in git-push format
  - `--select` mode shows line-count hints (`+N -M`) alongside each file in the multiselect
  - Unresolved conflict messages now include a clear hint to run `ziku pull`

- [#110](https://github.com/tktcorporation/.github/pull/110) [`85d2c87`](https://github.com/tktcorporation/.github/commit/85d2c87ef1e01091c5e4936f1e5052f4c7c76ab7) Thanks [@tktcorporation](https://github.com/tktcorporation)! - refactor(pull): upstream fixes — remove duplicate conflict logic and type workarounds
  - Use `hasConflictMarkers()` from merge.ts in `runContinue` instead of raw `includes("<<<<<<<")`.
    Previously the check was incomplete (missing `=======` / `>>>>>>>` detection) and duplicated
    existing utility logic.
  - Collapse the `base あり/なし` branch in Step 8 into a single code path using `""` as the
    default base. The only difference was the first argument to `threeWayMerge`; the conflict
    logging was identical copypaste.
  - Extract `logMergeConflict()` helper so conflict reporting is defined once.
  - Change `getInstalledModulePatterns` parameter type from `{ excludePatterns?: string[] }` to
    `DevEnvConfig`, removing the `config as any` cast.
  - Remove unused `getPatternsByModuleIds` import.

## 0.17.1

### Patch Changes

- [#108](https://github.com/tktcorporation/.github/pull/108) [`d651a74`](https://github.com/tktcorporation/.github/commit/d651a749420e745b2238d0776af722e7a869ce9e) Thanks [@tktcorporation](https://github.com/tktcorporation)! - Fix diff --verbose (now shows unified diff), pull deleted file selection prompt, track --list without patterns, and rename push --force to --yes (-f kept as alias)

## 0.17.0

### Minor Changes

- [#106](https://github.com/tktcorporation/.github/pull/106) [`885c8ae`](https://github.com/tktcorporation/.github/commit/885c8ae8d19c3ebee7e90705cd42ab3eff8726b7) Thanks [@tktcorporation](https://github.com/tktcorporation)! - push: 確認前に差分プレビューを表示 & Ctrl+C 時の一時ディレクトリクリーンアップ
  - Push summary の後、"Create PR?" の前にファイルごとの unified diff を表示するようにした。変更内容を確認してから判断できる。
  - Ctrl+C (process.exit) で終了した場合に .ziku-temp が残る問題を修正。process.on('exit') で同期クリーンアップを登録。

## 0.16.0

### Minor Changes

- [#104](https://github.com/tktcorporation/.github/pull/104) [`b2d9152`](https://github.com/tktcorporation/.github/commit/b2d9152e95a1a44edc20cd67a0971ab875a77976) Thanks [@tktcorporation](https://github.com/tktcorporation)! - pull コンフリクト解決を大幅改善
  - JSON/JSONC ファイルの構造マージ: キーレベルで deep merge し、ファイルを壊すコンフリクトマーカーの代わりに有効な JSON を出力。コンフリクトがあるキーはローカル値を保持しつつ、どのキーを確認すべきかを明示
  - テキストマージの精度向上: fuzz factor によるパッチ適用リトライと、ファイル全体ではなく hunk 単位のコンフリクトマーカーで影響範囲を最小化
  - .mcp.json, .claude/settings.json, .devcontainer/devcontainer.json 等の構造ファイルが pull 時に壊れなくなる

## 0.15.0

### Minor Changes

- [#101](https://github.com/tktcorporation/.github/pull/101) [`451a091`](https://github.com/tktcorporation/.github/commit/451a091336c2359c26c72b8cdcdf594c4505398d) Thanks [@tktcorporation](https://github.com/tktcorporation)! - Improve push UX and add 3-way merge for conflict resolution
  - PR title and body are now auto-generated from changed files (no prompt by default)
  - Use `--edit` to interactively edit title/body, or `-m` to set title directly
  - File selection is skipped by default (all files included). Use `--select` to pick files
  - Summary is displayed before PR creation with a single confirmation prompt
  - init/pull now store `baseRef` (commit SHA) in `.ziku.json` for 3-way merge
  - push/pull conflicts are resolved via 3-way merge using `baseRef` to re-download the base template
  - Auto-merge succeeds silently; unresolvable conflicts prompt the user for confirmation

## 0.14.0

### Minor Changes

- [#98](https://github.com/tktcorporation/.github/pull/98) [`1c04012`](https://github.com/tktcorporation/.github/commit/1c0401254f57691c852fbea2c1d6f84ad0546a21) Thanks [@tktcorporation](https://github.com/tktcorporation)! - feat(ziku): add `ziku pull` command with 3-way merge engine

  テンプレートの最新変更をローカルに取り込む `ziku pull` コマンドを追加。
  3-way マージエンジンにより、ローカルの変更を保持しつつテンプレート更新を適用する。
  コンフリクト時はマーカーを挿入し、ユーザーが手動解決できる。

  - 新規: `ziku pull` コマンド
  - 新規: 3-way マージエンジン (`utils/merge.ts`)
  - 新規: ファイルハッシュユーティリティ (`utils/hash.ts`)
  - 改善: `ziku init` が baseHashes を `.ziku.json` に記録
  - 改善: `ziku push` がテンプレート側の変更を検出し pull を促す
  - 改善: DevEnvConfig スキーマに `baseRef` / `baseHashes` を追加

- [#98](https://github.com/tktcorporation/.github/pull/98) [`3421f14`](https://github.com/tktcorporation/.github/commit/3421f147d32668920665607f83c13916f897da6a) Thanks [@tktcorporation](https://github.com/tktcorporation)! - UX 改善: コマンドがコンテキストに応じたスマートなデフォルトを提案するように
  - init: 上書き戦略にスマートデフォルト（新規 →overwrite, 再実行 →skip）
  - push: 変更内容から PR タイトル・本文を自動生成してデフォルト表示
  - push: `gh auth token` からトークンを自動取得（環境変数不要に）
  - push: ファイル選択後の確認プロンプトのデフォルトを Yes に変更

## 0.13.0

### Minor Changes

- [#96](https://github.com/tktcorporation/.github/pull/96) [`83a133d`](https://github.com/tktcorporation/.github/commit/83a133daa962bdfa8a3963bccf38b6c5328f7a78) Thanks [@tktcorporation](https://github.com/tktcorporation)! - Redesign CLI with @clack/prompts and unified error handling
  - Replace @inquirer/prompts + nanospinner with @clack/prompts for consistent UI
  - Introduce BermError for structured error handling with optional hints
  - Add unified UI layer (renderer, prompts, diff-view modules)
  - Remove old prompt and UI utility files

## 0.12.0

### Minor Changes

- [#92](https://github.com/tktcorporation/.github/pull/92) [`a1d859e`](https://github.com/tktcorporation/.github/commit/a1d859e00650fa16237c4315f3a30fba6d976cec) Thanks [@tktcorporation](https://github.com/tktcorporation)! - feat: add --from flag to init command for configurable template source

  `ziku init --from owner/repo` でテンプレートソースを指定可能に。
  未指定時は git remote origin からオーナーを自動検出し `{owner}/.github` を使用。
  検出できない場合はデフォルトの `tktcorporation/.github` にフォールバック。

## 0.11.2

### Patch Changes

- [#88](https://github.com/tktcorporation/.github/pull/88) [`8add69e`](https://github.com/tktcorporation/.github/commit/8add69e276683020ee855b5d3e8566f2a1b28054) Thanks [@tktcorporation](https://github.com/tktcorporation)! - `push --execute` で PR 作成成功後に `.ziku-push-manifest.yaml` を自動削除するように変更

## 0.11.1

### Patch Changes

- [#81](https://github.com/tktcorporation/.github/pull/81) [`b0957ca`](https://github.com/tktcorporation/.github/commit/b0957cac35cff736df8f1d8a8e74b724d8bc7c67) Thanks [@tktcorporation](https://github.com/tktcorporation)! - fix: Claude モジュールの patterns に hooks と rules を追加

- [#81](https://github.com/tktcorporation/.github/pull/81) [`53a5b6f`](https://github.com/tktcorporation/.github/commit/53a5b6fad6c7e66d4016a5914cd947b4c9e10aa4) Thanks [@tktcorporation](https://github.com/tktcorporation)! - fix: push --execute で未追跡ファイルの内容が PR に含まれないバグを修正

## 0.11.0

### Minor Changes

- [#79](https://github.com/tktcorporation/.github/pull/79) [`2bb2905`](https://github.com/tktcorporation/.github/commit/2bb2905ad1e8d937d2a453675ceade606722550f) Thanks [@tktcorporation](https://github.com/tktcorporation)! - init コマンドに --modules (-m) と --overwrite-strategy (-s) オプションを追加し、AI エージェントが非インタラクティブにモジュール選択と上書き戦略を指定可能に

### Patch Changes

- [#76](https://github.com/tktcorporation/.github/pull/76) [`4dff0e4`](https://github.com/tktcorporation/.github/commit/4dff0e4ec9d453d847329a1bed31221a2cf6d625) Thanks [@tktcorporation](https://github.com/tktcorporation)! - diff/push コマンドで未トラックファイル検出時に track コマンドの存在を案内し、AI ガイドに track コマンドの重要性を追記

- [#78](https://github.com/tktcorporation/.github/pull/78) [`f722b36`](https://github.com/tktcorporation/.github/commit/f722b36e22860c74aca5275bfce611a9e5c5d251) Thanks [@tktcorporation](https://github.com/tktcorporation)! - init コマンドでテンプレートの .ziku/modules.jsonc をターゲットプロジェクトにコピーするように修正。これにより init → track のワークフローが正しく動作するようになります。

## 0.10.0

### Minor Changes

- [#74](https://github.com/tktcorporation/.github/pull/74) [`64b3475`](https://github.com/tktcorporation/.github/commit/64b3475c39362cadc4a332fa3eeb91c7f5d8c12f) Thanks [@tktcorporation](https://github.com/tktcorporation)! - feat: add `track` command for non-interactive file tracking management

  AI エージェントが非インタラクティブにファイルパターンを `.ziku/modules.jsonc` のホワイトリストに追加できる `track` コマンドを追加。

  - `npx @tktco/ziku track ".cloud/rules/*.md"` でパターン追加（モジュール自動検出）
  - `--module` オプションで明示的にモジュール指定可能
  - 存在しないモジュールは自動作成（`--name`, `--description` でカスタマイズ可能）
  - `--list` で現在の追跡モジュール・パターン一覧を表示
  - AI agent guide にドキュメントを追加

### Patch Changes

- [#72](https://github.com/tktcorporation/.github/pull/72) [`c8beabc`](https://github.com/tktcorporation/.github/commit/c8beabcff2048bb932d0f5de34cf0ca552cc8d9d) Thanks [@tktcorporation](https://github.com/tktcorporation)! - fix(devcontainer): use Docker-compliant volume name for pnpm-store

  devcontainer 起動時の volume 名エラーを修正。`.github` というリポジトリ名により、`${localWorkspaceFolderBasename}-pnpm-store` が `.github-pnpm-store` に展開され、Docker の命名規則に違反していた問題を解決。`devcontainer-` プレフィックスを追加することで命名規則に準拠。

## 0.9.1

### Patch Changes

- [#69](https://github.com/tktcorporation/.github/pull/69) [`6ea205a`](https://github.com/tktcorporation/.github/commit/6ea205a2632b73cd20ba798e7ce7cea08e92fcb9) Thanks [@tktcorporation](https://github.com/tktcorporation)! - Show AI agent hint in default command output

  When running `ziku` without arguments, the output now includes a hint for AI agents pointing them to the `ai-docs` command for non-interactive usage documentation.

## 0.9.0

### Minor Changes

- [#65](https://github.com/tktcorporation/.github/pull/65) [`03464f3`](https://github.com/tktcorporation/.github/commit/03464f39cf516de0e0018c58a5ab37246fa94764) Thanks [@tktcorporation](https://github.com/tktcorporation)! - feat(ziku): add ai-docs command for LLM-friendly documentation
  - Add `ai-docs` subcommand that outputs comprehensive documentation for AI coding agents
  - Create unified documentation source (src/docs/ai-guide.ts) for both CLI and README
  - Add "For AI Agents" section to README with non-interactive workflow instructions
  - Integrate ai-docs command into CLI help output

## 0.8.0

### Minor Changes

- [#61](https://github.com/tktcorporation/.github/pull/61) [`41ea99b`](https://github.com/tktcorporation/.github/commit/41ea99b9c0ed8f9fbe88c976735577cece92636c) Thanks [@tktcorporation](https://github.com/tktcorporation)! - Add AI-agent friendly manifest-based push workflow

  - `--prepare` option: Generates a YAML manifest file (`.ziku-push-manifest.yaml`) for reviewing and editing file selections
  - `--execute` option: Creates a PR based on the manifest file without interactive prompts

  This enables AI agents (like Claude Code) to handle the push workflow by reading/editing the manifest file, rather than requiring interactive CLI input.

## 0.7.1

### Patch Changes

- [#51](https://github.com/tktcorporation/.github/pull/51) [`71d6e04`](https://github.com/tktcorporation/.github/commit/71d6e04edd297f79e56d1a6df40262da2e22d2a4) Thanks [@tktcorporation](https://github.com/tktcorporation)! - feat(init): gitignore 対象ファイルの同期時の挙動を改善

  - init 時に gitignore 対象のファイルがローカルに既存在する場合、上書きせずスキップして警告を表示
  - gitignore 対象のファイルがローカルに存在しない場合は、通常通りコピー
  - push 時は gitignore 対象ファイルを追跡対象から除外（既存の動作を維持）

  これにより、ローカルで編集した gitignore 対象ファイル（環境設定など）がテンプレート同期時に上書きされることを防止します。

- [#50](https://github.com/tktcorporation/.github/pull/50) [`f70e506`](https://github.com/tktcorporation/.github/commit/f70e50601bcedb3a19054463b11b6e77d83df3c8) Thanks [@tktcorporation](https://github.com/tktcorporation)! - fix(ziku): fix stdin conflict between @inquirer/prompts and interactive diff viewer
  - Clear existing keypress listeners before setting up interactive viewer to prevent conflicts with @inquirer/prompts
  - Call stdin.resume() to ensure stdin is in correct state after @inquirer/prompts usage
  - Properly restore stdin state in cleanup for subsequent prompts

## 0.7.0

### Minor Changes

- [#45](https://github.com/tktcorporation/.github/pull/45) [`4557ba0`](https://github.com/tktcorporation/.github/commit/4557ba09b019d2f8f0dbaad3f274d6c4e56c9731) Thanks [@tktcorporation](https://github.com/tktcorporation)! - feat(ziku): improve diff display with summary box and interactive viewer

  - Add new diff-viewer.ts with modern box-styled summary display
  - Show file changes grouped by type (added/modified/deleted) with line stats
  - Add interactive diff viewer with n/p navigation between files
  - Improve file selection UI with stats display

- [#45](https://github.com/tktcorporation/.github/pull/45) [`09b8e2e`](https://github.com/tktcorporation/.github/commit/09b8e2ebc31d44e1a771ef034fc8c5ed7a1e8edc) Thanks [@tktcorporation](https://github.com/tktcorporation)! - feat(ziku): add word-level diff and syntax highlighting
  - Word-level diff: highlight changed words with background colors
  - Syntax highlighting: automatic language detection based on file extension
  - Supports 30+ languages including TypeScript, JavaScript, JSON, YAML, etc.

### Patch Changes

- [#47](https://github.com/tktcorporation/.github/pull/47) [`052075d`](https://github.com/tktcorporation/.github/commit/052075dd830d4ccc8eae4b949a73db164e903df7) Thanks [@tktcorporation](https://github.com/tktcorporation)! - テストを大幅に拡充

  - config.ts: 設定ファイルの読み書きテスト
  - patterns.ts: パターンマッチングとマージのテスト
  - modules/schemas.ts: Zod スキーマバリデーションテスト
  - modules/loader.ts: modules.jsonc ローダーテスト
  - modules/index.ts: モジュールヘルパー関数テスト
  - untracked.ts: 未追跡ファイル検出テスト
  - readme.ts: README 生成テスト
  - diff-viewer.ts: 差分表示テスト
  - github.ts: GitHub API 連携テスト

  テスト数: 40 → 209 (+169 テスト)

## 0.6.0

### Minor Changes

- [#43](https://github.com/tktcorporation/.github/pull/43) [`6685140`](https://github.com/tktcorporation/.github/commit/66851404ab3aa2bb325dcf642460648213f56d2c) Thanks [@tktcorporation](https://github.com/tktcorporation)! - Improve CLI output with modern, user-friendly design
  - Add step-by-step progress indicators (e.g., [1/3], [2/3])
  - Add spinners for async operations (template download, diff detection)
  - Improve file operation results display with colored icons
  - Add summary section showing added/updated/skipped counts
  - Add "Next steps" guidance after successful operations
  - Add colored diff output with visual summary
  - Use consistent styling across all commands (init, push, diff)
  - Replace consola with picocolors + nanospinner for better UX

## 0.5.1

### Patch Changes

- [#34](https://github.com/tktcorporation/.github/pull/34) [`d142d5a`](https://github.com/tktcorporation/.github/commit/d142d5ad3b091ad33c1532c701c3b52609739bed) Thanks [@tktcorporation](https://github.com/tktcorporation)! - ツールチェーンを oxc エコシステムに移行
  - Biome → oxlint + oxfmt に移行
  - tsc --noEmit → oxlint --type-check に移行
  - unbuild → tsdown に移行

## 0.5.0

### Minor Changes

- [#32](https://github.com/tktcorporation/.github/pull/32) [`69db290`](https://github.com/tktcorporation/.github/commit/69db290f4757f65910f41f4557847c3e3d94540c) Thanks [@tktcorporation](https://github.com/tktcorporation)! - README 自動生成機能を追加
  - `pnpm run docs` で README のセクション（機能一覧・コマンド・生成ファイル）を自動生成
  - push コマンド実行時に README を自動更新して PR に含める
  - デフォルトコマンドをインタラクティブ選択に変更
  - 開発者向けドキュメントを CONTRIBUTING.md に移動

## 0.4.1

### Patch Changes

- [#26](https://github.com/tktcorporation/.github/pull/26) [`c490325`](https://github.com/tktcorporation/.github/commit/c4903250a0a7f8f84dae429ac5d7536b02af019f) Thanks [@tktcorporation](https://github.com/tktcorporation)! - ホワイトリスト追加フローを改善
  - ファイル選択 UI を罫線付きツリー形式に変更し、ディレクトリ構造を視覚化
  - ホワイトリスト追加後に moduleList を再パースし、新規ファイルが即座に PUSH 対象に含まれるように修正

## 0.4.0

### Minor Changes

- [#23](https://github.com/tktcorporation/.github/pull/23) [`ec36c47`](https://github.com/tktcorporation/.github/commit/ec36c474aac4e01b30ad018507f5fe7f9a305da2) Thanks [@tktcorporation](https://github.com/tktcorporation)! - push コマンドにホワイトリスト外ファイル検知機能を追加し、モジュール定義を外部化

  ### ホワイトリスト外ファイル検知

  - push 時にホワイトリスト（patterns）に含まれていないファイルを検出
  - モジュールごとにグループ化して選択 UI を表示
  - 選択したファイルを modules.jsonc に自動追加（PR に含まれる）
  - gitignore されているファイルは自動で除外

  ### モジュール定義の外部化

  - モジュール定義をコードから `.ziku/modules.jsonc` に外部化
  - テンプレートリポジトリの modules.jsonc から動的に読み込み
  - `customPatterns` を廃止し modules.jsonc に統合

  ### ディレクトリベースのモジュール設計

  - モジュール ID をディレクトリパスベースに変更（例: `.devcontainer`, `.github`, `.`）
  - ファイルパスから即座にモジュール ID を導出可能に
  - モジュール間のファイル重複を構造的に防止

## 0.3.0

### Minor Changes

- [#14](https://github.com/tktcorporation/.github/pull/14) [`c026ed5`](https://github.com/tktcorporation/.github/commit/c026ed55da57df6599f7c57cdbb5d29c05e3273d) Thanks [@tktcorporation](https://github.com/tktcorporation)! - .gitignore に記載されたファイルを自動的に除外する機能を追加

  - init, diff, push の全コマンドで .gitignore にマッチするファイルを除外
  - ローカルディレクトリとテンプレートリポジトリ両方の .gitignore をチェック
  - クレデンシャル等の機密情報の誤流出を防止

- [#16](https://github.com/tktcorporation/.github/pull/16) [`3d89baa`](https://github.com/tktcorporation/.github/commit/3d89baa1c236998be4cfb72b68b9b4a6480a7b4e) Thanks [@tktcorporation](https://github.com/tktcorporation)! - push コマンドに unified diff を見ながらファイルを選択できる機能を追加
  - デフォルトで差分を表示しながらチェックボックスでファイル選択が可能に
  - `--no-interactive` オプションで従来の確認プロンプトに切り替え可能
  - `--force` オプションは引き続き確認なしで全ファイルを push

## 0.2.0

### Minor Changes

- [#12](https://github.com/tktcorporation/.github/pull/12) [`798d3fb`](https://github.com/tktcorporation/.github/commit/798d3fb332bdffbc4feac24d9ed89a1b510d7fcf) Thanks [@tktcorporation](https://github.com/tktcorporation)! - 双方向同期機能とホワイトリスト形式を追加

  ### 新機能

  - `push` コマンド: ローカル変更を GitHub PR として自動送信
  - `diff` コマンド: ローカルとテンプレートの差分をプレビュー

  ### 破壊的変更

  - モジュール定義を `files` + `excludeFiles` 形式から `patterns` (glob) 形式に移行
  - テンプレート対象ファイルをホワイトリスト形式で明示的に指定するように変更

  ### 使用例

  ```bash
  # 差分を確認
  npx @tktco/ziku diff

  # ローカル変更を PR として送信
  npx @tktco/ziku push --message "feat: DevContainer設定を更新"

  # ドライラン
  npx @tktco/ziku push --dry-run
  ```

- [#10](https://github.com/tktcorporation/.github/pull/10) [`d932401`](https://github.com/tktcorporation/.github/commit/d93240170c298d5469e4c7646c383ac8e6aed90c) Thanks [@tktcorporation](https://github.com/tktcorporation)! - CLI 出力を改善
  - すべてのファイル操作に上書き戦略を適用
  - .ziku.json は常に更新（設定管理ファイルとして特別扱い）
  - セットアップ後にモジュール別説明を表示
  - 全スキップ時は「変更はありませんでした」と表示
  - ts-pattern で網羅的なパターンマッチング
  - Zod スキーマで型安全性を向上

## 0.1.3

### Patch Changes

- [#6](https://github.com/tktcorporation/.github/pull/6) [`91d9a86`](https://github.com/tktcorporation/.github/commit/91d9a86b9097af297c848eaf06ca58736dd552a5) Thanks [@tktcorporation](https://github.com/tktcorporation)! - feat: ビルド時にバージョン情報を埋め込み、実行時に表示するように改善

## 0.1.2

### Patch Changes

- [#4](https://github.com/tktcorporation/.github/pull/4) [`ae7c5e7`](https://github.com/tktcorporation/.github/commit/ae7c5e712b1a16963cd0cd920a92dd589f5e9f84) Thanks [@tktcorporation](https://github.com/tktcorporation)! - fix: overwriteStrategy オプションが正しく機能するように修正

  - "prompt" 戦略: ファイルごとにユーザーに上書き確認を表示
  - "skip" 戦略: 既存ファイルをスキップして新規ファイルのみコピー
  - "overwrite" 戦略: 既存ファイルを全て上書き

  また、Vitest によるテスト環境を追加

## 0.1.1

### Patch Changes

- [`c3dcb7a`](https://github.com/tktcorporation/.github/commit/c3dcb7a158a4eedc331fef98433537ed9969c20d) Thanks [@tktcorporation](https://github.com/tktcorporation)! - fix: ignore "init" argument as directory name

  When running `npx ziku init`, the "init" was interpreted as the target directory.
  Now "init" is ignored and files are extracted to the current directory.
