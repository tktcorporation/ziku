/**
 * テンプレートソース解決の共通ユーティリティ。
 *
 * 背景: pull/push/diff/init で繰り返される「lock.json から source を読む →
 * ローカル or GitHub からテンプレートを取得 → クリーンアップ」を DRY 化する。
 *
 * 設計: Effect.Scope を返すことで、呼び出し側は Effect.scoped で囲うだけで
 * cleanup が型レベルで強制される。withFinally による命令的な cleanup は不要。
 */
import { Effect } from "effect";
import type { Scope } from "effect";
import { resolve } from "pathe";
import type { TemplateSource } from "../modules/schemas";
import { isLocalSource } from "../modules/schemas";
import type { TemplateError } from "../errors";
import { acquireTempTemplate, buildTemplateSource } from "./template";

/**
 * TemplateSource からテンプレートディレクトリを解決する Scoped Effect。
 *
 * - ローカルソース: パスをそのまま返す (Scope は解放処理なしで閉じる)
 * - GitHub ソース: ダウンロードして一時ディレクトリを Scope に紐づける
 *
 * 呼び出し側は `Effect.scoped(...)` で囲うこと。Scope クローズ時 (成功/失敗/中断)
 * に temp dir が同期削除される。
 *
 * @param source テンプレートの取得元
 * @param targetDir ダウンロード先のベースディレクトリ (GitHub ソースのみ使用)
 * @param label 一時ディレクトリを区別するためのラベル (例: pull の base 取得時)
 */
export function resolveTemplateDirScoped(
  source: TemplateSource,
  targetDir: string,
  label?: string,
): Effect.Effect<string, TemplateError, Scope.Scope> {
  if (isLocalSource(source)) {
    return Effect.succeed(resolve(source.path));
  }
  return acquireTempTemplate(targetDir, buildTemplateSource(source), label);
}
