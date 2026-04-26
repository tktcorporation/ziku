import { match } from "ts-pattern";
import type { LockState } from "../modules/schemas";
import type { FileClassification } from "./merge/types";

/**
 * ステータス表示で使う「方向」のラベル。
 *
 * 7カテゴリ（FileClassification）を UX 上の3方向に集約するためのキー。
 * - "pull"  : テンプレート側で起きた変更を取り込む方向
 * - "push"  : ローカル側で起きた変更をテンプレートに送る方向
 * - "conflict" : 双方が変更しており、3-way merge が必要
 */
export type StatusDirection = "pull" | "push" | "conflict";

/**
 * ファイル単位のステータスエントリ。
 *
 * UI は `direction` でグルーピング、`category` で「modified / new file / deleted」等の
 * ラベルを描き分け、`isDestructive` で破壊的変更（テンプレ側削除・ローカル側削除）を
 * 警告表示する。
 */
export interface StatusEntry {
  readonly path: string;
  readonly direction: StatusDirection;
  readonly category: keyof FileClassification;
  /**
   * 破壊的（ファイル削除を伴う）変更か。
   *
   * UI は `git status` の "deleted" のように赤系で目立たせ、必要なら確認プロンプトの
   * トリガにする。`deletedFiles` (テンプレ側削除→pull) と `deletedLocally`
   * (ローカル側削除→push --includeDeletions で反映) が true。
   */
  readonly isDestructive: boolean;
}

/**
 * 集計済みステータス。
 *
 * 配列はそれぞれ direction でフィルタ済み。並びは categorizeForStatus が
 * path 昇順でソートした結果になる（決定論的出力でスナップショットテストや
 * grep フィルタを安定させるため）。
 */
export interface StatusBuckets {
  readonly pull: StatusEntry[];
  readonly push: StatusEntry[];
  readonly conflict: StatusEntry[];
  /**
   * 完全一致しているファイル数。表示には使わないが
   * 「全部合わせて N ファイル中 K ファイル out-of-sync」を出したい時のために保持。
   */
  readonly inSyncCount: number;
}

/**
 * 推奨アクション。discriminated union として表現することで、
 * UI 側で `match().exhaustive()` により網羅チェックを効かせる。
 *
 * - inSync           : 何もすることがない
 * - pullOnly         : pull だけで十分
 * - pushOnly         : push だけで十分
 * - pullThenPush     : 先に pull、その後 push（順序が重要なので分岐させている）
 * - resolveConflict  : conflict があるので pull で 3-way merge を始める
 * - continueMerge    : pendingMerge 中。`ziku pull --continue` で再開
 */
export type Recommendation =
  | { readonly kind: "inSync" }
  | { readonly kind: "pullOnly"; readonly pullCount: number }
  | { readonly kind: "pushOnly"; readonly pushCount: number }
  | {
      readonly kind: "pullThenPush";
      readonly pullCount: number;
      readonly pushCount: number;
    }
  | {
      readonly kind: "resolveConflict";
      readonly conflictCount: number;
      readonly pullCount: number;
      readonly pushCount: number;
    }
  | { readonly kind: "continueMerge"; readonly conflictCount: number };

/**
 * exit code 戦略の SSOT。`--exit-code` 指定時の終了コードをここに集約する。
 *
 * - SYNC: 完全 in-sync
 * - OUT_OF_SYNC: 何らかの差分 (pull/push/conflict) がある
 * - PENDING_MERGE: pendingMerge 中（最も注意が必要な状態）
 *
 * 値は git status と意図を揃えており、CI ユーザーが `if rc -ne 0` で out-of-sync を
 * 検知できるようにしている。`PENDING_MERGE` を別値にしているのは、CI 上で
 * 「pull --continue 必要」を `2` で識別したいユースケース向け。
 */
export const STATUS_EXIT_CODE = {
  SYNC: 0,
  OUT_OF_SYNC: 1,
  PENDING_MERGE: 2,
} as const;
export type StatusExitCode = (typeof STATUS_EXIT_CODE)[keyof typeof STATUS_EXIT_CODE];

// ────────────────────────────────────────────────────────────────
// (A) categorizeForStatus
// ────────────────────────────────────────────────────────────────

/**
 * FileClassification の 7 カテゴリ → 3方向 の SSOT マッピング。
 *
 * `null` 戻りは「unchanged は inSyncCount にのみ反映、どのバケツにも入れない」
 * を意味する。export してマッピング変更時のデグレを単体テストできるようにしている。
 *
 * 設計意図:
 *   - autoUpdate / newFiles / deletedFiles はすべて「テンプレート起点の変更」
 *     なので pull で取り込む（deletedFiles は破壊的なので isDestructive で警告）
 *   - localOnly / deletedLocally はすべて「ローカル起点の変更」なので push で送る
 *     （deletedLocally は push --includeDeletions で実反映。
 *      status の役割は「方向を見せる」ことなので、フラグの有無は別問題として扱う）
 *   - conflicts は両方変更されているので merge 必要
 */
export function directionOfCategory(category: keyof FileClassification): StatusDirection | null {
  return match(category)
    .with("autoUpdate", "newFiles", "deletedFiles", () => "pull" as const)
    .with("localOnly", "deletedLocally", () => "push" as const)
    .with("conflicts", () => "conflict" as const)
    .with("unchanged", () => null)
    .exhaustive();
}

/**
 * 削除を伴うカテゴリかどうかを判定する。
 *
 * UI が破壊的操作を警告表示するために StatusEntry.isDestructive にコピーする。
 * `deletedFiles` (テンプレ側削除) と `deletedLocally` (ローカル側削除) が破壊的。
 */
export function isDestructiveCategory(category: keyof FileClassification): boolean {
  return category === "deletedFiles" || category === "deletedLocally";
}

/** path 昇順比較。決定論的出力のためバケツ内ソートに使う。 */
const byPath = (a: StatusEntry, b: StatusEntry): number => a.path.localeCompare(b.path);

/**
 * FileClassification の 7 カテゴリを、UX の3方向（pull / push / conflict）に集約する。
 *
 * push.ts は内部で `localOnly + conflicts + deletedLocally` を pushable として扱うが、
 * status は conflict を別バケツとして表示する点が異なる（「次に何をすべきか」を
 * 強調するため、両方変更されたファイルは "modify both sides" として目立たせる）。
 *
 * 並び: 各バケツ内は path 昇順。
 */
export function categorizeForStatus(classification: FileClassification): StatusBuckets {
  const pull: StatusEntry[] = [];
  const push: StatusEntry[] = [];
  const conflict: StatusEntry[] = [];
  // direction → 受け皿配列のルックアップ。直接 push() するため二重 match を回避。
  const bucketOf: Record<StatusDirection, StatusEntry[]> = { pull, push, conflict };

  for (const cat of Object.keys(classification) as Array<keyof FileClassification>) {
    const direction = directionOfCategory(cat);
    if (!direction) continue;
    const isDestructive = isDestructiveCategory(cat);
    for (const path of classification[cat]) {
      bucketOf[direction].push({ path, direction, category: cat, isDestructive });
    }
  }

  return {
    pull: pull.toSorted(byPath),
    push: push.toSorted(byPath),
    conflict: conflict.toSorted(byPath),
    inSyncCount: classification.unchanged.length,
  };
}

// ────────────────────────────────────────────────────────────────
// (B) decideRecommendation
// ────────────────────────────────────────────────────────────────

/**
 * バケツと lock の状態から「次にすべきアクション」を1つ決める。
 *
 * 優先度（上から評価）:
 *   1. pendingMerge があれば continueMerge（最優先；他の差分より先に解決すべき）
 *      - ただし conflicts.length === 0 のレアケース（--continue 直前にプロセスが
 *        死んだ場合）では continueMerge を選ばず、通常フローで再評価する
 *   2. conflict があれば resolveConflict（pull --continue ではなく新規 pull で merge を開始）
 *   3. pull も push もある → pullThenPush（pull 先行で取りこぼし防止）
 *   4. pull だけ → pullOnly
 *   5. push だけ → pushOnly
 *   6. 何もない → inSync
 *
 * 参考: schemas.ts の pendingMerge コメント — pendingMerge 中は push がブロックされる仕様。
 */
export function decideRecommendation(
  buckets: StatusBuckets,
  lock: Pick<LockState, "pendingMerge">,
): Recommendation {
  // pendingMerge.conflicts が空の縮退ケースは continueMerge を選ばない。
  // UI 側で「0 件のコンフリクトを解消してください」という矛盾表示を避ける。
  if (lock.pendingMerge !== undefined && lock.pendingMerge.conflicts.length > 0) {
    return {
      kind: "continueMerge",
      conflictCount: lock.pendingMerge.conflicts.length,
    };
  }

  const pullCount = buckets.pull.length;
  const pushCount = buckets.push.length;
  const conflictCount = buckets.conflict.length;

  if (conflictCount > 0) {
    return { kind: "resolveConflict", conflictCount, pullCount, pushCount };
  }
  if (pullCount > 0 && pushCount > 0) {
    return { kind: "pullThenPush", pullCount, pushCount };
  }
  if (pullCount > 0) {
    return { kind: "pullOnly", pullCount };
  }
  if (pushCount > 0) {
    return { kind: "pushOnly", pushCount };
  }
  return { kind: "inSync" };
}

/**
 * Recommendation から `--exit-code` 用の終了コードを決定する。
 *
 * SSOT: コマンド層でコードをハードコードせず、本関数経由で取得する。
 */
export function exitCodeForRecommendation(rec: Recommendation): StatusExitCode {
  return match(rec)
    .with({ kind: "inSync" }, () => STATUS_EXIT_CODE.SYNC)
    .with({ kind: "continueMerge" }, () => STATUS_EXIT_CODE.PENDING_MERGE)
    .with(
      { kind: "pullOnly" },
      { kind: "pushOnly" },
      { kind: "pullThenPush" },
      { kind: "resolveConflict" },
      () => STATUS_EXIT_CODE.OUT_OF_SYNC,
    )
    .exhaustive();
}
