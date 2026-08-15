/**
 * 失敗の表現 — 判別 union `FailureReason` とその運搬役 `ZikuFailure`。
 *
 * 失敗理由は「呼び出し側またはユーザーが取れる行動」の単位で分ける。行動が同じ失敗を
 * 別ケースにしても分岐が増えるだけで、呼び出し側は得をしない。
 *
 * ユーザー向けの文言は `describeFailure` の 1 箇所だけで組み立てる。`match().exhaustive()`
 * がケースの取りこぼしをコンパイルエラーにするので、ケースを足すと文言の追加を強制される。
 *
 * レイヤーの分担:
 * - ユーティリティ層の TaggedError (`FileNotFoundError` 等) は「どの入出力がどう失敗したか」
 *   だけを表す。ユーザー向けの語彙を持たない。
 * - コマンド層の境界でそれらを `FailureReason` へ分類する (`toZikuFailure`)。
 */
import { Data } from "effect";
import { match } from "ts-pattern";

// ────────────────────────────────────────────────────────────────
// 失敗理由の判別 union
// ────────────────────────────────────────────────────────────────

/**
 * ziku がユーザーに報告する失敗の全体。
 *
 * 各ケースは「ユーザーが次に取る行動」で区切られている。文字列の hint を持ち回らず、
 * 行動を決めるのに必要な素材 (パス・候補リスト・クォータの状態) だけを構造化して持つ。
 */
export type FailureReason =
  /** `.ziku/` の必須ファイルが無い。プロジェクトが未初期化。 */
  | { readonly kind: "NotInitialized"; readonly path: string }
  /** 設定ファイルが JSON / JSONC として壊れている。手で直せる。 */
  | { readonly kind: "ConfigUnparsable"; readonly path: string; readonly detail: string }
  /** 構文は通るが ziku の設定として解釈できない。作り直しが復旧手段。 */
  | { readonly kind: "ConfigInvalid"; readonly path: string; readonly issues: readonly string[] }
  /** テンプレートを取得できない (ダウンロード失敗・パス不正)。 */
  | { readonly kind: "TemplateUnavailable"; readonly detail: string }
  /** テンプレート側に `.ziku/ziku.jsonc` が無い。テンプレート側の作業が要る。 */
  | { readonly kind: "TemplateNotConfigured"; readonly templateRef: string }
  /** 問い合わせたテンプレートリポジトリがどれも存在しない。`owner/repo` 形式で列挙する。 */
  | { readonly kind: "TemplateRepoNotFound"; readonly repos: readonly string[] }
  /** テンプレートの取得元を推測できない (git remote 無し・候補ゼロ)。 */
  | { readonly kind: "TemplateSourceUndetectable" }
  /** 候補が複数あり、どれを使うか決められない。`owner/repo` 形式で列挙する。 */
  | { readonly kind: "AmbiguousTemplateSource"; readonly candidates: readonly string[] }
  /** GitHub への書き込みにトークンが要るが未設定。`operation` は「何をするために」の部分。 */
  | { readonly kind: "GitHubTokenMissing"; readonly operation: string }
  /** トークンはあるが GitHub に拒否された (401)。 */
  | { readonly kind: "GitHubAuthRejected"; readonly detail: string }
  /** GitHub API のレート制限。認証状況で取れる行動が変わる。 */
  | {
      readonly kind: "GitHubRateLimited";
      readonly authenticated: boolean;
      readonly resetAt: Date | undefined;
    }
  /**
   * トークンは受け付けられたが、GitHub がその操作を拒否した (403)。
   *
   * 取る行動はトークンの権限とリポジトリ側の設定を見直すこと。`GitHubAuthRejected` と違い
   * トークンの差し替えでは解決せず、足りないのは書き込みスコープ・SSO の認可・fork の可否
   * といった権限の側。`operation` は「何をしようとして拒否されたか」。
   */
  | {
      readonly kind: "GitHubPermissionDenied";
      readonly operation: string;
      readonly detail: string;
    }
  /**
   * GitHub へ届かなかった (名前解決失敗・接続断・タイムアウト)。
   *
   * 取る行動は接続（ネットワーク・プロキシ）を確かめて同じコマンドを実行し直すこと。
   * ziku 側の状態は変わっていないので、再実行の前に片付けるものは無い。
   */
  | { readonly kind: "GitHubUnreachable"; readonly operation: string; readonly detail: string }
  /**
   * GitHub は応答したが、その内容をこちらが使えない。
   *
   * API の上限で本文が省かれた（Contents API の 1MB 制限など）、あるいは想定した形で
   * 返ってこなかった場合。再実行しても同じ結果になるので、`GitHubUnreachable` の
   * 「接続を確かめて実行し直す」とは取る行動が違う。対象を小さくするか、対象そのものを
   * 変えることになる。
   *
   * 値の欠けを黙って既定値に読み替えないための分類でもある。1MB を超えたファイルの
   * 空の本文を「中身が空のファイル」として扱うと、内容が消えたのか元から空なのかを
   * 呼び出し側が区別できない。
   */
  | {
      readonly kind: "GitHubUnusableResponse";
      readonly operation: string;
      readonly detail: string;
    }
  /**
   * GitHub が宛先を「無い」と答えた (404)。
   *
   * 取る行動は宛先を今あるものへ直すこと。ref を明示していないテンプレートでは、lock に
   * 控えた既定ブランチ名 (`source.defaultBranch`) が宛先になるので、上流でブランチが
   * 改名・削除されるとこの失敗になる。`DefaultBranchUnresolved` と違い宛先の名前は
   * 決まっていて、その名前が指す先が無い。`GitHubPermissionDenied` と違いトークンの権限を
   * 広げても変わらない（ただし対象が private なら、見えないトークンには 404 として届く）。
   */
  | { readonly kind: "GitHubTargetNotFound"; readonly operation: string; readonly detail: string }
  /**
   * リポジトリのファイル数が多すぎて、GitHub がツリーを最後まで返さなかった。
   *
   * 取る行動はリポジトリのファイル数を減らすこと。ziku は既存ファイルを更新するために全件の
   * 一覧を要るので、欠けた一覧で続けると更新すべきファイルを新規作成として送ることになる。
   * `GitHubPermissionDenied` 等と違いトークンや接続では変わらず、リポジトリの中身の話。
   */
  | { readonly kind: "RepoTreeTooLarge"; readonly repo: string }
  /**
   * 削除として送ると示したファイルが、PR の宛先ブランチに存在しない。
   *
   * 取る行動は `ziku pull` で同期ベースを取り直してから push し直すこと。削除は ziku が
   * 控えたベースから導くので、上流で既に消えたファイルは送信の直前に初めて食い違いとして
   * 現れる。`RepoTreeTooLarge` と違い一覧そのものは取れていて、欠けているのは対象のパス。
   */
  | {
      readonly kind: "PushDeletionTargetMissing";
      readonly repo: string;
      readonly paths: readonly string[];
    }
  /**
   * 新しく足すはずのファイルが、PR の宛先ブランチに既にある。
   *
   * 取る行動はそのファイルを直接編集すること。`ziku setup` は「まだ ziku を使っていない
   * テンプレートに規定の設定を置く」操作なので、既にあるものを規定値へ戻すことはしない
   * （戻すと、そのテンプレートを使う全プロジェクトの同期対象が規定値に変わる）。
   * `PushDeletionTargetMissing` と逆向きで、宛先の状態が操作の前提と食い違っている。
   */
  | {
      readonly kind: "PushCreateTargetExists";
      readonly repo: string;
      readonly paths: readonly string[];
    }
  /**
   * 同じパスを、内容の更新と削除の両方として送ろうとした。
   *
   * 取る行動はそのファイルを今回の push から外し、更新か削除のどちらか一方だけを送ること。
   * 更新は新しい blob を作り、削除は宛先ブランチの blob SHA を要求するので、両方を含む PR は
   * GitHub が受け付けない。`PushDeletionTargetMissing` と違い宛先の状態は関係なく、送ろうと
   * している指示そのものが 2 つに割れている。
   */
  | {
      readonly kind: "PushPathUpdatedAndDeleted";
      readonly repo: string;
      readonly paths: readonly string[];
    }
  /**
   * PR の head に使う名前のリポジトリが認証ユーザー配下に既にあるが、対象の fork ではない。
   *
   * 取る行動はそのリポジトリを改名するか消すこと。ziku は対象リポジトリと同じ名前で fork を
   * 作って PR の head にするので、無関係な同名リポジトリがあると、そこへ同期ブランチを作る
   * ことになり、共通の履歴が無い PR として GitHub に拒まれる。`GitHubPermissionDenied` と
   * 違いトークンの権限では変わらず、直す先は GitHub 上のリポジトリ名。
   */
  | { readonly kind: "ForkNameTaken"; readonly repo: string; readonly existing: string }
  /** CLI 引数の値が受け付けられない。 */
  | {
      readonly kind: "InvalidArgument";
      readonly argument: string;
      readonly value: string;
      readonly expected: string;
    }
  /** 必須の CLI 引数が無い。 */
  | { readonly kind: "MissingArgument"; readonly argument: string; readonly usage: string }
  /**
   * 解決待ちのマージが残っているため、新しいマージを始められない。
   *
   * 取る行動は「`pull` ではなく `pull --continue` を使う」。解決自体は既に済んでいる
   * こともあるので、コマンドの言い直しが本体になる。
   */
  | { readonly kind: "MergePaused"; readonly conflicts: readonly string[] }
  /**
   * 解決待ちのマージが無いのに再開しようとした。
   *
   * 取る行動は「まず `pull` を実行する」。`MergePaused` とは逆向きの言い直しになる。
   */
  | { readonly kind: "NoMergePaused" }
  /**
   * 再開を試みたが、コンフリクトマーカーが残っている。
   *
   * 取る行動はファイルの編集。コマンドは合っているので言い直しでは解決せず、
   * どこを直せばよいかを行番号まで添えて示す。
   */
  | {
      readonly kind: "ConflictsUnresolved";
      readonly files: readonly { readonly path: string; readonly lines: readonly number[] }[];
    }
  /**
   * 自動マージできなかったファイルの扱いが決まっていないまま、対話を省く実行で再開しようとした。
   *
   * 取る行動は「対話実行で再開し、ファイルごとにどちらの内容を残すか選ぶ」。どちらを選んでも
   * 片側の変更が失われるため、ツールが代わりに決められる判断ではない。
   */
  | { readonly kind: "UnmergedChoiceRequired"; readonly files: readonly string[] }
  /**
   * 取り寄せたテンプレートに、内容を取ると決めたファイルが無い。
   *
   * 取る行動は「そのファイルはローカルを残す側で再開する」。テンプレート側で消えている
   * ファイルなので、待っても取れるようにはならない。
   */
  | { readonly kind: "TemplateFileMissing"; readonly path: string }
  /**
   * リポジトリの既定ブランチを引けず、PR の宛先もテンプレートの取得先も決められない。
   *
   * 取る行動は 2 つ。GitHub へ到達できているか（ネットワーク・トークン・クォータ）を確かめるか、
   * lock の `source.ref` でブランチを明示する。`TemplateRefNotBranch` と違い、
   * lock の記述自体は正しい。
   */
  | { readonly kind: "DefaultBranchUnresolved"; readonly repo: string }
  /**
   * 自動マージできなかったファイルを push 対象に選んだ。
   *
   * 取る行動は「`ziku pull` でテンプレートの変更を取り込み、衝突を解いてから push し直す」。
   * `MergePaused` と違いマージはまだ始まっていないので、案内するのは `--continue` ではなく
   * `pull` そのものになる。
   */
  | { readonly kind: "PushBlockedByConflicts"; readonly files: readonly string[] }
  /**
   * PR の宛先ブランチが決まらない。テンプレートがタグ・コミットに固定されている。
   *
   * 取る行動は lock の `source.ref` をブランチへ書き換えること。テンプレートの取得自体は
   * 成功しているので、取得元を選び直す `TemplateUnavailable` 系とは行動が違う。
   */
  | { readonly kind: "TemplateRefNotBranch"; readonly refKind: "tag" | "commit" }
  /** ローカルへの書き込みに失敗した。書き込み先の権限か空き容量を直せば通る。 */
  | {
      readonly kind: "FileWriteFailed";
      readonly path: string;
      readonly directory: string;
      readonly detail: string;
    }
  /**
   * `--dryRun` がリモートへの変更を止めた。
   *
   * ローカルの書き込みと違い、リモートの作成は「実行したふり」ができない。プレビューを
   * 続けるための材料を作れないので、中断して選択肢を示す。
   */
  | { readonly kind: "DryRunBlocked"; readonly operation: string };

/** ユーザーに見せる 1 つの失敗の表示。hint は必ず「次に何をするか」を答える。 */
export interface FailureDisplay {
  readonly message: string;
  readonly hint: string;
}

const GITHUB_TOKEN_HINT = "Set GITHUB_TOKEN or GH_TOKEN, or run: gh auth login";
const SPECIFY_FROM_HINT = "Specify --from <owner> or --from <owner/repo>";

/**
 * 失敗理由をユーザー向けの文言に変換する。
 *
 * 文言の組み立てはここだけで行う。`ZikuFailure` は生成時にこの結果を保持するので、
 * 表示側が理由を再解釈する必要はない。
 */
export function describeFailure(reason: FailureReason): FailureDisplay {
  return match(reason)
    .with({ kind: "NotInitialized" }, (r) => ({
      message: `${r.path} not found.`,
      hint: "Run 'ziku init' first.",
    }))
    .with({ kind: "ConfigUnparsable" }, (r) => ({
      message: `Failed to parse ${r.path}`,
      hint: r.detail,
    }))
    .with({ kind: "ConfigInvalid" }, (r) => ({
      message: `Failed to read ${r.path}`,
      hint: [...r.issues, "Run `ziku init` to recreate it."].join("\n"),
    }))
    .with({ kind: "TemplateUnavailable" }, (r) => ({
      message: "Failed to load template",
      hint: r.detail,
    }))
    .with({ kind: "TemplateNotConfigured" }, (r) => ({
      message: "Template has no .ziku/ziku.jsonc",
      hint: `Run 'ziku setup' in ${r.templateRef} to create it.`,
    }))
    .with({ kind: "TemplateRepoNotFound" }, (r) => ({
      message: `Template repository not found: ${r.repos.join(", ")}`,
      hint: "Check the --from value, or create the repository first",
    }))
    .with({ kind: "TemplateSourceUndetectable" }, () => ({
      message: "Cannot detect template source",
      hint: SPECIFY_FROM_HINT,
    }))
    .with({ kind: "AmbiguousTemplateSource" }, (r) => ({
      message: `Multiple template candidates found: ${r.candidates.join(", ")}`,
      hint: `${SPECIFY_FROM_HINT} to disambiguate`,
    }))
    .with({ kind: "GitHubTokenMissing" }, (r) => ({
      message: `GitHub token required to ${r.operation}`,
      hint: GITHUB_TOKEN_HINT,
    }))
    .with({ kind: "GitHubAuthRejected" }, (r) => ({
      message: `GitHub authentication failed: ${r.detail}`,
      hint: "GITHUB_TOKEN / GH_TOKEN is invalid or expired. Run `gh auth login` again, or update the environment variable.",
    }))
    .with({ kind: "GitHubRateLimited" }, (r) => ({
      message: "GitHub API rate limit exceeded",
      hint: `${describeQuota(r.authenticated)}${describeQuotaReset(r.resetAt)}`,
    }))
    .with({ kind: "GitHubPermissionDenied" }, (r) => ({
      message: `GitHub refused to ${r.operation}: ${r.detail}`,
      hint: "Check that the token has write access to the repository (repo scope, and SSO authorization for org-owned repositories), and that the repository allows forking.",
    }))
    .with({ kind: "GitHubUnreachable" }, (r) => ({
      message: `Cannot reach GitHub to ${r.operation}: ${r.detail}`,
      hint: "Check your network connection and any proxy settings, then run the same command again.",
    }))
    .with({ kind: "GitHubUnusableResponse" }, (r) => ({
      message: `GitHub returned a response ziku cannot use while trying to ${r.operation}: ${r.detail}`,
      hint: "Re-running will not change the result. Reduce the size of the file involved, or point the command at a different target.",
    }))
    .with({ kind: "GitHubTargetNotFound" }, (r) => ({
      message: `GitHub has no such repository or branch to ${r.operation}: ${r.detail}`,
      hint: `Point ziku at something that exists now. Without source.ref, ziku targets the branch recorded in .ziku/lock.json as source.defaultBranch, which stops existing when the branch is renamed or deleted upstream — name the branch that exists now in source.ref (for example { "kind": "branch", "name": "main" }), or delete .ziku/lock.json and run \`ziku init\` to record the template again. If the repository itself moved or is private, check source.owner / source.repo and that GITHUB_TOKEN / GH_TOKEN can see it.`,
    }))
    .with({ kind: "RepoTreeTooLarge" }, (r) => ({
      message: `GitHub could not list every file in ${r.repo}: the repository tree is too large`,
      hint: `ziku needs the full listing to tell which files it must update. Reduce the number of files in ${r.repo} — narrowing the include patterns in \`.ziku/ziku.jsonc\` keeps fewer files in sync — then run the command again.`,
    }))
    .with({ kind: "PushDeletionTargetMissing" }, (r) => ({
      message: `${r.repo} has no such file to delete: ${r.paths.join(", ")}`,
      hint: `ziku derives deletions from the sync base recorded in \`.ziku/lock.json\`, and these files are already gone from the branch the pull request targets. Run \`ziku pull\` to bring the base up to date, then push again.`,
    }))
    .with({ kind: "PushCreateTargetExists" }, (r) => ({
      message: `${r.repo} already has: ${r.paths.join(", ")}`,
      hint: `ziku setup adds these files to a template that does not have them yet, and never replaces what is already there — replacing them would reset the sync patterns for every project using this template. Edit the file in ${r.repo} directly to change what the template tracks.`,
    }))
    .with({ kind: "PushPathUpdatedAndDeleted" }, (r) => ({
      message: `Cannot push ${r.paths.join(", ")} to ${r.repo} as both new content and a deletion`,
      hint: `A pull request carries one intent per file: updating it writes a new blob, deleting it needs the blob the target branch has now. Leave ${r.paths.length === 1 ? "that file" : "those files"} out of this push (name the other files with --files, or unselect it in the interactive list), then push the update or the deletion on its own.`,
    }))
    .with({ kind: "ForkNameTaken" }, (r) => ({
      message: `${r.existing} already exists and is not a fork of ${r.repo}`,
      hint: `ziku opens the pull request from a fork of ${r.repo} under your account, and a fork keeps the upstream repository name. Rename or delete ${r.existing} on GitHub, then run the command again.`,
    }))
    .with({ kind: "InvalidArgument" }, (r) => ({
      message: `Invalid ${r.argument}: "${r.value}"`,
      hint: `Expected: ${r.expected}`,
    }))
    .with({ kind: "MissingArgument" }, (r) => ({
      message: `No ${r.argument} specified.`,
      hint: r.usage,
    }))
    .with({ kind: "MergePaused" }, (r) => ({
      message: "Merge already in progress from a previous `ziku pull`",
      hint: `Resolve the pending conflicts in these files, then run \`ziku pull --continue\`:\n${bulletList(r.conflicts)}`,
    }))
    .with({ kind: "NoMergePaused" }, () => ({
      message: "No pending merge found",
      hint: "Run `ziku pull` first to start a merge",
    }))
    .with({ kind: "ConflictsUnresolved" }, (r) => ({
      message: "Unresolved conflict markers remain",
      hint: `Remove the conflict markers from these files, then run \`ziku pull --continue\` again:\n${bulletList(
        r.files.map((f) => `${f.path} ${describeConflictLines(f.lines)}`),
      )}`,
    }))
    .with({ kind: "UnmergedChoiceRequired" }, (r) => ({
      message: `${r.files.length} file(s) could not be auto-merged and need your decision`,
      hint: `Run \`ziku pull --continue\` without --yes / --force to choose, for each file, whether to keep your local version or take the template's:\n${bulletList(
        r.files,
      )}`,
    }))
    .with({ kind: "TemplateFileMissing" }, (r) => ({
      message: `${r.path} is not in the template being merged`,
      hint: "Run `ziku pull --continue` again and keep your local version for that file.",
    }))
    .with({ kind: "DefaultBranchUnresolved" }, (r) => ({
      message: `Cannot determine the default branch of ${r.repo}`,
      hint: `Check that GitHub is reachable (network, GITHUB_TOKEN / GH_TOKEN). Without a token GitHub allows 60 requests per hour, so waiting for the quota to reset or setting a token also fixes this. You can also name the branch in .ziku/lock.json's source.ref (for example { "kind": "branch", "name": "main" }) to stop asking GitHub for it.`,
    }))
    .with({ kind: "PushBlockedByConflicts" }, (r) => ({
      message: `${r.files.length} selected file(s) have conflicts that couldn't be auto-merged`,
      hint: `Resolve these conflicts before pushing:\n${bulletList(
        r.files,
      )}\n\nRun \`ziku pull\` to bring in the template changes and resolve the conflicts, then push again.`,
    }))
    .with({ kind: "TemplateRefNotBranch" }, (r) => ({
      message: `Cannot open a pull request against a template pinned to a ${r.refKind}`,
      hint: `Point .ziku/lock.json's source.ref at a branch (for example { "kind": "branch", "name": "main" }) and run push again.`,
    }))
    .with({ kind: "FileWriteFailed" }, (r) => ({
      message: `Failed to write ${r.path}: ${r.detail}`,
      hint: `Check write permissions and free space for ${r.directory}`,
    }))
    .with({ kind: "DryRunBlocked" }, (r) => ({
      message: `${r.operation}, but --dryRun prevents remote changes`,
      hint: "Run without --dryRun to apply it, or point at an existing template with --from",
    }))
    .exhaustive();
}

/** 対象ファイルを 1 行 1 件で並べる。hint の中で複数件を数えられるようにする。 */
function bulletList(items: readonly string[]): string {
  return items.map((item) => `  • ${item}`).join("\n");
}

/**
 * 未解決ブロックの位置をユーザー向けに整形する。
 *
 * 行番号を添えるのは、マーカーが 1 ファイルに複数ブロック残ることがあり、
 * ファイル名だけでは編集すべき箇所が分からないため。
 *
 * 失敗の hint と、マージ中の警告ログの両方がこの文言を使う。
 */
export function describeConflictLines(lines: readonly number[]): string {
  return `(${lines.length === 1 ? "line" : "lines"} ${lines.join(", ")})`;
}

/**
 * レート制限の hint 前半。トークンを足すべきか、待つしかないかを分ける。
 *
 * 認証済みで「1 時間あたりのクォータ」と「連投を弾く secondary rate limit」を書き分けない
 * のは、どちらでも取る行動が「待ってから実行し直す」で同じため。
 */
function describeQuota(authenticated: boolean): string {
  return authenticated
    ? "Authenticated quota (5000/hr) exhausted, or a secondary rate limit was hit"
    : "Unauthenticated quota (60/hr) exhausted — set GITHUB_TOKEN or run `gh auth login` to raise it to 5000/hr";
}

/** レート制限の hint 後半。リセット時刻が取れないときは何も足さない。 */
function describeQuotaReset(resetAt: Date | undefined): string {
  if (!resetAt) return "";
  const minutes = Math.max(0, Math.ceil((resetAt.getTime() - Date.now()) / 60000));
  return ` (resets in ~${minutes} min)`;
}

/**
 * 失敗理由を Effect のエラーチャネルに載せ、`throw` でも運べる形にしたもの。
 *
 * `Error` を継承するので、Effect を使っていない async 関数からそのまま throw できる。
 * `reason` が残るため、呼び出し側は文言ではなく理由で分岐できる。
 *
 * 生成には `zikuFailure()` を使うこと。`message` / `hint` は `describeFailure` の
 * 出力であり、直接コンストラクタを呼ぶと理由と文言がずれる。
 */
export class ZikuFailure extends Data.TaggedError("ZikuFailure")<{
  readonly reason: FailureReason;
  readonly message: string;
  readonly hint: string;
  readonly cause?: unknown;
}> {}

/**
 * 失敗理由から `ZikuFailure` を作る。
 *
 * @param reason 失敗理由
 * @param options.cause 元の例外。原因を捨てないため、外部から捕捉した例外は必ず渡す。
 */
export function zikuFailure(
  reason: FailureReason,
  options?: { readonly cause?: unknown },
): ZikuFailure {
  const { message, hint } = describeFailure(reason);
  return new ZikuFailure({ reason, message, hint, cause: options?.cause });
}

// ────────────────────────────────────────────────────────────────
// Effect Tagged Errors — ユーティリティ関数の型付きエラーチャネル用
//
// これらは「どの入出力がどう失敗したか」までを表す。ユーザー向けの語彙は持たず、
// コマンド層の境界で FailureReason へ分類される。
// ────────────────────────────────────────────────────────────────

/** ファイルが見つからない */
export class FileNotFoundError extends Data.TaggedError("FileNotFoundError")<{
  readonly path: string;
}> {}

/** JSONC/JSON パースに失敗 */
export class ParseError extends Data.TaggedError("ParseError")<{
  readonly path: string;
  readonly cause: unknown;
}> {}

/** Zod スキーマバリデーション失敗 */
export class ValidationError extends Data.TaggedError("ValidationError")<{
  readonly path: string;
  readonly issues: readonly string[];
}> {}

/** テンプレートダウンロード・操作エラー */
export class TemplateError extends Data.TaggedError("TemplateError")<{
  readonly message: string;
  readonly cause?: unknown;
}> {}

/**
 * ref を明示していないテンプレートソースで、リポジトリの既定ブランチを引けなかった。
 *
 * `TemplateError` と分けるのは、取れる行動が違うため。ダウンロードそのものの失敗と違い、
 * ここでは「どのブランチを取ればよいか」が決まっていない。ユーザーは GitHub への到達性を
 * 直すか、lock の `source.ref` で取得先を明示することで解決できる。
 *
 * 待てば直る失敗（レート制限・5xx・接続断）でこれを返すのは、lock に既定ブランチの控えが
 * 無い場合だけ。控えがあるときは取得先が決まるので、失敗にはしない（`gitHubSourceSchema`
 * の `defaultBranch`）。
 */
export class DefaultBranchUnresolvedError extends Data.TaggedError("DefaultBranchUnresolvedError")<{
  readonly owner: string;
  readonly repo: string;
  /** 引けなかった事情。HTTP ステータス文か例外のメッセージ。 */
  readonly detail: string;
}> {}

/**
 * 付与したトークンを GitHub が拒否した（401）。
 *
 * `DefaultBranchUnresolvedError` と分けるのは、待っても再実行しても結果が変わらないため。
 * 控えのブランチ名へ倒す対象にせず、そのまま中断してユーザーにトークンを直してもらう。
 * プライベートリポジトリでは「見えるはずのものが見えない」状態でもあるので、ツールが代わりに
 * 続行を決めてよい失敗ではない。
 */
export class GitHubAuthRejectedError extends Data.TaggedError("GitHubAuthRejectedError")<{
  readonly detail: string;
}> {}

/**
 * テンプレートに .ziku/ziku.jsonc が存在しない。
 * init 時にテンプレートが未構成の場合に発生する。
 */
export class TemplateNotConfiguredError extends Data.TaggedError("TemplateNotConfiguredError")<{
  readonly templateDir: string;
}> {}
