/**
 * コマンドごとのファイル操作メタデータの集約とドキュメント生成。
 *
 * 背景: ライフサイクルドキュメント（docs/architecture/file-lifecycle.md）を
 * コード定数から動的に生成するための単一の情報源（SSOT）。
 *
 * 各コマンドのライフサイクル定義は、コマンドファイル自身にコロケーション
 * されている（例: src/commands/diff.ts の diffLifecycle）。
 * このファイルはそれらを集約し、Markdown ドキュメントを生成する。
 *
 * 生成: scripts/generate-readme.ts から呼び出される。
 * 検証: `npm run docs:check` で CI 検証される。
 */

import { MODULES_FILE } from "../modules/loader";
import { LOCK_FILE } from "../utils/lock";
import { ZIKU_CONFIG_FILE } from "../utils/ziku-config";

// 型の re-export（外部消費者の互換性維持）
export type { FileOp, CommandLifecycle, Location, Op } from "./lifecycle-types";
export { SYNCED_FILES } from "./lifecycle-types";
import { SYNCED_FILES } from "./lifecycle-types";
import type { CommandLifecycle, Op } from "./lifecycle-types";

// ──────────────────────────────────────────────
// 各コマンドからライフサイクルを集約
// ──────────────────────────────────────────────

import { initUserLifecycle } from "../commands/init";
import { pullLifecycle } from "../commands/pull";
import { pushLifecycle } from "../commands/push";
import { setupLifecycle } from "../commands/setup";
import { diffLifecycle } from "../commands/diff";
import { trackLifecycle } from "../commands/track";

export const lifecycle: readonly CommandLifecycle[] = [
  setupLifecycle,
  initUserLifecycle,
  pullLifecycle,
  pushLifecycle,
  diffLifecycle,
  trackLifecycle,
];

// ──────────────────────────────────────────────
// ドキュメント生成
// ──────────────────────────────────────────────

/** 操作の種類をラベルに変換 */
function opLabel(op: Op): string {
  switch (op) {
    case "read":
      return "読み取り";
    case "create":
      return "作成";
    case "update":
      return "更新";
  }
}

/** コンポーネント（ファイル）一覧と、各コマンドとの関係を示す図を生成 */
function generateComponentDiagram(): string {
  const lines: string[] = [
    "```mermaid",
    "graph LR",
    "",
    '  subgraph Template["テンプレートリポジトリ"]',
    `    MODULES["${MODULES_FILE}"]`,
    '    T_FILES["synced files"]',
    "  end",
    "",
    '  subgraph User["ユーザープロジェクト"]',
    `    ZIKU["${ZIKU_CONFIG_FILE}"]`,
    `    LOCK["${LOCK_FILE}"]`,
    '    U_FILES["synced files"]',
    "  end",
    "",
    "  setup -->|create| MODULES",
    "  init -->|read| MODULES",
    "  init -->|create| ZIKU",
    "  init -->|create| LOCK",
    "  init -->|create| U_FILES",
    "  pull -->|read| ZIKU",
    "  pull -->|read| LOCK",
    "  pull -->|update| U_FILES",
    "  pull -->|update| LOCK",
    "  push -->|read| ZIKU",
    "  push -->|read| LOCK",
    "  push -->|read| MODULES",
    "  push -->|PR| T_FILES",
    "  diff -->|read| ZIKU",
    "  diff -->|read| U_FILES",
    "  track -->|update| ZIKU",
    "",
    "```",
  ];

  return lines.join("\n");
}

/** ファイルごとのライフサイクル表を生成 */
function generateFileLifecycleTable(): string {
  const files = [
    {
      file: MODULES_FILE,
      location: "テンプレートリポジトリ",
      description: "モジュール定義（Claude Code ルール、MCP 設定などのグループ）",
      lifecycle: [
        { phase: "生成", detail: "`ziku setup` でデフォルトモジュールを含む初期ファイルを作成" },
        { phase: "読み取り", detail: "`ziku init` でモジュール選択 UI のデータとして使用" },
        { phase: "読み取り", detail: "`ziku push` でテンプレートのパターンとローカルの差分を検出" },
      ],
    },
    {
      file: ZIKU_CONFIG_FILE,
      location: "ユーザープロジェクト",
      description: "同期設定（source + 選択済み include/exclude パターン）",
      lifecycle: [
        { phase: "生成", detail: "`ziku init` でモジュール選択結果をフラット化して保存" },
        {
          phase: "読み取り",
          detail: "`pull` / `push` / `diff` でパターンとテンプレート情報を取得",
        },
        { phase: "更新", detail: "`ziku track` で新しいパターンを追加" },
      ],
    },
    {
      file: LOCK_FILE,
      location: "ユーザープロジェクト",
      description: "同期状態（baseRef, baseHashes, pendingMerge）",
      lifecycle: [
        { phase: "生成", detail: "`ziku init` でテンプレートのコミット SHA とハッシュを記録" },
        { phase: "読み取り", detail: "`pull` / `push` で前回同期状態との差分検出に使用" },
        { phase: "更新", detail: "`ziku pull` で最新のベースに更新" },
      ],
    },
    {
      file: "synced files",
      location: "両方",
      description: "パターンに一致する実際のファイル群（.claude/rules/*.md など）",
      lifecycle: [
        { phase: "生成", detail: "`ziku init` でテンプレートからコピー" },
        { phase: "更新", detail: "`ziku pull` で 3-way マージにより同期" },
        { phase: "更新", detail: "`ziku push` でローカル変更を PR としてテンプレートに送信" },
      ],
    },
  ];

  const sections: string[] = [];

  for (const f of files) {
    const fileDisplay = f.file === "synced files" ? "synced files" : `\`${f.file}\``;
    sections.push(`### ${fileDisplay}\n`);
    sections.push(`**場所:** ${f.location}  `);
    sections.push(`**役割:** ${f.description}\n`);
    sections.push("| フェーズ | 詳細 |");
    sections.push("|---|---|");
    for (const lc of f.lifecycle) {
      sections.push(`| ${lc.phase} | ${lc.detail} |`);
    }
    sections.push("");
  }

  return sections.join("\n");
}

/** コマンドごとの操作テーブルを生成 */
function generateCommandTables(): string {
  const sections: string[] = [];

  for (const cmd of lifecycle) {
    sections.push(`### \`${cmd.name}\`\n`);
    sections.push(`${cmd.description}\n`);
    sections.push("| 操作 | ファイル | 場所 | 詳細 |");
    sections.push("|---|---|---|---|");
    for (const op of cmd.ops) {
      const loc = op.location === "template" ? "template" : "local";
      const fileDisplay = op.file === SYNCED_FILES ? "synced files" : `\`${op.file}\``;
      sections.push(`| ${opLabel(op.op)} | ${fileDisplay} | ${loc} | ${op.note} |`);
    }
    sections.push("");
  }

  return sections.join("\n");
}

/**
 * ライフサイクルドキュメント全体を生成する。
 * マーカー間に挿入される Markdown を返す。
 */
export function generateLifecycleDocument(): string {
  const sections = [
    "## コンポーネント関係図\n",
    generateComponentDiagram(),
    "",
    "## ファイルごとのライフサイクル\n",
    generateFileLifecycleTable(),
    "## コマンドごとのファイル操作\n",
    generateCommandTables(),
    "## 補足\n",
    "### modules.jsonc と ziku.jsonc の関係\n",
    `\`${MODULES_FILE}\` はテンプレートリポジトリにのみ存在する「メニュー表」。`,
    `\`${ZIKU_CONFIG_FILE}\` はユーザープロジェクトにのみ存在する「選択結果」。\n`,
    `\`ziku setup\` → テンプレートリポに \`${MODULES_FILE}\` を作成`,
    `\`ziku init\` → \`${MODULES_FILE}\` を読み、モジュール選択 → 結果を \`${ZIKU_CONFIG_FILE}\` に保存\n`,
    `\`${MODULES_FILE}\` 自体はユーザーのプロジェクトにはコピーされない。`,
    `init 後、\`${ZIKU_CONFIG_FILE}\` は \`${MODULES_FILE}\` から独立して管理される。\n`,
    "### init 後の独立性\n",
    `ユーザーが \`ziku track\` で追加したパターンは \`${ZIKU_CONFIG_FILE}\` にのみ反映される。`,
    `テンプレート側で \`${MODULES_FILE}\` にモジュールを追加しても、既存ユーザーの \`${ZIKU_CONFIG_FILE}\` には自動反映されない。`,
    `最新のモジュールを取り込むには \`ziku init\` を再実行する。\n`,
  ];

  return sections.join("\n");
}
