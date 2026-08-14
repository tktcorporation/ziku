import type { Ignore } from "ignore";
import type { AbsPath, GlobPattern, RepoRelPath } from "../modules/schemas";
import { loadMergedGitignore } from "./gitignore";
import { mergeTemplatePatterns } from "./template-patterns";
import { alwaysTrackedPathsIn, withConfigTracked } from "./ziku-config";

/**
 * 同期対象のファイルを走査する範囲。
 *
 * ローカルとテンプレートは同じ範囲で走査しなければならない。片側だけ条件がずれると、
 * 対象外のファイルが「片側にしか無い」と分類され、追加や削除として扱われる。
 * コマンドごとに範囲を組み立てると、分類では変更ありと出たファイルが差分に現れず
 * 送信候補から黙って落ちる、といった食い違いが生まれる。
 *
 * gitignore を範囲に含めるのは、無視されるファイルがローカル固有の内容
 * （マシン固有の設定・資格情報）を持つため。テンプレートが同名のファイルを持っていても、
 * ローカルの内容を上書きしてよいとは限らない。走査から外すことで、分類にも差分にも
 * 現れなくなり、pull が書き換えることも push が送ることもなくなる。
 *
 * 初期化時のコピーだけは例外で、ローカルにまだ無いファイルは配置する
 * （`fetchTemplates` が扱う）。そこにしかない判断なので、この型は「同期の対象か」だけを
 * 表す。
 */
export interface SyncScope {
  readonly include: readonly GlobPattern[];
  readonly exclude: readonly GlobPattern[];
  readonly gitignore: Ignore;
  /**
   * gitignore や exclude に関わらず走査へ戻すパス。
   *
   * ziku 自身の設定ファイルは、プロジェクトが `.ziku/` を無視していても同期する。
   * 同期対象パターンの定義そのものなので、これが伝播しないとテンプレート側の追加が
   * どのプロジェクトにも届かない。
   */
  readonly alwaysTracked: readonly RepoRelPath[];
}

export interface ResolvedSyncScope {
  readonly scope: SyncScope;
  /** テンプレート側にしかなかった include パターン。取り込みの通知に使う。 */
  readonly newInclude: readonly GlobPattern[];
}

/**
 * ローカルとテンプレートの両方から走査範囲を決める。
 *
 * include はローカルとテンプレートの和集合を採る。テンプレートが追加したパターン配下の
 * ファイルを差分検出の対象に含めないと、`status` が同期済みと答えた直後の `pull` で
 * 大量の新規ファイルが降ってくる。全コマンドが同じ和集合を使うので、`status` が勧めた
 * 操作を `push` が実行できない、`pull` が同期しているファイルを `push` が未追跡として
 * 報告する、といったずれが起きない。
 *
 * gitignore は双方をマージして読む。テンプレート側だけが無視しているファイルも、
 * ローカル側だけが無視しているファイルも、同期の対象から外れる。
 */
export async function resolveSyncScope(params: {
  targetDir: AbsPath;
  templateDir: AbsPath;
  include: readonly GlobPattern[];
  exclude: readonly GlobPattern[];
}): Promise<ResolvedSyncScope> {
  const { mergedInclude, mergedExclude, newInclude } = await mergeTemplatePatterns(
    params.templateDir,
    params.include,
    params.exclude,
  );
  const gitignore = await loadMergedGitignore([params.targetDir, params.templateDir]);
  const alwaysTracked = [
    ...new Set([
      ...alwaysTrackedPathsIn(params.targetDir),
      ...alwaysTrackedPathsIn(params.templateDir),
    ]),
  ];
  return {
    scope: {
      // ziku 自身の設定ファイルを走査対象へ含める。他の追跡ファイルと同じ差分検出に
      // 乗せることで、パターンの追加が双方向に伝わる。
      include: withConfigTracked(mergedInclude),
      exclude: mergedExclude,
      gitignore,
      alwaysTracked,
    },
    newInclude,
  };
}

/**
 * 走査範囲に include パターンを足す。
 *
 * `push` が未追跡ファイルを追跡対象へ加えるときに使う。分類は送信候補を確定させるので、
 * 加えたパターンを分類の前に範囲へ入れておかないと、新しく追跡したファイルが候補に乗らない。
 * gitignore は据え置く。無視されるファイルは追跡対象に選んでも同期しない。
 */
export function extendScope(scope: SyncScope, include: readonly GlobPattern[]): SyncScope {
  if (include.length === 0) return scope;
  return { ...scope, include: [...new Set([...scope.include, ...include])] };
}

/** 走査結果から、範囲外のパスを落とす。 */
export function withinScope(files: readonly RepoRelPath[], scope: SyncScope): RepoRelPath[] {
  const always = new Set<RepoRelPath>(scope.alwaysTracked);
  return files.filter((file) => always.has(file) || !scope.gitignore.ignores(file));
}
