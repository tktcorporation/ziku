/**
 * コマンドごとのファイル操作メタデータ。
 *
 * 背景: ライフサイクルドキュメント（docs/architecture/file-lifecycle.md）を
 * コード定数から動的に生成するための単一の情報源（SSOT）。
 * パス定数を直接インポートしているため、パス変更時にドキュメントが自動追従する。
 *
 * 生成: scripts/generate-readme.ts から呼び出される。
 * 検証: `npm run docs:check` で CI 検証される。
 */

import { MODULES_FILE } from "../modules/loader";
import { LOCK_FILE } from "../utils/lock";
import { ZIKU_CONFIG_FILE } from "../utils/ziku-config";

// ──────────────────────────────────────────────
// 型定義
// ──────────────────────────────────────────────

/** ファイルが存在する場所 */
type Location = "template" | "local";

/** ファイル操作の種類 */
type Op = "read" | "create" | "update";

/** 1 つのファイル操作 */
export interface FileOp {
  /** ファイルパス（定数参照 or リテラル） */
  file: string;
  /** ファイルが存在する場所 */
  location: Location;
  /** 操作の種類 */
  op: Op;
  /** 補足説明 */
  note: string;
}

/** 1 つのコマンドのライフサイクル */
export interface CommandLifecycle {
  /** コマンド名（表示用） */
  name: string;
  /** コマンドの説明 */
  description: string;
  /** ファイル操作のリスト */
  ops: FileOp[];
}

// ──────────────────────────────────────────────
// メタデータ定義
// ──────────────────────────────────────────────

const SYNCED_FILES = "synced files";

export const lifecycle: CommandLifecycle[] = [
  {
    name: "init (template repo)",
    description: "テンプレートリポジトリの初期化",
    ops: [
      {
        file: MODULES_FILE,
        location: "template",
        op: "create",
        note: "デフォルトパターンで生成（既存ならスキップ）",
      },
    ],
  },
  {
    name: "init (user project)",
    description: "ユーザープロジェクトの初期化",
    ops: [
      { file: MODULES_FILE, location: "template", op: "read", note: "モジュール選択 UI に使用" },
      {
        file: ZIKU_CONFIG_FILE,
        location: "local",
        op: "create",
        note: "選択パターンをフラット化して保存",
      },
      {
        file: LOCK_FILE,
        location: "local",
        op: "create",
        note: "ベースコミット SHA + ハッシュを記録",
      },
      {
        file: SYNCED_FILES,
        location: "local",
        op: "create",
        note: "テンプレートからパターンに一致するファイルをコピー",
      },
    ],
  },
  {
    name: "pull",
    description: "テンプレートの最新更新をローカルに反映",
    ops: [
      { file: ZIKU_CONFIG_FILE, location: "local", op: "read", note: "source と patterns を取得" },
      { file: LOCK_FILE, location: "local", op: "read", note: "前回の baseHashes, baseRef を取得" },
      {
        file: SYNCED_FILES,
        location: "template",
        op: "read",
        note: "テンプレートをダウンロードして差分比較",
      },
      {
        file: SYNCED_FILES,
        location: "local",
        op: "update",
        note: "自動更新・新規追加・3-way マージ・削除",
      },
      {
        file: LOCK_FILE,
        location: "local",
        op: "update",
        note: "新しい baseHashes, baseRef で上書き",
      },
    ],
  },
  {
    name: "push",
    description: "ローカルの変更をテンプレートリポジトリに PR として送信",
    ops: [
      { file: ZIKU_CONFIG_FILE, location: "local", op: "read", note: "source と patterns を取得" },
      { file: LOCK_FILE, location: "local", op: "read", note: "baseRef, baseHashes を取得" },
      { file: SYNCED_FILES, location: "local", op: "read", note: "ローカルの変更を検出" },
      {
        file: MODULES_FILE,
        location: "template",
        op: "read",
        note: "テンプレートのパターンと比較し、ローカル追加分を検出",
      },
      {
        file: SYNCED_FILES,
        location: "template",
        op: "read",
        note: "テンプレートをダウンロードして差分検出・3-way マージ",
      },
      {
        file: SYNCED_FILES,
        location: "template",
        op: "update",
        note: "変更ファイルを含む PR を作成",
      },
      {
        file: MODULES_FILE,
        location: "template",
        op: "update",
        note: "ローカルで追加されたパターンがあれば PR に含めて更新",
      },
    ],
  },
  {
    name: "diff",
    description: "ローカルとテンプレートの差分を表示",
    ops: [
      { file: ZIKU_CONFIG_FILE, location: "local", op: "read", note: "patterns を取得" },
      {
        file: SYNCED_FILES,
        location: "local",
        op: "read",
        note: "ローカルファイルを読み取り",
      },
      {
        file: SYNCED_FILES,
        location: "template",
        op: "read",
        note: "テンプレートをダウンロードして比較",
      },
    ],
  },
  {
    name: "track",
    description: "同期対象のパターンを追加",
    ops: [
      {
        file: ZIKU_CONFIG_FILE,
        location: "local",
        op: "read",
        note: "現在の include パターンを取得",
      },
      {
        file: ZIKU_CONFIG_FILE,
        location: "local",
        op: "update",
        note: "新しいパターンを include に追加",
      },
    ],
  },
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
