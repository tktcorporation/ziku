import { existsSync } from "node:fs";
import { readFile, rename, writeFile } from "node:fs/promises";
import { join } from "pathe";
import type { DevEnvConfig } from "../modules/schemas";
import { configSchema } from "../modules/schemas";

/**
 * config ファイルの相対パス。
 * .ziku/ ディレクトリに統一。
 */
export const CONFIG_FILE = ".ziku/config.json";

/** @deprecated v0.x 以前のパス。マイグレーション用。 */
const LEGACY_CONFIG_FILE = ".ziku.json";

/**
 * 旧 .ziku.json → .ziku/config.json へのマイグレーション。
 * 新ファイルが無く旧ファイルがある場合のみ移動する。
 */
export async function migrateConfigIfNeeded(targetDir: string): Promise<boolean> {
  const newPath = join(targetDir, CONFIG_FILE);
  const oldPath = join(targetDir, LEGACY_CONFIG_FILE);

  if (!existsSync(oldPath) || existsSync(newPath)) {
    return false;
  }

  await rename(oldPath, newPath);
  return true;
}

/**
 * .ziku/config.json を読み込み
 */
export async function loadConfig(targetDir: string): Promise<DevEnvConfig> {
  const configPath = join(targetDir, CONFIG_FILE);
  const content = await readFile(configPath, "utf-8");
  const data = JSON.parse(content);
  return configSchema.parse(data);
}

/**
 * .ziku/config.json を保存
 */
export async function saveConfig(targetDir: string, config: DevEnvConfig): Promise<void> {
  const configPath = join(targetDir, CONFIG_FILE);
  await writeFile(configPath, `${JSON.stringify(config, null, 2)}\n`);
}
