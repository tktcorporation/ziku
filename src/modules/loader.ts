import { existsSync } from "node:fs";
import { readFile } from "node:fs/promises";
import { parse } from "jsonc-parser";
import { join } from "pathe";
import { z } from "zod";
import type { TemplateModule } from "./schemas";
import { moduleSchema } from "./schemas";

/**
 * テンプレートリポジトリ側のモジュール定義ファイルパス。
 * ユーザープロジェクトには存在しない（ユーザー側は ziku.jsonc を使う）。
 */
export const MODULES_FILE = ".ziku/modules.jsonc";

/**
 * modules.jsonc の $schema URL。
 */
export const MODULES_SCHEMA_URL =
  "https://raw.githubusercontent.com/tktcorporation/ziku/main/schema/modules.json";

/**
 * modules.jsonc のスキーマ（常にモジュール形式）。
 *
 * modules.jsonc はテンプレートリポジトリにのみ存在する「メニュー表」。
 * 同期対象のファイルパターンを、モジュール（名前・説明付きのグループ）として定義する。
 * init 時にユーザーがどのモジュールを使うか選ぶ際の選択肢になる。
 *
 * ユーザー側では選択結果がフラット化されて ziku.jsonc に保存されるため、
 * modules.jsonc 自体はユーザーのプロジェクトにはコピーされない。
 */
export const modulesFileSchema = z.object({
  $schema: z.string().optional(),
  modules: z.array(moduleSchema),
});

/**
 * テンプレートの modules.jsonc を読み込む。
 *
 * 呼び出し元:
 *   - init: モジュール選択 UI を表示するため
 *   - push: テンプレートのパターンとローカルのパターンを比較するため
 */
export async function loadModulesFile(
  baseDir: string,
): Promise<{ modules: TemplateModule[]; rawContent: string }> {
  const filePath = join(baseDir, MODULES_FILE);

  if (!existsSync(filePath)) {
    throw new Error(`${MODULES_FILE} が見つかりません: ${filePath}`);
  }

  const content = await readFile(filePath, "utf-8");
  const parsed = parse(content);
  const validated = modulesFileSchema.parse(parsed);

  return {
    modules: validated.modules,
    rawContent: content,
  };
}

/**
 * テンプレートの modules.jsonc から全パターンをフラット化して返す。
 *
 * 全モジュールの include/exclude を結合する。
 * push でテンプレートのパターン一覧が必要な場合に使用。
 */
export function flattenModules(modules: TemplateModule[]): {
  include: string[];
  exclude: string[];
} {
  return {
    include: modules.flatMap((m) => m.include),
    exclude: modules.flatMap((m) => m.exclude ?? []),
  };
}

/**
 * ファイルパスがいずれかのモジュールの include パターンにマッチするか判定する。
 *
 * 背景: push 時に新しいファイルがテンプレートの modules.jsonc でカバーされているか
 * チェックし、カバーされていなければ modules.jsonc の更新が必要と判定するため。
 */
export function isFileMatchedByModules(filePath: string, modules: TemplateModule[]): boolean {
  for (const mod of modules) {
    for (const pattern of mod.include) {
      if (matchGlob(filePath, pattern)) return true;
    }
  }
  return false;
}

/**
 * マッチしないファイルパスからモジュール追加提案を生成する。
 *
 * ヒューリスティック: トップレベルディレクトリごとにグループ化し、
 * `{dir}/**` パターンで新モジュールを提案する。
 * ルートレベルのファイルは個別パターンで追加する。
 */
export function suggestModuleAdditions(
  unmatchedFiles: string[],
  existingModules: TemplateModule[],
): TemplateModule[] {
  // トップレベルディレクトリでグループ化
  const dirGroups = new Map<string, string[]>();
  const rootFiles: string[] = [];

  for (const file of unmatchedFiles) {
    const slashIndex = file.indexOf("/");
    if (slashIndex === -1) {
      rootFiles.push(file);
    } else {
      const dir = file.slice(0, slashIndex);
      const existing = dirGroups.get(dir);
      if (existing) {
        existing.push(file);
      } else {
        dirGroups.set(dir, [file]);
      }
    }
  }

  const additions: TemplateModule[] = [];

  // ディレクトリごとに新モジュールを提案
  for (const [dir, _files] of dirGroups) {
    // 既存モジュールに同名があれば、そのモジュールのパターンを拡張すべきだが
    // modules.jsonc の書き換えは複雑なので、新モジュールとして追加する
    const existingNames = new Set(existingModules.map((m) => m.name.toLowerCase()));
    const name = existingNames.has(dir.replace(/^\./, "").toLowerCase())
      ? `${dir.replace(/^\./, "")} (new)`
      : dir.replace(/^\./, "");
    additions.push({
      name,
      description: `Files under ${dir}/`,
      include: [`${dir}/**`],
    });
  }

  // ルートレベルファイルは個別パターンで追加
  if (rootFiles.length > 0) {
    additions.push({
      name: "Root files",
      description: "Root-level configuration files",
      include: rootFiles,
    });
  }

  return additions;
}

/**
 * modules.jsonc の JSON 文字列に新しいモジュールを追加する。
 *
 * @returns 更新後の JSON 文字列
 */
export function addModulesToJsonc(rawContent: string, newModules: TemplateModule[]): string {
  if (newModules.length === 0) return rawContent;

  const parsed = parse(rawContent) as { $schema?: string; modules: TemplateModule[] };
  const updated = {
    ...parsed,
    modules: [...parsed.modules, ...newModules],
  };
  return JSON.stringify(updated, null, 2);
}

/**
 * 簡易 glob マッチ。
 *
 * `**` はディレクトリの任意の深さ、`*` はファイル名のワイルドカード。
 * 完全な glob 実装ではないが、modules.jsonc のパターンに十分。
 */
function matchGlob(filePath: string, pattern: string): boolean {
  // 完全一致
  if (filePath === pattern) return true;

  // `dir/**` — ディレクトリ以下の全ファイル
  if (pattern.endsWith("/**")) {
    const prefix = pattern.slice(0, -3);
    return filePath.startsWith(`${prefix}/`);
  }

  // `dir/*.ext` — ディレクトリ直下の特定拡張子
  if (pattern.includes("*") && !pattern.includes("**")) {
    const regex = new RegExp(`^${pattern.replaceAll(".", "\\.").replaceAll("*", "[^/]*")}$`);
    return regex.test(filePath);
  }

  return false;
}

/**
 * モジュールファイルのパスを取得
 */
export function getModulesFilePath(baseDir: string): string {
  return join(baseDir, MODULES_FILE);
}

/**
 * modules.jsonc が存在するか確認
 */
export function modulesFileExists(baseDir: string): boolean {
  return existsSync(join(baseDir, MODULES_FILE));
}
