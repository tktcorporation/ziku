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
 * 扱いの決定は「分類 → pull / push のアクション → status の表示カテゴリ」の一方向で流す。
 * status が独自にカテゴリを決めると、勧めた操作を実行しても何も起きない案内になりうるため、
 * 表示は {@link zikuConfigActions} が返すアクションからしか導かない。
 */
import { match } from "ts-pattern";
import type { RepoRelPath } from "../../modules/schemas";
import type { ConfigDrift } from "../config-merge";
import { ZIKU_CONFIG_FILE, classifySyncPath } from "../ziku-config";
import type { FileCategory, FileClassification } from "./types";

/**
 * 分類結果における ziku 自身の設定ファイルの位置づけ。
 *
 * `Untracked` は分類の走査対象に現れなかった状態（設定ファイルを追跡しないパターンで
 * 分類した場合など）。`Tracked` の `category` は「他の追跡ファイルと同じ規則ならどう扱われた
 * はずか」を表すだけで、そのまま実行してよい指示ではない。加法 union で同期し削除は伝播
 * しないため、実際の扱いは {@link zikuConfigActions} へ翻訳してから使う。
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

/** pull における設定ファイルの扱い。 */
export type ZikuConfigPullAction =
  /** 触らない。テンプレート側の削除も、ローカルにしかないパターンも、pull では何もしない。 */
  | { readonly _tag: "Skip" }
  /** テンプレート側の追加を取り込むため、加法 union を計算してローカルへ反映する。 */
  | { readonly _tag: "UnionMerge" };

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

const SKIP_BOTH: ZikuConfigActions = { pull: { _tag: "Skip" }, push: { _tag: "Skip" } };

/**
 * 分類カテゴリごとに、pull と push が設定ファイルに対して行うことを決める。
 *
 * pull が取り込むのは、テンプレートだけが変えた（autoUpdate）か双方が変えた（conflicts）
 * 場合だけ。他のカテゴリでは union がローカルの内容と一致するので、読み書きせず何もしない。
 * テンプレート側の削除（deletedFiles / deletedWithLocalEdits）で pull が `Skip` を返すのが
 * 「削除は伝播しない」の実体で、ローカルの制御ファイルを消して以降のコマンドを未初期化に
 * しない。
 *
 * push が送るのはローカルの生の内容ではなく加法 union。生の内容を送ると、ローカルが
 * パターンを削除していた場合にテンプレート側のパターンまで消え、全下流のプロジェクトへ
 * 波及する。テンプレートだけが変えた状態（autoUpdate）で送らないのも同じ理由で、送れば
 * テンプレートが削除したパターンを復活させてしまう。
 */
export function zikuConfigActions(state: ZikuConfigState): ZikuConfigActions {
  return match(state)
    .with({ _tag: "Untracked" }, (): ZikuConfigActions => SKIP_BOTH)
    .with(
      { _tag: "Tracked" },
      ({ category }): ZikuConfigActions =>
        match(category)
          .with(
            "autoUpdate",
            (): ZikuConfigActions => ({
              pull: { _tag: "UnionMerge" },
              push: { _tag: "TemplateOnly" },
            }),
          )
          .with(
            "conflicts",
            (): ZikuConfigActions => ({
              pull: { _tag: "UnionMerge" },
              push: { _tag: "SendUnion", restoresTemplateDeletion: false },
            }),
          )
          .with(
            "localOnly",
            "deletedLocally",
            (): ZikuConfigActions => ({
              pull: { _tag: "Skip" },
              push: { _tag: "SendUnion", restoresTemplateDeletion: false },
            }),
          )
          .with(
            "deletedWithLocalEdits",
            (): ZikuConfigActions => ({
              pull: { _tag: "Skip" },
              push: { _tag: "SendUnion", restoresTemplateDeletion: true },
            }),
          )
          .with("newFiles", "deletedFiles", "unchanged", (): ZikuConfigActions => SKIP_BOTH)
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
 * status が設定ファイルを入れうるカテゴリ。
 *
 * 加法 union の同期に「ファイルの追加」も「削除」も無いため、新規追加・削除系のカテゴリは
 * 結論になりえない。取りうる値を絞ることで、表示側が起こりえないラベル（`new file:` など）を
 * 設定ファイルに対して描く経路を型で塞ぐ。
 */
export type ZikuConfigStatusCategory = Extract<
  FileCategory,
  "autoUpdate" | "localOnly" | "conflicts" | "unchanged"
>;

/**
 * status で設定ファイルを入れるカテゴリを決める。
 *
 * 結論は「pull / push が実際にこの設定ファイルを書き換えるか」から導く。分類カテゴリや
 * drift から直接カテゴリを決めると、status だけが別の結論を持つことになり、勧めた操作を
 * 実行しても何も起きない案内になる。
 *
 * テンプレートがパターンを削除し、ローカルが変更していない状態は `unchanged`（同期済み）に
 * なる。加法 union の下でこの状態は終端で、pull は削除を伝播せず、push はテンプレートが
 * 消したパターンを復活させない。どちらのコマンドも何も変えない以上、操作待ちとして見せる
 * 相手が存在しない。テンプレートに合わせてローカルからもパターンを消したい利用者は、
 * ローカルの `ziku.jsonc` を自分で編集する（それが「削除は伝播しない」方針の帰結）。
 */
export function zikuConfigStatusCategory(
  state: ZikuConfigState,
  drift: ConfigDrift,
): ZikuConfigStatusCategory {
  const actions = zikuConfigActions(state);
  return match({
    pull: pullWritesLocal(actions.pull, drift),
    push: pushSendsToTemplate(actions.push, drift),
  })
    .with({ pull: true, push: true }, (): ZikuConfigStatusCategory => "conflicts")
    .with({ pull: true, push: false }, (): ZikuConfigStatusCategory => "autoUpdate")
    .with({ pull: false, push: true }, (): ZikuConfigStatusCategory => "localOnly")
    .with({ pull: false, push: false }, (): ZikuConfigStatusCategory => "unchanged")
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
    .with({ _tag: "Skip" }, () => false)
    .with({ _tag: "UnionMerge" }, () => drift.pullRelevant)
    .exhaustive();
}

/**
 * push がテンプレートの設定ファイルを書き換えるか。
 *
 * union がテンプレートの内容と一致する（`pushRelevant` が false）なら、送っても差分が
 * 生まれない。`TemplateOnly` は送らないと決めたカテゴリなので、drift によらず false。
 */
function pushSendsToTemplate(action: ZikuConfigPushAction, drift: ConfigDrift): boolean {
  return match(action)
    .with({ _tag: "Skip" }, { _tag: "TemplateOnly" }, () => false)
    .with({ _tag: "SendUnion" }, () => drift.pushRelevant)
    .exhaustive();
}

/**
 * 仕分けで外した設定ファイルを、指定カテゴリへ戻した分類結果を返す。
 *
 * 表示のように「通常の同期ファイルと同じ土俵で数え上げたい」場面のための逆操作。
 * どのカテゴリへ戻すかは {@link zikuConfigStatusCategory} が決める。
 */
export function withZikuConfigAt(
  files: FileClassification,
  category: ZikuConfigStatusCategory,
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
  merged[category].push(ZIKU_CONFIG_FILE);
  return merged;
}
