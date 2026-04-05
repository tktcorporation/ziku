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

/**
 * コンポーネント（ファイル）一覧と、各コマンドとの関係を示す mermaid 図を生成。
 * file-lifecycle.md と README の両方で使用される（SSOT）。
 */
export function generateComponentDiagram(): string {
  const lines: string[] = [
    "```mermaid",
    "graph TB",
    "",
    `  subgraph Template["Template Repository"]`,
    `    ZIKU_TPL["${ZIKU_CONFIG_FILE}"]`,
    `    T_FILES["synced files"]`,
    "  end",
    "",
    `  subgraph User["User Project"]`,
    `    ZIKU["${ZIKU_CONFIG_FILE}"]`,
    `    LOCK["${LOCK_FILE}"]`,
    `    U_FILES["synced files"]`,
    "  end",
    "",
    "  setup([setup]) -->|create| ZIKU_TPL",
    "  init([init]) -->|read| ZIKU_TPL",
    "  init -->|create| ZIKU & LOCK & U_FILES",
    "  push([push]) -->|read| ZIKU & LOCK",
    "  push -->|update| T_FILES",
    "  pull([pull]) -->|read| ZIKU & LOCK",
    "  pull -->|update| U_FILES & ZIKU & LOCK",
    "  diff([diff]) -.->|read| ZIKU & LOCK & U_FILES",
    "  track([track]) -.->|update| ZIKU",
    "",
    "```",
  ];

  return lines.join("\n");
}

/** ファイルごとのライフサイクル表を生成 */
function generateFileLifecycleTable(): string {
  const files = [
    {
      file: ZIKU_CONFIG_FILE,
      location: "両方（テンプレート + ユーザー）",
      description:
        "同期対象パターン定義（include/exclude）。テンプレートとユーザーで同一フォーマット",
      lifecycle: [
        {
          phase: "生成",
          detail: "`ziku setup` でデフォルトパターンを含む初期ファイルをテンプレートに作成",
        },
        {
          phase: "読み取り",
          detail:
            "`ziku init` でテンプレートのパターンを読み、ディレクトリ選択 UI のデータとして使用",
        },
        { phase: "生成", detail: "`ziku init` で選択結果をユーザープロジェクトに保存" },
        {
          phase: "読み取り",
          detail: "`pull` / `push` / `diff` でパターンを取得",
        },
        { phase: "更新", detail: "`ziku track` で新しいパターンを追加" },
      ],
    },
    {
      file: LOCK_FILE,
      location: "ユーザープロジェクト",
      description: "同期状態 + ソース情報（source, baseRef, baseHashes, pendingMerge）",
      lifecycle: [
        {
          phase: "生成",
          detail: "`ziku init` でソース情報 + テンプレートのコミット SHA とハッシュを記録",
        },
        {
          phase: "読み取り",
          detail: "`pull` / `push` / `diff` でソースと前回同期状態との差分検出に使用",
        },
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
    "### ziku.jsonc の役割\n",
    `\`${ZIKU_CONFIG_FILE}\` はテンプレートとユーザープロジェクトの両方に存在する。`,
    "同一フォーマット（include/exclude パターンのみ）で、source 情報は含まない。\n",
    `\`ziku setup\` → テンプレートリポに \`${ZIKU_CONFIG_FILE}\` を作成`,
    `\`ziku init\` → テンプレートの \`${ZIKU_CONFIG_FILE}\` を読み、ディレクトリ選択 → 結果をユーザーの \`${ZIKU_CONFIG_FILE}\` に保存\n`,
    "### source 情報の分離\n",
    `テンプレートの取得元（owner/repo またはローカルパス）は \`${LOCK_FILE}\` に保存される。`,
    `これにより \`${ZIKU_CONFIG_FILE}\` はテンプレート・ユーザー間で完全に同一フォーマットになる。\n`,
    "### init 後の独立性\n",
    `ユーザーが \`ziku track\` で追加したパターンは \`${ZIKU_CONFIG_FILE}\` にのみ反映される。`,
    `テンプレート側で \`${ZIKU_CONFIG_FILE}\` にパターンを追加しても、既存ユーザーの \`${ZIKU_CONFIG_FILE}\` には自動反映されない。`,
    `最新のパターンを取り込むには \`ziku init\` を再実行する。\n`,
  ];

  return sections.join("\n");
}
