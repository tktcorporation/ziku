/**
 * 分類結果を種別ごとに仕分け、種別ごとの扱いを決める。
 *
 * `.ziku/ziku.jsonc` は同期対象パターンそのものを定義するファイルで、他の追跡ファイルとは
 * 違う規則で扱う（`src/utils/ziku-config.ts` の `SyncPath` を参照）。規則の実行に必要な
 * 判断はすべてこのモジュールに置き、コマンド側は返ってきた値を実行するだけにする。
 *
 * コマンドが `FileClassification` から設定ファイルを自分で抜き出す形にすると、抜き出しが
 * pull / push / status それぞれに散り、片方だけ直したときに「二重に処理される」「どこでも
 * 処理されない」が起きる。{@link partitionSyncPlan} が仕分けの唯一の場所で、以降
 * `SyncPlan.files` には設定ファイルが入らない。
 *
 * 扱いの決定は「分類 → pull / push のアクション → push の結論 → 利用者へ見せる結論」の一方向で
 * 流す。表示や案内が独自にカテゴリを決めると、勧めた操作を実行しても何も起きない案内に
 * なりうるため、push の結論（{@link zikuConfigPushOutcome}）は {@link zikuConfigActions} が
 * 返すアクションからしか導かず、status の表示（{@link zikuConfigStatus}）はその push の結論から
 * しか導かない。分岐が枝分かれしないので、片方だけが直った状態を作れない。
 */
import { P, match } from "ts-pattern";
import type { RepoRelPath } from "../../modules/schemas";
import type { ConfigDrift } from "../config-merge";
import { ZIKU_CONFIG_FILE, classifySyncPath } from "../ziku-config";
import type { FileCategory, FileClassification } from "./types";

/**
 * 分類結果における ziku 自身の設定ファイルの位置づけ。
 *
 * `Untracked` は分類の走査対象に現れなかった状態（設定ファイルを追跡しないパターンで
 * 分類した場合など）。`Tracked` の `category` は「他の追跡ファイルと同じ規則ならどう扱われた
 * はずか」を表すだけで、そのまま実行してよい指示ではない。このファイルは中身（パターン集合）を
 * 突き合わせて同期し、ファイル自体の削除はどちらの向きにも伝播しないため、実際の扱いは
 * {@link zikuConfigActions} へ翻訳してから使う。
 */
export type ZikuConfigState =
  | { readonly _tag: "Untracked" }
  | { readonly _tag: "Tracked"; readonly category: FileCategory };

/**
 * 種別ごとに仕分けた分類結果。
 *
 * `files` には設定ファイルが含まれない。含めないことが、コマンド側で汎用の適用処理
 * （テンプレ内容での上書き・削除・テキストマージ）に設定ファイルが紛れ込まない保証になる。
 */
export interface SyncPlan {
  /** 通常の同期ファイルの分類。設定ファイルは含まれない。 */
  readonly files: FileClassification;
  /** ziku 自身の設定ファイルの位置づけ。 */
  readonly config: ZikuConfigState;
}

/**
 * 分類結果を種別ごとに仕分ける。
 *
 * 戻り値の `files` を組み立てるオブジェクトリテラルが全カテゴリを必須にするため、カテゴリを
 * 増やすとここがコンパイルエラーになる。パスの種別を増やしたときは `match` の網羅性が
 * 仕分け漏れを教える。
 */
export function partitionSyncPlan(classification: FileClassification): SyncPlan {
  // 見つけたカテゴリは配列へ積んで最後に 1 つへ畳む。ループの中から書き換える変数を持つと、
  // 仕分けのコールバックがループごとに別の値を掴む形になり読み解きづらくなる。
  const configCategories: FileCategory[] = [];

  const take = (category: FileCategory, paths: readonly RepoRelPath[]): RepoRelPath[] => {
    const syncedFiles: RepoRelPath[] = [];
    for (const path of paths) {
      match(classifySyncPath(path))
        .with({ kind: "syncedFile" }, (synced) => {
          syncedFiles.push(synced.path);
        })
        .with({ kind: "zikuConfig" }, () => {
          configCategories.push(category);
        })
        .exhaustive();
    }
    return syncedFiles;
  };

  const files: FileClassification = {
    autoUpdate: take("autoUpdate", classification.autoUpdate),
    localOnly: take("localOnly", classification.localOnly),
    conflicts: take("conflicts", classification.conflicts),
    newFiles: take("newFiles", classification.newFiles),
    deletedFiles: take("deletedFiles", classification.deletedFiles),
    deletedWithLocalEdits: take("deletedWithLocalEdits", classification.deletedWithLocalEdits),
    deletedLocally: take("deletedLocally", classification.deletedLocally),
    unchanged: take("unchanged", classification.unchanged),
  };

  // 1 つのパスは 1 つのカテゴリにしか入らない（classifyFiles の性質）ので、見つかるのは高々 1 件。
  const category = configCategories[0];
  return {
    files,
    config: category === undefined ? { _tag: "Untracked" } : { _tag: "Tracked", category },
  };
}

/**
 * pull における設定ファイルの扱い。
 *
 * ローカルの内容をどうするかと、lock の同期ベースをどうするかを 1 つの値で表す。「マージ
 * しない」だけを表す値を置くと、ベースの扱いは表明されないまま残り、pull のベース計算
 * （`commands/pull-plan.ts` の `configBaseHash`）が既定として持つ「テンプレートの走査結果に
 * 従う」へ黙って落ちる。設定ファイルは仕分けの時点で通常の同期フロー（{@link SyncPlan} の
 * `files`）から外れているため、その既定を打ち消す分岐がどこにも無い。
 */
export type ZikuConfigPullAction =
  /**
   * ローカルの内容は触らず、ベースはテンプレートの走査結果に従う。
   *
   * テンプレートに設定ファイルがあり、パターンを突き合わせてもローカルの内容が変わらない状態。
   */
  | { readonly _tag: "FollowTemplate" }
  /**
   * ローカルの内容は触らず、ベースは前回の値を据え置く。
   *
   * テンプレートが設定ファイルを削除した状態。ファイル自体の削除は伝播しないのでローカルには
   * 残るが、
   * ベースをテンプレートの走査結果（エントリ無し）まで進めると、次の分類は
   * 「ベース無・ローカル有・テンプレート無」＝ `localOnly` になる。`localOnly` は push の
   * 既定送信集合で、`restoresTemplateDeletion`（テンプレートの削除を取り消す操作だと識別
   * するための集合）にも入らないため、次の `ziku push --yes` が確認なしにテンプレートへ
   * 設定ファイルを復活させる。ベースを据え置けば分類は `deletedWithLocalEdits` のまま残り、
   * その識別が効き続ける。
   */
  | { readonly _tag: "RetainBase" }
  /**
   * テンプレート側の宣言の変化を取り込むため、パターンを 3-way で突き合わせてローカルへ
   * 反映する（`utils/config-merge.ts` の `reconcilePatterns`）。追加だけでなく、テンプレートが
   * 外したパターンの削除もここで反映される。
   */
  | { readonly _tag: "ReconcilePatterns" };

/** push における設定ファイルの扱い。 */
export type ZikuConfigPushAction =
  /** 送らない。 */
  | { readonly _tag: "Skip" }
  /** テンプレート側だけが変わっている。push 対象外で、pull を促す対象として数える。 */
  | { readonly _tag: "TemplateOnly" }
  /**
   * 加法 union を計算してテンプレートへ送る。
   *
   * `restoresTemplateDeletion` は、テンプレートが削除した設定ファイルをローカルの内容で
   * 復活させる push かどうか。サマリで「テンプレート側の削除を取り消す」と明示するために使う。
   */
  | { readonly _tag: "SendUnion"; readonly restoresTemplateDeletion: boolean };

/**
 * 設定ファイルに対して pull と push がそれぞれ何をするか。
 *
 * 2 つを 1 つの値として決めるのは、両者が同じ事実から矛盾しない結論を出すため。方向ごとに
 * 独立した分岐を持つと、片方だけ直したときに「status は push を勧めるのに push は送らない」
 * のような噛み合わない組み合わせが作れてしまう。
 */
export interface ZikuConfigActions {
  readonly pull: ZikuConfigPullAction;
  readonly push: ZikuConfigPushAction;
}

/** どちらの方向にも動かさず、ベースはテンプレートの走査結果に従う。 */
const NO_SYNC: ZikuConfigActions = { pull: { _tag: "FollowTemplate" }, push: { _tag: "Skip" } };

/**
 * 分類カテゴリごとに、pull と push が設定ファイルに対して行うことを決める。
 *
 * pull が取り込むのは、テンプレートだけが変えた（autoUpdate）か双方が変えた（conflicts）
 * 場合だけ。他のカテゴリでは突き合わせの結果がローカルの内容と一致するので、読み書きせず
 * 何もしない。テンプレート側がファイルごと削除したカテゴリ（deletedFiles /
 * deletedWithLocalEdits）でローカルの内容を触らないのは、ローカルの制御ファイルを消すと以降の
 * コマンドが未初期化になるため。そのうえで pull が `RetainBase` を返し、その決定が lock の
 * ベースにも表れるようにする（{@link ZikuConfigPullAction}）。
 *
 * push が送るのはローカルの生の内容ではなく加法 union。生の内容を送ると、ローカルが外した
 * パターンがテンプレート側からも消え、全下流のプロジェクトへ波及する。1 つのプロジェクトの
 * opt-out を全体へ配らないため、パターンの削除はローカル → テンプレートの向きには伝播させない
 * （テンプレート → ローカルの向きは伝播する。規則の全体は `utils/config-merge.ts`）。
 * テンプレートだけが変えた状態（autoUpdate）で送らないのも同じ理由で、送れば
 * テンプレートが外したパターンを復活させてしまう。
 *
 * ローカルに設定ファイルが無いカテゴリ（newFiles / deletedLocally）で push が `Skip` を
 * 返すのは、送る内容である加法 union がテンプレートの内容と必ず一致するため。ローカルで
 * ファイルごと消した場合もそれは送らない。テンプレートの設定ファイルが消えると、そのテンプレートを
 * 使う全プロジェクトが同期対象パターンを引けなくなる。
 */
export function zikuConfigActions(state: ZikuConfigState): ZikuConfigActions {
  return match(state)
    .with({ _tag: "Untracked" }, (): ZikuConfigActions => NO_SYNC)
    .with(
      { _tag: "Tracked" },
      ({ category }): ZikuConfigActions =>
        match(category)
          .with(
            "autoUpdate",
            (): ZikuConfigActions => ({
              pull: { _tag: "ReconcilePatterns" },
              push: { _tag: "TemplateOnly" },
            }),
          )
          .with(
            "conflicts",
            (): ZikuConfigActions => ({
              pull: { _tag: "ReconcilePatterns" },
              push: { _tag: "SendUnion", restoresTemplateDeletion: false },
            }),
          )
          .with(
            "localOnly",
            (): ZikuConfigActions => ({
              pull: { _tag: "FollowTemplate" },
              push: { _tag: "SendUnion", restoresTemplateDeletion: false },
            }),
          )
          .with(
            "deletedWithLocalEdits",
            (): ZikuConfigActions => ({
              pull: { _tag: "RetainBase" },
              push: { _tag: "SendUnion", restoresTemplateDeletion: true },
            }),
          )
          .with(
            "deletedFiles",
            (): ZikuConfigActions => ({ pull: { _tag: "RetainBase" }, push: { _tag: "Skip" } }),
          )
          .with("newFiles", "deletedLocally", "unchanged", (): ZikuConfigActions => NO_SYNC)
          .exhaustive(),
    )
    .exhaustive();
}

/** pull が設定ファイルに対して何をするかを取り出す。 */
export function zikuConfigPullAction(state: ZikuConfigState): ZikuConfigPullAction {
  return zikuConfigActions(state).pull;
}

/** push が設定ファイルに対して何をするかを取り出す。 */
export function zikuConfigPushAction(state: ZikuConfigState): ZikuConfigPushAction {
  return zikuConfigActions(state).push;
}

/**
 * push が設定ファイルに対して取る結論。分類上の位置づけ（{@link ZikuConfigPushAction}）に
 * パターン集合の実差分を突き合わせて導く。
 */
export type ZikuConfigPushOutcome =
  /** 送らず、案内も出さない。 */
  | { readonly _tag: "Skip" }
  /** 送らないが、pull が取り込める追加がテンプレート側にある。 */
  | { readonly _tag: "PullToSync" }
  /** 加法 union を計算してテンプレートへ送る。 */
  | { readonly _tag: "SendUnion"; readonly restoresTemplateDeletion: boolean };

/**
 * push が設定ファイルに対して取る結論を、drift まで見て決める。
 *
 * 分類カテゴリが決めるのは「送ってよいか」までで、送るものがあるかまでは決まらない。
 * どちらの向きも、加法 union が相手側の内容と一致するなら実行しても何も起きない:
 *
 * - ローカルにしか無いパターンが無い（`pushRelevant` が false）なら、送っても差分が
 *   生まれない。それでも送ると、パターンが 1 つも増えない `ziku.jsonc` だけの PR が立つ。
 * - テンプレートがパターンを削除しただけなら、pull は何も書き換えない。この状態を pull の
 *   対象として見せると、実行しても何も起きない操作を勧めることになる。
 *
 * どちらも起きないときは終端（同期済み）として扱い、案内を出さない。
 */
export function zikuConfigPushOutcome(
  state: ZikuConfigState,
  drift: ConfigDrift,
): ZikuConfigPushOutcome {
  const actions = zikuConfigActions(state);
  return match({
    push: pushWritesTemplate(actions.push, drift),
    pull: pullWritesLocal(actions.pull, drift),
  })
    .with(
      { push: { _tag: "SendUnion" } },
      ({ push }): ZikuConfigPushOutcome => ({
        _tag: "SendUnion",
        restoresTemplateDeletion: push.restoresTemplateDeletion,
      }),
    )
    .with(
      { push: { _tag: "NoWrite" }, pull: true },
      (): ZikuConfigPushOutcome => ({ _tag: "PullToSync" }),
    )
    .with(
      { push: { _tag: "NoWrite" }, pull: false },
      (): ZikuConfigPushOutcome => ({ _tag: "Skip" }),
    )
    .exhaustive();
}

/**
 * status が設定ファイルを入れうるカテゴリ。
 *
 * パターンの同期は既存の設定ファイルの中身だけを書き換えるので、「ファイルの追加」も「削除」も
 * 起きない。そのため新規追加・削除系のカテゴリは結論になりえない。取りうる値を絞ることで、表示側が起こりえないラベル（`new file:` など）を
 * 設定ファイルに対して描く経路を型で塞ぐ。
 */
export type ZikuConfigStatusCategory = Extract<
  FileCategory,
  "autoUpdate" | "localOnly" | "conflicts" | "unchanged"
>;

/**
 * status が設定ファイルについて見せる状態。
 *
 * 通常の同期ファイルと同じカテゴリでは表せない状態が 1 つある: ローカルにしか無いパターンが
 * 残っているのに、push が設定ファイルを送らない状態（{@link ZikuConfigStatus.LocalOnlyPatterns}
 * の説明を参照）。カテゴリへ畳むと「同期済み」と区別できず、status が事実と食い違う。
 *
 * 判別可能な union にしておくと、状態を足したときに `match().exhaustive()` が全消費者へ対応を
 * 要求するので、表示だけがその状態を落とすことがない。
 */
export type ZikuConfigStatus =
  /** 通常の同期ファイルと同じカテゴリに載せて数え上げる。 */
  | { readonly _tag: "Categorized"; readonly category: ZikuConfigStatusCategory }
  /**
   * ローカルの `ziku.jsonc` にテンプレートへ無いパターンが残っているが、push は設定ファイルを
   * 送らない。
   *
   * テンプレートが外したパターンは、ローカルの宣言からも落ちたうえで判定に入る
   * （`utils/config-merge.ts` の `analyzeConfigDrift`）ので、ここに残るのはローカル固有の
   * パターンだけ。それでも送信は安全側（送らない）に倒す。テンプレートの宣言を記録していない
   * lock では「テンプレートが外した」と「ローカルが足した」を区別できず、送れば消えたはずの
   * パターンを全下流のプロジェクトへ復活させてしまう。
   *
   * ただし利用者から見れば同期済みではない。ローカル限定のパターンは、それに一致するファイルを
   * push したときにスコープ限定の union として同梱されて初めてテンプレートへ届く。status が
   * この状態を見せることで、届いていない事実と、届けるために取れる操作が分かる。
   */
  | { readonly _tag: "LocalOnlyPatterns" };

/** 通常の同期ファイルと同じカテゴリに載せる状態を作る。 */
function categorized(category: ZikuConfigStatusCategory): ZikuConfigStatus {
  return { _tag: "Categorized", category };
}

/**
 * status で設定ファイルをどう見せるかを決める。
 *
 * 結論は push の結論（{@link zikuConfigPushOutcome}）と、pull が実際にローカルを書き換えるか
 * から導く。分類カテゴリや drift から直接カテゴリを決めると、status だけが別の結論を持つ
 * ことになり、勧めた操作を実行しても何も起きない案内になる。push が送ると決めた状態でだけ
 * push 方向（`localOnly` / `conflicts`）を見せるので、status が pull だけを勧めた状態で
 * `ziku push` が PR を作ることはない。
 *
 * どちらのコマンドも設定ファイルを書き換えないときは、ローカルにしか無いパターンが残っているか
 * （`pushRelevant`）で分かれる。残っていなければ `unchanged`（同期済み）。残っていれば
 * {@link ZikuConfigStatus} の
 * `LocalOnlyPatterns` で、送信の可否は変えずに、届いていない事実だけを見せる。
 */
export function zikuConfigStatus(state: ZikuConfigState, drift: ConfigDrift): ZikuConfigStatus {
  return match({
    push: zikuConfigPushOutcome(state, drift),
    pull: pullWritesLocal(zikuConfigActions(state).pull, drift),
  })
    .with({ push: { _tag: "SendUnion" }, pull: true }, () => categorized("conflicts"))
    .with({ push: { _tag: "SendUnion" }, pull: false }, () => categorized("localOnly"))
    .with({ push: { _tag: "PullToSync" } }, () => categorized("autoUpdate"))
    .with(
      { push: { _tag: "Skip" } },
      (): ZikuConfigStatus =>
        drift.pushRelevant ? { _tag: "LocalOnlyPatterns" } : categorized("unchanged"),
    )
    .exhaustive();
}

/**
 * pull がローカルの設定ファイルを書き換えるか。
 *
 * union はローカルに無いパターンを足すだけなので、足すものが無ければ（`pullRelevant` が
 * false なら）union はローカルの内容と一致し、書き込みは起きない。
 */
function pullWritesLocal(action: ZikuConfigPullAction, drift: ConfigDrift): boolean {
  return match(action)
    .with({ _tag: P.union("FollowTemplate", "RetainBase") }, () => false)
    .with({ _tag: "ReconcilePatterns" }, () => drift.pullRelevant)
    .exhaustive();
}

/**
 * push がテンプレートの設定ファイルに対して実際に行う書き込み。
 *
 * 分類上の位置づけ（{@link ZikuConfigPushAction}）に drift を突き合わせた結果で、
 * {@link zikuConfigPushOutcome} と {@link zikuConfigStatusCategory} はどちらもこの値を
 * 経由する。
 */
type ZikuConfigPushEffect =
  /** テンプレートの設定ファイルは変わらない。 */
  | { readonly _tag: "NoWrite" }
  /** 加法 union を送り、テンプレートの設定ファイルにパターンが増える。 */
  | { readonly _tag: "SendUnion"; readonly restoresTemplateDeletion: boolean };

/**
 * push がテンプレートの設定ファイルを書き換えるか。
 *
 * union がテンプレートの内容と一致する（`pushRelevant` が false）なら、送っても差分が
 * 生まれない。`TemplateOnly` は送らないと決めたカテゴリなので、drift によらず書き込まない。
 */
function pushWritesTemplate(
  action: ZikuConfigPushAction,
  drift: ConfigDrift,
): ZikuConfigPushEffect {
  return match(action)
    .with(
      { _tag: "Skip" },
      { _tag: "TemplateOnly" },
      (): ZikuConfigPushEffect => ({ _tag: "NoWrite" }),
    )
    .with(
      { _tag: "SendUnion" },
      ({ restoresTemplateDeletion }): ZikuConfigPushEffect =>
        drift.pushRelevant ? { _tag: "SendUnion", restoresTemplateDeletion } : { _tag: "NoWrite" },
    )
    .exhaustive();
}

/**
 * 仕分けで外した設定ファイルを、status の状態に応じて分類結果へ戻す。
 *
 * 表示のように「通常の同期ファイルと同じ土俵で数え上げたい」場面のための逆操作。どこへ戻すかは
 * {@link zikuConfigStatus} が決める。
 *
 * `LocalOnlyPatterns` はどのカテゴリへも戻さない。pull も push もこのファイルを書き換えないので
 * 操作待ちのバケツには入らず、テンプレートと一致してもいないので同期済みの数にも入らない。
 * この状態は分類結果ではなく {@link ZikuConfigStatus} のまま表示側へ渡し、専用の案内として
 * 見せる。
 */
export function withZikuConfigStatus(
  files: FileClassification,
  status: ZikuConfigStatus,
): FileClassification {
  const merged: FileClassification = {
    autoUpdate: [...files.autoUpdate],
    localOnly: [...files.localOnly],
    conflicts: [...files.conflicts],
    newFiles: [...files.newFiles],
    deletedFiles: [...files.deletedFiles],
    deletedWithLocalEdits: [...files.deletedWithLocalEdits],
    deletedLocally: [...files.deletedLocally],
    unchanged: [...files.unchanged],
  };
  match(status)
    .with({ _tag: "Categorized" }, ({ category }) => {
      merged[category].push(ZIKU_CONFIG_FILE);
    })
    .with({ _tag: "LocalOnlyPatterns" }, () => {})
    .exhaustive();
  return merged;
}
