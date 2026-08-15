/**
 * テンプレートの .ziku/ziku.jsonc を読み込むユーティリティ。
 *
 * 背景: modules.jsonc 廃止後、テンプレート側も .ziku/ziku.jsonc で
 * 同期対象パターンを定義する。ユーザー側と同一フォーマット。
 * テンプレートの ziku.jsonc には source がない（パターン定義のみ）。
 */
import { Effect } from "effect";
import { existsSync } from "node:fs";
import { match } from "ts-pattern";
import type { AbsPath, GlobPattern, ZikuConfig } from "../modules/schemas";
import { ParseError, TemplateNotConfiguredError, ValidationError } from "../errors";
import { joinAbs } from "./paths";
import { ZIKU_CONFIG_FILE, readZikuConfig } from "./ziku-config";

/**
 * テンプレートの .ziku/ziku.jsonc を読み込む。
 *
 * テンプレートリポジトリの include/exclude パターンを取得する。
 * init 時にどのディレクトリを同期するか選択するためのデータソース。
 *
 * 読めなければパターン無しとして扱わず失敗を返す。この戻り値は「テンプレートが同期対象と
 * 定めた範囲」そのものであり、欠けた範囲は下流で「テンプレートがそう決めた」と読まれるため。
 * init は取り込むディレクトリの選択肢をここから作るので、エラー回復が拾えた分だけの部分的な
 * パターンを返すと、利用者はテンプレートの一部だけを取り込んだプロジェクトを、全部取り込んだ
 * つもりで作ることになる。壊れている事実を報告すれば、テンプレート側を直すという行動が取れる。
 *
 * 失敗の分類は {@link readZikuConfig} が持つ。構文の破綻（`ParseError`）とスキーマ違反
 * （`ValidationError`）を分けるのは、ローカル側の入口（`loadZikuConfig`）と同じ理由で、
 * 潰すと利用者が壊れていない JSONC の中で構文ミスを探すことになるため。
 */
export function loadTemplateConfig(
  templateDir: AbsPath,
): Effect.Effect<ZikuConfig, TemplateNotConfiguredError | ParseError | ValidationError> {
  const configPath = joinAbs(templateDir, ZIKU_CONFIG_FILE);

  return Effect.promise(() => readZikuConfig(templateDir)).pipe(
    Effect.flatMap(
      (
        read,
      ): Effect.Effect<ZikuConfig, TemplateNotConfiguredError | ParseError | ValidationError> =>
        match(read)
          .with({ _tag: "NotFound" }, () =>
            Effect.fail(new TemplateNotConfiguredError({ templateDir })),
          )
          .with({ _tag: "Unparsable" }, ({ detail }) =>
            Effect.fail(new ParseError({ path: configPath, cause: new SyntaxError(detail) })),
          )
          .with({ _tag: "Invalid" }, ({ issues }) =>
            Effect.fail(new ValidationError({ path: configPath, issues })),
          )
          .with({ _tag: "Ok" }, ({ config }) => Effect.succeed(config))
          .exhaustive(),
    ),
  );
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
