# modules.jsonc 形式リファクタリング計画

## 背景

PR #8 で MODULE_PRESETS が導入され、modules.jsonc の柔軟性が高まった。
しかし現在の形式には以下の構造的問題がある:

1. `id` がディレクトリパス・識別子・所有判定の3つの役割を兼ねている
2. `id` と `patterns` の関係に制約がなく、重複や不整合が起きうる
3. `modules` の概念が init 時の選択 UI とランタイムのスコープ定義で混在している
4. `excludePatterns` が consumer 側 (`.ziku/ziku.jsonc + .ziku/lock.json`) にしかなく、upstream から除外宣言できない

## 設計方針

### 原則

- **lint ツール (biome, ESLint flat config) の `include` / `exclude` パターンを参考にする**
- **modules は init 時の UI 概念に徹する** — ランタイムは flat なパターンで動く
- **`.ziku/modules.jsonc` がパターン定義**、**`.ziku/ziku.jsonc + .ziku/lock.json` が同期状態** — 責務を分離する
- **`.ziku/ziku.jsonc + .ziku/lock.json` から `modules` 配列と `excludePatterns` を削除する**
- **`id` は使わない** — 内部設計も `id` に依存しないよう再設計する
- **後方互換は考慮しない** — 破壊的変更として一括で移行する

### 新しいファイル責務

| ファイル                       | 役割                                                 | 配置                   |
| ------------------------------ | ---------------------------------------------------- | ---------------------- |
| upstream `.ziku/modules.jsonc` | init 時の選択メニュー + パターン定義                 | テンプレートリポジトリ |
| local `.ziku/modules.jsonc`    | 同期対象のパターン定義（選択済みモジュールのみ）     | consumer プロジェクト  |
| `.ziku/ziku.jsonc + .ziku/lock.json`                   | 同期状態 (source, baseRef, baseHashes, pendingMerge) | consumer プロジェクト  |

## 新しい形式

### upstream `.ziku/modules.jsonc`

```jsonc
{
  "$schema": "...",
  "modules": [
    {
      "name": "GitHub",
      "description": "GitHub Actions workflows and configuration",
      "include": [".github/**"],
      "exclude": [".github/CODEOWNERS"]
    },
    {
      "name": "DevContainer",
      "description": "VS Code DevContainer setup",
      "include": [".devcontainer/**"]
    },
    {
      "name": "Root Config",
      "description": "Root-level configuration files",
      "include": [".editorconfig", ".mcp.json", ".mise.toml"]
    }
  ]
}
```

変更点:

- `id` 削除 — パターンがスコープの真実の源泉
- `patterns` → `include` にリネーム (lint ツールと同じ語彙)
- `exclude` 追加 (モジュール単位、upstream が宣言可能)
- `setupDescription` は残す (optional)

### local `.ziku/modules.jsonc` (consumer 側)

init 時にユーザーが選択したモジュールのみを含む。upstream と同じ形式。
`copyModulesJsonc()` を廃止し、選択されたモジュールのみをフィルタして書き出す。

```jsonc
{
  "$schema": "...",
  "modules": [
    {
      "name": "GitHub",
      "description": "GitHub Actions workflows and configuration",
      "include": [".github/**"],
      "exclude": [".github/CODEOWNERS"]
    },
    {
      "name": "DevContainer",
      "description": "VS Code DevContainer setup",
      "include": [".devcontainer/**"]
    }
  ]
}
```

pull/push/diff はこのファイルの全 modules の `include` / `exclude` を読んでフラットにする。

### `.ziku/ziku.jsonc + .ziku/lock.json`

```json
{
  "version": "1.0.0",
  "installedAt": "2026-04-01T00:00:00Z",
  "source": {
    "owner": "my-org",
    "repo": ".github"
  },
  "baseRef": "abc123",
  "baseHashes": {
    ".github/workflows/ci.yml": "sha256...",
    ".devcontainer/devcontainer.json": "sha256..."
  }
}
```

削除されるフィールド:

- `modules` (string[] — 旧モジュール ID 配列)
- `excludePatterns` (string[] — consumer 側グローバル除外)

## `id` なしで各機能を実現する方法

### push の diff (detectLocalModuleAdditions)

旧: module ID で local vs template を突合 → ID が一致するモジュール間でパターンの差分を取得

新: **パターン単位でフラットに diff する**

1. local modules.jsonc の全 `include` をフラット集合にする
2. upstream modules.jsonc の全 `include` をフラット集合にする
3. local にあって upstream にないパターン = ローカル追加分
4. push 時の PR にはローカルの modules.jsonc をそのまま含める (パターン追加がモジュール構造ごと反映される)

### `--modules` CLI フラグ

旧: `--modules .github,.devcontainer` (ID で指定)

新: `--modules GitHub,DevContainer` (**`name` で指定**)

- name は modules.jsonc 内で一意であることをバリデーション

### track コマンド (どのモジュールにパターンを追加するか)

旧: `inferModuleId()` がファイルパスの先頭ディレクトリから module ID を導出

新: **既存モジュールの include パターンとプレフィックスマッチ**

1. 追加したいパターン (例: `.github/workflows/deploy.yml`) のディレクトリプレフィックスを取得
2. 各モジュールの include パターンの中に同じプレフィックスを持つものがあるか探す
3. 一致するモジュールが1つなら自動選択、複数 or 0 なら interactive picker
4. `--module` フラグは `name` を受け取る

### devcontainer ハードコードチェック (init.ts L227)

旧: `answers.modules.includes("devcontainer")`

新: 選択されたモジュールの `include` に `.devcontainer/**` 系のパターンが含まれるか判定

```typescript
const hasDevcontainer = selectedModules.some(m =>
  m.include.some(p => p.startsWith(".devcontainer/"))
);
```

### untracked detection

旧: `getModuleIdFromPath()` でファイル → module ID → インストール済みかチェック

新: **全 include パターンでマッチ判定**

1. local modules.jsonc の全 include パターンを結合
2. ターゲットディレクトリの全ファイルを取得
3. include にマッチするが modules.jsonc の patterns で明示されていないファイル = untracked
4. 表示用のフォルダグルーピングはパスの先頭ディレクトリから導出 (UI のみ)

### exclude のセマンティクス

`exclude` は **resolve 後のファイルリストに対するフィルタ** として適用する。
tinyglobby の `ignore` オプションを使い、glob 解決時に除外する。

```typescript
const files = globSync(module.include, {
  cwd: baseDir,
  ignore: module.exclude ?? [],
  dot: true,
  onlyFiles: true,
});
```

## 実装ステップ

### Phase 1: スキーマ変更

1. **`src/modules/schemas.ts`**
   - `moduleSchema`: `id` 削除、`patterns` → `include`、`exclude` (optional) 追加
   - `configSchema`: `modules` フィールド削除、`excludePatterns` 削除
   - `answersSchema`: `modules` (string[]) → `selectedModules` (moduleSchema[]) に変更
   - `validateModulePatternScope()` 削除 (不要に)
   - `TemplateModule` 型が新形式に追従

2. **`schema/modules.json`**
   - JSON Schema を新形式に合わせて更新 (`pnpm run docs` で自動生成)

### Phase 2: モジュール読み込み・操作

3. **`src/modules/loader.ts`**
   - `loadModulesFile()`: 新スキーマでパース
   - `addPatternToModulesFile()`: `patterns` → `include` 参照に変更、module を `name` で検索
   - `addPatternToModulesFileWithCreate()`: 同上、`id` 不要に。`name` + `description` を自動生成
   - ヘルパー追加: `resolveModuleFiles(modules, baseDir)` — 全モジュールの include を結合し exclude を適用してファイル一覧を返す

4. **`src/modules/index.ts`**
   - `getModuleById()` → `getModuleByName()` に変更
   - `getPatternsByModuleIds()` 削除
   - `getAllPatterns()` → `include` を参照するように変更
   - 新関数: `getAllIncludePatterns(modules)` — 全モジュールの include をフラットに結合

### Phase 3: ユーティリティ

5. **`src/utils/patterns.ts`**
   - `getEffectivePatterns()` 削除 — exclude は glob 解決時に処理するため不要
   - `filterByExcludePatterns()` 削除 — 同上

6. **`src/utils/untracked.ts`**
   - `getModuleIdFromPath()` 削除
   - `getModuleBaseDir()` 削除
   - `detectUntrackedFiles()` リファクタ:
     - modules.jsonc の全 include/exclude からパターンベースで tracked files を算出
     - 表示用フォルダ名はファイルパスの先頭ディレクトリから導出
   - `UntrackedFile` インターフェース: `moduleId` → `folder` (表示用のみ)

7. **`src/utils/diff.ts`**
   - `detectDiff()`: module ID ループ → modules.jsonc からフラットパターンで比較

8. **`src/utils/template.ts`**
   - `fetchTemplates()`: module ID ベースのパターン取得 → modules.jsonc 直接参照に

9. **`src/utils/config.ts`**
   - `loadConfig()` / `saveConfig()`: 新 configSchema に合わせる

10. **`src/utils/readme.ts`**
    - `mod.id` 参照 → `mod.name` と `mod.include` から導出

### Phase 4: コマンド

11. **`src/commands/init.ts`**
    - `MODULE_PRESETS`: `id` 削除、`patterns` → `include` に
    - ルートファイルプリセット統合: `.editorconfig`, `.mcp.json`, `.mise.toml` を一つの "Root Config" モジュールに
    - `generateInitialModulesJsonc()`: 新形式で生成
    - `copyModulesJsonc()` 廃止 → 選択されたモジュールのみフィルタして書き出す関数に置換
    - `selectModules()` の戻り値: module ID 配列 → 選択された module 定義の配列
    - `displayModuleDescriptions()`: module 定義直接参照
    - `devcontainer` ハードコード: include パターンベースの判定に変更
    - `--modules` フラグ: ID → name で指定
    - `.ziku/ziku.jsonc + .ziku/lock.json` 保存時に `modules` フィールドを含めない

12. **`src/commands/pull.ts`**
    - `getInstalledModulePatterns()`: modules.jsonc から直接パターン取得に変更
    - config.modules 参照を削除

13. **`src/commands/push.ts`**
    - `detectLocalModuleAdditions()`: パターン単位のフラット diff に変更
    - config.modules 参照を削除

14. **`src/commands/diff.ts`**
    - config.modules 参照を削除、modules.jsonc からパターン取得

15. **`src/commands/track.ts`**
    - `inferModuleId()` → include パターンのプレフィックスマッチに変更
    - `--module` フラグ: ID → name で指定
    - `--list` 表示: `mod.id (mod.name)` → `mod.name` + include パターン

### Phase 5: UI

16. **`src/ui/prompts.ts`**
    - `selectModules()`: module ID を返す → module 定義の配列を返す
    - `selectTemplateModules()`: 同上

### Phase 6: スクリプト・ドキュメント

17. **`scripts/generate-readme.ts`**
    - `generateInitialModulesJsonc()` の新形式に追従
    - フィルタロジック: `m.id` → include パターンで判定

18. **README.md**: `pnpm run docs` で自動更新

### Phase 7: テスト

19. **全テストファイルの更新**
    - `src/commands/__tests__/init.test.ts`
    - `src/commands/__tests__/init-setup-ux.test.ts`
    - `src/commands/__tests__/push.test.ts`
    - `src/commands/__tests__/pull.test.ts`
    - `src/modules/__tests__/schemas.test.ts`
    - `src/modules/__tests__/loader.test.ts`
    - `src/modules/__tests__/index.test.ts`
    - `src/utils/__tests__/patterns.test.ts`
    - `src/utils/__tests__/config.test.ts`
    - `src/utils/__tests__/untracked.test.ts`
    - `src/utils/__tests__/diff.test.ts`
    - `src/utils/__tests__/readme.test.ts`

## name の一意性

- modules.jsonc 内で `name` の重複を禁止する
- load 時にバリデーションエラーを出す
- `name` はユーザー向け表示にのみ使い、内部ロジックは include パターンで動く
- `name` のリネームは modules.jsonc だけの変更で済む (.ziku/ziku.jsonc + .ziku/lock.json に影響しない)
