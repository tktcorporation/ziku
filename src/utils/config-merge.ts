/**
 * `.ziku/ziku.jsonc`（include/exclude パターン）専用の要素レベル 3-way マージ。
 *
 * 背景: `ziku.jsonc` を双方向同期の追跡ファイルにすると、ローカルとテンプレートの双方が
 * パターンを編集したケース（conflict）が発生する。これを汎用のテキスト diff3 マージに
 * かけると、JSON 配列の隣接行編集が衝突マーカーになり JSON が壊れる。代わりにパターンを
 * 「集合」として扱い、要素単位で 3-way マージすることで、常に解決可能（衝突マーカーなし）で
 * 決定的な結果を得る。
 *
 * 真の共通祖先（base = 前回同期時のテンプレート `ziku.jsonc`）が得られる場合は、両者の
 * 追加を足し・両者の削除を引く完全な 3-way（削除も双方向に伝播）。base が無い場合
 * （baseRef 未取得・旧 lock 等）は削除を判定できないため、安全側に倒して 2-way 和集合
 * （additive、削除は伝播しない）にフォールバックする。
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
 * 配列を出現順を保ったまま重複除去して結合する（base → local → template の順）。
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
 * 1 つのパターン配列（include または exclude）を 3-way マージする。
 *
 * - base あり: `(base ∪ localAdded ∪ templateAdded) \ (localRemoved ∪ templateRemoved)`。
 *   どちらかが削除したパターンは結果から消える（削除の双方向伝播）。
 * - base なし: `local ∪ template`（削除を判定できないため和集合）。
 */
function mergePatternList(
  base: string[] | undefined,
  local: string[],
  template: string[],
): string[] {
  if (base === undefined) {
    return unionOrdered(local, template);
  }
  const localSet = new Set(local);
  const templateSet = new Set(template);
  // base にあったが、どちらかの側で消えたパターン → 削除されたとみなす。
  const removed = new Set(base.filter((p) => !localSet.has(p) || !templateSet.has(p)));
  const candidates = unionOrdered(base, local, template);
  return candidates.filter((p) => !removed.has(p));
}

/**
 * include / exclude を要素レベルで 3-way マージする純粋関数。
 */
export function mergeConfigPatterns(opts: {
  base: ConfigPatterns | undefined;
  local: ConfigPatterns;
  template: ConfigPatterns;
}): ConfigPatterns {
  return {
    include: mergePatternList(opts.base?.include, opts.local.include, opts.template.include),
    exclude: mergePatternList(opts.base?.exclude, opts.local.exclude, opts.template.exclude),
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

/**
 * ローカル / テンプレート / （あれば）履歴 base の `ziku.jsonc` を読み、要素レベル
 * 3-way マージした結果を `ziku.jsonc` 文字列として返す。
 *
 * pull / push の conflict 解決で `ziku.jsonc` をテキスト diff3 ではなくこれで解決する。
 *
 * @param opts.baseTemplateDir 履歴 base（template@baseRef）のディレクトリ。無ければ
 *   2-way 和集合にフォールバック。
 */
export async function computeMergedZikuConfig(opts: {
  targetDir: string;
  templateDir: string;
  baseTemplateDir: string | undefined;
}): Promise<string> {
  const [local, template, base] = await Promise.all([
    readPatternsAt(opts.targetDir),
    readPatternsAt(opts.templateDir),
    opts.baseTemplateDir ? readPatternsAt(opts.baseTemplateDir) : Promise.resolve(undefined),
  ]);

  const merged = mergeConfigPatterns({
    base,
    local: local ?? EMPTY_PATTERNS,
    template: template ?? EMPTY_PATTERNS,
  });

  return generateZikuJsonc(merged);
}
