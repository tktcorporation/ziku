/// <reference types="vitest/globals" />
/**
 * ライフサイクルメタデータと実装の整合性ガードテスト。
 *
 * 背景: 各コマンドファイルにコロケーションされたライフサイクル定義が、
 * 実際の import（= ファイル操作の使用）と矛盾していないかを検証する。
 * 例えば push.ts が loadLock を import しているのに pushLifecycle に
 * lock.json の read ops がなければ、テストが失敗する。
 *
 * 検出範囲: 直接的なファイル I/O 関数のみ。
 * detectDiff や createPullRequest のように内部で synced files を
 * 読み書きする関数は、1:1 対応が難しいため対象外。
 */

import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { LOCK_FILE } from "../../utils/lock";
import { ZIKU_CONFIG_FILE } from "../../utils/ziku-config";
import type { FileOp } from "../lifecycle-types";

import { diffLifecycle } from "../../commands/diff";
import { trackLifecycle } from "../../commands/track";
import { pullLifecycle } from "../../commands/pull";
import { pushLifecycle } from "../../commands/push";
import { initUserLifecycle } from "../../commands/init";

// ──────────────────────────────────────────────
// ポリシー定義: import 名 → 期待される ops
// ──────────────────────────────────────────────

/**
 * 「この関数を import しているなら、lifecycle にこの ops があるべき」マッピング。
 *
 * - file: 期待されるファイルパス定数
 * - ops: 期待される操作の種類（複数指定時は OR — いずれか 1 つがあれば OK）
 *
 * saveLock は init では "create"、pull では "update" のため ops に両方を含める。
 */
const IMPORT_OP_MAP: Record<string, { file: string; ops: string[] }[]> = {
  loadZikuConfig: [{ file: ZIKU_CONFIG_FILE, ops: ["read"] }],
  loadLock: [{ file: LOCK_FILE, ops: ["read"] }],
  saveLock: [{ file: LOCK_FILE, ops: ["update", "create"] }],
  saveZikuConfig: [{ file: ZIKU_CONFIG_FILE, ops: ["update"] }],
};

// ──────────────────────────────────────────────
// ヘルパー
// ──────────────────────────────────────────────

/** ソースファイルの import 文から名前を抽出する */
function extractImportedNames(source: string): Set<string> {
  const names = new Set<string>();
  // `import { foo, bar } from "..."` と `import type { Baz } from "..."` の両方に対応
  for (const match of source.matchAll(/import\s+(?:type\s+)?\{([^}]+)\}/g)) {
    for (const name of match[1].split(",")) {
      // `foo as bar` → `foo` を取得
      const trimmed = name.trim().split(/\s+as\s+/)[0];
      if (trimmed) names.add(trimmed);
    }
  }
  return names;
}

/** lifecycle ops に { file, op } の組み合わせが含まれるか */
function hasOp(ops: readonly FileOp[], file: string, opCandidates: string[]): boolean {
  return ops.some((o) => o.file === file && opCandidates.includes(o.op));
}

// ──────────────────────────────────────────────
// テスト対象
// ──────────────────────────────────────────────

/**
 * import ベースのガード対象コマンド。
 *
 * init (template repo) は除外: init.ts に 2 つのライフサイクルが同居しており、
 * ファイル全体の import が template repo 側にも適用されてしまうため。
 * template repo の init は ops が create のみで、import ガードの実益が薄い。
 */
const COMMANDS = [
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

// ──────────────────────────────────────────────
// テスト本体
// ──────────────────────────────────────────────

describe("lifecycle guard: import → ops の整合性", () => {
  for (const cmd of COMMANDS) {
    describe(cmd.name, () => {
      const sourcePath = resolve(__dirname, "../../../", cmd.src);
      const source = readFileSync(sourcePath, "utf-8");
      const imports = extractImportedNames(source);

      for (const [fnName, expectedEntries] of Object.entries(IMPORT_OP_MAP)) {
        if (!imports.has(fnName)) continue;

        for (const expected of expectedEntries) {
          it(`${fnName} を import → ${expected.file} の [${expected.ops.join("|")}] が ops に存在する`, () => {
            expect(hasOp(cmd.lifecycle.ops, expected.file, expected.ops)).toBe(true);
          });
        }
      }
    });
  }
});

describe("lifecycle guard: extractImportedNames", () => {
  it("通常の named import を抽出する", () => {
    const source = `import { foo, bar } from "./module";`;
    expect(extractImportedNames(source)).toEqual(new Set(["foo", "bar"]));
  });

  it("type import を抽出する", () => {
    const source = `import type { Foo, Bar } from "./module";`;
    expect(extractImportedNames(source)).toEqual(new Set(["Foo", "Bar"]));
  });

  it("as による別名がある場合は元の名前を抽出する", () => {
    const source = `import { foo as bar } from "./module";`;
    expect(extractImportedNames(source)).toEqual(new Set(["foo"]));
  });

  it("複数の import 文を処理する", () => {
    const source = [
      `import { a, b } from "./x";`,
      `import { c } from "./y";`,
      `import type { D } from "./z";`,
    ].join("\n");
    expect(extractImportedNames(source)).toEqual(new Set(["a", "b", "c", "D"]));
  });
});
