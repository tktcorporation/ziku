import { readFile, writeFile } from "node:fs/promises";
import { join } from "pathe";
import type { DevEnvConfig } from "../modules/schemas";
import { configSchema } from "../modules/schemas";

/**
 * .devenv.json を読み込み
 */
export async function loadConfig(targetDir: string): Promise<DevEnvConfig> {
  const configPath = join(targetDir, ".devenv.json");
  const content = await readFile(configPath, "utf-8");
  const data = JSON.parse(content);
  return configSchema.parse(data);
}

/**
 * .devenv.json を保存
 */
export async function saveConfig(targetDir: string, config: DevEnvConfig): Promise<void> {
  const configPath = join(targetDir, ".devenv.json");
  await writeFile(configPath, `${JSON.stringify(config, null, 2)}\n`);
}
