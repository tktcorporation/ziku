/**
 * 一時ディレクトリの中断時クリーンアップトラッカー。
 *
 * 役割: 「最終防衛線」としての同期クリーンアップ。
 * Effect の Scope finalizer (acquireRelease/addFinalizer) で守れない領域、
 * すなわち process.exit() / SIGINT / SIGTERM の同期終了経路を埋める。
 *
 * 設計上の責務分担:
 *   - 通常終了 / 失敗 / Fiber 中断 → Effect の Scope finalizer が削除
 *   - process.exit() / シグナル        → このトラッカーが同期削除
 *
 * 二重管理に見えるが、両方が必要:
 *   - Effect 側だけだと process.exit() で event loop が止まり非同期処理が走らない
 *   - 同期トラッカーだけだと「型でクリーンアップを強制」できない
 *
 * giget が安定して finally で resource cleanup を保証するようになれば、
 * Effect 側だけで完結する。
 */
import { existsSync, rmSync } from "node:fs";
import { Effect } from "effect";

const activeTempDirs = new Set<string>();
const installedSignals = new Set<"SIGINT" | "SIGTERM">();
let exitHandlerInstalled = false;

function cleanupAll(): void {
  for (const dir of activeTempDirs) {
    if (existsSync(dir)) {
      rmSync(dir, { recursive: true, force: true });
    }
  }
  activeTempDirs.clear();
}

function ensureExitHandler(): void {
  if (exitHandlerInstalled) return;
  exitHandlerInstalled = true;
  // 'exit' は同期処理のみ実行可能。process.exit() / 通常終了の両方で発火する。
  process.on("exit", cleanupAll);
}

/**
 * SIGINT/SIGTERM ハンドラを (まだ無ければ) 登録する。
 *
 * 設計: signal 別に installed 状態を管理し、register のたびに
 * ensure を呼ぶことで「delegate 経路で外れた後の再インストール」を保証する。
 *
 * self-removal + signal re-raise パターン:
 *   1. 同期クリーンアップ
 *   2. 自身を listener から外す + installedSignals からも外す
 *      → 後続の registerTempDir() で再インストールされる
 *        (long-lived プロセスで signal を delegate した後の 2 回目以降の
 *         registerTempDir も保護される)
 *   3. 他のリスナーが残っていればそれに任せる
 *   4. 他にいなければ process.kill で signal を再送し、default 動作
 *      (terminate with exit code 128 + signal number) に戻す
 */
function ensureSignalHandler(signal: "SIGINT" | "SIGTERM"): void {
  if (installedSignals.has(signal)) return;
  installedSignals.add(signal);

  const handler = (): void => {
    cleanupAll();
    process.removeListener(signal, handler);
    installedSignals.delete(signal);
    if (process.listenerCount(signal) === 0) {
      process.kill(process.pid, signal);
    }
  };
  process.on(signal, handler);
}

/**
 * 中断時に削除すべき temp dir を登録する (同期API)。
 * 毎回 ensureExitHandler / ensureSignalHandler を呼ぶことで、
 * delegate 経路で外れた signal handler が次回以降も再登録される。
 *
 * Effect コンテキストからは {@link registerTempDirEffect} を使うこと。
 */
export function registerTempDir(dir: string): void {
  ensureExitHandler();
  ensureSignalHandler("SIGINT");
  ensureSignalHandler("SIGTERM");
  activeTempDirs.add(dir);
}

/**
 * 通常クリーンアップ完了時に登録解除する (同期API)。
 *
 * Effect コンテキストからは {@link unregisterTempDirEffect} を使うこと。
 */
export function unregisterTempDir(dir: string): void {
  activeTempDirs.delete(dir);
}

/** Effect ラッパー: Scope finalizer から呼ぶ用途。 */
export const registerTempDirEffect = (dir: string): Effect.Effect<void> =>
  Effect.sync(() => registerTempDir(dir));

/** Effect ラッパー: Scope finalizer から呼ぶ用途。 */
export const unregisterTempDirEffect = (dir: string): Effect.Effect<void> =>
  Effect.sync(() => unregisterTempDir(dir));

/**
 * temp dir を物理削除する Effect (sync)。
 * Scope finalizer に組み込んで使う。存在しない場合は no-op。
 */
export const removeTempDirEffect = (dir: string): Effect.Effect<void> =>
  Effect.sync(() => {
    if (existsSync(dir)) {
      rmSync(dir, { recursive: true, force: true });
    }
  });

/** テスト用: 内部状態をリセットする。 */
export function _resetForTest(): void {
  activeTempDirs.clear();
}

/** テスト用: 現在追跡中の temp dir 数を返す。 */
export function _getTrackedCountForTest(): number {
  return activeTempDirs.size;
}

/** テスト用: signal handler が installed 状態か返す。 */
export function _isSignalInstalledForTest(signal: "SIGINT" | "SIGTERM"): boolean {
  return installedSignals.has(signal);
}
