/**
 * テンプレートソース解決の共通ユーティリティ。
 *
 * 背景: pull/push/diff/init で繰り返される「lock.json から source を読む →
 * ローカル or GitHub からテンプレートを取得 → クリーンアップ」を DRY 化する。
 *
 * 設計: Effect.Scope を返すことで、呼び出し側は Effect.scoped で囲うだけで
 * cleanup が型レベルで強制される。命令的な cleanup 呼び出しは不要。
 */
import { Effect } from "effect";
import type { Scope } from "effect";
import { match } from "ts-pattern";
import type { AbsPath, TemplateSource } from "../modules/schemas";
import type { TemplateError } from "../errors";
import { absPath } from "./paths";
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
  targetDir: AbsPath,
  label?: string,
): Effect.Effect<AbsPath, TemplateError, Scope.Scope> {
  return (
    match(source)
      // lock.json は手で書き換えられるので、載っているパスが絶対とは限らない。読んだ値を
      // そのまま基点にすると、カレントディレクトリ次第で別の場所をテンプレートとして扱う。
      .with({ kind: "local" }, (local) => Effect.succeed(absPath(local.path)))
      .with({ kind: "github" }, (gh) =>
        acquireTempTemplate(targetDir, buildTemplateSource(gh), label),
      )
      .exhaustive()
  );
}
