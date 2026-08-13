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

/**
 * ユーザー向けエラー。`hint` でリカバリ方法を提示する。
 *
 * `push` が使う。トップレベルハンドラ (`index.ts`) が `ZikuFailure` と同じ経路で表示する。
 * 理由で分岐できないため、新規の失敗は `ZikuFailure` で表す。
 */
export class ZikuError extends Error {
  constructor(
    message: string,
    public hint?: string,
  ) {
    super(message);
    this.name = "ZikuError";
  }
}

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
  /** ローカルへの書き込みに失敗した。権限や書き込み先の状態を疑う。 */
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
      hint: "GITHUB_TOKEN / GH_TOKEN が無効または失効しています。`gh auth login` で再ログインするか、環境変数を更新してください。",
    }))
    .with({ kind: "GitHubRateLimited" }, (r) => ({
      message: "GitHub API rate limit exceeded",
      hint: `${describeQuota(r.authenticated)}${describeQuotaReset(r.resetAt)}`,
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
      hint: `Resolve the conflict markers in these files, then run \`ziku pull --continue\`:\n${bulletList(r.conflicts)}`,
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
    .with({ kind: "FileWriteFailed" }, (r) => ({
      message: `Failed to write ${r.path}: ${r.detail}`,
      hint: `Check write permissions for ${r.directory}`,
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

/** レート制限の hint 前半。トークンを足すべきか、待つしかないかを分ける。 */
function describeQuota(authenticated: boolean): string {
  return authenticated
    ? "Authenticated quota (5000/hr) exhausted"
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
 * テンプレートに .ziku/ziku.jsonc が存在しない。
 * init 時にテンプレートが未構成の場合に発生する。
 */
export class TemplateNotConfiguredError extends Data.TaggedError("TemplateNotConfiguredError")<{
  readonly templateDir: string;
}> {}
