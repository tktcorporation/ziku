import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname, join } from "pathe";
import type { LockState } from "../modules/schemas";
import { lockSchema } from "../modules/schemas";

export const LOCK_FILE = ".ziku/lock.json";

/**
 * .ziku/lock.json を読み込み
 */
export async function loadLock(targetDir: string): Promise<LockState> {
  const lockPath = join(targetDir, LOCK_FILE);
  const content = await readFile(lockPath, "utf-8");
  const data = JSON.parse(content);
  return lockSchema.parse(data);
}

/**
 * .ziku/lock.json を保存
 */
export async function saveLock(targetDir: string, lock: LockState): Promise<void> {
  const lockPath = join(targetDir, LOCK_FILE);
  await mkdir(dirname(lockPath), { recursive: true });
  await writeFile(lockPath, `${JSON.stringify(lock, null, 2)}\n`);
}
