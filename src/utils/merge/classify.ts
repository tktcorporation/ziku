import { Option, pipe } from "effect";
import { P, match } from "ts-pattern";
import type { ContentHash } from "../../modules/schemas";
import { repoRelPaths } from "../paths";
import type { ClassifyOptions, FileCategory, FileClassification } from "./types";

/** 分類カテゴリ名。FileClassification のキーと対応する。 */
type Category = FileCategory;

/**
 * 1 ファイルの同期履歴。
 *
 * 3 個の optional なハッシュを判定処理へ直接渡すと、各分岐で「この値は必ずある」という
 * 前提を繰り返すことになる。存在関係を先に直和型へ変換し、分類側では成立する状態だけを扱う。
 * どこにも存在しない組み合わせはファイルの状態ではないため、この型には含めない。
 */
type FileHistory =
  | { readonly _tag: "CreatedInTemplate" }
  | { readonly _tag: "CreatedLocally" }
  | {
      readonly _tag: "CreatedOnBoth";
      readonly local: ContentHash;
      readonly template: ContentHash;
    }
  | { readonly _tag: "DeletedEverywhere" }
  | {
      readonly _tag: "DeletedFromTemplate";
      readonly base: ContentHash;
      readonly local: ContentHash;
    }
  | {
      readonly _tag: "DeletedLocally";
      readonly base: ContentHash;
      readonly template: ContentHash;
    }
  | {
      readonly _tag: "PresentEverywhere";
      readonly base: ContentHash;
      readonly local: ContentHash;
      readonly template: ContentHash;
    };

/** 外部の疎なハッシュマップ表現を、分類ドメインの状態へ一度だけ変換する。 */
function fileHistory(
  baseInput: ContentHash | undefined,
  localInput: ContentHash | undefined,
  templateInput: ContentHash | undefined,
): Option.Option<FileHistory> {
  return match({ base: baseInput, local: localInput, template: templateInput })
    .with({ base: undefined, local: undefined, template: undefined }, () => Option.none())
    .with({ base: undefined, local: undefined, template: P.not(undefined) }, () =>
      Option.some({ _tag: "CreatedInTemplate" } as const),
    )
    .with({ base: undefined, local: P.not(undefined), template: undefined }, () =>
      Option.some({ _tag: "CreatedLocally" } as const),
    )
    .with(
      { base: undefined, local: P.not(undefined), template: P.not(undefined) },
      ({ local, template }) => Option.some({ _tag: "CreatedOnBoth", local, template } as const),
    )
    .with({ base: P.not(undefined), local: undefined, template: undefined }, () =>
      Option.some({ _tag: "DeletedEverywhere" } as const),
    )
    .with(
      { base: P.not(undefined), local: P.not(undefined), template: undefined },
      ({ base, local }) => Option.some({ _tag: "DeletedFromTemplate", base, local } as const),
    )
    .with(
      { base: P.not(undefined), local: undefined, template: P.not(undefined) },
      ({ base, template }) => Option.some({ _tag: "DeletedLocally", base, template } as const),
    )
    .with(
      { base: P.not(undefined), local: P.not(undefined), template: P.not(undefined) },
      ({ base, local, template }) =>
        Option.some({ _tag: "PresentEverywhere", base, local, template } as const),
    )
    .exhaustive();
}

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
  baseInput: ContentHash | undefined,
  localInput: ContentHash | undefined,
  templateInput: ContentHash | undefined,
): Option.Option<Category> {
  return pipe(
    fileHistory(baseInput, localInput, templateInput),
    Option.map((history) =>
      match(history)
        .with({ _tag: "CreatedInTemplate" }, () => "newFiles" as const)
        // テンプレート側の削除とローカル側の編集が衝突する delete/modify。テンプレート側に
        // ファイルが無いのでテキストマージの材料が揃わず、conflicts には入れられない
        // （下の不変条件を参照）。削除候補に混ぜると --force がローカルの編集ごと消すため、
        // 「削除するか残すか」を選ばせる専用カテゴリに分ける。
        .with({ _tag: "DeletedFromTemplate" }, ({ base, local }) =>
          local === base ? "deletedFiles" : "deletedWithLocalEdits",
        )
        .with({ _tag: "DeletedEverywhere" }, () => "deletedFiles" as const)
        // 逆向きの delete/modify（ローカル削除 × テンプレート変更）は conflicts のままでよい。
        // テンプレート側にファイルがあるので、ローカル側を空文字列としてマージできる。
        .with({ _tag: "DeletedLocally" }, ({ base, template }) =>
          template === base ? "deletedLocally" : "conflicts",
        )
        .with({ _tag: "CreatedLocally" }, () => "localOnly" as const)
        .with({ _tag: "CreatedOnBoth" }, ({ local, template }) =>
          local === template ? "unchanged" : "conflicts",
        )
        .with({ _tag: "PresentEverywhere" }, ({ base, local, template }) =>
          classifyThreeWay(base, local, template),
        )
        .exhaustive(),
    ),
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
    pipe(
      classifyOneFile(baseHashes[file], localHashes[file], templateHashes[file]),
      Option.map((category) => result[category].push(file)),
    );
  }

  return result;
}
