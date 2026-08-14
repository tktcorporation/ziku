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
import type { AbsPath, GitHubSource, TemplateSource } from "../modules/schemas";
import type { TemplateError } from "../errors";
import { DefaultBranchUnresolvedError } from "../errors";
import { resolveDefaultBranch } from "./github";
import { absPath } from "./paths";
import { acquireTempTemplate, buildTemplateSource } from "./template";

/**
 * GitHub ソースの取得先を確定させる。ref 未指定なら既定ブランチを解決して埋める。
 *
 * 返す値をそのまま取得にも SHA の問い合わせにも使うこと。取得先を決めた側とベースを記録する側が
 * 別々に ref を解決すると、同じ規則を通していても解決が二重になり、片方だけが失敗したときの
 * 扱いが分かれる。
 *
 * 埋める理由: テンプレートの取得先は、同じ実行の中で決まる他の 2 つと同じブランチでなければ
 * 意味を持たない。lock の `base.ref` に記録するコミット SHA（`resolveSourceCommit`）と、
 * push が PR を向ける宛先ブランチ（`resolveDefaultBranch`）は、どちらも「リポジトリの既定
 * ブランチ」を見る。ref を落として giget に任せると giget の既定である `main` から取得され、
 * 既定ブランチが `master` のリポジトリでは差分比較のツリーだけが別のブランチを指す。
 *
 * 解決できなければ取得を止める理由: 既定ブランチが分からないまま `main` へ倒すと、上の食い違い
 * が黙って起きる。差分もマージ結果も「テンプレートと比べた結果」として表示されるので、
 * 別ブランチのツリーと比べたことは出力のどこにも現れない。既定ブランチを引けない状況
 * （リポジトリ不在・トークン拒否・ネットワーク断・レート制限）は、そもそもテンプレート本体の
 * 取得も失敗するか、記録済みのベースと関係のないツリーしか得られない状況でもある。止めて
 * 到達性を直すか `source.ref` で取得先を明示してもらうほうが、行動が決まる。push が PR の
 * 宛先を決められないときに中断するのと同じ扱いにすることで、到達できないリポジトリはどの
 * コマンドでも同じ形で失敗する。
 */
export function resolveGitHubFetchSource(
  gh: GitHubSource,
): Effect.Effect<GitHubSource, DefaultBranchUnresolvedError> {
  return Effect.gen(function* () {
    if (gh.ref !== undefined) return gh;

    const defaultBranch = yield* Effect.promise(() => resolveDefaultBranch(gh.owner, gh.repo));
    if (defaultBranch === undefined) {
      return yield* Effect.fail(
        new DefaultBranchUnresolvedError({ owner: gh.owner, repo: gh.repo }),
      );
    }

    return { ...gh, ref: { kind: "branch", name: defaultBranch } };
  });
}

/**
 * TemplateSource からテンプレートディレクトリを解決する Scoped Effect。
 *
 * - ローカルソース: パスをそのまま返す (Scope は解放処理なしで閉じる)
 * - GitHub ソース: 取得先ブランチを決めてからダウンロードし、一時ディレクトリを Scope に
 *   紐づける。ブランチの決め方と、決まらないときに止める理由は
 *   {@link resolveGitHubFetchSource} を参照。
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
): Effect.Effect<AbsPath, TemplateError | DefaultBranchUnresolvedError, Scope.Scope> {
  return (
    match(source)
      // lock.json は手で書き換えられるので、載っているパスが絶対とは限らない。読んだ値を
      // そのまま基点にすると、カレントディレクトリ次第で別の場所をテンプレートとして扱う。
      .with({ kind: "local" }, (local) => Effect.succeed(absPath(local.path)))
      .with({ kind: "github" }, (gh) =>
        resolveGitHubFetchSource(gh).pipe(
          Effect.flatMap((fetched) =>
            acquireTempTemplate(targetDir, buildTemplateSource(fetched), label),
          ),
        ),
      )
      .exhaustive()
  );
}
