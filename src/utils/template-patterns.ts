/**
 * テンプレート側パターン (`.ziku/ziku.jsonc`) とローカルパターンを突き合わせるための SSOT。
 *
 * 背景: `pull` はテンプレート側の宣言の変化を取り込んで実際にローカル `ziku.jsonc` を
 * 書き換える。`status` は同じ突き合わせ結果を使ってハッシュ比較しないと、テンプレ側に
 * 新パターンが追加された状態で「in sync」と誤判定してしまう（その後 `pull` が実行された
 * 瞬間に新ファイルが大量に降ってくる）。両コマンドが同じ結果を共有するために、ここで
 * 純粋関数として切り出す。
 *
 * 走査に使う集合と宣言として持つ集合は別物になる。テンプレートがパターンを外したとき、
 * 宣言はそのパターンを落とすが、走査は落とせない。落とすと、そのパターンにだけ一致していた
 * ローカルのファイルがどちらの走査にも現れなくなり、テンプレートが同時に削除したファイルが
 * 削除候補から静かに消える。走査は前回のテンプレートの宣言まで含めた和集合で行い、宣言を
 * 縮めるのはファイルの分類が済んだ後になる。
 *
 * ログ表示は呼び出し側の責務。本関数は副作用ゼロで `added` / `removed` を返し、
 * 呼び出し元がそれを見て `log.info` するなり、`status` のように暗黙に取り込むなりを選ぶ。
 */
import { Effect, Either } from "effect";
import { match } from "ts-pattern";
import { zikuFailure } from "../errors";
import type { AbsPath, GlobPattern } from "../modules/schemas";
import type { ConfigPatterns } from "./config-merge";
import { reconcilePatterns } from "./config-merge";
import { unionPatterns } from "./patterns";
import { loadTemplateConfig } from "./template-config";

export interface ReconciledTemplatePatterns {
  /**
   * テンプレートが現在宣言しているパターン。次回の同期の共通祖先として lock へ記録する。
   *
   * テンプレートに `ziku.jsonc` が無いときは `undefined`。空集合として記録すると、次回の
   * 突き合わせで「テンプレートが全パターンを外した」と読まれ、ローカルの宣言が消える。
   */
  readonly templatePatterns: ConfigPatterns | undefined;
  /**
   * 走査に使う和集合。ローカルの宣言・テンプレートの宣言・前回のテンプレートの宣言のすべてを
   * 含む。分類が「片側にしか無い」を正しく出せるよう、どの由来のパターンも落とさない。
   */
  readonly scan: ConfigPatterns;
  /** ローカルの `ziku.jsonc` が持つべき宣言（3-way の結果）。 */
  readonly declared: ConfigPatterns;
  /** テンプレ側で新規に追加され、ローカルには無かったパターン。 */
  readonly added: ConfigPatterns;
  /** テンプレ側が外し、ローカルの宣言からも落とすパターン。利用者への通知に使う。 */
  readonly removed: ConfigPatterns;
  /**
   * 走査には入るが宣言には入らないパターン。
   *
   * ローカルが宣言していなくても、テンプレートや前回の宣言に由来して走査へ入るものがある
   * （ローカルが外したパターンをテンプレートがまだ持っている場合など）。{@link removed} は
   * ローカルの宣言から落ちる分だけなので、その差を表せない。同期対象かどうかの判定には
   * こちらを使う。
   */
  readonly retired: ConfigPatterns;
}

const EMPTY: ConfigPatterns = { include: [], exclude: [] };

/** `local` にあって `next` に無いパターン。宣言から落ちる分を取り出す。 */
function droppedFrom(local: readonly GlobPattern[], next: readonly GlobPattern[]): GlobPattern[] {
  const kept = new Set<string>(next);
  return local.filter((pattern) => !kept.has(pattern));
}

/**
 * テンプレートの `ziku.jsonc` を読み込み、ローカルパターンと突き合わせた結果を返す。
 *
 * テンプレート側の設定が読めなかったときの扱いは、パターンが空である理由で分ける。
 *
 * - `ziku.jsonc` が無い: まだ ziku を使っていないテンプレートという正当な状態。テンプレートの
 *   宣言を空として扱い、ローカルのパターンだけが残る。前回の宣言（`basePatterns`）は渡さずに
 *   突き合わせる。渡すと、読めなかっただけの状態が「テンプレートが全パターンを外した」に
 *   見え、ローカルの宣言を丸ごと空にする。
 * - 構文が壊れている / ziku の設定として解釈できない: 空へ潰さず中断する。潰すと「テンプレートは
 *   何も同期対象と定めていない」という読みが走査範囲になり、テンプレートが追跡しているファイルが
 *   分類にも差分にも現れないまま、同期済みとして報告される。テキストは人が直せるので、直すまで
 *   待っても何も失われない。構文の破綻とスキーマ違反は、直す箇所が違うので別の失敗として報告する。
 *
 * 失敗は `ZikuFailure` を throw して返す（`src/utils/config-merge.ts` と同じ経路）。呼び出し元は
 * Effect ではない async 関数の連なりで、その先はコマンド層が defect ごと拾ってトップレベルへ運ぶ。
 *
 * @param basePatterns 前回の同期時点でテンプレートが宣言していたパターン。記録の無い lock では
 *   `undefined` で、その場合パターンの削除は伝播しない（加法 union へ縮退する）。
 */
export async function mergeTemplatePatterns(
  templateDir: AbsPath,
  include: readonly GlobPattern[],
  exclude: readonly GlobPattern[],
  basePatterns: ConfigPatterns | undefined,
): Promise<ReconciledTemplatePatterns> {
  const loaded = await Effect.runPromise(loadTemplateConfig(templateDir).pipe(Effect.either));

  const templateConfig = Either.match(loaded, {
    onRight: (config) => ({
      patterns: { include: config.include, exclude: config.exclude ?? [] },
      configured: true,
    }),
    onLeft: (error) =>
      match(error)
        .with({ _tag: "TemplateNotConfiguredError" }, () => ({
          patterns: EMPTY,
          configured: false,
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

  const local: ConfigPatterns = { include, exclude };
  const base = templateConfig.configured ? basePatterns : undefined;
  const declared = reconcilePatterns({ base, local, template: templateConfig.patterns });

  const scanInclude = unionPatterns(
    unionPatterns(include, templateConfig.patterns.include).merged,
    base?.include ?? [],
  );
  const scanExclude = unionPatterns(
    unionPatterns(exclude, templateConfig.patterns.exclude).merged,
    base?.exclude ?? [],
  );

  return {
    templatePatterns: templateConfig.configured ? templateConfig.patterns : undefined,
    scan: { include: scanInclude.merged, exclude: scanExclude.merged },
    declared,
    added: {
      include: unionPatterns(include, declared.include).added,
      exclude: unionPatterns(exclude, declared.exclude).added,
    },
    removed: {
      include: droppedFrom(include, declared.include),
      exclude: droppedFrom(exclude, declared.exclude),
    },
    retired: {
      include: droppedFrom(scanInclude.merged, declared.include),
      exclude: droppedFrom(scanExclude.merged, declared.exclude),
    },
  };
}
