import type { Ignore } from "ignore";
import type { AbsPath, GlobPattern, RepoRelPath } from "../modules/schemas";
import { loadMergedGitignore } from "./gitignore";
import { mergeTemplatePatterns } from "./template-patterns";
import { alwaysTrackedPathsIn, withConfigTracked } from "./ziku-config";

/**
 * パターン集合の用途。
 *
 * 走査用と宣言用は同じ形（include / exclude）なので、識別子が無いと互いに代入でき、
 * 取り違えても型検査を通る。用途を値として持たせることで、受け取る側が
 * {@link ScanPatterns} / {@link DeclaredPatterns} のどちらを要求するかをシグネチャで
 * 表明でき、渡し間違いがコンパイルエラーになる。
 */
export type PatternPurpose = "scan" | "declared";

interface PurposedPatterns<P extends PatternPurpose> {
  readonly purpose: P;
  readonly include: readonly GlobPattern[];
  readonly exclude: readonly GlobPattern[];
}

/**
 * ローカルとテンプレートを突き合わせるために走査するパターン。
 *
 * 宣言されたパターンに加えて、ziku 自身が同期の前提として必要とする制御ファイル
 * （`alwaysTrackedPathsIn` の対象）を含む。ハッシュ計算・分類・差分検出はこれで走る。
 */
export type ScanPatterns = PurposedPatterns<"scan">;

/**
 * 追跡対象として `.ziku/ziku.jsonc` に宣言されたパターン。
 *
 * ziku が走査のために足す制御ファイルのエントリを含まない。未追跡ファイルの探索は
 * こちらで走らせる。走査用のパターンで探索すると `.ziku` が探索の基点とみなされ、
 * 同期対象ではない `.ziku/lock.json`（テンプレート取得元とベースを持つマシン固有の
 * ファイル）が追跡候補として提示される。案内に従って追跡すると、そのマシン固有の内容が
 * テンプレートへ送られる。
 *
 * テンプレート側にしかなかったパターンはこちらにも含む。パターン同期は加法 union なので、
 * それらは次の `pull` / `push` でローカルの `ziku.jsonc` へ書き込まれる宣言そのものになる。
 * 除くと、実際に同期されているディレクトリが探索の基点から外れ、そこに置いた新規ファイルを
 * 追跡候補として提示できなくなる。
 */
export type DeclaredPatterns = PurposedPatterns<"declared">;

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
  /** 走査に使うパターン。 */
  readonly scan: ScanPatterns;
  /** 追跡対象として宣言されたパターン。 */
  readonly declared: DeclaredPatterns;
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
 * 宣言されたパターンから走査範囲を組み立てる。
 *
 * 走査用の include は宣言に制御ファイルを足したもので、それ以外の差は作らない。2 つの
 * 集合を別々に組み立てると、宣言には有るのに走査されないパターン（またはその逆）が
 * 生まれ、「追跡していると表示されるのに同期されない」ずれになる。
 */
async function composeScope(params: {
  targetDir: AbsPath;
  templateDir: AbsPath;
  include: readonly GlobPattern[];
  exclude: readonly GlobPattern[];
}): Promise<SyncScope> {
  const gitignore = await loadMergedGitignore([params.targetDir, params.templateDir]);
  const alwaysTracked = [
    ...new Set([
      ...alwaysTrackedPathsIn(params.targetDir),
      ...alwaysTrackedPathsIn(params.templateDir),
    ]),
  ];
  return {
    scan: {
      purpose: "scan",
      // ziku 自身の設定ファイルを走査対象へ含める。他の追跡ファイルと同じ差分検出に
      // 乗せることで、パターンの追加が双方向に伝わる。
      include: withConfigTracked(params.include),
      exclude: params.exclude,
    },
    declared: { purpose: "declared", include: params.include, exclude: params.exclude },
    gitignore,
    alwaysTracked,
  };
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
  const scope = await composeScope({
    targetDir: params.targetDir,
    templateDir: params.templateDir,
    include: mergedInclude,
    exclude: mergedExclude,
  });
  return { scope, newInclude };
}

/**
 * 渡したパターンだけで走査範囲を決める（テンプレート側の追加を取り込まない）。
 *
 * `init` は導入するディレクトリをユーザーに選ばせるので、テンプレートのパターン全体を
 * 走査すると、配置していないファイルのハッシュまで次の同期ベースに載る。ベースだけが
 * 存在するそのパスは「ローカルは変えていない・テンプレートだけが変わった」と読まれ、
 * 次の `pull` がユーザーの既存ファイルを確認なくテンプレートの内容で置き換える。
 * 選んだ範囲に閉じておけば、選ばなかったディレクトリのファイルはベースを持たず、
 * ローカルとテンプレートの両方に在るファイルとして `conflicts` に入る（ユーザーが決める）。
 */
export function resolveDeclaredScope(params: {
  targetDir: AbsPath;
  templateDir: AbsPath;
  include: readonly GlobPattern[];
  exclude: readonly GlobPattern[];
}): Promise<SyncScope> {
  return composeScope(params);
}

/**
 * 走査範囲に include パターンを足す。
 *
 * `push` が未追跡ファイルを追跡対象へ加えるときに使う。分類は送信候補を確定させるので、
 * 加えたパターンを分類の前に範囲へ入れておかないと、新しく追跡したファイルが候補に乗らない。
 * 宣言側にも同じパターンを足す。push 成功後に `ziku.jsonc` へ書き込む宣言そのものなので、
 * 走査だけに足すと「同期はされるが宣言には無い」状態を範囲が表せなくなる。
 * gitignore は据え置く。無視されるファイルは追跡対象に選んでも同期しない。
 */
export function extendScope(scope: SyncScope, include: readonly GlobPattern[]): SyncScope {
  if (include.length === 0) return scope;
  return {
    ...scope,
    scan: { ...scope.scan, include: [...new Set([...scope.scan.include, ...include])] },
    declared: {
      ...scope.declared,
      include: [...new Set([...scope.declared.include, ...include])],
    },
  };
}

/** 走査結果から、範囲外のパスを落とす。 */
export function withinScope(files: readonly RepoRelPath[], scope: SyncScope): RepoRelPath[] {
  const always = new Set<RepoRelPath>(scope.alwaysTracked);
  return files.filter((file) => always.has(file) || !scope.gitignore.ignores(file));
}
