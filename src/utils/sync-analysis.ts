import type { AbsPath, HashMap, RepoRelPath } from "../modules/schemas";
import type { FileClassification } from "./merge/types";
import type { SyncPlan } from "./merge/sync-plan";
import { partitionSyncPlan } from "./merge/sync-plan";
import { classifyFiles } from "./merge";
import { hashFiles } from "./hash";
import { repoRelPaths } from "./paths";
import type { SyncScope } from "./sync-scope";
import { declaredPaths, scanExceedsDeclared } from "./sync-scope";

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
  readonly targetDir: AbsPath;
  readonly templateDir: AbsPath;
  /**
   * 前回 sync 時のハッシュ。`baseHashesOf(lock)` の戻り値をそのまま渡す。
   * ベース未確定の lock では空になり、すべてのテンプレートファイルが `newFiles` に分類される。
   */
  readonly baseHashes: HashMap;
  /**
   * ローカルとテンプレートを走査する範囲。両側に同じものを使う。
   * {@link import("./sync-scope").resolveSyncScope} で作る。
   */
  readonly scope: SyncScope;
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
  /**
   * 同期対象として宣言されているパス。次の同期ベースに載せてよいパスの判定に使う
   * （`commands/pull-plan.ts` の `nextSyncBase`）。宣言の外のエントリをベースへ載せると、
   * 以降は走査されないパスのベースだけが残り続ける。
   *
   * 走査が宣言と一致する実行では、走査で拾ったパスがそのまま宣言の中身になる。テンプレートが
   * パターンを外した実行だけ、宣言のパターンを別に解決して狭い集合になる。
   */
  readonly declaredPaths: ReadonlySet<RepoRelPath>;
}

/**
 * 宣言の外に出たパスを、扱いごとに仕分ける。
 *
 * 走査が宣言より広いのは、テンプレートが外したパターンにだけ一致するファイルを、削除候補と
 * して最後まで見届けるため。その一点を超えて広い範囲を使うと、同期対象ではないファイルへ
 * テンプレートの内容が配置され、ローカルの変更がテンプレートへ送られる。削除の 2 カテゴリ
 * だけを宣言の外にも許し、残りは落とす。
 *
 * 落ちたパスはどのカテゴリにも入らないので、コマンドから見えなくなる。ファイルはワークツリー
 * に残り、以降は未追跡として扱われる（パターンを外すこととファイルを消すことは別）。
 */
export function restrictToDeclaredScope(
  classification: FileClassification,
  isDeclared: (path: RepoRelPath) => boolean,
): FileClassification {
  const declared = (paths: readonly RepoRelPath[]): RepoRelPath[] =>
    paths.filter((path) => isDeclared(path));
  return {
    autoUpdate: declared(classification.autoUpdate),
    localOnly: declared(classification.localOnly),
    conflicts: declared(classification.conflicts),
    newFiles: declared(classification.newFiles),
    // テンプレートが外したパターンのファイルは、ここでだけ宣言の外に残る。
    deletedFiles: classification.deletedFiles,
    deletedWithLocalEdits: classification.deletedWithLocalEdits,
    deletedLocally: declared(classification.deletedLocally),
    unchanged: declared(classification.unchanged),
  };
}

/**
 * ローカル / テンプレート / lock(base) の3者を比較し、ファイルを分類する。
 *
 * 呼び出し側が前提にしてよいこと:
 * - ローカルとテンプレートのハッシュは同じ範囲で走査した結果である。走査条件が片側だけ
 *   ずれると、対象外のファイルが「片側にしか無い」と分類されてしまう。
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
  const { targetDir, templateDir, baseHashes, scope } = options;
  const [templateHashes, localHashes] = await Promise.all([
    hashFiles(templateDir, scope),
    hashFiles(targetDir, scope),
  ]);
  const classification = classifyFiles({
    baseHashes,
    localHashes,
    templateHashes,
  });

  // 走査が宣言と一致する実行（テンプレートがパターンを外していない）では、宣言の中かどうかを
  // 確かめるまでもなく全パスが宣言の中にある。追加の走査を省く。
  if (!scanExceedsDeclared(scope)) {
    return {
      plan: partitionSyncPlan(classification),
      hashes: { baseHashes, localHashes, templateHashes },
      declaredPaths: new Set([
        ...repoRelPaths([...Object.keys(templateHashes), ...Object.keys(localHashes)]),
        ...scope.alwaysTracked,
      ]),
    };
  }

  const declared = declaredPaths({ targetDir, templateDir, scope });
  return {
    plan: partitionSyncPlan(restrictToDeclaredScope(classification, (path) => declared.has(path))),
    hashes: { baseHashes, localHashes, templateHashes },
    declaredPaths: declared,
  };
}
