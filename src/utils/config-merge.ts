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
 *   （baseRef のダウンロード）は full なので両者が矛盾する。この矛盾下で削除を伝播させると、
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

/**
 * ローカルとテンプレートの `ziku.jsonc` を読み、要素レベルの和集合マージ結果を
 * `ziku.jsonc` 文字列として返す。
 *
 * pull / push の conflict 解決で `ziku.jsonc` をテキスト diff3 ではなくこれで解決する。
 * 和集合なので削除は伝播しないが、テンプレートのパターンもローカルの追加も失われない。
 */
export async function computeMergedZikuConfig(opts: {
  targetDir: string;
  templateDir: string;
}): Promise<string> {
  const [local, template] = await Promise.all([
    readPatternsAt(opts.targetDir),
    readPatternsAt(opts.templateDir),
  ]);

  const merged = mergeConfigPatterns({
    local: local ?? EMPTY_PATTERNS,
    template: template ?? EMPTY_PATTERNS,
  });

  return generateZikuJsonc(merged);
}
