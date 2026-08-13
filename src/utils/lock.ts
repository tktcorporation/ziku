import { mkdir, readFile, writeFile } from "node:fs/promises";
import { Effect } from "effect";
import { dirname, join } from "pathe";
import type { LockState } from "../modules/schemas";
import { lockSchema } from "../modules/schemas";
import { FileNotFoundError, ParseError, ValidationError } from "../errors";

export const LOCK_FILE = ".ziku/lock.json";

/**
 * 読めない lock.json のうち、同期状態をトップレベルの optional フィールドで表していた
 * ものを見分けるためのキー。
 *
 * これらが読めないことをスキーマ違反として一括で報告すると「どこが悪いのか」が伝わらず、
 * ユーザーは lock を手で直そうとする。作り直しが唯一の復旧手段だと言い切るために、
 * この形だけ専用のメッセージにする。
 */
const UNREADABLE_LOCK_KEYS = ["baseHashes", "baseRef", "pendingMerge"] as const;

const UNREADABLE_LOCK_MESSAGE =
  "The lock file uses a format this version of ziku cannot read (top-level baseHashes / baseRef / pendingMerge).";

function hasUnreadableShape(data: unknown): boolean {
  if (typeof data !== "object" || data === null) return false;
  return UNREADABLE_LOCK_KEYS.some((key) => key in data);
}

/**
 * `.ziku/lock.json` を読み込む。
 *
 * 失敗理由を 3 つに分けて返す。呼び出し側が「初期化されていない」と「壊れている」を
 * 区別できないと、スキーマ違反まで「ファイルが無い」と誤報告してしまうため。
 *
 * - `FileNotFoundError`: ファイルが読めない（未初期化）
 * - `ParseError`: JSON として壊れている
 * - `ValidationError`: JSON ではあるが lock として解釈できない
 */
export function loadLock(
  targetDir: string,
): Effect.Effect<LockState, FileNotFoundError | ParseError | ValidationError> {
  const lockPath = join(targetDir, LOCK_FILE);

  return Effect.gen(function* () {
    const content = yield* Effect.tryPromise({
      try: () => readFile(lockPath, "utf-8"),
      catch: () => new FileNotFoundError({ path: LOCK_FILE }),
    });

    const data = yield* Effect.try({
      try: (): unknown => JSON.parse(content),
      catch: (cause) => new ParseError({ path: LOCK_FILE, cause }),
    });

    if (hasUnreadableShape(data)) {
      return yield* new ValidationError({
        path: LOCK_FILE,
        issues: [UNREADABLE_LOCK_MESSAGE],
      });
    }

    const parsed = lockSchema.safeParse(data);
    if (!parsed.success) {
      return yield* new ValidationError({
        path: LOCK_FILE,
        issues: parsed.error.issues.map((issue) =>
          issue.path.length > 0 ? `${issue.path.join(".")}: ${issue.message}` : issue.message,
        ),
      });
    }

    return parsed.data;
  });
}

/**
 * `.ziku/lock.json` を保存する。
 *
 * 引数が `LockState` なので、同期状態の組み合わせは型が保証する。状態を進めるときは
 * `markSynced` / `markMerging` / `resolveMerge` を通すこと。
 */
export async function saveLock(targetDir: string, lock: LockState): Promise<void> {
  const lockPath = join(targetDir, LOCK_FILE);
  await mkdir(dirname(lockPath), { recursive: true });
  await writeFile(lockPath, `${JSON.stringify(lock, null, 2)}\n`);
}
