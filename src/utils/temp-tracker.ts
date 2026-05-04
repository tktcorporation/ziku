/**
 * 一時ディレクトリの中断時クリーンアップトラッカー。
 *
 * 背景: downloadTemplateToTemp() が作る .ziku-temp などの一時ディレクトリは、
 * 通常 withFinally (src/effect-helpers.ts) 経由で finally で削除されるが、
 * 以下のケースでは finally が走らずディレクトリが残る:
 *
 *   - prompts/file-select の Ctrl+C が process.exit(0) を直接呼ぶ
 *   - トップレベルのエラーハンドラが process.exit(1) を呼ぶ
 *   - SIGINT / SIGTERM のデフォルトハンドラでプロセスが即時終了する
 *
 * このモジュールはアクティブな temp dir を Set で保持し、process の
 * 'exit' / 'SIGINT' / 'SIGTERM' に同期削除フックを一度だけ登録する。
 *
 * giget が安定して finally で resource cleanup を保証するようになれば不要になる。
 */
import { existsSync, rmSync } from "node:fs";

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
  // 明示的に同期クリーンアップ → exit code を立てて終了する。
  for (const signal of ["SIGINT", "SIGTERM"] as const) {
    process.on(signal, () => {
      cleanupAll();
      // 慣例に従い 128 + signal number を終了コードに使う
      const code = signal === "SIGINT" ? 130 : 143;
      process.exit(code);
    });
  }
}

/**
 * 中断時に削除すべき temp dir を登録する。
 * 初回呼び出し時に process の終了ハンドラを設置する。
 */
export function registerTempDir(dir: string): void {
  installHandlers();
  activeTempDirs.add(dir);
}

/**
 * 通常クリーンアップ完了時に登録解除する。
 */
export function unregisterTempDir(dir: string): void {
  activeTempDirs.delete(dir);
}

/** テスト用: 内部状態をリセットする。 */
export function _resetForTest(): void {
  activeTempDirs.clear();
}

/** テスト用: 現在追跡中の temp dir 数を返す。 */
export function _getTrackedCountForTest(): number {
  return activeTempDirs.size;
}
