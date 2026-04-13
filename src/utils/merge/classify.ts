import { match, P } from "ts-pattern";
import type { ClassifyOptions, FileClassification } from "./types";

/** 分類カテゴリ名。FileClassification のキーと対応する。 */
type Category = keyof FileClassification;

/** 有無を boolean に変換して3値の存在パターンをタプルで扱う */
type Presence = { hasBase: boolean; hasLocal: boolean; hasTemplate: boolean };

/**
 * 1ファイルの base/local/template ハッシュから分類カテゴリを判定する。
 *
 * 背景: classifyFiles の分岐数を抑えるために切り出した純粋関数。
 * 3値の有無パターンで大分類し、値の一致で細分類する。
 */
function classifyOneFile(
  base: string | undefined,
  local: string | undefined,
  template: string | undefined,
): Category {
  const presence: Presence = {
    hasBase: base !== undefined,
    hasLocal: local !== undefined,
    hasTemplate: template !== undefined,
  };

  return match(presence)
    .with({ hasBase: false, hasLocal: false, hasTemplate: true }, () => "newFiles" as const)
    .with({ hasBase: true, hasTemplate: false }, () => "deletedFiles" as const)
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
    .with(P.any, () => "unchanged" as const)
    .exhaustive();
}

/**
 * 3者すべて存在する場合の分類。
 * ローカル/テンプレートどちらが変更されたかで判定する。
 */
function classifyThreeWay(
  base: string | undefined,
  local: string | undefined,
  template: string | undefined,
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
    deletedLocally: [],
    unchanged: [],
  };

  const allFiles = new Set([
    ...Object.keys(baseHashes),
    ...Object.keys(localHashes),
    ...Object.keys(templateHashes),
  ]);

  for (const file of allFiles) {
    const category = classifyOneFile(baseHashes[file], localHashes[file], templateHashes[file]);
    result[category].push(file);
  }

  return result;
}
