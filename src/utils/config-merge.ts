/**
 * `.ziku/ziku.jsonc`（include/exclude パターン）専用の要素レベル加法マージ（和集合）。
 *
 * 背景: `ziku.jsonc` を双方向同期の追跡ファイルにすると、ローカルとテンプレートの双方が
 * パターンを編集したケース（conflict）が発生する。これを汎用のテキスト diff3 マージに
 * かけると、JSON 配列の隣接行編集が衝突マーカーになり JSON が壊れる。代わりにパターンを
 * 「集合」として扱い、要素単位でマージすることで、常に解決可能（衝突マーカーなし）で
 * 決定的な結果を得る。
 *
 * マージは「和集合（additive）」に固定する。理由:
 * - 真の共通祖先で 3-way 差分を取れば削除も双方向に伝播できるが、`ziku.jsonc` の base は
 *   信頼できない。特に `init` で「テンプレートのパターンの部分集合」を選んで導入した
 *   プロジェクトでは、lock に記録される base は合成された部分集合である一方、履歴テンプレ
 *   （ベースのコミットからのダウンロード）は full なので両者が矛盾する。この矛盾下で削除を伝播させると、
 *   ユーザーが未選択にしただけのテンプレ側パターンを「削除」とみなして push で消してしまう
 *   （全下流に波及する事故 / codex review P1）。
 * - 和集合なら、ローカルの追加もテンプレの追加も保持し、いかなるパターンも削除しないため、
 *   テンプレートを壊さず・ローカルの追加も失わない。
 *
 * トレードオフ: パターンの「削除」は自動伝播しない（明示的に各 ziku.jsonc を編集する必要が
 * ある）。これは安全性とのトレードオフとして受け入れる。
 */
import { existsSync } from "node:fs";
import { readFile } from "node:fs/promises";
import { match } from "ts-pattern";
import { zikuFailure } from "../errors";
import type { AbsPath, GlobPattern, RepoRelPath } from "../modules/schemas";
import { parseJsonc } from "./jsonc";
import { globPatterns, joinAbs, selectPatternsMatchingPaths } from "./paths";
import { unionPatterns } from "./patterns";
import { ZIKU_CONFIG_FILE, generateZikuJsonc, withPatterns } from "./ziku-config";

export interface ConfigPatterns {
  readonly include: GlobPattern[];
  readonly exclude: GlobPattern[];
}

const EMPTY_PATTERNS: ConfigPatterns = { include: [], exclude: [] };

/**
 * include / exclude を要素レベルで加法マージ（和集合）する純粋関数。
 *
 * ローカル優先の出現順で、ローカルにもテンプレにもあるパターンを保持する。
 * いずれの側のパターンも削除しない（削除は伝播しない）。
 */
export function mergeConfigPatterns(opts: {
  local: ConfigPatterns;
  template: ConfigPatterns;
}): ConfigPatterns {
  return {
    include: unionPatterns(opts.local.include, opts.template.include).merged,
    exclude: unionPatterns(opts.local.exclude, opts.template.exclude).merged,
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
 * 構文が壊れていれば、ユーザーが手で直せる失敗として報告して中断する。パターン無しとして
 * 扱わないのは、ここで読んだ内容が union の入力であると同時に、{@link renderMergedConfig} が
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
  if (!existsSync(path)) return undefined;
  const raw = await readFile(path, "utf-8");

  // ディスク上の JSONC はスキーマを通っていない生の値。ここがパターンの brand 入口になる。
  const parsed = match(parseJsonc(raw))
    .with({ kind: "parsed" }, ({ value }) => value as { include?: string[]; exclude?: string[] })
    .with({ kind: "unparsable" }, ({ detail }): never => {
      throw zikuFailure({ kind: "ConfigUnparsable", path, detail });
    })
    .exhaustive();

  return {
    raw,
    patterns: {
      include: globPatterns(parsed?.include ?? []),
      exclude: globPatterns(parsed?.exclude ?? []),
    },
  };
}

/**
 * union の結果を `ziku.jsonc` の内容として書き出す。
 *
 * 元の文書があればその include / exclude だけを差し替え、注釈と他のキーを残す。無い場合
 * （まだ `ziku.jsonc` が存在しないテンプレート / プロジェクト）だけ新規に生成する。
 */
function renderMergedConfig(base: ConfigDocument | undefined, merged: ConfigPatterns): string {
  return base === undefined ? generateZikuJsonc(merged) : withPatterns(base.raw, merged);
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
 * 加法 union モデルでは「片側だけのパターン削除」は同期アクションにならない（union==その側）
 * ため、ハッシュ差分ではなくパターン集合の包含関係で判断する。
 */
export interface ConfigDrift {
  /** テンプレにあってローカルに無いパターンがある（pull で取り込む価値あり）。 */
  readonly pullRelevant: boolean;
  /** ローカルにあってテンプレに無いパターンがある（push で伝播する価値あり）。 */
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
): Promise<ConfigDrift> {
  const [local, template] = await Promise.all([readConfigAt(targetDir), readConfigAt(templateDir)]);
  const l = local?.patterns ?? EMPTY_PATTERNS;
  const t = template?.patterns ?? EMPTY_PATTERNS;
  const union = mergeConfigPatterns({ local: l, template: t });
  const eq = (a: ConfigPatterns, b: ConfigPatterns): boolean =>
    sameSet(a.include, b.include) && sameSet(a.exclude, b.exclude);
  return {
    pullRelevant: !eq(union, l),
    pushRelevant: !eq(union, t),
  };
}

/**
 * ローカルとテンプレートの `ziku.jsonc` を読み、要素レベルの和集合マージ結果を
 * `ziku.jsonc` 文字列として返す。
 *
 * pull / push の conflict 解決で `ziku.jsonc` をテキスト diff3 ではなくこれで解決する。
 * 和集合なので削除は伝播しないが、テンプレートのパターンもローカルの追加も失われない。
 *
 * `extraIncludes` は、ディスク上の `ziku.jsonc` にはまだ書かれていないが今回の push で
 * 反映したい include パターン（対話 push で新規追跡選択したファイルのパス）を渡すために使う。
 * 追跡選択の永続化（`persistNewlyTracked`）は push 成功後に走るため、ディスク内容だけを
 * 読むと新規パターンが union から漏れ、テンプレにファイル本体だけ届いて include が届かない
 * （他プロジェクトの init/pull が拾えるのが 2 回目の push 後になる）。これを防ぐため、
 * 確定した新規追跡パターンをローカル側へ加えてから union を取る（codex P2）。
 *
 * 結果はローカルの `ziku.jsonc` を土台に組み立てる（{@link renderMergedConfig}）。この内容は
 * pull ならローカルへ書き戻され、push ならローカルの `ziku.jsonc` を送ると決めた場面で使われる
 * ので、どちらもローカルの注釈が残る側が正しい土台になる。
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

  const localBase = local?.patterns ?? EMPTY_PATTERNS;
  const localWithExtra: ConfigPatterns = {
    include: [...localBase.include, ...(opts.extraIncludes ?? [])],
    exclude: localBase.exclude,
  };

  const merged = mergeConfigPatterns({
    local: localWithExtra,
    template: template?.patterns ?? EMPTY_PATTERNS,
  });

  return renderMergedConfig(local, merged);
}

/**
 * ローカルの `ziku.jsonc` にのみ存在する include パターンのうち、指定パスのいずれかに
 * 一致するものだけを返す。
 *
 * 背景（#90）: `ziku track <pattern>` は即座にディスクの `ziku.jsonc` にパターンを
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
 * テンプレート側の `ziku.jsonc` に、指定した追加パターンだけを和集合で加えた
 * `ziku.jsonc` 文字列を返す。ローカルの `ziku.jsonc` の他のパターンは一切参照しない。
 *
 * `computeMergedZikuConfig` はローカルの `ziku.jsonc` 全体をテンプレと和集合するため、
 * ユーザーが `--files` で明示していないのに ziku.jsonc を自動同梱する場面（#90）で使うと、
 * 今回の push と無関係なローカル限定パターンまで一緒にテンプレへ漏れてしまう
 * （issue #90 で懸念されていたリスク）。この関数はテンプレの内容 + 明示的に渡した
 * 追加分だけを union するため、無関係なパターンを一切巻き込まない。
 *
 * 結果はテンプレートの `ziku.jsonc` を土台に組み立てる（{@link renderMergedConfig}）。この
 * 内容はテンプレートへ送るだけでローカルへは書き戻さない（`push-plan.ts` の
 * `ZikuConfigWriteBack`）ので、残すべき注釈はテンプレート側のもの。
 */
export async function computeScopedZikuConfig(opts: {
  templateDir: AbsPath;
  additionalIncludes: readonly GlobPattern[];
}): Promise<string> {
  const template = await readConfigAt(opts.templateDir);
  const merged = mergeConfigPatterns({
    local: { include: [...opts.additionalIncludes], exclude: [] },
    template: template?.patterns ?? EMPTY_PATTERNS,
  });
  return renderMergedConfig(template, merged);
}
