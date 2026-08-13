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
import { parse } from "jsonc-parser";
import { join } from "pathe";
import type { ZikuConfig } from "../modules/schemas";
import { ZIKU_CONFIG_FILE, generateZikuJsonc } from "./ziku-config";

export interface ConfigPatterns {
  readonly include: string[];
  readonly exclude: string[];
}

const EMPTY_PATTERNS: ConfigPatterns = { include: [], exclude: [] };

/**
 * 配列を出現順を保ったまま重複除去して結合する（local → template の順）。
 */
function unionOrdered(...lists: string[][]): string[] {
  const seen = new Set<string>();
  const result: string[] = [];
  for (const list of lists) {
    for (const item of list) {
      if (!seen.has(item)) {
        seen.add(item);
        result.push(item);
      }
    }
  }
  return result;
}

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
    include: unionOrdered(opts.local.include, opts.template.include),
    exclude: unionOrdered(opts.local.exclude, opts.template.exclude),
  };
}

/**
 * 指定ディレクトリの `.ziku/ziku.jsonc` を読み、パターンを抽出する。
 * ファイルが無ければ undefined（base が無いケースの判定に使う）。
 */
async function readPatternsAt(dir: string): Promise<ConfigPatterns | undefined> {
  const path = join(dir, ZIKU_CONFIG_FILE);
  if (!existsSync(path)) return undefined;
  const content = await readFile(path, "utf-8");
  const parsed = parse(content) as ZikuConfig | undefined;
  return {
    include: parsed?.include ?? [],
    exclude: parsed?.exclude ?? [],
  };
}

/** 2 つのパターン配列が集合として等しいか（順序・重複を無視）。 */
function sameSet(a: string[], b: string[]): boolean {
  const sa = new Set(a);
  const sb = new Set(b);
  if (sa.size !== sb.size) return false;
  for (const x of sa) if (!sb.has(x)) return false;
  return true;
}

/**
 * `ziku.jsonc` の「実際に同期アクションが必要か」を union 観点で判定する。
 *
 * - `pullRelevant`: テンプレにあってローカルに無いパターンがある（pull で取り込む価値あり）。
 * - `pushRelevant`: ローカルにあってテンプレに無いパターンがある（push で伝播する価値あり）。
 *
 * 加法 union モデルでは「片側だけのパターン削除」は同期アクションにならない（union==その側）。
 * これを status の推奨判定に使うことで、テンプレ側のパターン削除だけのケースで pull を
 * 無限に推奨してしまう no-op ループを防ぐ（codex P2）。
 */
export async function analyzeConfigDrift(
  targetDir: string,
  templateDir: string,
): Promise<{ pullRelevant: boolean; pushRelevant: boolean }> {
  const [local, template] = await Promise.all([
    readPatternsAt(targetDir),
    readPatternsAt(templateDir),
  ]);
  const l = local ?? EMPTY_PATTERNS;
  const t = template ?? EMPTY_PATTERNS;
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
 */
export async function computeMergedZikuConfig(opts: {
  targetDir: string;
  templateDir: string;
  extraIncludes?: string[];
}): Promise<string> {
  const [local, template] = await Promise.all([
    readPatternsAt(opts.targetDir),
    readPatternsAt(opts.templateDir),
  ]);

  const localBase = local ?? EMPTY_PATTERNS;
  const localWithExtra: ConfigPatterns = {
    include: [...localBase.include, ...(opts.extraIncludes ?? [])],
    exclude: localBase.exclude,
  };

  const merged = mergeConfigPatterns({
    local: localWithExtra,
    template: template ?? EMPTY_PATTERNS,
  });

  return generateZikuJsonc(merged);
}

/**
 * ローカルの `ziku.jsonc` にのみ存在する include パターンのうち、指定パス集合に
 * 一致するものだけを返す。
 *
 * 背景（#90）: `ziku track <path>` は即座にディスクの `ziku.jsonc` にパターンを
 * 書き込む。その後 `ziku push --files=<path>` のようにファイル本体だけを指定すると、
 * `ziku.jsonc` 自体は `--files` に含まれず push 候補から漏れ、パターンがテンプレへ
 * 伝播しない（本体だけテンプレに存在し、他プロジェクトの `pull` が検出できない）。
 *
 * パターン = ファイルパス（個別追跡）の前提で、push されるパスと厳密一致するものだけを
 * 「関連パターン」として返す。無関係なローカル限定パターン（今回の push が触れていない
 * ファイルのもの）まで巻き込まないためのスコープ計算に使う。glob パターンの一致判定は
 * 将来拡張。
 */
export async function findLocalOnlyPatternsForPaths(opts: {
  targetDir: string;
  templateDir: string;
  paths: string[];
}): Promise<string[]> {
  if (opts.paths.length === 0) return [];

  const [local, template] = await Promise.all([
    readPatternsAt(opts.targetDir),
    readPatternsAt(opts.templateDir),
  ]);

  const templateInclude = new Set((template ?? EMPTY_PATTERNS).include);
  const pathSet = new Set(opts.paths);

  return (local ?? EMPTY_PATTERNS).include.filter(
    (pattern) => !templateInclude.has(pattern) && pathSet.has(pattern),
  );
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
 */
export async function computeScopedZikuConfig(opts: {
  templateDir: string;
  additionalIncludes: string[];
}): Promise<string> {
  const template = (await readPatternsAt(opts.templateDir)) ?? EMPTY_PATTERNS;
  const merged = mergeConfigPatterns({
    local: { include: opts.additionalIncludes, exclude: [] },
    template,
  });
  return generateZikuJsonc(merged);
}
