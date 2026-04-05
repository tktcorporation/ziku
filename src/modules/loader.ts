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
