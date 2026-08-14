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
import type {
  AbsPath,
  GitHubSource,
  LocalSource,
  TemplateRef,
  TemplateSource,
} from "../modules/schemas";
import type { TemplateError } from "../errors";
import { DefaultBranchUnresolvedError, GitHubAuthRejectedError } from "../errors";
import { log } from "../ui/renderer";
import { decideDefaultBranch, fetchDefaultBranch } from "./github";
import { absPath } from "./paths";
import { acquireTempTemplate, buildTemplateSource } from "./template";

/**
 * 取得先が確定した GitHub ソース。
 *
 * `ref` を必須にすることで、giget の既定（`main`）へ落ちる取得先が型として作れなくなる。
 * 取得先を決めた側と、その取得先のコミット SHA を lock へ記録する側は、同じ値を受け取ること。
 */
export type PinnedGitHubSource = GitHubSource & { readonly ref: TemplateRef };

/**
 * 取得先の解決結果。
 *
 * `defaultBranch` を `pinned.ref` と別に持つのは、両者の意味が違うため。`pinned.ref` は
 * 「今回どこから取ったか」で、ユーザーが `source.ref` を書いていればそれがそのまま入る。
 * `defaultBranch` は「GitHub から引けた既定ブランチ名」で、lock へ控えるのはこちらだけ。
 * 一緒にすると、ユーザーがタグやトピックブランチを指定しただけで、それが既定ブランチの
 * 控えとして記録されてしまう。
 */
export interface GitHubFetchTarget {
  /** giget の取得先と、ベースの SHA 問い合わせの両方に渡す。 */
  readonly pinned: PinnedGitHubSource;
  /** 今回 GitHub から引けた既定ブランチ名。引いていない・引けなかったときは undefined。 */
  readonly defaultBranch: string | undefined;
}

/**
 * GitHub ソースの取得先を確定させる。ref 未指定なら既定ブランチを解決して埋める。
 *
 * 返す `pinned` をそのまま取得にも SHA の問い合わせにも使うこと。取得先を決めた側とベースを
 * 記録する側が別々に ref を解決すると、同じ規則を通していても解決が二重になり、片方だけが
 * 失敗したときの扱いが分かれる。
 *
 * 埋める理由: テンプレートの取得先は、同じ実行の中で決まる他の 2 つと同じブランチでなければ
 * 意味を持たない。lock の `base.ref` に記録するコミット SHA（`resolveSourceCommit`）と、
 * push が PR を向ける宛先ブランチ（`resolvePrBaseBranch`）は、どちらもここで確定した `pinned`
 * から導く。ref を落として giget に任せると giget の既定である `main` から取得され、既定
 * ブランチが `master` のリポジトリでは差分比較のツリーだけが別のブランチを指す。
 *
 * 既定ブランチを GitHub へ問い合わせるのはこの関数だけにする。同じ実行で二度引くと、控えへ
 * 倒れるかどうかが問い合わせごとに変わりうるうえ、未認証で 60 req/h しかない予算を用途の
 * 数だけ消費する。引けなかったときにどこまで進むかは {@link decideDefaultBranch} が決める。
 * 取得を止める失敗は種別ごとに別のエラーへ写す（トークン拒否は人がトークンを直すまで、控えの
 * 不在は宛先を明示するまで解消しない）。
 *
 * 控えへ倒しても取得したツリーと記録する参照は食い違わない。`pinned.ref` は控えのブランチ名で
 * 埋まり、ベースの SHA も呼び出し側が同じ `pinned` で引く。SHA まで引けなければ lock の
 * `base.ref` は空のまま残り、次回のマージがベース無しへ縮退するだけで、別ブランチの SHA が
 * 記録されることはない。控えの名前が改名で古くなっていた場合は giget の取得が 404 で失敗する。
 */
export function resolveGitHubFetchSource(
  gh: GitHubSource,
): Effect.Effect<GitHubFetchTarget, DefaultBranchUnresolvedError | GitHubAuthRejectedError> {
  return Effect.gen(function* () {
    const pinnedByUser = gh.ref;
    if (pinnedByUser !== undefined) {
      return { pinned: { ...gh, ref: pinnedByUser }, defaultBranch: undefined };
    }

    const resolution = yield* Effect.promise(() => fetchDefaultBranch(gh.owner, gh.repo));

    return yield* match(decideDefaultBranch(resolution, gh.defaultBranch))
      .with({ _tag: "Fetched" }, (d) =>
        Effect.succeed<GitHubFetchTarget>({
          pinned: pinnedToBranch(gh, d.name),
          defaultBranch: d.name,
        }),
      )
      // 控えを使ったことは警告として出す。取得先が「今の既定ブランチ」ではなく「最後に引けた
      // 既定ブランチ」に変わっており、その間に改名や切り替えがあれば結果が変わるため、黙って
      // 進めてよい代替ではない。
      .with({ _tag: "Recorded" }, (d) =>
        Effect.sync<GitHubFetchTarget>(() => {
          log.warn(
            `Could not ask GitHub for the default branch of ${gh.owner}/${gh.repo} (${d.reason}). Using the recorded default branch ${d.name}.`,
          );
          return { pinned: pinnedToBranch(gh, d.name), defaultBranch: undefined };
        }),
      )
      .with({ _tag: "AuthRejected" }, (f) =>
        Effect.fail(new GitHubAuthRejectedError({ detail: f.detail })),
      )
      .with({ _tag: "Unresolved" }, (f) =>
        Effect.fail(
          new DefaultBranchUnresolvedError({ owner: gh.owner, repo: gh.repo, detail: f.reason }),
        ),
      )
      .exhaustive();
  });
}

/** 決まったブランチ名で取得先を固定する。 */
function pinnedToBranch(gh: GitHubSource, name: string): PinnedGitHubSource {
  return { ...gh, ref: { kind: "branch", name } };
}

/**
 * 解決済みのテンプレート。ソース種別ごとに、後段が要る情報が違う。
 *
 * GitHub ソースだけが `pinned` と `defaultBranch` を持つ。ローカルソースには取得先の ref も
 * 既定ブランチも無く、共通の形にすると「ローカルソースなのに ref がある」状態を呼び出し側が
 * 場当たりに潰すことになる。
 *
 * 取得元（`source` / `pinned`）も同じ値に載せる理由: ソース種別で処理を分ける呼び出し側が、
 * 取得元と解決結果を別々に分岐せずに済む。別々に分岐すると「GitHub ソースなのにローカルの
 * 解決結果」という組み合わせが型として残り、呼び出し側がそれを場当たりに潰すことになる。
 */
export type ResolvedTemplate =
  | {
      readonly kind: "local";
      readonly dir: AbsPath;
      /** lock に載っている取得元そのもの。`dir` はこれを絶対パスへ直した読み書きの基点。 */
      readonly source: LocalSource;
    }
  | {
      readonly kind: "github";
      readonly dir: AbsPath;
      /** 取得に使った取得元。ベースの SHA も同じ ref で引くこと。 */
      readonly pinned: PinnedGitHubSource;
      /** 今回 GitHub から引けた既定ブランチ名。lock へ控える値（{@link GitHubFetchTarget}）。 */
      readonly defaultBranch: string | undefined;
    };

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
): Effect.Effect<
  ResolvedTemplate,
  TemplateError | DefaultBranchUnresolvedError | GitHubAuthRejectedError,
  Scope.Scope
> {
  return (
    match(source)
      .returnType<
        Effect.Effect<
          ResolvedTemplate,
          TemplateError | DefaultBranchUnresolvedError | GitHubAuthRejectedError,
          Scope.Scope
        >
      >()
      // lock.json は手で書き換えられるので、載っているパスが絶対とは限らない。読んだ値を
      // そのまま基点にすると、カレントディレクトリ次第で別の場所をテンプレートとして扱う。
      .with({ kind: "local" }, (local) =>
        Effect.succeed({ kind: "local", dir: absPath(local.path), source: local }),
      )
      .with({ kind: "github" }, (gh) =>
        resolveGitHubFetchSource(gh).pipe(
          Effect.flatMap((target) =>
            acquireTempTemplate(targetDir, buildTemplateSource(target.pinned), label).pipe(
              Effect.map((dir) => ({
                kind: "github" as const,
                dir,
                pinned: target.pinned,
                defaultBranch: target.defaultBranch,
              })),
            ),
          ),
        ),
      )
      .exhaustive()
  );
}
