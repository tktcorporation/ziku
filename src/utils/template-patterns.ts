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
import { loadTemplateConfig } from "./template-config";

export interface MergedTemplatePatterns {
  /** ローカル + テンプレ追加分の include */
  readonly mergedInclude: string[];
  /** ローカル + テンプレ追加分の exclude */
  readonly mergedExclude: string[];
  /** テンプレ側で新規に追加された include パターン (ローカルには無い) */
  readonly newInclude: string[];
  /** テンプレ側で新規に追加された exclude パターン (ローカルには無い) */
  readonly newExclude: string[];
  /** マージで何か変化したか (ローカル `ziku.jsonc` 更新の判定に使う) */
  readonly patternsUpdated: boolean;
}

/**
 * テンプレートの `ziku.jsonc` を読み込み、ローカルパターンとマージした結果を返す。
 *
 * - テンプレ側に `ziku.jsonc` が無ければ、ローカルをそのまま返す（`patternsUpdated: false`）。
 * - 重複パターンは include / exclude それぞれで除去する。
 *
 * 戻り値の `newInclude` / `newExclude` を呼び出し側が見て、ログ表示や永続化を決める。
 */
export async function mergeTemplatePatterns(
  templateDir: string,
  include: string[],
  exclude: string[],
): Promise<MergedTemplatePatterns> {
  const templateConfigOption = await Effect.runPromise(
    loadTemplateConfig(templateDir).pipe(Effect.option),
  );

  if (Option.isNone(templateConfigOption)) {
    return {
      mergedInclude: include,
      mergedExclude: exclude,
      newInclude: [],
      newExclude: [],
      patternsUpdated: false,
    };
  }

  const templateConfig = templateConfigOption.value;
  const newInclude = templateConfig.include.filter((p) => !include.includes(p));
  const newExclude = (templateConfig.exclude ?? []).filter((p) => !exclude.includes(p));
  const patternsUpdated = newInclude.length > 0 || newExclude.length > 0;

  return {
    mergedInclude: patternsUpdated ? [...include, ...newInclude] : include,
    mergedExclude: patternsUpdated ? [...exclude, ...newExclude] : exclude,
    newInclude,
    newExclude,
    patternsUpdated,
  };
}
