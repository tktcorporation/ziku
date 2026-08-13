/**
 * テンプレート側パターン (`.ziku/ziku.jsonc`) とローカルパターンをマージするための SSOT。
 *
 * 背景: `pull` はテンプレート側で追加されたパターンを取り込んで実際にローカル
 * `ziku.jsonc` を書き換える。`status` は同じマージ結果を使ってハッシュ比較しないと、
 * テンプレ側に新パターンが追加された状態で「in sync」と誤判定してしまう
 * （その後 `pull` が実行された瞬間に新ファイルが大量に降ってくる）。
 * 両コマンドが同じマージ結果を共有するために、ここで純粋関数として切り出す。
 *
 * ログ表示は呼び出し側の責務。本関数は副作用ゼロで `newInclude` / `newExclude` を返し、
 * 呼び出し元がそれを見て `log.info` するなり、`status` のように暗黙に取り込むなりを選ぶ。
 */
import { Effect, Option } from "effect";
import type { AbsPath, GlobPattern } from "../modules/schemas";
import { unionPatterns } from "./patterns";
import { loadTemplateConfig } from "./template-config";

export interface MergedTemplatePatterns {
  /** ローカル + テンプレ追加分の include */
  readonly mergedInclude: GlobPattern[];
  /** ローカル + テンプレ追加分の exclude */
  readonly mergedExclude: GlobPattern[];
  /** テンプレ側で新規に追加された include パターン (ローカルには無い) */
  readonly newInclude: GlobPattern[];
  /** テンプレ側で新規に追加された exclude パターン (ローカルには無い) */
  readonly newExclude: GlobPattern[];
  /** マージで何か変化したか (ローカル `ziku.jsonc` 更新の判定に使う) */
  readonly patternsUpdated: boolean;
}

/**
 * テンプレートの `ziku.jsonc` を読み込み、ローカルパターンとマージした結果を返す。
 *
 * マージは `unionPatterns` の和集合なので、ローカルのパターンは順序ごと保たれ、
 * テンプレ側の追加分だけが末尾に付く。テンプレ側に `ziku.jsonc` が無い場合は
 * 「追加分ゼロ」として扱い、ローカルのパターンだけが残る。
 *
 * 戻り値の `newInclude` / `newExclude` を呼び出し側が見て、ログ表示や永続化を決める。
 */
export async function mergeTemplatePatterns(
  templateDir: AbsPath,
  include: readonly GlobPattern[],
  exclude: readonly GlobPattern[],
): Promise<MergedTemplatePatterns> {
  const templateConfigOption = await Effect.runPromise(
    loadTemplateConfig(templateDir).pipe(Effect.option),
  );

  const templatePatterns = Option.match(templateConfigOption, {
    onNone: () => ({ include: [] as GlobPattern[], exclude: [] as GlobPattern[] }),
    onSome: (config) => ({ include: config.include, exclude: config.exclude ?? [] }),
  });

  const mergedInclude = unionPatterns(include, templatePatterns.include);
  const mergedExclude = unionPatterns(exclude, templatePatterns.exclude);

  return {
    mergedInclude: mergedInclude.merged,
    mergedExclude: mergedExclude.merged,
    newInclude: mergedInclude.added,
    newExclude: mergedExclude.added,
    patternsUpdated: mergedInclude.added.length > 0 || mergedExclude.added.length > 0,
  };
}
