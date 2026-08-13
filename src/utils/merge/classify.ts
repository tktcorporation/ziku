import { match } from "ts-pattern";
import type { ContentHash } from "../../modules/schemas";
import { repoRelPaths } from "../paths";
import type { ClassifyOptions, FileCategory, FileClassification } from "./types";

/** 分類カテゴリ名。FileClassification のキーと対応する。 */
type Category = FileCategory;

/** 有無を boolean に変換して3値の存在パターンをタプルで扱う */
type Presence = { hasBase: boolean; hasLocal: boolean; hasTemplate: boolean };

/**
 * 1ファイルの base/local/template ハッシュから分類カテゴリを判定する。
 *
 * 背景: classifyFiles の分岐数を抑えるために切り出した純粋関数。
 * 3値の有無パターンで大分類し、値の一致で細分類する。
 *
 * 不変条件: `conflicts` に入るファイルはテンプレート側に必ず存在する。
 * conflicts はテンプレート内容をマージの片側として読む（conflict-io.ts の mergeOneFile）ため、
 * テンプレート側に無いファイルを入れると読み込みが失敗して回復不能になる。
 */
function classifyOneFile(
  base: ContentHash | undefined,
  local: ContentHash | undefined,
  template: ContentHash | undefined,
): Category {
  const presence: Presence = {
    hasBase: base !== undefined,
    hasLocal: local !== undefined,
    hasTemplate: template !== undefined,
  };

  return (
    match(presence)
      .with({ hasBase: false, hasLocal: false, hasTemplate: true }, () => "newFiles" as const)
      // テンプレート側の削除とローカル側の編集が衝突する delete/modify。テンプレート側に
      // ファイルが無いのでテキストマージの材料が揃わず、conflicts には入れられない
      // （下の不変条件を参照）。削除候補に混ぜると --force がローカルの編集ごと消すため、
      // 「削除するか残すか」を選ばせる専用カテゴリに分ける。
      .with({ hasBase: true, hasLocal: true, hasTemplate: false }, () =>
        local === base ? ("deletedFiles" as const) : ("deletedWithLocalEdits" as const),
      )
      .with({ hasBase: true, hasLocal: false, hasTemplate: false }, () => "deletedFiles" as const)
      // 逆向きの delete/modify（ローカル削除 × テンプレート変更）は conflicts のままでよい。
      // テンプレート側にファイルがあるので、ローカル側を空文字列としてマージできる。
      .with({ hasBase: true, hasLocal: false, hasTemplate: true }, () =>
        template === base ? ("deletedLocally" as const) : ("conflicts" as const),
      )
      .with({ hasBase: false, hasLocal: true, hasTemplate: false }, () => "localOnly" as const)
      .with({ hasBase: false, hasLocal: true, hasTemplate: true }, () =>
        local === template ? ("unchanged" as const) : ("conflicts" as const),
      )
      .with({ hasBase: true, hasLocal: true, hasTemplate: true }, () =>
        classifyThreeWay(base, local, template),
      )
      // どのハッシュマップにも無いパスは classifyFiles の走査対象に入らないため到達しない。
      // 網羅性検査を成立させるためだけの分岐で、変更なし扱いにしても副作用はない。
      .with({ hasBase: false, hasLocal: false, hasTemplate: false }, () => "unchanged" as const)
      .exhaustive()
  );
}

/**
 * 3者すべて存在する場合の分類。
 * ローカル/テンプレートどちらが変更されたかで判定する。
 */
function classifyThreeWay(
  base: ContentHash | undefined,
  local: ContentHash | undefined,
  template: ContentHash | undefined,
): Category {
  const localChanged = local !== base;
  const templateChanged = template !== base;

  if (!localChanged && !templateChanged) return "unchanged";
  if (!localChanged && templateChanged) return "autoUpdate";
  if (localChanged && !templateChanged) return "localOnly";
  // 両方変更 — 同じ内容なら unchanged、異なれば conflict
  return local === template ? "unchanged" : "conflicts";
}

/**
 * base/local/template のハッシュを比較し、各ファイルを分類する。
 *
 * 背景: pull/push 時にファイルごとの処理方法（自動上書き・マージ・スキップ等）を
 * 決定するために使用する。3つのハッシュマップの差分パターンで分類を行う。
 */
export function classifyFiles(opts: ClassifyOptions): FileClassification {
  const { baseHashes, localHashes, templateHashes } = opts;

  const result: FileClassification = {
    autoUpdate: [],
    localOnly: [],
    conflicts: [],
    newFiles: [],
    deletedFiles: [],
    deletedWithLocalEdits: [],
    deletedLocally: [],
    unchanged: [],
  };

  // `Object.keys` はハッシュマップの鍵 brand を落として `string` を返す。走査対象は
  // 3 つのマップの鍵そのものなので、重複を畳んでから相対パスとして brand し直す。
  const allFiles = repoRelPaths([
    ...new Set([
      ...Object.keys(baseHashes),
      ...Object.keys(localHashes),
      ...Object.keys(templateHashes),
    ]),
  ]);

  for (const file of allFiles) {
    const category = classifyOneFile(baseHashes[file], localHashes[file], templateHashes[file]);
    result[category].push(file);
  }

  return result;
}
