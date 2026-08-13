import { z } from "zod/v4";
import { findConflictRegions } from "./conflict-markers";

// ---- Branded types: base/local/template の取り違えをコンパイル時に検出 ----
//
// 入力側の 3 つの brand（BaseContent / LocalContent / TemplateContent）が守るのは
// 「引数の取り違え」だけで、値そのものには何の性質も要求しない。だから任意の string を
// そのままブランドする `asBaseContent` のような関数を公開してよい。
// 出力側の brand（MergedContent / ConflictedContent）は逆に「内容がどうであるか」を
// 表すため、検証を通った経路以外から作れてはならない（下の MergeOutcome を参照）。

/**
 * 3-way マージにおけるベース（共通祖先）のファイル内容。
 *
 * 背景: threeWayMerge の引数は全て string だが、base/local/template を
 * 入れ違えるとサイレントに誤った結果を返す（#148 で発生）。
 * Zod brand で型レベルで区別し、取り違えをコンパイルエラーにする。
 */
const BaseContent = z.string().brand("BaseContent");
export type BaseContent = z.infer<typeof BaseContent>;

/** ローカル側（ユーザー）のファイル内容。コンフリクト時に優先される側。 */
const LocalContent = z.string().brand("LocalContent");
export type LocalContent = z.infer<typeof LocalContent>;

/** テンプレート側のファイル内容。ローカルに適用される変更の源。 */
const TemplateContent = z.string().brand("TemplateContent");
export type TemplateContent = z.infer<typeof TemplateContent>;

/** string を BaseContent にブランドする */
export function asBaseContent(s: string): BaseContent {
  return BaseContent.parse(s);
}

/** string を LocalContent にブランドする */
export function asLocalContent(s: string): LocalContent {
  return LocalContent.parse(s);
}

/** string を TemplateContent にブランドする */
export function asTemplateContent(s: string): TemplateContent {
  return TemplateContent.parse(s);
}

// ---- 3-way マージの結果 ----

/**
 * コンフリクトマーカーを含まないことが検証済みのファイル内容。
 *
 * ziku はマージ結果をテンプレートへの PR に載せる。マーカー入りのテキストがそこへ紛れると、
 * テンプレートを使う全プロジェクトへ壊れたファイルが配られる。内容とフラグを別々の
 * フィールドで持つと「マーカー入りなのにコンフリクト無し」という値が作れてしまうため、
 * 「マーカーが無い」という性質を型そのものに載せる。
 *
 * この型を作れるのは `classifyMergeOutcome` だけで、任意の string からブランドする関数は
 * 公開しない。素通しの変換を 1 つ用意した時点で「検証済み」という意味が失われる。
 */
const MergedContentSchema = z.string().brand("MergedContent");
export type MergedContent = z.infer<typeof MergedContentSchema>;

/**
 * コンフリクトマーカーを含むことが確定したファイル内容。
 *
 * ユーザーが手で解決するためにローカルへ書き出す先はあるが、テンプレートへ送る経路は無い。
 * `MergedContent` と別の型にすることで、送信対象へ渡した時点でコンパイルエラーになる。
 */
const ConflictedContentSchema = z.string().brand("ConflictedContent");
export type ConflictedContent = z.infer<typeof ConflictedContentSchema>;

/** 未解決のコンフリクトブロック 1 つ。 */
export interface ConflictRegion {
  /** ブロック開始行（`<<<<<<<` の行番号、1 始まり）。ユーザーに解決箇所を示すために持つ。 */
  readonly startLine: number;
}

/** 1 つ以上の未解決ブロック。「コンフリクトしたが対象ブロックがゼロ」を作れなくする。 */
export type ConflictRegions = readonly [ConflictRegion, ...ConflictRegion[]];

/**
 * 3-way マージの結果。
 *
 * 内容の性質（マーカーの有無）を判別タグと brand の両方に載せ、分岐を通らずに内容へ
 * 触れられないようにする。呼び出し側は `match().exhaustive()` で 2 つの結末を扱う。
 */
export type MergeOutcome =
  | { readonly _tag: "Clean"; readonly content: MergedContent }
  | {
      readonly _tag: "Conflicted";
      readonly content: ConflictedContent;
      readonly regions: ConflictRegions;
    };

/**
 * 1 ファイル分のマージ試行の結末。
 *
 * `Clean` / `Conflicted` は 3-way マージを実行できた場合の結果で、`NoBase` は共通祖先を
 * 用意できず自動マージを試みなかったことを表す。共通祖先が無い状態で行える比較は 2-way
 * （ローカル対テンプレート）だけで、どちらが変更した側かを判別できない。空のベースで
 * 代用すると、両側の全行を追加とみなしたマージ結果が生まれ、内容としては何も解決して
 * いないのに「マージ済み」の見た目になる。試みなかったことを値として残し、解決の判断は
 * ユーザーへ渡す。
 *
 * 呼び出し側は `Clean` だけを解決済みとして扱う。
 */
export type FileMergeOutcome = MergeOutcome | { readonly _tag: "NoBase" };

/**
 * マージ結果の文字列を検査して `MergeOutcome` にする。`MergedContent` の唯一の生成経路。
 *
 * マージアルゴリズムが「コンフリクトを出力したか」ではなく、実際の内容を走査して判定する。
 * 前回のコンフリクトを解決しないまま再マージした場合のように、アルゴリズムが新しい
 * ブロックを作らなくても内容にマーカーが残っていることがあり、そのまま Clean 扱いすると
 * マーカーがテンプレートへ流れる。
 */
export function classifyMergeOutcome(content: string): MergeOutcome {
  const [first, ...rest] = findConflictRegions(content);
  if (first === undefined) {
    return { _tag: "Clean", content: MergedContentSchema.parse(content) };
  }
  return {
    _tag: "Conflicted",
    content: ConflictedContentSchema.parse(content),
    regions: [first, ...rest],
  };
}

/**
 * ファイル分類結果。
 * pull/push 時に base/local/template のハッシュを比較し、
 * 各ファイルの処理方法を決定するために使用する。
 */
export interface FileClassification {
  /** テンプレートのみ更新 → 自動上書き */
  autoUpdate: string[];
  /** ローカルのみ変更 → スキップ（ローカル保持） */
  localOnly: string[];
  /**
   * 両側の変更が衝突 → テキストとして 3-way マージを試みる対象。
   *
   * テンプレート側には必ずファイルが存在する（mergeOneFile が依存する不変条件。
   * 詳細は classify.ts の該当分岐を参照）。両側にファイルがあり内容が衝突している
   * ケースに加え、ローカルだけ削除されテンプレートが変更された delete/modify も含む。
   * 後者はローカル側を空文字列としてマージする。
   *
   * テンプレート側にファイルが無い delete/modify は deletedWithLocalEdits が扱う。
   */
  conflicts: string[];
  /** テンプレートに新規追加 → そのまま追加 */
  newFiles: string[];
  /**
   * テンプレートで削除され、ローカルは base から変更していない → ユーザーに確認して削除。
   *
   * ローカルが base から変更されている場合は deletedWithLocalEdits に入る。
   */
  deletedFiles: string[];
  /**
   * テンプレートで削除されたが、ローカルは base から変更している。
   * 削除するとローカルの編集が失われるため、テキストマージではなく
   * 「削除するか残すか」をユーザーが選ぶ。
   */
  deletedWithLocalEdits: string[];
  /** ローカルで削除（base と template にあるがローカルにない）→ push で削除可能 */
  deletedLocally: string[];
  /** 変更なし → スキップ */
  unchanged: string[];
}

/**
 * 分類カテゴリ名。`FileClassification` のキーと対応する。
 *
 * 「どのカテゴリに入ったか」を配列から引き剥がして 1 つの値として持ち回るために型を与える
 * （`src/utils/merge/sync-plan.ts` の `ZikuConfigState`）。
 */
export type FileCategory = keyof FileClassification;

export interface ClassifyOptions {
  baseHashes: Record<string, string>;
  localHashes: Record<string, string>;
  templateHashes: Record<string, string>;
}

/**
 * 3-way マージの入力パラメータ。
 *
 * 背景: base/local/template の3つの文字列は全て string 型で、位置引数だと
 * 入れ違いがコンパイルエラーにならない。named parameters + branded types で
 * 意図を明示し、取り違えをコンパイルエラーにする。
 */
export interface ThreeWayMergeParams {
  /** 共通祖先（ベース）の内容 */
  base: BaseContent;
  /** ローカル側の内容（コンフリクトマーカーの LOCAL 側に表示される） */
  local: LocalContent;
  /** テンプレート側の内容（ローカルに適用される変更の源） */
  template: TemplateContent;
  /** ファイルパス（構造ファイルのマージ後バリデーションに使用） */
  filePath?: string;
}
