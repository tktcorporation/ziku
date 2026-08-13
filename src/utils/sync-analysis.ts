import type { HashMap } from "../modules/schemas";
import type { SyncPlan } from "./merge/sync-plan";
import { partitionSyncPlan } from "./merge/sync-plan";
import { classifyFiles } from "./merge";
import { hashFiles } from "./hash";

/**
 * 3-way ハッシュ比較に必要な3つのハッシュマップ。
 *
 * - base: 前回 sync 時のハッシュ（lock のベース由来）。3-way 比較の共通祖先。
 * - local: 現在のローカルファイルのハッシュ。
 * - template: 現在のテンプレートファイルのハッシュ。
 */
export interface SyncHashes {
  readonly baseHashes: HashMap;
  readonly localHashes: HashMap;
  readonly templateHashes: HashMap;
}

export interface AnalyzeSyncOptions {
  readonly targetDir: string;
  readonly templateDir: string;
  /**
   * 前回 sync 時のハッシュ。`baseHashesOf(lock)` の戻り値をそのまま渡す。
   * ベース未確定の lock では空になり、すべてのテンプレートファイルが `newFiles` に分類される。
   */
  readonly baseHashes: HashMap;
  readonly include: string[];
  readonly exclude?: string[];
}

export interface SyncAnalysis {
  /**
   * 種別ごとに仕分けた分類結果。
   *
   * 生の `FileClassification` を返さないのは、ziku 自身の設定ファイルだけ扱いが違うため。
   * 仕分けを呼び出し側に任せると、抜き出しがコマンドごとに散る（`merge/sync-plan.ts`）。
   */
  readonly plan: SyncPlan;
  readonly hashes: SyncHashes;
}

/**
 * ローカル / テンプレート / lock(base) の3者を比較し、ファイルを分類する。
 *
 * 呼び出し側が前提にしてよいこと:
 * - ローカルとテンプレートのハッシュは同じ `include` / `exclude` で走査した結果である。
 *   走査条件が片側だけずれると、対象外のファイルが「片側にしか無い」と分類されてしまう。
 * - 分類は `hashes` に入っている 3 つのマップだけから導かれる。同じハッシュを渡せば
 *   どのコマンドから呼んでも同じ分類になる。
 * - 返す `hashes.templateHashes` は分類に使ったものそのもので、次の同期ベースとして
 *   lock へ書ける。
 *
 * I/O バウンドな2つの hashFiles を Promise.all で並列化する。
 *
 * 規約メモ: hashFiles が plain async のため本関数も plain async に揃えている。
 * hashFiles を Effect 化する際は本関数も Effect.gen に書き直すこと。
 */
export async function analyzeSync(options: AnalyzeSyncOptions): Promise<SyncAnalysis> {
  const { targetDir, templateDir, baseHashes, include, exclude } = options;
  const [templateHashes, localHashes] = await Promise.all([
    hashFiles(templateDir, include, exclude),
    hashFiles(targetDir, include, exclude),
  ]);
  const classification = classifyFiles({
    baseHashes,
    localHashes,
    templateHashes,
  });
  return {
    plan: partitionSyncPlan(classification),
    hashes: { baseHashes, localHashes, templateHashes },
  };
}
