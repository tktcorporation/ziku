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
let handlersInstalled = false;

function cleanupAll(): void {
  for (const dir of activeTempDirs) {
    if (existsSync(dir)) {
      rmSync(dir, { recursive: true, force: true });
    }
  }
  activeTempDirs.clear();
}

function installHandlers(): void {
  if (handlersInstalled) return;
  handlersInstalled = true;

  // 'exit' は同期処理のみ実行可能。process.exit() / 通常終了の両方で発火する。
  process.on("exit", cleanupAll);

  // SIGINT/SIGTERM のデフォルト動作は即時終了で 'exit' も発火しないため、
  // 明示的に同期クリーンアップを実行してから default 動作に戻す。
  //
  // 設計: process.exit() を直接呼ぶと event loop を停止させてしまい、
  // 同じ signal に登録された後続リスナー (例: interactive prompt の TTY 復元、
  // 埋め込みホストの graceful shutdown) を skip させてしまう (codex review #74)。
  // 代わりに self-removal + signal re-raise パターンを使う:
  //   1. 同期クリーンアップ
  //   2. 自身を listener から外す
  //   3. 他のリスナーが残っていればそれに任せる
  //   4. 他にいなければ process.kill で signal を再送し、default 動作 (terminate
  //      with exit code 128 + signal number) に戻す
  for (const signal of ["SIGINT", "SIGTERM"] as const) {
    const handler = (): void => {
      cleanupAll();
      process.removeListener(signal, handler);
      if (process.listenerCount(signal) === 0) {
        process.kill(process.pid, signal);
      }
    };
    process.on(signal, handler);
  }
}

/**
 * 中断時に削除すべき temp dir を登録する (同期API)。
 * 初回呼び出し時に process の終了ハンドラを設置する。
 *
 * Effect コンテキストからは {@link registerTempDirEffect} を使うこと。
 */
export function registerTempDir(dir: string): void {
  installHandlers();
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
