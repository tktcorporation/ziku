import type { AbsPath, GlobPattern, RepoRelPath } from "../modules/schemas";
import type { ConfigPatterns } from "./config-merge";
import { loadMergedGitignore } from "./gitignore";
import { resolvePatterns } from "./patterns";
import type { IgnoreDecision } from "./gitignore";
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
 * 宣言されたパターンに加えて、テンプレートが外したパターン（前回の宣言）と、ziku 自身が
 * 同期の前提として必要とする制御ファイル（`alwaysTrackedPathsIn` の対象）を含む。
 * ハッシュ計算・分類・差分検出はこれで走る。
 *
 * 宣言より広く取るのは、パターンを外すことがファイルを消すことと別だから。外したパターンを
 * 走査からも同時に落とすと、そのパターンにだけ一致していたローカルのファイルはどちらの走査にも
 * 現れず、テンプレートが同じ変更で削除したファイルが削除候補から静かに落ちる。
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
 * テンプレート側にしかなかったパターンはこちらにも含む。それらは次の `pull` / `push` で
 * ローカルの `ziku.jsonc` へ書き込まれる宣言そのものになる。除くと、実際に同期されている
 * ディレクトリが探索の基点から外れ、そこに置いた新規ファイルを追跡候補として提示できなくなる。
 *
 * 逆に、テンプレートが外したパターンはこちらから落ちる。走査
 * （{@link ScanPatterns}）には残るので、そのパターンにだけ一致していたファイルは今回の実行では
 * 分類の対象のままで、削除候補として提示できる。宣言から落ちた時点でそのファイルは同期対象で
 * なくなり、以降は未追跡として扱われる。
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
  /**
   * 走査から外すファイルの判定。
   *
   * ローカルとテンプレートのルート `.gitignore` に加えて、宣言されたパターンが触れる
   * サブツリーに実在する `.gitignore`（`.claude/.gitignore` や `.claude/sub/.gitignore`）も
   * 深さに関わらず畳み込んである。
   * 参照は {@link isExcludedFromScope} 経由に閉じる。ここから直接 `ignores()` を呼ぶと
   * `alwaysTracked` の例外が抜け落ちる。
   */
  readonly gitignore: IgnoreDecision;
  /**
   * gitignore や exclude に関わらず走査へ戻すパス。
   *
   * ziku 自身の設定ファイルは、プロジェクトが `.ziku/` を無視していても同期する。
   * 同期対象パターンの定義そのものなので、これが伝播しないとテンプレート側の追加が
   * どのプロジェクトにも届かない。
   */
  readonly alwaysTracked: readonly RepoRelPath[];
  /**
   * 宣言から落ちたパターン。走査には残っているが、同期対象ではない。
   *
   * 空でないことが「走査が宣言より広い」ことの根拠になる。広い分に含まれるファイルは、
   * テンプレート側の削除を最後まで見届けるためだけに分類へ載せ、それ以外の扱い
   * （テンプレート内容の配置・更新・マージ）からは外す（`utils/sync-analysis.ts`）。
   */
  readonly retired: ConfigPatterns;
}

export interface ResolvedSyncScope {
  readonly scope: SyncScope;
  /** テンプレート側にしかなかった include パターン。取り込みの通知に使う。 */
  readonly newInclude: readonly GlobPattern[];
  /** テンプレート側が外し、ローカルの宣言からも落とす include パターン。通知に使う。 */
  readonly removedInclude: readonly GlobPattern[];
  /**
   * テンプレートが現在宣言しているパターン。lock へ記録して次回の共通祖先にする
   * （`utils/template-patterns.ts` の `ReconciledTemplatePatterns`）。
   */
  readonly templatePatterns: ConfigPatterns | undefined;
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
  scan: ConfigPatterns;
  declared: ConfigPatterns;
  retired: ConfigPatterns;
}): Promise<SyncScope> {
  // `.gitignore` を探す範囲は、同期対象のパターンが触れる位置に限る。走査用パターンへ足す
  // `.ziku/ziku.jsonc` を含めると、ziku 自身の設定ディレクトリを探索の基点として扱う経路が
  // 範囲の決定側にも生まれる。
  const gitignore = await loadMergedGitignore(
    [params.targetDir, params.templateDir],
    params.scan.include,
  );
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
      include: withConfigTracked(params.scan.include),
      exclude: params.scan.exclude,
    },
    declared: {
      purpose: "declared",
      include: params.declared.include,
      exclude: params.declared.exclude,
    },
    gitignore,
    alwaysTracked,
    retired: params.retired,
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
 *
 * テンプレートの `ziku.jsonc` が壊れている場合は `ZikuFailure` を throw する
 * （{@link mergeTemplatePatterns}）。範囲が黙って縮むより、直せる失敗として報告する。
 */
export async function resolveSyncScope(params: {
  targetDir: AbsPath;
  templateDir: AbsPath;
  include: readonly GlobPattern[];
  exclude: readonly GlobPattern[];
  /**
   * 前回の同期時点でテンプレートが宣言していたパターン（lock の `base.patterns`）。
   *
   * 記録の無い lock では `undefined`。そのときはテンプレートが外したパターンを「ローカル固有の
   * 追加」と区別できないので、削除は伝播しない（加法 union へ縮退する）。省略可能にしないのは、
   * 渡し忘れが同じ縮退へ静かに落ちるため。
   */
  basePatterns: ConfigPatterns | undefined;
}): Promise<ResolvedSyncScope> {
  const reconciled = await mergeTemplatePatterns(
    params.templateDir,
    params.include,
    params.exclude,
    params.basePatterns,
  );
  const scope = await composeScope({
    targetDir: params.targetDir,
    templateDir: params.templateDir,
    scan: reconciled.scan,
    declared: reconciled.declared,
    retired: reconciled.retired,
  });
  return {
    scope,
    newInclude: reconciled.added.include,
    removedInclude: reconciled.removed.include,
    templatePatterns: reconciled.templatePatterns,
  };
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
  const patterns: ConfigPatterns = { include: params.include, exclude: params.exclude };
  return composeScope({
    targetDir: params.targetDir,
    templateDir: params.templateDir,
    scan: patterns,
    declared: patterns,
    retired: { include: [], exclude: [] },
  });
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

/**
 * そのパスが走査範囲から外れるか。
 *
 * 「同期の対象か」を決める規則はこの 1 関数だけが持つ。ハッシュ計算・差分検出（{@link
 * withinScope} 経由）と未追跡ファイルの探索が別々に gitignore を評価すると、片方だけが
 * 落とすファイルが生まれる。そのファイルは未追跡として追跡を勧められるのに、追跡しても
 * ハッシュにも差分にも現れず、`ziku.jsonc` に載ったまま永久に同期されないパターンになる。
 */
export function isExcludedFromScope(file: RepoRelPath, scope: SyncScope): boolean {
  if (scope.alwaysTracked.includes(file)) return false;
  return scope.gitignore.ignores(file);
}

/** 走査結果から、範囲外のパスを落とす。 */
export function withinScope(files: readonly RepoRelPath[], scope: SyncScope): RepoRelPath[] {
  return files.filter((file) => !isExcludedFromScope(file, scope));
}

/**
 * 走査が宣言より広いか。
 *
 * テンプレートが外したパターンがあるときだけ真になる。広くない実行では、宣言の中かどうかを
 * 確かめるための追加の走査（{@link declaredPaths}）が不要になる。
 */
export function scanExceedsDeclared(scope: SyncScope): boolean {
  return scope.retired.include.length > 0 || scope.retired.exclude.length > 0;
}

/**
 * 宣言されたパターンが実際に拾うパス。
 *
 * 走査の範囲（{@link ScanPatterns}）には、テンプレートが外したパターンにだけ一致する
 * ファイルも入る。それらは同期対象ではないので、テンプレートの内容を配置したり更新したり
 * する扱いへ載せてはならない。その判定に使う集合を、両ディレクトリの実体から作る。
 */
export function declaredPaths(params: {
  targetDir: AbsPath;
  templateDir: AbsPath;
  scope: SyncScope;
}): ReadonlySet<RepoRelPath> {
  const { scope } = params;
  const resolve = (dir: AbsPath): RepoRelPath[] =>
    withinScope(resolvePatterns(dir, scope.declared.include, scope.declared.exclude), scope);
  return new Set([
    ...resolve(params.targetDir),
    ...resolve(params.templateDir),
    ...scope.alwaysTracked,
  ]);
}
