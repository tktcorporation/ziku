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

import { initTemplateLifecycle, initUserLifecycle } from "../commands/init";
import { pullLifecycle } from "../commands/pull";
import { pushLifecycle } from "../commands/push";
import { diffLifecycle } from "../commands/diff";
import { trackLifecycle } from "../commands/track";

export const lifecycle: readonly CommandLifecycle[] = [
  initTemplateLifecycle,
  initUserLifecycle,
  pullLifecycle,
  pushLifecycle,
  diffLifecycle,
  trackLifecycle,
];

// ──────────────────────────────────────────────
// ドキュメント生成
// ──────────────────────────────────────────────

/** ファイル一覧テーブルを生成 */
function generateFileSummaryTable(): string {
  const files = [
    {
      file: MODULES_FILE,
      location: "テンプレートリポジトリのみ",
      role: "同期対象の glob パターンを定義する「メニュー表」。init 時にユーザーが選ぶモジュール一覧の元データ。push 時にローカル追加パターンが書き戻される",
    },
    {
      file: ZIKU_CONFIG_FILE,
      location: "ユーザーのプロジェクトのみ",
      role: "同期設定。テンプレートの source（owner/repo）と、選択済みの include/exclude パターンを保持。track コマンドで追加可能",
    },
    {
      file: LOCK_FILE,
      location: "ユーザーのプロジェクトのみ",
      role: "同期状態。前回同期時のコミット SHA（baseRef）、ファイルごとの SHA-256 ハッシュ（baseHashes）、未解決マージ情報（pendingMerge）を保持。pull/push の差分検出に使用",
    },
  ];

  const lines = ["| ファイル | 存在する場所 | 役割 |", "|---|---|---|"];
  for (const f of files) {
    lines.push(`| \`${f.file}\` | ${f.location} | ${f.role} |`);
  }
  return lines.join("\n");
}

/** 操作の種類を絵文字付きラベルに変換 */
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

/** Mermaid sequence diagram を生成 */
function generateMermaidDiagram(): string {
  const lines: string[] = [
    "```mermaid",
    "sequenceDiagram",
    "    participant T as Template Repo",
    "    participant U as User Project",
    "",
  ];

  for (const cmd of lifecycle) {
    lines.push(`    note over T,U: ${cmd.name}`);

    for (const op of cmd.ops) {
      const fileLabel = op.file === SYNCED_FILES ? "synced files" : op.file;
      const arrow =
        op.location === "template"
          ? op.op === "read"
            ? `U->>T: read ${fileLabel}`
            : `T->>T: ${op.op} ${fileLabel}`
          : op.op === "read"
            ? `U->>U: read ${fileLabel}`
            : `U->>U: ${op.op} ${fileLabel}`;

      // push の template update は U→T
      if (cmd.name === "push" && op.location === "template" && op.op === "update") {
        lines.push(`    U->>T: ${op.op} ${fileLabel} (PR)`);
      } else {
        lines.push(`    ${arrow}`);
      }
    }
    lines.push("");
  }

  lines.push("```");
  return lines.join("\n");
}

/**
 * ライフサイクルドキュメント全体を生成する。
 * マーカー間に挿入される Markdown を返す。
 */
export function generateLifecycleDocument(): string {
  const sections = [
    "## ファイル一覧\n",
    generateFileSummaryTable(),
    "",
    "## ライフサイクル図\n",
    generateMermaidDiagram(),
    "",
    "## コマンドごとのファイル操作\n",
    generateCommandTables(),
    "## 補足\n",
    "### modules.jsonc の役割\n",
    `\`${MODULES_FILE}\` はテンプレートリポジトリにのみ存在する「メニュー表」。`,
    "同期対象のファイルパターンを、モジュール（名前・説明付きのグループ）として定義する。\n",
    "**init 時**: ユーザーがどのモジュールを使うか選ぶ際の選択肢になる。選択結果はフラット化（モジュール構造を外して glob パターンだけにする）され、",
    `ユーザーのプロジェクトには \`${ZIKU_CONFIG_FILE}\` として保存される。つまり \`${MODULES_FILE}\` 自体はユーザーのプロジェクトにはコピーされない。\n`,
    `**push 時**: ユーザーが \`ziku track\` で追加した新しいパターンがあれば、\`${MODULES_FILE}\` に書き戻される（PR 経由）。`,
    "これにより、他のプロジェクトが init する際にも新パターンが選択肢に含まれるようになる。\n",
    "### ziku.jsonc と modules.jsonc は init 後に独立\n",
    `init が完了すると、\`${ZIKU_CONFIG_FILE}\` のパターンはテンプレートの \`${MODULES_FILE}\` から独立して管理される。`,
    `ユーザーが \`ziku track\` で追加したパターンは \`${ZIKU_CONFIG_FILE}\` にのみ反映され、テンプレートのどのモジュールにも属さない（push するまで）。`,
    `逆に、テンプレート側で \`${MODULES_FILE}\` にモジュールを追加しても、既存ユーザーの \`${ZIKU_CONFIG_FILE}\` には自動反映されない。\n`,
  ];

  return sections.join("\n");
}
