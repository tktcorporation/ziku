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
 * しないため、実際の扱いは下の action へ翻訳してから使う。
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

/**
 * pull が設定ファイルに対して何をするかを決める。
 *
 * 取り込む余地があるのは、テンプレートだけが変えた（autoUpdate）か双方が変えた（conflicts）
 * 場合だけ。他のカテゴリでは union がローカルの内容と一致するので、読み書きせず何もしない。
 * テンプレート側の削除（deletedFiles / deletedWithLocalEdits）で `Skip` を返すのが「削除は
 * 伝播しない」の実体で、ローカルの制御ファイルを消して以降のコマンドを未初期化にしない。
 */
export function zikuConfigPullAction(state: ZikuConfigState): ZikuConfigPullAction {
  return match(state)
    .with({ _tag: "Untracked" }, (): ZikuConfigPullAction => ({ _tag: "Skip" }))
    .with(
      { _tag: "Tracked" },
      ({ category }): ZikuConfigPullAction =>
        match(category)
          .with("autoUpdate", "conflicts", (): ZikuConfigPullAction => ({ _tag: "UnionMerge" }))
          .with(
            "localOnly",
            "newFiles",
            "deletedFiles",
            "deletedWithLocalEdits",
            "deletedLocally",
            "unchanged",
            (): ZikuConfigPullAction => ({ _tag: "Skip" }),
          )
          .exhaustive(),
    )
    .exhaustive();
}

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
 * push が設定ファイルに対して何をするかを決める。
 *
 * ローカル側に伝えるものがあるカテゴリでは、ローカルの生の内容ではなく加法 union を送る。
 * 生の内容を送ると、ローカルがパターンを削除していた場合にテンプレート側のパターンまで
 * 消え、全下流のプロジェクトへ波及する。
 */
export function zikuConfigPushAction(state: ZikuConfigState): ZikuConfigPushAction {
  return match(state)
    .with({ _tag: "Untracked" }, (): ZikuConfigPushAction => ({ _tag: "Skip" }))
    .with(
      { _tag: "Tracked" },
      ({ category }): ZikuConfigPushAction =>
        match(category)
          .with(
            "localOnly",
            "conflicts",
            "deletedLocally",
            (): ZikuConfigPushAction => ({
              _tag: "SendUnion",
              restoresTemplateDeletion: false,
            }),
          )
          .with(
            "deletedWithLocalEdits",
            (): ZikuConfigPushAction => ({
              _tag: "SendUnion",
              restoresTemplateDeletion: true,
            }),
          )
          .with("autoUpdate", (): ZikuConfigPushAction => ({ _tag: "TemplateOnly" }))
          .with(
            "newFiles",
            "unchanged",
            "deletedFiles",
            (): ZikuConfigPushAction => ({
              _tag: "Skip",
            }),
          )
          .exhaustive(),
    )
    .exhaustive();
}

/**
 * status で設定ファイルを入れるカテゴリを決める。
 *
 * 判断材料が分類カテゴリではなく union 観点の実差分（drift）なのは、加法 union では
 * 「片側だけのパターン削除」がアクションにならないため。ハッシュ差分をそのまま使うと、
 * テンプレート側がパターンを削除しただけの状態で status が pull を勧め続ける一方、pull は
 * 何もしない、という噛み合わない案内になる。
 */
export function zikuConfigStatusCategory(drift: ConfigDrift): FileCategory {
  return match(drift)
    .with({ pullRelevant: true, pushRelevant: true }, (): FileCategory => "conflicts")
    .with({ pullRelevant: true, pushRelevant: false }, (): FileCategory => "autoUpdate")
    .with({ pullRelevant: false, pushRelevant: true }, (): FileCategory => "localOnly")
    .with({ pullRelevant: false, pushRelevant: false }, (): FileCategory => "unchanged")
    .exhaustive();
}

/**
 * 仕分けで外した設定ファイルを、指定カテゴリへ戻した分類結果を返す。
 *
 * 表示のように「通常の同期ファイルと同じ土俵で数え上げたい」場面のための逆操作。
 * どのカテゴリへ戻すかは {@link zikuConfigStatusCategory} のような判断関数が決める。
 */
export function withZikuConfigAt(
  files: FileClassification,
  category: FileCategory,
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
