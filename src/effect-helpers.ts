/**
 * Effect ベースのリソース管理ヘルパー
 *
 * 背景: コマンド層の try/finally はリソースクリーンアップのためだけに存在する。
 * このヘルパーで try/finally を置き換え、throw/catch の既存フローは維持する。
 *
 * Effect.ensuring を使い、成功・失敗・例外いずれの場合もクリーンアップを保証する。
 * 内部で throw された例外（ZikuError 等）はそのまま re-throw される。
 */
import { Cause, Effect, Exit, Option } from "effect";

/**
 * 非同期関数を実行し、成功・失敗いずれの場合も cleanup を実行する。
 * try/finally の Effect 版。内部で throw されたエラーはそのまま re-throw される。
 */
export async function withFinally<T>(
  fn: () => Promise<T>,
  cleanup: () => void | Promise<void>,
): Promise<T> {
  const effect = Effect.tryPromise({ try: fn, catch: (e) => e }).pipe(
    Effect.ensuring(Effect.promise(async () => cleanup())),
  );
  const exit = await Effect.runPromiseExit(effect);
  if (Exit.isSuccess(exit)) return exit.value;

  // 失敗チャネルのエラー（fn 内で throw されたもの）をそのまま re-throw
  const failure = Cause.failureOption(exit.cause);
  if (Option.isSome(failure)) throw failure.value;

  // Defect（予期しないエラー）
  throw Cause.squash(exit.cause);
}
