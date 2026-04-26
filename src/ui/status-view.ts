/**
 * status コマンドの表示ロジック。
 *
 * 純粋に「StatusBuckets + Recommendation を文字列に変換する」関数を提供する。
 * I/O は呼び出し側（status コマンド）で行うため、ここはテストしやすい純粋関数。
 *
 * `git status` のメンタルモデルを踏襲:
 *   - グルーピング (Pull pending / Push pending / Conflict / Untracked)
 *   - 各セクションにアクションヒント "(use \"ziku pull\" to apply)"
 *   - --short モードでは XY 形式の porcelain ライク出力
 */
import { match } from "ts-pattern";
import pc from "picocolors";
import type { EntryCategory, Recommendation, StatusBuckets, StatusEntry } from "../utils/status";

/**
 * カテゴリごとのラベルとカラーの SSOT。
 *
 * `git status` の "modified:" / "new file:" / "deleted:" / "both modified:" を踏襲。
 * `unchanged` は EntryCategory に含まれないため定義不要（型レベルで保証）。
 */
const CATEGORY_LABEL: Record<EntryCategory, string> = {
  autoUpdate: "modified:",
  newFiles: "new file:",
  deletedFiles: "deleted: ",
  localOnly: "modified:",
  deletedLocally: "deleted: ",
  conflicts: "both modified:",
};

function colorForEntry(entry: StatusEntry): (s: string) => string {
  if (entry.isDestructive) return pc.red;
  return match(entry.direction)
    .with("pull", () => pc.cyan)
    .with("push", () => pc.green)
    .with("conflict", () => pc.yellow)
    .exhaustive();
}

/**
 * long モードの section ブロックを生成する。
 * 各 section はタイトル + アクションヒント + ファイル一覧で構成される。
 */
function renderSection(
  icon: string,
  title: string,
  hint: string,
  entries: StatusEntry[],
): string[] {
  if (entries.length === 0) return [];
  const fileLines = entries.map((entry) => {
    const color = colorForEntry(entry);
    const label = CATEGORY_LABEL[entry.category];
    return `    ${color(label)}  ${color(entry.path)}`;
  });
  return [
    `  ${icon} ${pc.bold(title)} (${entries.length})`,
    `    ${pc.dim(hint)}`,
    ...fileLines,
    "",
  ];
}

/**
 * Recommendation を1行ヒントに変換する。`git status` の
 * "(use \"git push\" to publish your local commits)" の感覚。
 *
 * `continueMerge` は conflictCount で2分岐:
 *   - count > 0: 通常の merge resume
 *   - count === 0: 縮退（stale lock）。`pull --continue` でクリアを案内
 */
export function recommendationLine(rec: Recommendation): string {
  return match(rec)
    .with({ kind: "inSync" }, () => `${pc.green("✓")} In sync — nothing to do.`)
    .with(
      { kind: "pullOnly" },
      ({ pullCount }) =>
        `${pc.cyan("→")} Run ${pc.cyan("`ziku pull`")} to apply ${pullCount} incoming change(s).`,
    )
    .with(
      { kind: "pushOnly" },
      ({ pushCount }) =>
        `${pc.green("→")} Run ${pc.green("`ziku push`")} to send ${pushCount} local change(s) to the template.`,
    )
    .with(
      { kind: "pullThenPush" },
      ({ pullCount, pushCount }) =>
        `${pc.yellow("→")} Run ${pc.cyan("`ziku pull`")} (${pullCount}), then ${pc.green("`ziku push`")} (${pushCount}).`,
    )
    .with(
      { kind: "resolveConflict" },
      ({ conflictCount }) =>
        `${pc.yellow("⚠")} Run ${pc.cyan("`ziku pull`")} to start a 3-way merge for ${conflictCount} conflict(s).`,
    )
    .with({ kind: "continueMerge" }, ({ conflictCount }) =>
      conflictCount === 0
        ? `${pc.yellow("⏸")} Stale merge state in lock — run ${pc.cyan("`ziku pull --continue`")} to clear it (push will be blocked otherwise).`
        : `${pc.yellow("⏸")} Merge paused — resolve ${conflictCount} conflict(s) and run ${pc.cyan("`ziku pull --continue`")}.`,
    )
    .exhaustive();
}

export interface UntrackedGroup {
  readonly files: ReadonlyArray<{ path: string }>;
}

export interface StatusViewModel {
  readonly buckets: StatusBuckets;
  readonly untracked: ReadonlyArray<UntrackedGroup>;
  readonly recommendation: Recommendation;
}

/**
 * long モード（git status 風）の出力を生成する。
 * `clack/prompts` の log.message に渡す前提のプレーン文字列を返す。
 *
 * 注: recommendation 行は含めない。コマンド側で `outro(recommendationLine(...))` として
 * 別途レンダリングし、@clack/prompts のフッタとして強調表示する設計のため。
 */
export function renderStatusLong(model: StatusViewModel): string {
  const { buckets, untracked } = model;
  const untrackedFiles = untracked.flatMap((g) => g.files);

  const untrackedLines: string[] =
    untrackedFiles.length === 0
      ? []
      : [
          `  ${pc.dim("?")} ${pc.bold("Untracked")} (outside whitelist) (${untrackedFiles.length})`,
          `    ${pc.dim(`(use "ziku track <pattern>" to include)`)}`,
          ...untrackedFiles.map((file) => `    ${pc.dim("•")} ${pc.dim(file.path)}`),
          "",
        ];

  const isClean =
    buckets.pull.length === 0 &&
    buckets.push.length === 0 &&
    buckets.conflict.length === 0 &&
    untrackedFiles.length === 0;
  const cleanLines = isClean
    ? [
        `  ${pc.green("✓")} Tracked files are in sync (${buckets.inSyncCount} file(s) match template).`,
      ]
    : [];

  return [
    ...renderSection(
      "⬇",
      "Pull pending — template has changes",
      `(use "ziku pull" to apply)`,
      buckets.pull,
    ),
    ...renderSection(
      "⬆",
      "Push pending — local has changes",
      `(use "ziku push" to send)`,
      buckets.push,
    ),
    ...renderSection(
      "⚠",
      "Conflict — both sides changed",
      `(use "ziku pull" to start a 3-way merge)`,
      buckets.conflict,
    ),
    ...untrackedLines,
    ...cleanLines,
  ].join("\n");
}

/**
 * short / porcelain モード。1ファイル1行の `XY <path>` 形式。
 *
 * X (template 側), Y (local 側):
 *   - "M": modified, "A": added, "D": deleted, "U": both modified, "?": untracked
 *
 * 例:
 *   " M .mcp.json"          (template-modified, locally unchanged base — autoUpdate)
 *   " A new.md"             (template-added)
 *   " D old.md"             (template-deleted)
 *   "M  settings.json"      (locally-modified)
 *   "D  removed.md"         (locally-deleted)
 *   "UU both.md"            (conflict)
 *   "?? draft.md"           (untracked)
 *
 * 注: `unchanged` は EntryCategory に含まれないため、shortCodeFor の入力には現れない。
 */
function shortCodeFor(entry: StatusEntry): string {
  return match(entry.category)
    .with("autoUpdate", () => " M")
    .with("newFiles", () => " A")
    .with("deletedFiles", () => " D")
    .with("localOnly", () => "M ")
    .with("deletedLocally", () => "D ")
    .with("conflicts", () => "UU")
    .exhaustive();
}

export function renderStatusShort(model: StatusViewModel): string {
  const lines: string[] = [];
  // 順序は git -s の慣習（Conflict → Push → Pull → Untracked）ではなく、
  // ziku の主要関心事（Pull → Push → Conflict → Untracked）に合わせる。
  for (const entry of model.buckets.pull) lines.push(`${shortCodeFor(entry)} ${entry.path}`);
  for (const entry of model.buckets.push) lines.push(`${shortCodeFor(entry)} ${entry.path}`);
  for (const entry of model.buckets.conflict) lines.push(`${shortCodeFor(entry)} ${entry.path}`);
  for (const group of model.untracked) {
    for (const file of group.files) lines.push(`?? ${file.path}`);
  }
  return lines.join("\n");
}
