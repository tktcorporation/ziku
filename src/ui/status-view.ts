/**
 * status コマンドの表示ロジック。
 *
 * 純粋に「StatusBuckets + Recommendation を文字列に変換する」関数を提供する。
 * I/O は呼び出し側（status コマンド）で行うため、ここはテストしやすい純粋関数。
 *
 * `git status` のメンタルモデルを踏襲:
 *   - グルーピング (Pull pending / Push pending / Conflict / Untracked)
 *   - 各セクションにアクションヒント "(use \"ziku pull\" to apply)"
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
  deletedWithLocalEdits: "deleted in template, edited locally:",
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
    .with(
      { kind: "continueMerge" },
      ({ conflictCount }) =>
        `${pc.yellow("⏸")} Merge paused — resolve ${conflictCount} conflict(s) and run ${pc.cyan("`ziku pull --continue`")}.`,
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
  const { buckets, untracked, recommendation } = model;
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

  // isClean は decideRecommendation の結論をそのまま尊重する SSOT 設計。
  //
  // recommendation.kind === "inSync" はすでに「全バケツ空 + 解決待ち無し」を意味する
  // (decideRecommendation 側で集約済み)。ここで bucket や untracked を再評価すると、
  // 新しい pull-pending 信号 (例: コンフリクト解決待ち) を decideRecommendation に
  // 追加するたびにこの条件式も同期更新する必要が出てしまい、矛盾の温床になる。
  //
  // untracked は「Tracked files are in sync」というメッセージとは独立。
  // 「追跡対象は in sync、それ以外は別途」という直交した情報なので、両方表示してよい。
  const isClean = recommendation.kind === "inSync";

  // conflict section のアクションヒントは recommendation 種別で出し分ける。
  // 解決待ち中の場合は新規 merge ではなく `pull --continue` を案内する
  // (解決待ちなのに「3-way merge を始めろ」と促す矛盾したヒントを出さないため)。
  const conflictHint =
    recommendation.kind === "continueMerge"
      ? `(resolve and run "ziku pull --continue")`
      : `(use "ziku pull" to start a 3-way merge)`;
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
    ...renderSection("⚠", "Conflict — both sides changed", conflictHint, buckets.conflict),
    ...untrackedLines,
    ...cleanLines,
  ].join("\n");
}
