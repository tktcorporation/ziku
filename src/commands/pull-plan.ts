/**
 * pull が「テンプレートの何を取り込み、次の同期ベースに何を書くか」を決める計算。
 *
 * ファイルシステム・GitHub API・プロンプトのいずれにも触れず、渡された分類結果・走査した
 * ハッシュ・CLI フラグ・既に確定したユーザーの選択だけから次の状態を導く。`pull.ts` は I/O と
 * ユーザーへの問い合わせを担い、その結果をここへ渡して返ってきた判断を実行する。
 *
 * 分割の狙いは、pull の判断（削除候補をどう扱うか / lock へ書くベースをどこまで前進させるか /
 * 見せる変更が無くても lock を書き直すか）を、外部環境を用意せずに検証できる形に保つこと。
 * とりわけベースの前進は、誤ると次の `ziku push --yes` がテンプレートの削除を黙って巻き戻す
 * （{@link baseAfterDeletions}）ので、環境を組み立てずに 1 ケースずつ確かめられることが要る。
 */
import { P, match } from "ts-pattern";
import type {
  CommitSha,
  ContentHash,
  HashMap,
  MergingLockState,
  PendingConflict,
  RepoRelPath,
  ResumableLockState,
  SyncPoint,
  UnmergedConflict,
} from "../modules/schemas";
import { markSynced, resolveMerge } from "../modules/schemas";
import type { FileClassification } from "../utils/merge";
import { repoRelPaths } from "../utils/paths";
import type { SyncHashes } from "../utils/sync-analysis";
import { ZIKU_CONFIG_FILE } from "../utils/ziku-config";

// ─── 承認フラグの解釈 ───

/**
 * `--force`（破壊的操作の承認）と `--yes`（対話の省略）の組み合わせ。
 * 削除候補の扱いはこの 2 つだけで決まる。
 */
export interface PullApprovalFlags {
  readonly force: boolean;
  readonly yes: boolean;
}

/** 削除候補に対して取る行動。 */
export type DeletionPolicy = "deleteAll" | "keepAll" | "askUser";

/**
 * テンプレートで削除され、ローカルも base のままのファイルの扱いを決める。
 *
 * 失われるのはテンプレートから再取得できる内容だけなので、`--force` はこの削除の承認に
 * なる。承認済みの対象について改めて選択を求めても意味が無いので全件削除する。
 * `--yes` はプロンプトを省くだけで削除を承認しないため、全件残す。
 */
export function resolveDeletionPolicy(flags: PullApprovalFlags): DeletionPolicy {
  return match(flags)
    .with({ force: true }, () => "deleteAll" as const)
    .with({ force: false, yes: true }, () => "keepAll" as const)
    .with({ force: false, yes: false }, () => "askUser" as const)
    .exhaustive();
}

/**
 * プロンプトを出さずに進める実行か。
 *
 * `--yes` は対話の省略、`--force` は破壊的操作の承認で、どちらも対話端末を前提にしない
 * 実行を意図する指定。選択を求める処理はこの判定で分岐し、入力待ちで止まらないようにする。
 * 選択できないときに何をするかは処理ごとに違う（削除候補は残し、マージの選択は中断する）。
 */
export function isNonInteractive(flags: PullApprovalFlags): boolean {
  return flags.force || flags.yes;
}

// ─── `ziku.jsonc` の加法 union 同期 ───

/**
 * pull における `ziku.jsonc` の加法 union 同期の結末。
 *
 * union マージを行ったなら lock の base は必ずローカル最終内容（= union）へ揃える。base を
 * テンプレート側へ寄せると、テンプレが削除したパターンを後続 push が localOnly として再追加
 * してしまう。書き込みが要るかどうかはそれとは別に決まり、union が現在のローカルと一致する
 * とき（テンプレ削除のみ等）は書かない。書けば内容が変わらないまま更新扱いになり、再検出の
 * ノイズになる。
 *
 * base と書き込みを別々の optional として持つと「書き込むが base を揃えない」という、どの
 * 経路も作らない組み合わせが表現できてしまうので、成立する組み合わせだけを持つ union にする。
 *
 * どのケースも base の行き先を必ず表明する。設定ファイルは仕分けの時点で通常の同期フロー
 * （`SyncPlan.files`）から外れており、削除候補としてベースを据え置く経路
 * （{@link baseAfterDeletions}）を通らない。「マージしない」としか言わない値を置くと、その
 * ファイルの base を決める分岐がどこにも無くなり、テンプレートの走査結果がそのまま base に
 * なる。テンプレートが削除した設定ファイルは走査結果に現れないので、エントリが黙って落ちる。
 */
export type ZikuConfigMergeResult =
  /** union マージの対象外。base はテンプレートの走査結果に従う。 */
  | { readonly _tag: "FollowTemplate" }
  /** テンプレートが設定ファイルを削除した。内容は触らず、base は前回の値を据え置く。 */
  | { readonly _tag: "RetainBase" }
  /** union が現在のローカルと一致する。書き込みは要らず、base だけを揃える。 */
  | { readonly _tag: "BaseOnly"; readonly baseHash: ContentHash }
  /** union をローカルへ書き込み、base をその内容へ揃える。 */
  | { readonly _tag: "Write"; readonly baseHash: ContentHash; readonly content: string };

/**
 * lock に記録する `ziku.jsonc` の base。ベースからエントリを落とすなら undefined。
 *
 * `RetainBase` でローカルの実在を見るのは、据え置きが「テンプレートの削除がローカルの
 * `localOnly` に化けるのを防ぐ」ためのものだから（`utils/merge/sync-plan.ts` の
 * `ZikuConfigPullAction`）。両側から消えていれば化ける先が無く、据え置くと存在しないファイルの
 * ベースだけが毎回残る。判定の規則は通常の同期ファイルの据え置き
 * （{@link baseAfterDeletions}）と同じで、対象が設定ファイルかどうかで扱いを変えない。
 */
export function configBaseHash(
  result: ZikuConfigMergeResult,
  hashes: SyncHashes,
): ContentHash | undefined {
  return match(result)
    .with({ _tag: "FollowTemplate" }, () => hashes.templateHashes[ZIKU_CONFIG_FILE])
    .with({ _tag: "RetainBase" }, () =>
      hashes.localHashes[ZIKU_CONFIG_FILE] === undefined
        ? undefined
        : hashes.baseHashes[ZIKU_CONFIG_FILE],
    )
    .with({ _tag: P.union("BaseOnly", "Write") }, ({ baseHash }) => baseHash)
    .exhaustive();
}

/** ローカルの `ziku.jsonc` へ書き込む内容。書き込みが要らないなら undefined。 */
export function configContentToWrite(result: ZikuConfigMergeResult): string | undefined {
  return match(result)
    .with({ _tag: "Write" }, ({ content }) => content)
    .with({ _tag: P.union("FollowTemplate", "RetainBase", "BaseOnly") }, () => undefined)
    .exhaustive();
}

// ─── テンプレート側の削除 ───

/** テンプレートが削除したファイルを、削除を問える側と問う意味が無い側に分けた結果。 */
export interface TemplateDeletions {
  /** ローカルに実在し、削除するか残すかを問える候補。 */
  readonly deletable: readonly RepoRelPath[];
  /** ベースにだけエントリが残っているファイルがあるか。 */
  readonly hasStaleBaseEntries: boolean;
}

/**
 * テンプレートが削除したファイルを、ローカルでの実在で分ける。
 *
 * `deletedFiles` には「テンプレートにもワークツリーにも無く、ベースにだけ残っている」
 * ファイルも入る（`utils/merge/classify.ts`）。消すものが無いので、候補として見せても
 * 選択も削除ログも実体を伴わない。
 *
 * ベースにだけ残ったエントリは、見せる変更が無くても lock を書き直して落とす必要がある
 * （{@link baseAfterDeletions}）。落とさないと毎回同じ状態で走り、`status` も同期済みに
 * ならないため、その有無を呼び出し側へ返す。
 */
export function splitTemplateDeletions(
  deletedFiles: readonly RepoRelPath[],
  localHashes: HashMap,
): TemplateDeletions {
  const deletable = deletedFiles.filter((path) => localHashes[path] !== undefined);
  return { deletable, hasStaleBaseEntries: deletable.length < deletedFiles.length };
}

/**
 * テンプレート側の削除候補と、そのうち実際にローカルから消したもの。
 *
 * 候補と適用結果を 1 つの値で運ぶことで、{@link baseAfterDeletions} が「残ったのはどれか」を
 * 自分で導ける。呼び出し側が差を計算して渡す形にすると、経路ごとに引き算が散る。
 */
export interface DeletionOutcome {
  /** テンプレートから消えたファイル。`deletedFiles` と `deletedWithLocalEdits` の合計。 */
  readonly candidates: readonly RepoRelPath[];
  /** そのうちローカルからも消したファイル。 */
  readonly applied: ReadonlySet<RepoRelPath>;
}

/**
 * lock に書き込む同期ベースのハッシュを、適用された削除だけ反映した形で組み立てる。
 *
 * pull は分類に使ったテンプレート側のハッシュをそのまま次のベースにする。テンプレートから
 * 消えたファイルはそこにエントリを持たないので、ローカルに残したファイルまでベースを進めると
 * 「base に無い・template に無い・local にある」＝ `localOnly` に化ける。`localOnly` は
 * push の既定送信集合であり、`restoresTemplateDeletion`（テンプレートの削除を取り消す操作
 * だと識別するための集合）にも入らない。結果として、次の `ziku push --yes` がテンプレートの
 * 削除を黙って巻き戻す。
 *
 * そこで据え置くのは、次の 2 つをどちらも満たすファイルだけ。
 *
 * 1. 今回の実行で削除を適用しなかった
 * 2. ローカルのワークツリーにファイルが実在する（`localHashes` にエントリがある）
 *
 * 条件 2 が要るのは、据え置きが `localOnly` への化けを防ぐためのものだから。ローカルに無い
 * ファイルは push の送信集合に入りようがなく、据え置く理由が無い。削除候補には
 * 「テンプレートにもワークツリーにも無く、ベースにだけ残っている」ファイルも入る
 * （`utils/merge/classify.ts`）。これは削除の適用対象にならないので、据え置くとベースの
 * エントリだけが永久に残り、毎回削除候補として報告され `status` も同期済みにならない。
 * エントリを落とせば以降は分類の対象から外れ、繰り返しても状態が収束する。
 *
 * 据え置いたファイルは次回の pull でも「テンプレートが削除した」状態として同じカテゴリに
 * 分類され、ユーザーは削除するか残すかを再び問われる。テンプレートとの差異が解消していない
 * 以上、問われ続けるのが正しい。黙ってテンプレートへ送り返すより、毎回目に入るほうが失う
 * ものが小さい。
 */
export function baseAfterDeletions(params: {
  /** テンプレート側へ前進させたベース（`ziku.jsonc` の補正込み）。 */
  readonly advancedBase: HashMap;
  /** 今回の比較で共通祖先として使ったベース。 */
  readonly previousBase: HashMap;
  /** 今回の走査で得たローカルのハッシュ。エントリの有無がワークツリーでの実在と一致する。 */
  readonly localHashes: HashMap;
  readonly deletions: DeletionOutcome;
}): HashMap {
  const retained = params.deletions.candidates.filter(
    (path) => !params.deletions.applied.has(path) && params.localHashes[path] !== undefined,
  );
  if (retained.length === 0) return params.advancedBase;

  const base: HashMap = { ...params.advancedBase };
  for (const path of retained) {
    const previous = params.previousBase[path];
    // 削除候補はベースにエントリを持つ（`utils/merge/classify.ts` の `hasBase: true` 側から
    // しか出てこない）。型はそれを保証しないので、無ければ前進させた側をそのまま残す。
    if (previous === undefined) continue;
    base[path] = previous;
  }
  return base;
}

/**
 * ベースを前進させる先のテンプレートツリーと、そのツリーを取り直すためのコミット SHA。
 *
 * 2 つを 1 つの値として受け取るのは、別々の引数にすると「ハッシュは今回取り込んだツリー・
 * SHA は前回記録した値」という、両者が別のツリーを指す組み合わせを呼び出し側が組めてしまう
 * ため。その lock が書かれると、後でコンフリクトが起きたときに `downloadBaseForMerge` が
 * SHA 側の古いツリーを共通祖先として取り寄せ、既に取り込み済みのテンプレート変更が
 * 「テンプレート側の新しい変更」として再びマージに載る。ユーザーには一度受け入れたはずの
 * 差分が二度現れる。
 *
 * TypeScript は「この SHA がこのハッシュ写像を生んだツリーを指す」ことまでは検査できない
 * （SHA は文字列で、ハッシュ写像との対応はリモートのリポジトリだけが知っている）。型で
 * 担保できるのは「片方だけを別の出所から差し込めない」ところまでで、残りは構築点を 1 つに
 * 絞ることで守る。
 */
export interface BaseAdvance {
  /** 取り込んだテンプレートへ前進させたハッシュ（`ziku.jsonc` の補正込み）。 */
  readonly hashes: HashMap;
  /**
   * `hashes` を取ったツリーのコミット SHA。解決できなかったなら undefined。
   *
   * 解決できないときに lock の記録済み SHA を引き継がないのは、それが `hashes` とは別の
   * （前回同期時点の）ツリーを指すため。SHA を落とすと 3-way マージは共通祖先無しの 2-way へ
   * 縮退し、コンフリクトの解決はユーザーがどちらの版を残すか選ぶ形になる（`FileMergeOutcome`
   * の `NoBase`）。選ばせるほうが、誤ったツリーを共通祖先に据えて解決済みの差分を蒸し返す
   * より失うものが小さい。SHA は次に解決できた pull で再び載る。
   */
  readonly commitSha: CommitSha | undefined;
}

/**
 * lock に書き込む同期ベースを組み立てる。
 *
 * lock を書く経路は 3 つある（通常フローの確定・解決待ちでの中断・`pull --continue` の確定）。
 * 前 2 つはこの関数を通し、`--continue` は中断時に書いた `merge.nextBase` をそのまま昇格
 * させる（{@link finalizeMergedBase}）ので、ベースの決め方はこの 1 箇所に閉じる。中断と確定で
 * 違うのは適用済みの削除だけなので、そこだけを引数で受ける。
 *
 * 据え置いた削除のエントリ（{@link baseAfterDeletions}）だけは `advance.commitSha` のツリーに
 * 存在しない。ただしそれらはテンプレートから消えたファイルで、共通祖先として読み出す対象
 * （コンフリクトと分類されたファイル）には入らないので、ベースツリーの取り寄せには影響しない。
 */
export function nextSyncBase(params: {
  readonly advance: BaseAdvance;
  readonly previousBase: HashMap;
  readonly localHashes: HashMap;
  readonly deletions: DeletionOutcome;
}): SyncPoint {
  return {
    hashes: baseAfterDeletions({
      advancedBase: params.advance.hashes,
      previousBase: params.previousBase,
      localHashes: params.localHashes,
      deletions: params.deletions,
    }),
    commitSha: params.advance.commitSha,
  };
}

// ─── 取り込む変更の集計 ───

/**
 * ユーザーへ見せる変更が 1 件も無くても、lock だけは書き直す必要があるか。
 *
 * 該当するのは 2 つ。ziku.jsonc の base が記録済みの値から変わる場合（union の内容へ揃える／
 * 両側から消えてエントリを落とす）と、ベースにだけ残ったエントリを落とす場合。どちらも古い
 * base を残すと `status` / `push` が誤判定し、同じ状態のまま毎回走ることになる。
 *
 * @param configBaseHash 今回の pull が lock へ書く ziku.jsonc の base。落とすなら undefined。
 * @param recordedConfigBaseHash lock に記録されている ziku.jsonc の base。
 */
export function lockNeedsRewrite(params: {
  readonly configBaseHash: ContentHash | undefined;
  readonly recordedConfigBaseHash: ContentHash | undefined;
  readonly hasStaleBaseEntries: boolean;
}): boolean {
  return params.configBaseHash !== params.recordedConfigBaseHash || params.hasStaleBaseEntries;
}

/** 分類結果とハッシュから導いた、この pull で取り込む変更。 */
export interface PullChangePlan {
  /** ローカルに実在し、削除するか残すかを問える候補。 */
  readonly deletableFiles: readonly RepoRelPath[];
  /**
   * テンプレートから消えたファイル全て。ローカルに実在しないものも含む。
   *
   * ベースのエントリを落とすか据え置くかの判断は {@link baseAfterDeletions} が持つので、
   * 実在で絞らずに渡す。
   */
  readonly deletionCandidates: readonly RepoRelPath[];
  /**
   * テンプレート側へ前進させたベース（`ziku.jsonc` の補正込み）。
   *
   * `ziku.jsonc` のエントリだけは {@link configBaseHash} が決める。union マージを行ったなら
   * ローカル最終内容（union）のハッシュ、テンプレートが削除しローカルに残るなら前回の値の
   * 据え置き。templateHashes 側に寄せると、テンプレが削除したパターンを後続 push が
   * localOnly として再追加してしまう。
   */
  readonly advancedBase: HashMap;
  /** ユーザーへ見せる変更の件数。0 なら適用するものが無い。 */
  readonly totalChanges: number;
  /** 見せる変更が 0 件でも lock を書き直す必要があるか。 */
  readonly rewriteLock: boolean;
}

/**
 * 分類結果・走査したハッシュ・`ziku.jsonc` の同期結果から、この pull が何を取り込むかを決める。
 *
 * 呼び出し側が前提にしてよいこと:
 * - `totalChanges` が 0 かつ `rewriteLock` が false なら、ディスクにも lock にも書くものが無い。
 * - `deletableFiles` はユーザーへ提示してよい削除候補で、`deletionCandidates` はベースの
 *   計算にだけ使う集合。前者は後者の部分集合になる。
 */
export function planPullChanges(params: {
  readonly files: FileClassification;
  readonly hashes: SyncHashes;
  readonly configSync: ZikuConfigMergeResult;
}): PullChangePlan {
  const { autoUpdate, newFiles, conflicts, deletedFiles, deletedWithLocalEdits } = params.files;
  const { deletable, hasStaleBaseEntries } = splitTemplateDeletions(
    deletedFiles,
    params.hashes.localHashes,
  );
  const configBase = configBaseHash(params.configSync, params.hashes);
  const configWrite = configContentToWrite(params.configSync);

  return {
    deletableFiles: deletable,
    deletionCandidates: [...deletedFiles, ...deletedWithLocalEdits],
    advancedBase: withConfigBase(params.hashes.templateHashes, configBase),
    totalChanges:
      autoUpdate.length +
      newFiles.length +
      conflicts.length +
      deletable.length +
      deletedWithLocalEdits.length +
      (configWrite !== undefined ? 1 : 0),
    rewriteLock: lockNeedsRewrite({
      configBaseHash: configBase,
      recordedConfigBaseHash: params.hashes.baseHashes[ZIKU_CONFIG_FILE],
      hasStaleBaseEntries,
    }),
  };
}

/**
 * テンプレート側へ前進させたベースへ、`ziku.jsonc` の base を載せる。
 *
 * 設定ファイルのエントリは必ずこの関数で決まり、テンプレートの走査結果をそのまま採用する
 * 経路は残さない。{@link configBaseHash} が undefined を返したときにエントリを消すのは、
 * 「ベースから落とす」がテンプレートの走査結果と一致するとは限らないため（ローカルにも
 * テンプレートにも無いのに、走査結果の側にだけ残っている状況を作らない）。
 */
function withConfigBase(templateHashes: HashMap, configBase: ContentHash | undefined): HashMap {
  const advanced: HashMap = {};
  for (const path of repoRelPaths(Object.keys(templateHashes))) {
    if (path === ZIKU_CONFIG_FILE) continue;
    const hash = templateHashes[path];
    if (hash !== undefined) advanced[path] = hash;
  }
  if (configBase !== undefined) advanced[ZIKU_CONFIG_FILE] = configBase;
  return advanced;
}

// ─── `--continue` の解決 ───

/** 自動マージを試みなかった経路か。マーカーの有無では解決を判定できない側。 */
export function isUnmergedConflict(conflict: PendingConflict): conflict is UnmergedConflict {
  return match(conflict)
    .with({ reason: "markers" }, () => false)
    .with({ reason: P.union("noBase", "binary") }, () => true)
    .exhaustive();
}

/** テキストとして読めるか。バイナリの中からマーカーを探しても意味を持たない。 */
export function hasReadableText(conflict: PendingConflict): boolean {
  return match(conflict)
    .with({ reason: P.union("markers", "noBase") }, () => true)
    .with({ reason: "binary" }, () => false)
    .exhaustive();
}

/**
 * 解決を終えたベースを確定した lock を組み立てる。
 *
 * 土台は中断時に記録した `merge.nextBase`。中断は削除の問い合わせより手前で起きるため、
 * `nextBase` はテンプレートが削除したファイルのエントリを据え置いた状態で書かれている
 * （{@link baseAfterDeletions}）。そのまま昇格させることで、問われないまま削除が失われる
 * 経路が無くなり、未処理の削除は次回の pull で改めてユーザーに提示される。
 *
 * テンプレートの内容で置き換えたファイルは、`nextBase` に記録されたハッシュではなく実際に
 * 書き込んだ内容のハッシュをベースにする。書き込む内容の取得元が中断時点のツリーである保証は
 * 無いため、`nextBase` をそのまま載せると「ローカルにある内容」と「ベースが指す内容」が食い
 * 違い、直後から同じファイルが `localOnly` として現れて次の push がテンプレートの内容を
 * ローカルの変更として送り返す。
 *
 * 置き換えたファイルが無ければ到達点は `nextBase` そのものなので、`resolveMerge` で確定する。
 *
 * ハッシュを差し替えても SHA との対応は崩れない。`nextBase.ref` があるなら書き込む内容はその
 * コミットのツリーから取るので同じツリーを指したままで、無いなら SHA も記録されない
 * （{@link BaseAdvance}）。
 *
 * @param takenFromTemplate テンプレートの内容で置き換えたファイルと、書き込んだ内容のハッシュ。
 */
export function finalizeMergedBase(
  lock: MergingLockState,
  takenFromTemplate: HashMap,
): ResumableLockState {
  if (Object.keys(takenFromTemplate).length === 0) return resolveMerge(lock);

  return markSynced(lock, {
    hashes: { ...lock.merge.nextBase.hashes, ...takenFromTemplate },
    commitSha: lock.merge.nextBase.ref,
  });
}
