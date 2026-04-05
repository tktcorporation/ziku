# ライフサイクルメタデータのコロケーション + ガードテスト

## Context

`src/docs/lifecycle.ts` がすべてのコマンドのファイル操作メタデータを一括管理しているが、
実装（各コマンドファイル）と離れた場所にあるため、実装変更時にメタデータの更新を忘れやすい。
実際に diff の local synced files 読み取り、push のテンプレート読み取りが漏れていた。

**目標**: メタデータをソースコードに近い位置へ移動し、乖離を CI で検出できる仕組みを作る。

## 方針: コロケーション + import ベースガードテスト

### A. コロケーション

各コマンドファイルにライフサイクル定義を export し、`lifecycle.ts` は集約 + ドキュメント生成のみにする。

### B. ガードテスト

コマンドの import 文を読み取り、ライフサイクル ops との整合性を検証するテスト。

---

## ファイル変更一覧

### 新規作成

1. **`src/docs/lifecycle-types.ts`** — 型定義 + `SYNCED_FILES` 定数の切り出し
   - `Location`, `Op`, `FileOp`, `CommandLifecycle` の型定義
   - `SYNCED_FILES = "synced files"` 定数
   - 循環依存を防ぐため lifecycle.ts から分離

2. **`src/docs/__tests__/lifecycle-guard.test.ts`** — ガードテスト
   - 各コマンドのソースを `readFileSync` で読み取り
   - import されている関数名を正規表現で抽出
   - `IMPORT_OP_MAP` で定義した「この関数を import しているなら、この ops が必要」を検証

### 修正

3. **`src/docs/lifecycle.ts`** — 集約ファイルに変更
   - 型定義を `lifecycle-types.ts` から re-export
   - `lifecycle` 配列を各コマンドから import して組み立て
   - `generateLifecycleDocument()` とそのヘルパー関数・補足テキストはここに残す

4. **`src/commands/diff.ts`** — `diffLifecycle` を export 追加
5. **`src/commands/track.ts`** — `trackLifecycle` を export 追加
6. **`src/commands/pull.ts`** — `pullLifecycle` を export 追加
7. **`src/commands/push.ts`** — `pushLifecycle` を export 追加
8. **`src/commands/init.ts`** — `initTemplateLifecycle`, `initUserLifecycle` を export 追加

---

## 詳細設計

### 1. `src/docs/lifecycle-types.ts`（新規）

```typescript
/** ファイルが存在する場所 */
export type Location = "template" | "local";

/** ファイル操作の種類 */
export type Op = "read" | "create" | "update";

/** 1 つのファイル操作 */
export interface FileOp {
  file: string;
  location: Location;
  op: Op;
  note: string;
}

/** 1 つのコマンドのライフサイクル */
export interface CommandLifecycle {
  name: string;
  description: string;
  ops: FileOp[];
}

/**
 * 同期対象ファイル群を表すラベル。
 * 実際のファイルパスではなく、ドキュメント上の概念的な表現。
 */
export const SYNCED_FILES = "synced files";
```

### 2. 各コマンドファイルの変更パターン

例: `src/commands/diff.ts`

```typescript
import type { CommandLifecycle } from "../docs/lifecycle-types";
import { SYNCED_FILES } from "../docs/lifecycle-types";
// ZIKU_CONFIG_FILE は既存の import で取得済み

export const diffLifecycle: CommandLifecycle = {
  name: "diff",
  description: "ローカルとテンプレートの差分を表示",
  ops: [
    { file: ZIKU_CONFIG_FILE, location: "local", op: "read", note: "patterns を取得" },
    { file: SYNCED_FILES, location: "local", op: "read", note: "ローカルファイルを読み取り" },
    { file: SYNCED_FILES, location: "template", op: "read", note: "テンプレートをダウンロードして比較" },
  ],
};
```

他のコマンドも同様のパターン。init.ts のみ 2 つの lifecycle を export:

- `initTemplateLifecycle` — "init (template repo)"
- `initUserLifecycle` — "init (user project)"

各コマンドが既に import している定数（`ZIKU_CONFIG_FILE`, `LOCK_FILE`, `MODULES_FILE`）を
そのまま ops の `file` に使う。新たに必要な import は `CommandLifecycle` 型と `SYNCED_FILES` のみ。

init.ts は `MODULES_FILE` を `../modules/index` から既に import している。
diff.ts は `ZIKU_CONFIG_FILE` を import していないので新たに追加する。

### 3. `src/docs/lifecycle.ts` の変更

```typescript
// 型の re-export（外部消費者の互換性維持）
export type { FileOp, CommandLifecycle, Location, Op } from "./lifecycle-types";
export { SYNCED_FILES } from "./lifecycle-types";

// 各コマンドから集約
import { initTemplateLifecycle, initUserLifecycle } from "../commands/init";
import { pullLifecycle } from "../commands/pull";
import { pushLifecycle } from "../commands/push";
import { diffLifecycle } from "../commands/diff";
import { trackLifecycle } from "../commands/track";

export const lifecycle: CommandLifecycle[] = [
  initTemplateLifecycle,
  initUserLifecycle,
  pullLifecycle,
  pushLifecycle,
  diffLifecycle,
  trackLifecycle,
];

// generateLifecycleDocument() とヘルパー関数はそのまま残す
// 補足セクションのテキストもここに残す（ドキュメント生成の関心事）
```

既存の `MODULES_FILE`, `LOCK_FILE`, `ZIKU_CONFIG_FILE` の import は、
ヘルパー関数（`generateFileSummaryTable` 等）と補足テキストで使うため残す。

### 4. ガードテスト `src/docs/__tests__/lifecycle-guard.test.ts`

```typescript
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { MODULES_FILE } from "../../modules/loader";
import { LOCK_FILE } from "../../utils/lock";
import { ZIKU_CONFIG_FILE } from "../../utils/ziku-config";
import { SYNCED_FILES } from "../lifecycle-types";

// 各コマンドのライフサイクルを import
import { diffLifecycle } from "../../commands/diff";
import { trackLifecycle } from "../../commands/track";
import { pullLifecycle } from "../../commands/pull";
import { pushLifecycle } from "../../commands/push";
import { initTemplateLifecycle, initUserLifecycle } from "../../commands/init";

/**
 * 「この関数を import しているなら、lifecycle にこの ops があるべき」マッピング。
 *
 * 注意: detectDiff のように内部で複数ファイルを読む関数は、
 * 個々の ops を列挙する。
 */
const IMPORT_OP_MAP: Record<string, { file: string; op: string }[]> = {
  loadZikuConfig: [{ file: ZIKU_CONFIG_FILE, op: "read" }],
  loadLock: [{ file: LOCK_FILE, op: "read" }],
  saveLock: [{ file: LOCK_FILE, op: "update" }],  // init では create
  loadPatternsFile: [{ file: MODULES_FILE, op: "read" }],
  loadTemplateModulesFile: [{ file: MODULES_FILE, op: "read" }],
};

// コマンドソースファイルから import 名を抽出
function extractImportedNames(source: string): Set<string> {
  const names = new Set<string>();
  for (const match of source.matchAll(/import\s+(?:type\s+)?{([^}]+)}/g)) {
    for (const name of match[1].split(",")) {
      names.add(name.trim().split(/\s+as\s+/)[0]);
    }
  }
  return names;
}

// lifecycle ops に特定の { file, op } が含まれるか
function hasOp(ops, file, op): boolean {
  return ops.some(o => o.file === file && o.op === op);
}

// 各コマンドを検証
const commands = [
  { name: "diff", lifecycle: diffLifecycle, src: "src/commands/diff.ts" },
  { name: "track", lifecycle: trackLifecycle, src: "src/commands/track.ts" },
  { name: "pull", lifecycle: pullLifecycle, src: "src/commands/pull.ts" },
  { name: "push", lifecycle: pushLifecycle, src: "src/commands/push.ts" },
  {
    name: "init (user project)",
    lifecycle: initUserLifecycle,
    src: "src/commands/init.ts",
  },
];

describe("lifecycle guard", () => {
  for (const cmd of commands) {
    describe(cmd.name, () => {
      const source = readFileSync(resolve(__dirname, "../../../", cmd.src), "utf-8");
      const imports = extractImportedNames(source);

      for (const [fnName, expectedOps] of Object.entries(IMPORT_OP_MAP)) {
        if (!imports.has(fnName)) continue;

        for (const expected of expectedOps) {
          // saveLock は init では create、pull では update
          const opVariants = expected.op === "update"
            ? ["update", "create"]
            : [expected.op];

          it(`imports ${fnName} → ops に ${expected.file} の ${expected.op} がある`, () => {
            const found = opVariants.some(op => hasOp(cmd.lifecycle.ops, expected.file, op));
            expect(found).toBe(true);
          });
        }
      }
    });
  }
});
```

**テストの特徴:**

- `IMPORT_OP_MAP` はシンプルに「関数名 → 期待される ops」のみを管理
- `saveLock` は init で `create`、pull で `update` のため variant 対応
- `import type` も含めて抽出（ただし type-only import は関数呼び出しではないので、
  `import type` だけの場合は誤検出するが、現状このケースは発生しない）
- `detectDiff` や `createPullRequest` のような「内部で synced files を読む」関数は
  MAP に含めない（暗黙的すぎるため）。これらは手動でレビューする領域

---

## 依存関係の整理

```
lifecycle-types.ts ← 型 + SYNCED_FILES（依存なし）
     ↑ import type          ↑ import
各 commands/*.ts        lifecycle.ts
     ↓ export lifecycle      ↓ import lifecycle objects
lifecycle.ts ←──────── commands/*.ts
```

循環なし: command files → lifecycle-types.ts (型 + 定数), lifecycle.ts → command files (値)

---

## 実装順序

1. `src/docs/lifecycle-types.ts` を作成（型 + SYNCED_FILES）
2. 各コマンドファイルに lifecycle export を追加（5 ファイル）
3. `src/docs/lifecycle.ts` を集約ファイルに変更
4. `src/docs/__tests__/lifecycle-guard.test.ts` を作成
5. `npm run docs` で再生成し、出力が変わらないことを確認
6. `npm run docs:check` で CI チェック通過を確認
7. 全テスト通過を確認

## 検証

- `npm run docs:check` — ドキュメント生成結果が変わらないこと（リファクタなので出力は同一）
- `npx vitest run` — 全テスト通過
- `npx vitest run src/docs/` — ガードテスト通過
- ガードテストの有効性確認: 試しに pull.ts の lifecycle から lock.json の read を削除 → テスト失敗を確認 → 戻す
