/**
 * Effect ベースのリソース管理ヘルパー。
 *
 * コマンドの中核処理は「テンプレートを一時ディレクトリへ展開して使い、必ず片付ける」
 * 形をしている。その片付けを `Effect.ensuring` に載せ、成功・失敗・中断のいずれでも
 * 走ることを保証する。
 */
import { Cause, Effect, Exit } from "effect";

/**
 * `work` の後始末として `cleanup` を必ず実行する。
 *
 * `Effect.ensuring` をそのまま使うのと違い、`cleanup` が同期・非同期どちらでも渡せる。
 * エラーチャネル `E` はそのまま通す — 失敗理由を `unknown` に潰すと、呼び出し側が
 * 失敗理由で分岐できなくなる。
 *
 * `cleanup` 自身が失敗した場合は defect になる。一時ディレクトリを消せない状態は
 * 呼び出し側が対処を選べる失敗ではなく、プロセスを止めて原因を見せるべき異常。
 */
export function withCleanup<A, E, R>(
  work: Effect.Effect<A, E, R>,
  cleanup: () => void | Promise<void>,
): Effect.Effect<A, E, R> {
  return work.pipe(
    Effect.ensuring(
      Effect.promise(async () => {
        await cleanup();
      }),
    ),
  );
}

/**
 * `withCleanup` の Promise 版。`throw` で失敗を伝えるコマンド (pull / push / status) が使う。
 *
 * 本体は Effect を返さない async 関数なので、失敗は型で表現できずそのまま throw で
 * 抜ける。Effect 側では defect として扱い、投げられた値を素通しで再スローする
 * （包み直すと呼び出し側の `instanceof` 判定と cause が壊れる）。
 */
export async function withFinally<T>(
  fn: () => Promise<T>,
  cleanup: () => void | Promise<void>,
): Promise<T> {
  const exit = await Effect.runPromiseExit(withCleanup(Effect.promise(fn), cleanup));
  if (Exit.isSuccess(exit)) return exit.value;
  throw Cause.squash(exit.cause);
}
