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
import { Effect, Either } from "effect";
import { match } from "ts-pattern";
import { zikuFailure } from "../errors";
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
 * テンプレ側の追加分だけが末尾に付く。
 *
 * テンプレート側の設定が読めなかったときの扱いは、パターンが空である理由で分ける。
 *
 * - `ziku.jsonc` が無い: まだ ziku を使っていないテンプレートという正当な状態。追加分ゼロ
 *   として扱い、ローカルのパターンだけが残る。
 * - 構文が壊れている / ziku の設定として解釈できない: 空へ潰さず中断する。潰すと「テンプレートは
 *   何も同期対象と定めていない」という読みが走査範囲になり、テンプレートが追跡しているファイルが
 *   分類にも差分にも現れないまま、同期済みとして報告される。テキストは人が直せるので、直すまで
 *   待っても何も失われない。構文の破綻とスキーマ違反は、直す箇所が違うので別の失敗として報告する。
 *
 * 失敗は `ZikuFailure` を throw して返す（`src/utils/config-merge.ts` と同じ経路）。呼び出し元は
 * Effect ではない async 関数の連なりで、その先はコマンド層が defect ごと拾ってトップレベルへ運ぶ。
 *
 * 戻り値の `newInclude` / `newExclude` を呼び出し側が見て、ログ表示や永続化を決める。
 */
export async function mergeTemplatePatterns(
  templateDir: AbsPath,
  include: readonly GlobPattern[],
  exclude: readonly GlobPattern[],
): Promise<MergedTemplatePatterns> {
  const loaded = await Effect.runPromise(loadTemplateConfig(templateDir).pipe(Effect.either));

  const templatePatterns = Either.match(loaded, {
    onRight: (config) => ({ include: config.include, exclude: config.exclude ?? [] }),
    onLeft: (error) =>
      match(error)
        .with({ _tag: "TemplateNotConfiguredError" }, () => ({
          include: [] as GlobPattern[],
          exclude: [] as GlobPattern[],
        }))
        .with({ _tag: "ParseError" }, (e): never => {
          throw zikuFailure(
            { kind: "ConfigUnparsable", path: e.path, detail: String(e.cause) },
            { cause: e.cause },
          );
        })
        .with({ _tag: "ValidationError" }, (e): never => {
          throw zikuFailure({ kind: "ConfigInvalid", path: e.path, issues: e.issues });
        })
        .exhaustive(),
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
