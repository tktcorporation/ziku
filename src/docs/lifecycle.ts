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
import type { CommandLifecycle, FileOp, Location, Op } from "./lifecycle-types";

// ──────────────────────────────────────────────
// 各コマンドからライフサイクルを集約
// ──────────────────────────────────────────────

import { aggregateLifecycle } from "../commands/aggregate";
import { initUserLifecycle } from "../commands/init";
import { pullLifecycle } from "../commands/pull";
import { pushLifecycle } from "../commands/push";
import { setupLifecycle } from "../commands/setup";
import { diffLifecycle } from "../commands/diff";
import { statusLifecycle } from "../commands/status";
import { trackLifecycle } from "../commands/track";
import type { SubCommandName } from "../commands/names";

/**
 * サブコマンドごとのライフサイクル定義。
 *
 * `Record<SubCommandName, ...>` にしているのは、コマンドを足したときにここへの登録が
 * コンパイルエラーになるようにするため。素の配列だと登録漏れが検知できず、生成される
 * ドキュメントからそのコマンドが黙って消える。
 *
 * 宣言順がそのままドキュメントの節の並びになる（{@link lifecycle} が値の順を引き継ぐ）。
 */
export const LIFECYCLE_BY_COMMAND: Record<SubCommandName, CommandLifecycle> = {
  setup: setupLifecycle,
  init: initUserLifecycle,
  pull: pullLifecycle,
  push: pushLifecycle,
  diff: diffLifecycle,
  status: statusLifecycle,
  track: trackLifecycle,
  aggregate: aggregateLifecycle,
};

export const lifecycle: readonly CommandLifecycle[] = Object.values(LIFECYCLE_BY_COMMAND);

// ──────────────────────────────────────────────
// ドキュメント生成
// ──────────────────────────────────────────────

/**
 * 操作の種類の表示ラベル。
 *
 * `Record<Op, string>` にしているのは、`Op` に値を足したときにラベルの登録が
 * コンパイルエラーになるようにするため。既定値へ落とす分岐にすると、ラベルの無い操作が
 * 生の識別子のままドキュメントへ出る。
 */
export const OP_LABELS: Record<Op, string> = {
  read: "読み取り",
  create: "作成",
  update: "更新",
};

/**
 * ファイル別表で行を並べる順。
 *
 * `Record<Op, number>` にしているのは、`Op` に値を足したときに順序の登録が
 * コンパイルエラーになるようにするため。順序が決まっていないと、ops と無関係に行が
 * 入れ替わった生成物で `docs:check` が落ちる。
 */
const OP_ROW_ORDER: Record<Op, number> = {
  read: 0,
  create: 1,
  update: 2,
};

/**
 * 図の矢印の種類。読み取りだけ点線にして、状態を変える操作と見分けられるようにする。
 *
 * `Record<Op, string>` にしているのは、`Op` に値を足したときに矢印の登録が
 * コンパイルエラーになるようにするため。
 */
const OP_ARROWS: Record<Op, string> = {
  read: "-.->",
  create: "-->",
  update: "-->",
};

/** 図の subgraph と、表・図での場所の並び順。 */
interface LocationView {
  /** mermaid の subgraph ID */
  readonly subgraphId: string;
  /** subgraph の表示名 */
  readonly title: string;
  /**
   * ノード ID の接頭辞。
   *
   * 同じファイルがテンプレートとユーザープロジェクトの両方に存在し、図では別ノードに
   * なるため、場所で ID を分ける。
   */
  readonly nodePrefix: string;
  /** 図の subgraph と表の行の並び順 */
  readonly order: number;
}

/**
 * 場所ごとの表示定義。
 *
 * `Record<Location, LocationView>` にしているのは、場所を足したときに登録が
 * コンパイルエラーになるようにするため。
 */
const LOCATION_VIEWS: Record<Location, LocationView> = {
  template: { subgraphId: "Template", title: "Template Repository", nodePrefix: "T", order: 0 },
  local: { subgraphId: "User", title: "User Project", nodePrefix: "U", order: 1 },
  // ローカルに取得せず GitHub API 経由でのみ読む、テンプレートを使う複数のリポジトリ。
  // 1 つのディレクトリに対応しないので、図でも template / local と別の枠に置く。
  remote: { subgraphId: "Consumers", title: "Consumer Repositories", nodePrefix: "R", order: 2 },
};

/**
 * ファイルの役割。ops から導けない唯一の散文なので、ここに持つ。
 *
 * `Record` ではなく `Map` なのは、パス定数が brand 付きの `string` でリテラル型ではなく、
 * `Record` のキーとして網羅を強制できないため。役割を持たないファイルは見出しと表だけを出す。
 */
const FILE_ROLES: ReadonlyMap<string, string> = new Map<string, string>([
  [
    ZIKU_CONFIG_FILE,
    "同期対象パターン定義（include/exclude）。テンプレートとユーザーで同一フォーマット",
  ],
  [LOCK_FILE, "同期状態 + ソース情報（source, sync, base, merge）"],
  [SYNCED_FILES, "パターンに一致する実際のファイル群（.claude/rules/*.md など）"],
]);

/** 表示用のファイル名。実パスはコード表記にし、概念的なラベルはそのまま出す。 */
function formatFile(file: string): string {
  return file === SYNCED_FILES ? SYNCED_FILES : `\`${file}\``;
}

/**
 * mermaid のノード ID を作る。
 *
 * パスには mermaid の ID に使えない文字（`.` `/` 空白）が含まれるので英数字以外を潰し、
 * 場所の接頭辞を付けて一意にする。
 */
function nodeId(op: FileOp): string {
  const slug = op.file
    .replaceAll(/[^A-Za-z0-9]+/g, "_")
    .replaceAll(/^_+|_+$/g, "")
    .toUpperCase();
  return `${LOCATION_VIEWS[op.location].nodePrefix}_${slug}`;
}

/**
 * コンポーネント（ファイル）一覧と、各コマンドとの関係を示す mermaid 図を生成。
 * file-lifecycle.md と README の両方で使用される（SSOT）。
 *
 * ノードもエッジも ops から導く。図を手書きすると、コマンドが宣言した操作が図に現れない
 * （テンプレートの README を書き換えるエッジが落ちる等）ずれが起きる。
 */
export function generateComponentDiagram(): string {
  /** 場所 → ノード ID → ラベル。ノードの並びは ops への初出順。 */
  const nodesByLocation = new Map<Location, Map<string, string>>();
  const edges: string[] = [];

  for (const [command, cmd] of Object.entries(LIFECYCLE_BY_COMMAND)) {
    /** 操作 → 宛先ノード ID。同じ操作の宛先は mermaid の `A & B` 記法で 1 本にまとめる。 */
    const targetsByOp = new Map<Op, string[]>();

    for (const op of cmd.ops) {
      const id = nodeId(op);

      const nodes = nodesByLocation.get(op.location) ?? new Map<string, string>();
      nodesByLocation.set(op.location, nodes);
      nodes.set(id, op.file);

      const targets = targetsByOp.get(op.op) ?? [];
      targetsByOp.set(op.op, targets);
      if (!targets.includes(id)) targets.push(id);
    }

    let shapeDeclared = false;
    for (const [op, targets] of targetsByOp) {
      // コマンドのノード形状は初出のエッジでだけ宣言する（2 回目以降は ID だけで参照する）。
      const from = shapeDeclared ? command : `${command}([${command}])`;
      shapeDeclared = true;
      edges.push(`  ${from} ${OP_ARROWS[op]}|${op}| ${targets.join(" & ")}`);
    }
  }

  const subgraphs = [...nodesByLocation].toSorted(
    ([a], [b]) => LOCATION_VIEWS[a].order - LOCATION_VIEWS[b].order,
  );

  const lines: string[] = ["```mermaid", "graph TB", ""];
  for (const [location, nodes] of subgraphs) {
    const view = LOCATION_VIEWS[location];
    lines.push(`  subgraph ${view.subgraphId}["${view.title}"]`);
    for (const [id, label] of nodes) {
      lines.push(`    ${id}["${label}"]`);
    }
    lines.push("  end", "");
  }
  lines.push(...edges, "", "```");

  return lines.join("\n");
}

/** ファイル別表の 1 行: ある場所のそのファイルへ、その操作をするコマンドの一覧。 */
interface FileUsageRow {
  readonly op: Op;
  readonly location: Location;
  readonly commands: string[];
}

/**
 * ファイルごとのライフサイクル表を生成。
 *
 * ops をファイルで束ね、操作 × 場所ごとに「どのコマンドがそれをするか」を集計する。
 * 各操作の詳細（note）はコマンド別表が持つので、ここでは繰り返さない。
 */
function generateFileLifecycleTable(): string {
  /** ファイル → 操作 → 場所 → コマンド名。ファイルの並びは ops への初出順。 */
  const usageByFile = new Map<string, Map<Op, Map<Location, string[]>>>();

  for (const [command, cmd] of Object.entries(LIFECYCLE_BY_COMMAND)) {
    for (const op of cmd.ops) {
      const byOp = usageByFile.get(op.file) ?? new Map<Op, Map<Location, string[]>>();
      usageByFile.set(op.file, byOp);

      const byLocation = byOp.get(op.op) ?? new Map<Location, string[]>();
      byOp.set(op.op, byLocation);

      const commands = byLocation.get(op.location) ?? [];
      byLocation.set(op.location, commands);
      // 同じコマンドが同じファイルへ同じ操作を複数回宣言していても、表には 1 度だけ出す。
      if (!commands.includes(command)) commands.push(command);
    }
  }

  const sections: string[] = [];

  for (const [file, byOp] of usageByFile) {
    sections.push(`### ${formatFile(file)}\n`);

    const role = FILE_ROLES.get(file);
    if (role !== undefined) sections.push(`**役割:** ${role}\n`);

    sections.push("| 操作 | 場所 | コマンド |");
    sections.push("|---|---|---|");

    const rows: FileUsageRow[] = [...byOp].flatMap(([op, byLocation]) =>
      [...byLocation].map(([location, commands]) => ({ op, location, commands })),
    );
    const sorted = rows.toSorted((a, b) => {
      const byOpOrder = OP_ROW_ORDER[a.op] - OP_ROW_ORDER[b.op];
      if (byOpOrder !== 0) return byOpOrder;
      return LOCATION_VIEWS[a.location].order - LOCATION_VIEWS[b.location].order;
    });

    for (const row of sorted) {
      const commands = row.commands.map((command) => `\`${command}\``).join(", ");
      sections.push(`| ${OP_LABELS[row.op]} | ${row.location} | ${commands} |`);
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
      sections.push(
        `| ${OP_LABELS[op.op]} | ${formatFile(op.file)} | ${op.location} | ${op.note} |`,
      );
    }
    sections.push("");
  }

  return sections.join("\n");
}

/**
 * ライフサイクルドキュメント全体を生成する。
 * マーカー間に挿入される Markdown を返す。
 */
/**
 * 各コマンドの notes フィールドから「補足」セクションを自動生成する。
 *
 * notes をコマンドの実装ファイルへ置くことで、挙動を変えたときに説明も同じ差分に
 * 現れる。ドキュメント側に散文で持つと、実装だけが変わって説明が嘘になる。
 */
function generateNotesSection(): string {
  const commandsWithNotes = lifecycle.filter(
    (cmd) => cmd.notes !== undefined && cmd.notes.length > 0,
  );
  if (commandsWithNotes.length === 0) return "";

  const lines: string[] = ["## 補足\n"];
  for (const cmd of commandsWithNotes) {
    lines.push(`### ${cmd.name}\n`);
    for (const note of cmd.notes ?? []) {
      lines.push(`${note}\n`);
    }
  }
  return lines.join("\n");
}

export function generateLifecycleDocument(): string {
  const sections = [
    "## コンポーネント関係図\n",
    generateComponentDiagram(),
    "",
    "## ファイルごとのライフサイクル\n",
    generateFileLifecycleTable(),
    "## コマンドごとのファイル操作\n",
    generateCommandTables(),
    generateNotesSection(),
  ];

  return sections.join("\n");
}
