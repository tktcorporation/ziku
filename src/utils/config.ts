import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname, join } from "pathe";
import type { DevEnvConfig } from "../modules/schemas";
import { configSchema } from "../modules/schemas";

export const CONFIG_FILE = ".ziku/config.json";

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
  await mkdir(dirname(configPath), { recursive: true });
  await writeFile(configPath, `${JSON.stringify(config, null, 2)}\n`);
}
