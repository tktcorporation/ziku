/**
 * テンプレートソース解決の共通ユーティリティ。
 *
 * 背景: pull/push/diff/init で繰り返される「lock.json から source を読む →
 * ローカル or GitHub からテンプレートを取得 → クリーンアップ」を DRY 化する。
 * 各コマンドは resolveTemplateDir を yield* するだけでテンプレートを取得できる。
 */
import { Effect } from "effect";
import { resolve } from "pathe";
import type { TemplateSource } from "../modules/schemas";
import { isLocalSource } from "../modules/schemas";
import { TemplateError } from "../errors";
import { downloadTemplateToTemp, buildTemplateSource } from "./template";

export interface ResolvedTemplate {
  readonly templateDir: string;
  readonly cleanup: () => void;
}

/**
 * TemplateSource からテンプレートディレクトリを解決する。
 *
 * ローカルソースの場合はパスをそのまま返し、
 * GitHub ソースの場合はダウンロードして一時ディレクトリを返す。
 * 呼び出し元は cleanup を finally で呼ぶ責務がある。
 *
 * @param source - テンプレートの取得元
 * @param targetDir - ダウンロード先のベースディレクトリ（GitHub ソースの場合に使���）
 * @param label - 一時ディレクトリを区別するためのラベル
 */
export function resolveTemplateDir(
  source: TemplateSource,
  targetDir: string,
  label?: string,
): Effect.Effect<ResolvedTemplate, TemplateError> {
  if (isLocalSource(source)) {
    return Effect.succeed({
      templateDir: resolve(source.path),
      cleanup: () => {},
    });
  }

  return Effect.tryPromise({
    try: () => downloadTemplateToTemp(targetDir, buildTemplateSource(source), label),
    catch: (e) =>
      new TemplateError({
        message: `Failed to download template from ${source.owner}/${source.repo}`,
        cause: e,
      }),
  });
}
