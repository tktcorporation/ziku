/**
 * テンプレートの .ziku/ziku.jsonc を読み込むユーティリティ。
 *
 * 背景: modules.jsonc 廃止後、テンプレート側も .ziku/ziku.jsonc で
 * 同期対象パターンを定義する。ユーザー側と同一フォーマット。
 * テンプレートの ziku.jsonc には source がない（パターン定義のみ）。
 */
import { Effect } from "effect";
import { existsSync } from "node:fs";
import { readFile } from "node:fs/promises";
import { zikuConfigSchema } from "../modules/schemas";
import type { AbsPath, GlobPattern, ZikuConfig } from "../modules/schemas";
import { ParseError, TemplateNotConfiguredError } from "../errors";
import { parseJsonc } from "./jsonc";
import { joinAbs } from "./paths";
import { ZIKU_CONFIG_FILE } from "./ziku-config";

/**
 * テンプレートの .ziku/ziku.jsonc を読み込む。
 *
 * テンプレートリポジトリの include/exclude パターンを取得する。
 * init 時にどのディレクトリを同期するか選択するためのデータソース。
 *
 * 構文が壊れていれば `ParseError` を返す。パターン無しとして扱わないのは、この戻り値が
 * 「テンプレートが同期対象と定めた範囲」そのものであり、欠けた範囲は下流で「テンプレートが
 * そう決めた」と読まれるため。init は取り込むディレクトリの選択肢をここから作るので、
 * エラー回復が拾えた分だけの部分的なパターンを返すと、利用者はテンプレートの一部だけを
 * 取り込んだプロジェクトを、全部取り込んだつもりで作ることになる。壊れている事実を
 * 報告すれば、テンプレート側を直すという行動が取れる。
 */
export function loadTemplateConfig(
  templateDir: AbsPath,
): Effect.Effect<ZikuConfig, TemplateNotConfiguredError | ParseError> {
  return Effect.gen(function* () {
    const configPath = joinAbs(templateDir, ZIKU_CONFIG_FILE);

    if (!existsSync(configPath)) {
      return yield* new TemplateNotConfiguredError({ templateDir });
    }

    const content = yield* Effect.tryPromise({
      try: () => readFile(configPath, "utf-8"),
      catch: () => new ParseError({ path: configPath, cause: "Failed to read file" }),
    });

    const document = parseJsonc(content);
    if (document.kind === "unparsable") {
      return yield* new ParseError({
        path: configPath,
        cause: new SyntaxError(document.detail),
      });
    }

    const validated = yield* Effect.try({
      try: () => zikuConfigSchema.parse(document.value),
      catch: (e) => new ParseError({ path: configPath, cause: e }),
    });

    return validated;
  });
}

/**
 * テンプレートに .ziku/ziku.jsonc が存在するか確認する。
 */
export function templateConfigExists(templateDir: AbsPath): boolean {
  return existsSync(joinAbs(templateDir, ZIKU_CONFIG_FILE));
}

/**
 * include パターンからトップレベルディレクトリを抽出し、選択用エントリにグループ化する。
 *
 * 背景: modules.jsonc のモジュール選択を廃止し、パターンのトップレベルディレクトリを
 * 選択単位とする。ルートレベルのファイル（パスに / がないもの）は "Root files" に集約。
 *
 * 例:
 *   [".claude/**", ".claude/rules/*.md", ".mcp.json", ".devcontainer/**"]
 *   → [
 *       { label: ".claude", patterns: [".claude/**", ".claude/rules/*.md"] },
 *       { label: ".devcontainer", patterns: [".devcontainer/**"] },
 *       { label: "Root files", patterns: [".mcp.json"] },
 *     ]
 */
export function extractDirectoryEntries(
  includePatterns: readonly GlobPattern[],
): Array<{ label: string; patterns: GlobPattern[] }> {
  const dirMap = new Map<string, GlobPattern[]>();
  const rootFiles: GlobPattern[] = [];

  for (const pattern of includePatterns) {
    const slashIndex = pattern.indexOf("/");
    if (slashIndex === -1) {
      rootFiles.push(pattern);
    } else {
      const dir = pattern.slice(0, slashIndex);
      const existing = dirMap.get(dir);
      if (existing) {
        existing.push(pattern);
      } else {
        dirMap.set(dir, [pattern]);
      }
    }
  }

  const entries: Array<{ label: string; patterns: GlobPattern[] }> = [];

  // ディレクトリをアルファベット順でソート
  for (const [dir, patterns] of [...dirMap.entries()].toSorted(([a], [b]) => a.localeCompare(b))) {
    entries.push({ label: dir, patterns });
  }

  if (rootFiles.length > 0) {
    entries.push({ label: "Root files", patterns: rootFiles });
  }

  return entries;
}
