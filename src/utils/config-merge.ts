/**
 * `.ziku/ziku.jsonc`（include/exclude パターン）専用の要素レベル加法マージ（和集合）。
 *
 * 背景: `ziku.jsonc` を双方向同期の追跡ファイルにすると、ローカルとテンプレートの双方が
 * パターンを編集したケース（conflict）が発生する。これを汎用のテキスト diff3 マージに
 * かけると、JSON 配列の隣接行編集が衝突マーカーになり JSON が壊れる。代わりにパターンを
 * 「集合」として扱い、要素単位でマージすることで、常に解決可能（衝突マーカーなし）で
 * 決定的な結果を得る。
 *
 * 突き合わせ方は方向で分かれる。
 *
 * - テンプレート → ローカル（{@link reconcilePatterns}）は 3-way。lock の `base.patterns`
 *   （前回の同期時点でテンプレートが宣言していた集合）を共通祖先に使い、テンプレートが外した
 *   パターンをローカルからも落とす。ローカルが外したパターンは戻さない。
 * - ローカル → テンプレート（{@link mergeConfigPatterns}）は加法 union。1 つのプロジェクトが
 *   外したパターンをテンプレートから消すと、そのテンプレートを使う全プロジェクトへ波及する。
 *   削除はテンプレートの `ziku.jsonc` を直接編集する操作に閉じる。
 *
 * 3-way の共通祖先にローカル側の base（lock の `base.hashes` が指す内容）を使わないのは、
 * それが「ローカルが前回宣言していた集合」だから。`init` でテンプレートのパターンの部分集合を
 * 選んで導入したプロジェクトでは、それは合成された部分集合であってテンプレートの宣言とは
 * 一致しない。これを共通祖先に据えると、ユーザーが未選択にしただけのパターンが「テンプレートが
 * 削除した」に見える。記録が無い lock（この形式より前に作られたもの）は共通祖先を空集合として
 * 扱い、加法 union へ縮退する。
 */
import { match } from "ts-pattern";
import { zikuFailure } from "../errors";
import type { AbsPath, GlobPattern, RepoRelPath } from "../modules/schemas";
import { joinAbs, selectPatternsMatchingPaths } from "./paths";
import { unionPatterns } from "./patterns";
import { ZIKU_CONFIG_FILE, generateZikuJsonc, readZikuConfig, withPatterns } from "./ziku-config";

export interface ConfigPatterns {
  readonly include: readonly GlobPattern[];
  readonly exclude: readonly GlobPattern[];
}

const EMPTY_PATTERNS: ConfigPatterns = { include: [], exclude: [] };

/**
 * include / exclude を要素レベルで加法マージ（和集合）する純粋関数。
 *
 * `document` は、この結果を書き戻す先の `ziku.jsonc` が今持っているパターン。その並びを
 * 保ったまま `incoming` の追加分を末尾へ積む（{@link unionPatterns}）。いずれの側の
 * パターンも削除しない（削除は伝播しない）。
 */
export function mergeConfigPatterns(opts: {
  document: ConfigPatterns;
  incoming: ConfigPatterns;
}): ConfigPatterns {
  return {
    include: unionPatterns(opts.document.include, opts.incoming.include).merged,
    exclude: unionPatterns(opts.document.exclude, opts.incoming.exclude).merged,
  };
}

/** 並びを保ったまま重複を落とす。 */
function dedupe(patterns: readonly GlobPattern[]): GlobPattern[] {
  return [...new Set(patterns)];
}

/**
 * 1 種類のパターン列について、ローカルが持つべき集合を 3-way で決める。
 *
 * 並びはローカルの宣言を先頭に置き、テンプレートの追加分を末尾へ積む（{@link unionPatterns}
 * と同じ基準）。書き戻し先の文書と並びの基準を揃えることで、差分が末尾への追記と削除行だけに
 * なる。
 */
function reconcileList(
  base: readonly GlobPattern[],
  local: readonly GlobPattern[],
  template: readonly GlobPattern[],
): GlobPattern[] {
  const inBase = new Set<string>(base);
  const inLocal = new Set<string>(local);
  const inTemplate = new Set<string>(template);

  // ローカルの宣言のうち、テンプレートが外したものだけを落とす。ベースに無いパターンは
  // ローカル固有の追加なので、テンプレートに無くても残す。
  const kept = dedupe(local).filter(
    (pattern) => !(inBase.has(pattern) && !inTemplate.has(pattern)),
  );
  // テンプレートの宣言のうち、ローカルに無いものを足す。ベースにあってローカルに無いものは
  // ローカルが外した（opt-out）ので戻さない。
  const added = dedupe(template).filter((pattern) => !inLocal.has(pattern) && !inBase.has(pattern));

  return [...kept, ...added];
}

/**
 * ローカルの宣言・テンプレートの宣言・前回のテンプレートの宣言から、ローカルが持つべき
 * パターンを決める。
 *
 * `base` が `undefined`（記録の無い lock）のときは共通祖先が空集合になり、どちらの削除条件も
 * 成立しないので結果は加法 union と一致する。判断材料が無い状態では何も消さない、という
 * 安全側の縮退がそのまま式に現れる。
 */
export function reconcilePatterns(opts: {
  readonly base: ConfigPatterns | undefined;
  readonly local: ConfigPatterns;
  readonly template: ConfigPatterns;
}): ConfigPatterns {
  const base = opts.base ?? EMPTY_PATTERNS;
  return {
    include: reconcileList(base.include, opts.local.include, opts.template.include),
    exclude: reconcileList(base.exclude, opts.local.exclude, opts.template.exclude),
  };
}

/**
 * ディスク上の `ziku.jsonc` 1 つ分。
 *
 * 生の内容も持ち回るのは、union の結果を「新しく生成した内容」ではなく「元の内容の
 * include / exclude だけを差し替えたもの」として書き出すため（{@link withPatterns}）。
 * パターンだけを取り出して作り直すと、注釈と ziku が読まないキーが同期のたびに消える。
 */
interface ConfigDocument {
  readonly raw: string;
  readonly patterns: ConfigPatterns;
}

/**
 * 指定ディレクトリの `.ziku/ziku.jsonc` を読む。
 * ファイルが無ければ undefined（base が無いケースの判定に使う）。
 *
 * 読み取りと失敗の分類は {@link readZikuConfig} が持ち、ここはその結果を `ZikuFailure` へ
 * 写すだけにする。構文だけを見て値をキャストで通すと、`"include": "a"` や `"include": [1]`
 * のようにスキーマだけを破った設定が、パターン列を組み立てる時点の型エラー
 * （`map is not a function`）や、数値を glob として扱う同期として現れる。どちらも分類済みの
 * 失敗にならず、利用者はどのファイルのどこが悪いか分からないまま止まる。
 *
 * 構文が壊れていれば、ユーザーが手で直せる失敗として報告して中断する。パターン無しとして
 * 扱わないのは、ここで読んだ内容が union の入力であると同時に、{@link renderUnionInto} が
 * 書き戻す先の土台でもあるため。壊れた側を空集合とみなすと、その側のパターンを 1 つ残らず
 * 落とした内容を「マージ結果」として書き出す。テンプレート側でそれが起きると、パターンを
 * 失った `ziku.jsonc` が PR に載り、マージされた時点で全プロジェクトの init / pull が
 * 同期対象を見失う。エラー回復が返す部分的な値を採るのも同じ理由で採れない（回復できな
 * かった分だけが静かに消える）。
 *
 * 中断が安全側なのは、`ziku.jsonc` が人の手で直せるテキストであり、直すまで待っても
 * 何も失われないため。ローカル側は `loadZikuConfig` が同じ理由で先に弾いており、
 * テンプレート側もここで同じ扱いに揃う。
 *
 * 失敗は `ZikuFailure` を throw して返す。この関数の呼び出し元は Effect ではない async
 * 関数の連なりで、その先はコマンド層が defect ごと拾ってトップレベルへ運ぶ。`ZikuFailure`
 * は `Error` を継承するのでその経路をそのまま通り、文言と hint が保たれる。
 */
async function readConfigAt(dir: AbsPath): Promise<ConfigDocument | undefined> {
  const path = joinAbs(dir, ZIKU_CONFIG_FILE);

  return match(await readZikuConfig(dir))
    .with({ _tag: "NotFound" }, () => undefined)
    .with({ _tag: "Unparsable" }, ({ detail }): never => {
      throw zikuFailure({ kind: "ConfigUnparsable", path, detail });
    })
    .with({ _tag: "Invalid" }, ({ issues }): never => {
      throw zikuFailure({ kind: "ConfigInvalid", path, issues });
    })
    .with({ _tag: "Ok" }, ({ raw, config }) => ({
      raw,
      patterns: { include: config.include, exclude: config.exclude ?? [] },
    }))
    .exhaustive();
}

/**
 * 書き換える対象の文書に `incoming` を和集合で足した `ziku.jsonc` の内容を返す。
 *
 * 元の文書の include / exclude だけを差し替え、注釈と他のキーを残す。
 *
 * union の並びの基準（{@link unionPatterns} の `base`）と書き戻し先の文書を、同じ 1 つの
 * 引数から導く。マージ済みのパターン列を受け取る形にすると「テンプレートの文書を、ローカルを
 * 先にした並びで書き換える」組み合わせが作れてしまい、既存要素が並べ替わって配列全体の
 * 差し替えになる（追記のはずの差分が全行の入れ替えとして PR に出る）。
 *
 * 文書が無い場合（まだ `ziku.jsonc` が存在しないテンプレート / プロジェクト）はこの関数を
 * 通せない。その状況で作れるのは「土台に足した内容」ではなく「渡した分だけの新しい文書」で、
 * 両者を 1 つの関数で扱うと、土台があることを前提にした呼び出しが黙って全体生成へ落ちる。
 * 新規生成が正しい経路は {@link renderFullConfig} を明示的に選ぶ。
 */
function renderUnionInto(document: ConfigDocument, incoming: ConfigPatterns): string {
  return withPatterns(document.raw, mergeConfigPatterns({ document: document.patterns, incoming }));
}

/** 土台になる文書が無いときに、渡したパターンだけで `ziku.jsonc` を新規生成する。 */
function renderFullConfig(incoming: ConfigPatterns): string {
  return generateZikuJsonc(mergeConfigPatterns({ document: EMPTY_PATTERNS, incoming }));
}

/** 2 つのパターン配列が集合として等しいか（順序・重複を無視）。 */
function sameSet(a: readonly GlobPattern[], b: readonly GlobPattern[]): boolean {
  const sa = new Set(a);
  const sb = new Set(b);
  if (sa.size !== sb.size) return false;
  for (const x of sa) if (!sb.has(x)) return false;
  return true;
}

/**
 * `ziku.jsonc` の内容が、どちら向きに同期アクションを必要としているか。
 *
 * ハッシュ差分では判断できない。ローカルが独自に足したパターンがあるだけで内容は食い違うが、
 * push はテンプレートの宣言を減らさないので送っても何も起きない、という組み合わせがあるため。
 * 実際に書き込みが起きるかを、パターン集合の突き合わせから判断する。
 */
export interface ConfigDrift {
  /** pull がローカルの宣言を書き換える（テンプレートの追加を足す／外した分を落とす）。 */
  readonly pullRelevant: boolean;
  /** push がテンプレートの宣言を増やす（ローカルにしか無いパターンがある）。 */
  readonly pushRelevant: boolean;
}

/**
 * `ziku.jsonc` の「実際に同期アクションが必要か」を union 観点で判定する。
 *
 * status の推奨判定に使うことで、テンプレ側のパターン削除だけのケースで pull を
 * 無限に推奨してしまう no-op ループを防ぐ。
 */
export async function analyzeConfigDrift(
  targetDir: AbsPath,
  templateDir: AbsPath,
  /**
   * 前回の同期時点でテンプレートが宣言していたパターン（lock の `base.patterns`）。
   *
   * 記録の無い lock では `undefined`。省略可能にしないのは、渡し忘れが「テンプレートの削除を
   * 検出しない」へ静かに縮退するため。呼び出し側に毎回どちらかを表明させる。
   */
  basePatterns: ConfigPatterns | undefined,
): Promise<ConfigDrift> {
  const [local, template] = await Promise.all([readConfigAt(targetDir), readConfigAt(templateDir)]);
  const l = local?.patterns ?? EMPTY_PATTERNS;
  const t = template?.patterns ?? EMPTY_PATTERNS;
  // pull が書き込む内容そのもの。テンプレートが外したパターンはここで落ちるので、それが
  // 「ローカルにしか無いパターン」として push 側の判定へ流れ込まない。
  const reconciled = reconcilePatterns({ base: basePatterns, local: l, template: t });
  // どちら向きの判定も集合の包含だけを見るので、並びの基準はどちらでも結果が変わらない。
  const eq = (a: ConfigPatterns, b: ConfigPatterns): boolean =>
    sameSet(a.include, b.include) && sameSet(a.exclude, b.exclude);
  return {
    pullRelevant: !eq(reconciled, l),
    pushRelevant: !eq(mergeConfigPatterns({ document: t, incoming: reconciled }), t),
  };
}

/**
 * そのディレクトリの `ziku.jsonc` が宣言しているパターン。`ziku.jsonc` が無ければ `undefined`。
 *
 * lock へ「テンプレートが宣言していたパターン」を記録する経路が使う。空集合ではなく
 * `undefined` を返すのは、設定ファイルの不在と「何も宣言していない」を混ぜないため。前者を
 * 空集合として記録すると、次回の突き合わせで「テンプレートが全パターンを外した」と読まれる。
 */
export async function readDeclaredPatterns(dir: AbsPath): Promise<ConfigPatterns | undefined> {
  return (await readConfigAt(dir))?.patterns;
}

/**
 * pull がローカルの `ziku.jsonc` へ書き込む内容を組み立てる。
 *
 * テンプレートの追加を取り込み、テンプレートが外したパターンを落とした結果
 * （{@link reconcilePatterns}）を、ローカルの文書へ差し込む。土台をローカルの文書にするのは、
 * 書き込み先がローカルであり、注釈と ziku が読まないキーを残す必要があるため。
 *
 * テンプレートへ送る内容は {@link computeMergedZikuConfig} が別に組み立てる。こちらの結果を
 * 送ると、ローカルが外したパターンがテンプレートからも消え、全下流のプロジェクトへ波及する。
 */
export async function computeReconciledZikuConfig(opts: {
  targetDir: AbsPath;
  templateDir: AbsPath;
  basePatterns: ConfigPatterns | undefined;
}): Promise<string> {
  const [local, template] = await Promise.all([
    readConfigAt(opts.targetDir),
    readConfigAt(opts.templateDir),
  ]);

  const reconciled = reconcilePatterns({
    base: opts.basePatterns,
    local: local?.patterns ?? EMPTY_PATTERNS,
    template: template?.patterns ?? EMPTY_PATTERNS,
  });

  // ローカルに `ziku.jsonc` が無いのは init 前の状態。差し込む土台が無いので新規生成する。
  return local === undefined ? generateZikuJsonc(reconciled) : withPatterns(local.raw, reconciled);
}

/**
 * ローカルとテンプレートの `ziku.jsonc` を読み、要素レベルの和集合マージ結果を
 * `ziku.jsonc` 文字列として返す。
 *
 * テンプレートへ送る内容がこれになる。和集合なので、ローカルが外したパターンをテンプレートから
 * 消すことはなく、テンプレートのパターンもローカルの追加も失われない。ローカルへ書き込む内容は
 * {@link computeReconciledZikuConfig} が別に組み立てる。
 *
 * `extraIncludes` は、ディスク上の `ziku.jsonc` にはまだ書かれていないが今回の push で
 * 反映したい include パターン（対話 push で新規追跡選択したファイルのパス）を渡すために使う。
 * 追跡選択の永続化（`persistNewlyTracked`）は push 成功後に走るため、ディスク内容だけを
 * 読むと新規パターンが union から漏れ、テンプレにファイル本体だけ届いて include が届かない
 * （他プロジェクトの init/pull が拾えるのが 2 回目の push 後になる）。これを防ぐため、
 * 確定した新規追跡パターンを取り込む側へ加えてから union を取る。
 *
 * 結果はローカルの `ziku.jsonc` を土台に組み立てる（{@link renderUnionInto}）。この内容は
 * pull ならローカルへ書き戻され、push ならローカルの `ziku.jsonc` を送ると決めた場面で使われる
 * ので、どちらもローカルの注釈が残る側が正しい土台になる。並びもローカルの文書が基準になり、
 * 取り込む分（新規追跡パターン → テンプレートの追加分）が末尾へ積まれる。
 */
export async function computeMergedZikuConfig(opts: {
  targetDir: AbsPath;
  templateDir: AbsPath;
  extraIncludes?: readonly GlobPattern[];
}): Promise<string> {
  const [local, template] = await Promise.all([
    readConfigAt(opts.targetDir),
    readConfigAt(opts.templateDir),
  ]);

  const templatePatterns = template?.patterns ?? EMPTY_PATTERNS;
  const incoming: ConfigPatterns = {
    include: [...(opts.extraIncludes ?? []), ...templatePatterns.include],
    exclude: templatePatterns.exclude,
  };

  // ローカルに `ziku.jsonc` が無いのは init 前の状態で、そこへ書く内容はローカルの全パターン
  // （= 取り込む分だけ）になる。新規生成しても失われるものが無いので全体生成でよい。
  return local === undefined ? renderFullConfig(incoming) : renderUnionInto(local, incoming);
}

/**
 * ローカルの `ziku.jsonc` にのみ存在する include パターンのうち、指定パスのいずれかに
 * 一致するものだけを返す。
 *
 * 背景: `ziku track <pattern>` は即座にディスクの `ziku.jsonc` にパターンを
 * 書き込む。その後 `ziku push --files=<path>` のようにファイル本体だけを指定すると、
 * `ziku.jsonc` 自体は `--files` に含まれず push 候補から漏れ、パターンがテンプレへ
 * 伝播しない（本体だけテンプレに存在し、他プロジェクトの `pull` が検出できない）。
 *
 * 一致判定は glob として行う（`src/utils/paths.ts` の `selectPatternsMatchingPaths`）。
 * パターンとパスを同じ文字列として突き合わせると、`.claude/rules/*.md` のような glob は
 * どのパスとも一致せず、glob で追跡した利用者だけがこの補完から永久に漏れる。
 *
 * 無関係なローカル限定パターン（今回の push が触れていないファイルのもの）まで巻き込まない
 * ためのスコープ計算に使う。
 */
export async function findLocalOnlyPatternsForPaths(opts: {
  targetDir: AbsPath;
  templateDir: AbsPath;
  paths: readonly RepoRelPath[];
}): Promise<GlobPattern[]> {
  if (opts.paths.length === 0) return [];

  const [local, template] = await Promise.all([
    readConfigAt(opts.targetDir),
    readConfigAt(opts.templateDir),
  ]);

  const templateInclude = new Set<string>((template?.patterns ?? EMPTY_PATTERNS).include);
  const localOnly = (local?.patterns ?? EMPTY_PATTERNS).include.filter(
    (pattern) => !templateInclude.has(pattern),
  );

  return selectPatternsMatchingPaths({
    baseDir: opts.targetDir,
    patterns: localOnly,
    paths: opts.paths,
  });
}

/**
 * テンプレート側の `ziku.jsonc` に追加パターンを足せたかどうか。
 *
 * 足す先の文書が無ければ結果は「テンプレートの内容 + 追加分」ではなく「追加分だけの新しい
 * `ziku.jsonc`」になり、スコープ限定という前提が成り立たない。呼び出し側が両方のケースを
 * 網羅して扱う形にすることで、テンプレートに設定ファイルが無い状況で縮小版を新規作成する
 * 経路を型から選べなくする。
 */
export type ScopedZikuConfig =
  /** テンプレートの文書に追加分を足した内容。 */
  | { readonly _tag: "Scoped"; readonly content: string }
  /** テンプレートに `ziku.jsonc` が無く、足す先の文書が存在しない。 */
  | { readonly _tag: "NoTemplateConfig" };

/**
 * テンプレート側の `ziku.jsonc` に、指定した追加パターンだけを和集合で加えた
 * `ziku.jsonc` 文字列を返す。ローカルの `ziku.jsonc` の他のパターンは一切参照しない。
 *
 * `computeMergedZikuConfig` はローカルの `ziku.jsonc` 全体をテンプレと和集合するため、
 * ユーザーが `--files` で明示していないのに ziku.jsonc を自動同梱する場面で使うと、
 * 今回の push と無関係なローカル限定パターンまで一緒にテンプレへ漏れてしまう。
 * この関数はテンプレの内容 + 明示的に渡した追加分だけを union するため、無関係な
 * パターンを一切巻き込まない。
 *
 * 結果はテンプレートの `ziku.jsonc` を土台に組み立てる（{@link renderUnionInto}）。この
 * 内容はテンプレートへ送るだけでローカルへは書き戻さない（`push-plan.ts` の
 * `ZikuConfigWriteBack`）ので、残すべき注釈はテンプレート側のもの。並びもテンプレートの
 * 文書が基準になるため、既存パターンは動かず追加分だけが末尾に付く。追加分が既にテンプレート
 * にあるだけなら内容は 1 文字も変わらず、送るものが無いと判定される。
 */
export async function computeScopedZikuConfig(opts: {
  templateDir: AbsPath;
  additionalIncludes: readonly GlobPattern[];
}): Promise<ScopedZikuConfig> {
  const template = await readConfigAt(opts.templateDir);
  if (template === undefined) return { _tag: "NoTemplateConfig" };
  return {
    _tag: "Scoped",
    content: renderUnionInto(template, { include: opts.additionalIncludes, exclude: [] }),
  };
}
