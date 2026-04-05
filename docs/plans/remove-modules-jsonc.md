# modules.jsonc 廃止リファクタ

## 背景

modules.jsonc はパターン管理の複雑さの根源。テンプレート側（modules.jsonc）とユーザー側（ziku.jsonc）の2箇所でパターンが管理され、track → push で同期されない問題がある。

**新設計:** テンプレートリポのファイル = 同期対象。modules.jsonc を廃止し、init 時の選択はディレクトリ単位で行う。

## 現在のブランチ状態

ブランチ `refactor/remove-modules-jsonc` に以下が含まれている:
- `--from-dir` 対応（init/push/pull/diff がローカルディレクトリをテンプレートとして使用可能）
- `source: { path: string }` のスキーマ対応（ziku.jsonc に保存される）
- E2E ライフサイクルテスト（`src/commands/__tests__/e2e-lifecycle.test.ts`）
- リファクタ計画ドキュメント

## 変更内容

### 1. init のモジュール選択 → ディレクトリ選択に変更

**現状:**
```
init → loadModulesFile(templateDir) → selectModules(modules) → flattenModules → fetchTemplates
```

**新設計:**
```
init → テンプレートリポのトップレベルディレクトリを列挙 → selectDirectories → fetchTemplates
```

**具体的な変更:**
- `src/commands/init.ts`:
  - `resolveTemplatePatterns()` を削除
  - `selectModulesFromTemplate()` を削除
  - 代わりにテンプレートの `.` 直下のディレクトリを `fs.readdirSync` で列挙
  - `.ziku/` と `.git/` は除外
  - トップレベルのファイル（`.mcp.json` 等）は「Root files」グループとして表示
  - `--yes` なら全ディレクトリ選択
  - `--modules` 引数は `--dirs` にリネーム（or 廃止）
  - パターンはディレクトリ名から `{dir}/**` を生成 + トップレベルファイルはそのまま
- `src/ui/prompts.ts`:
  - `selectModules()` → `selectDirectories()` に置き換え

### 2. ziku.jsonc のスキーマ変更

**現状:**
```jsonc
{ "source": {...}, "include": [".claude/**", ".mcp.json"], "exclude": [...] }
```

**新設計:**
```jsonc
{ "source": {...}, "include": [".claude/**", ".mcp.json"], "exclude": [...] }
```

include の中身が「modules.jsonc のパターンのフラット化結果」から「テンプレートのディレクトリ/ファイルから生成されたパターン」に変わるだけで、スキーマ自体は同じ。

### 3. modules.jsonc 参照の削除

**削除するファイル:**
- `src/commands/track.ts` — コマンド自体を削除（テンプレートに追加するだけで済む）

**大幅修正するファイル:**
- `src/modules/loader.ts` — modules.jsonc 関連の全関数を削除。残すのは utils 的な関数のみ
  - 削除: `loadModulesFile`, `flattenModules`, `modulesFileExists`, `getModulesFilePath`, `modulesFileSchema`, `MODULES_FILE`, `MODULES_SCHEMA_URL`, `isFileMatchedByModules`, `suggestModuleAdditions`, `addModulesToJsonc`, matchGlob
  - ファイル自体を削除するか、最小限にする
- `src/modules/index.ts` — 上記に合わせて re-export 整理
- `src/modules/schemas.ts` — `moduleSchema`, `TemplateModule` 型を削除
- `src/commands/init.ts` — modules 読み込み → ディレクトリ列挙に変更。`handleMissingDevenv` 不要に（modules.jsonc チェック自体が不要）
- `src/commands/push.ts` — modules.jsonc 関連（loadModulesFile, flattenModules, isFileMatchedByModules, suggestModuleAdditions, addModulesToJsonc）を全削除。パターン比較ロジックも簡素化
- `src/commands/setup.ts` — modules.jsonc 生成部分を削除。setup コマンド自体が不要になる可能性（テンプレートリポにファイルを置くだけ）

**軽微な修正:**
- `src/docs/lifecycle.ts` — modules.jsonc 参照削除、setup/track ライフサイクル削除
- `src/docs/lifecycle-types.ts` — SYNCED_FILES は残す
- `scripts/generate-readme.ts` — modules スキーマ生成削除、Example 変更
- `src/utils/github.ts` — `checkRepoSetup` が modules.jsonc の存在確認をしているなら修正
- `src/utils/readme.ts` — modules.jsonc パス参照があれば修正
- `src/index.ts` — track, setup コマンドの登録削除

### 4. setup コマンドの扱い

modules.jsonc が不要なら、setup コマンドの役割は「テンプレートリポを作る」だけ。
テンプレートリポは「ファイルを置くだけ」なので、setup 自体が不要になる。

**判断:** setup コマンドを削除する。テンプレートリポは手動で作る（mkdir + git init + ファイル配置）。

### 5. track コマンドの扱い

modules.jsonc がないので、ziku.jsonc の include パターンを直接編集する track コマンドは引き続き有用かもしれない。
ただし新設計では「テンプレートリポのファイル = 同期対象」なので、パターン管理自体が不要。

**判断:** track コマンドを削除する。テンプレートにファイルを追加したいならテンプレートリポに直接追加。

### 6. テスト

**削除:**
- `src/modules/__tests__/loader.test.ts` — 全体
- `src/modules/__tests__/index.test.ts` — 全体
- `src/commands/__tests__/track.test.ts` — 全体
- `src/commands/__tests__/e2e-flat-format.test.ts` — modules 前提のテスト群

**修正:**
- `src/commands/__tests__/init.test.ts` — modules 選択 → ディレクトリ選択に
- `src/commands/__tests__/init-setup-ux.test.ts` — modules.jsonc チェック削除
- `src/commands/__tests__/push.test.ts` — modules 関連モック削除
- `src/commands/__tests__/e2e-scenarios.test.ts` — modules 選択シナリオ → ディレクトリ選択
- `src/commands/__tests__/e2e-lifecycle.test.ts` — setup ステップ変更、modules.jsonc チェック削除
- `src/modules/__tests__/schemas.test.ts` — moduleSchema テスト削除

### 7. .ziku/modules.jsonc（このリポ自体のファイル）

削除する。`.ziku/ziku.jsonc` だけ残す。

### 8. schema/modules.json

削除する。`scripts/generate-readme.ts` でのスキーマ生成も削除。

### 9. README

- Example modules.jsonc → テンプレートリポのディレクトリ構造の例に変更
- `setup` コマンドの説明削除
- `track` コマンドの説明削除
- Getting Started の Step 2 を「テンプレートリポにファイルを配置」に変更

### 10. E2E テストの更新

`e2e-lifecycle.test.ts` のシナリオ:
1. ~~setup~~ → テンプレートリポにファイルを直接配置
2. init --from-dir (プロジェクトA) → ディレクトリ選択 → ファイルコピー
3. init --from-dir (プロジェクトB)
4. プロジェクトA でファイル追加 → push
5. プロジェクトB で pull
6. 新プロジェクトC で init

## 検証

```bash
pnpm lint          # 0 errors, 0 warnings
pnpm test          # 全テスト pass
pnpm run docs      # ドキュメント再生成
pnpm run docs:check # ドキュメント最新確認
```
