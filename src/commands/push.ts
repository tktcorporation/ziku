import { existsSync } from "node:fs";
import { mkdir, rm, writeFile } from "node:fs/promises";
import { defineCommand } from "citty";
import { Effect } from "effect";
import { dirname } from "pathe";
import { P, match } from "ts-pattern";
import { withCleanup } from "../effect-helpers";
import { ZikuFailure, zikuFailure } from "../errors";
import type {
  AbsPath,
  FileDiff,
  GlobPattern,
  LocalSource,
  LockState,
  PendingConflict,
  PushContent,
  RepoRelPath,
  TemplateSource,
} from "../modules/schemas";
import {
  asPushContent,
  baseCommitSha,
  baseHashesOf,
  markSynced,
  mergedAsPushContent,
} from "../modules/schemas";
import { LOCK_FILE, saveLock } from "../utils/lock";
import {
  ZIKU_CONFIG_FILE,
  addIncludePattern,
  isZikuConfigPath,
  loadZikuConfig,
  saveZikuConfig,
} from "../utils/ziku-config";
import { loadCommandContext, runCommandEffect, toZikuFailure } from "../services/command-context";
import { mergeConflictFiles } from "../utils/merge";
import { analyzeSync } from "../utils/sync-analysis";
import type { SyncScope } from "../utils/sync-scope";
import { extendScope, resolveSyncScope } from "../utils/sync-scope";
import { transportTextToBytes } from "../utils/file-content";
import { absPath, joinAbs, pathAsPattern, repoRelPath } from "../utils/paths";
import {
  analyzeConfigDrift,
  computeMergedZikuConfig,
  computeScopedZikuConfig,
  findLocalOnlyPatternsForPaths,
} from "../utils/config-merge";
import type { CommandContextShape } from "../services/command-context";
import type { PinnedGitHubSource } from "../utils/template-resolve";
import type { CommandLifecycle } from "../docs/lifecycle-types";
import { SYNCED_FILES } from "../docs/lifecycle-types";
import {
  confirmAction,
  generatePrBody,
  generatePrTitle,
  inputGitHubToken,
  inputPrBody,
  inputPrTitle,
  logUntrackedFilesNotice,
  selectPushFiles,
  selectUntrackedToTrack,
} from "../ui/prompts";
import { calculateDiffStats, formatStats } from "../ui/diff-view";
import { padToWidth } from "../ui/text-width";
import { intro, log, logDiffSummary, outro, pc, withSpinner } from "../ui/renderer";
import { detectDiff } from "../utils/diff";
import { createPullRequest, getGitHubToken } from "../utils/github";
import { hashFiles } from "../utils/hash";
import { renderTemplateReadme } from "../utils/readme";
import { detectUntrackedFiles, getTotalUntrackedCount } from "../utils/untracked";
import type {
  ChangedFileDiff,
  ConfigPropagationPlan,
  PushCandidatePlan,
  PushDelivery,
  PushFile,
  PushFileSelection,
  PushPayload,
  PushSend,
  ZikuConfigWriteBack,
} from "./push-plan";
import {
  alreadySyncedPaths,
  applyPushSelection,
  baseAfterPush,
  collectPushCandidates,
  configDiffToInject,
  defaultPushSelection,
  filterByFilesArg,
  isPushedDeletion,
  patternsToPersist,
  planConfigPropagation,
  planPushCandidates,
  planPushDelivery,
  planUntrackedTracking,
  pushSummaryRows,
  pushedDeletions,
  pushedFiles,
  resolvePrBaseBranch,
  selectedUnresolvedConflicts,
  templateContentOf,
  withAutoUpdatedFile,
  withheldFromDefaultSelection,
  zikuConfigWriteBack,
} from "./push-plan";

/** テンプレートのリポジトリルートにある README。マーカー間が同期対象一覧の反映先になる。 */
const TEMPLATE_README = repoRelPath("README.md");

export const pushLifecycle: CommandLifecycle = {
  name: "push",
  description: "Push local changes to template (GitHub: PR / local: direct copy)",
  audience: "Template user",
  ops: [
    { file: ZIKU_CONFIG_FILE, location: "local", op: "read", note: "patterns を取得" },
    {
      file: ZIKU_CONFIG_FILE,
      location: "local",
      op: "update",
      note: "選択した未追跡ファイルを include に追記（push 成功後）",
    },
    { file: LOCK_FILE, location: "local", op: "read", note: "source と同期ベースを取得" },
    { file: SYNCED_FILES, location: "local", op: "read", note: "ローカルの変更を検出" },
    {
      file: SYNCED_FILES,
      location: "template",
      op: "read",
      note: "テンプレートと差分検出・3-way マージ",
    },
    {
      file: SYNCED_FILES,
      location: "template",
      op: "update",
      note: "GitHub: PR を作成 / ローカル: ファイルを直接コピー",
    },
    {
      file: ZIKU_CONFIG_FILE,
      location: "template",
      op: "update",
      note: "ローカルで追加したパターンをテンプレの ziku.jsonc へ加法 union マージで伝播",
    },
    {
      file: TEMPLATE_README,
      location: "template",
      op: "update",
      note: "マーカーがあれば同期対象一覧を反映した内容を PR に同梱（GitHub への push のみ）",
    },
    { file: LOCK_FILE, location: "local", op: "update", note: "同期ベースを更新" },
  ],
  notes: [
    "`ziku.jsonc` 自体が追跡ファイルとして同期対象に含まれる。`ziku track` で追加したローカルパターンは、push 時にテンプレートの `ziku.jsonc` へ加法 union マージで伝播する（pull と双方向）。パターンの削除は自動伝播しない。",
  ],
};

// ─── push 中の失敗の分類 ───

/**
 * push 中に飛んだ例外を、ユーザーが取れる行動がある失敗と、そうでない defect に振り分ける。
 *
 * ここが新たに文言へ変換するのは、ローカルへの書き込みが権限・容量で失敗した場合だけ
 * （{@link localWriteFailure}）。ユーザーは権限を直すか空きを作れば同じコマンドを通せる。
 *
 * GitHub API の失敗（401 / 403 / 404 / 429 / 接続断）は、API を呼ぶ側（`src/utils/github.ts`）が
 * 既に `ZikuFailure` へ分類して投げる。ここは `instanceof` でそのまま通すだけにする。同じ規則を
 * 写して分類し直すと、案内の文面と「行動を書けるか」の線引きが 2 箇所に散り、片方だけが動く。
 *
 * これ以外は defect のまま運び、トップレベルが原因とスタックトレースごと見せる。プロンプトの
 * 中断・想定外のレスポンス形・GitHub の 5xx がここに入る。文言に潰すと、ziku の不具合が
 * 「ユーザー側の問題」として案内され、原因を追う材料も消える。
 */
function pushFailure(cause: unknown): Effect.Effect<never, ZikuFailure> {
  if (cause instanceof ZikuFailure) return Effect.fail(cause);
  return localWriteFailure(cause);
}

/**
 * ユーザーが直せる書き込み失敗の errno。
 *
 * 権限 (`EACCES` / `EPERM` / `EROFS`) と空き容量 (`ENOSPC` / `EDQUOT`) だけを挙げる。どちらも
 * 書き込み先を直せば同じコマンドが通る。それ以外の errno は書き込み先ではなく ziku の組み立て方
 * （存在しない親ディレクトリ・ディレクトリへの上書き等）を疑う話なので分類しない。
 */
const FIXABLE_WRITE_ERROR_CODES: ReadonlySet<string> = new Set([
  "EACCES",
  "EDQUOT",
  "ENOSPC",
  "EPERM",
  "EROFS",
]);

/**
 * ローカルへの書き込み失敗のうち、ユーザーが直せるものを失敗として返す。
 *
 * 対象のパスが分からなければ分類しない。権限も空き容量も「どこを直すか」が言えて初めて
 * 行動になるため、パスを落とした案内は defect と同じだけ役に立たない。
 */
function localWriteFailure(cause: unknown): Effect.Effect<never, ZikuFailure> {
  const code = errnoStringOf(cause, "code");
  const path = errnoStringOf(cause, "path");
  if (code === undefined || path === undefined || !FIXABLE_WRITE_ERROR_CODES.has(code)) {
    return Effect.die(cause);
  }

  return Effect.fail(
    zikuFailure(
      {
        kind: "FileWriteFailed",
        path,
        directory: dirname(path),
        detail: cause instanceof Error ? cause.message : String(cause),
      },
      { cause },
    ),
  );
}

/** Node の fs エラーに載る文字列プロパティ（`code` / `path`）。持たない例外では undefined。 */
function errnoStringOf(cause: unknown, key: "code" | "path"): string | undefined {
  if (typeof cause !== "object" || cause === null) return undefined;
  const descriptor = Object.getOwnPropertyDescriptor(cause, key);
  return typeof descriptor?.value === "string" ? descriptor.value : undefined;
}

/**
 * PR の宛先ブランチを決め、ブランチへ向けられないソースは失敗として返す。
 *
 * 宛先はテンプレートの取得に使った参照から導く（{@link resolvePrBaseBranch}）。GitHub への
 * 既定ブランチの問い合わせはテンプレートの取得先を決めるときに済んでおり、その結果が
 * `pinned.ref` に入っているので、push は引き直さない。引き直すと 1 回の実行で同じ問い合わせが
 * 二度走り、控えへ倒れるかが問い合わせごとに変わりうる。
 *
 * 失敗になるのはタグ・コミットへ固定されたテンプレートだけで、ユーザーは lock の `source.ref`
 * を直すことになる。既定ブランチが分からない実行はテンプレートの取得自体が失敗するので、
 * ここまで到達しない。
 */
function prBaseBranch(pinned: PinnedGitHubSource): Effect.Effect<string, ZikuFailure> {
  return match(resolvePrBaseBranch(pinned))
    .with({ _tag: "Branch" }, ({ name }) => Effect.succeed(name))
    .with({ _tag: "UnsupportedRef" }, ({ kind }) =>
      Effect.fail(zikuFailure({ kind: "TemplateRefNotBranch", refKind: kind })),
    )
    .exhaustive();
}

/**
 * GitHub へ push: PR を作成する。
 *
 * トークン取得 → タイトル/本文 → サマリー表示 → 確認 → PR 作成
 *
 * @returns PR を作成したら true、確認でキャンセルされたら false。
 *   呼び出し側はこの結果で「追跡の永続化を行うか」を判断する（push 成功後のみ永続化する）。
 */
function pushToGitHub(
  ghSource: PinnedGitHubSource,
  target: PushSend,
  ctx: CommandContextShape,
  args: { message?: string; edit?: boolean; yes?: boolean },
): Effect.Effect<boolean, ZikuFailure> {
  return Effect.gen(function* () {
    // 宛先ブランチはトークンの入力や README 更新より先に決める。宛先が定まらないまま
    // 対話とローカルの書き換えを進めると、必ず中断する作業をユーザーにさせることになる。
    const baseBranch = yield* prBaseBranch(ghSource);

    // トークンの入力を促してよいのは対話実行のときだけ。プロンプトを省くフラグの下で
    // 入力を待つと、対話端末を持たない実行がそこで止まる。取れないなら失敗として返し、
    // 環境変数で渡す方法を案内する。
    const presetToken = getGitHubToken();
    if (!presetToken && args.yes) {
      return yield* zikuFailure({ kind: "GitHubTokenMissing", operation: "create a pull request" });
    }

    // 本体の失敗は `pushFailure` が振り分ける。分類できるものだけ文言にし、残りは defect の
    // まま運ぶ。catch で分類しないのは、defect へ戻す判断まで一箇所に置くため。
    return yield* Effect.tryPromise({
      catch: (cause) => cause,
      try: async () => {
        const token = presetToken || (await inputGitHubToken());

        // README の自動更新も送信対象そのものへ載せる。サマリも PR も同じ集合から作られる。
        // タイトルと本文はこの後で導く。送信対象へ足したファイルは PR に載るので、足す前の
        // 集合から文面を作ると PR の中身と本文のファイル一覧が食い違う。
        const sent = await withTemplateReadme(target, ctx.templateDir);

        const suggestedTitle = generatePrTitle(sent);
        const suggestedBody = generatePrBody(sent);

        const { title, body } = await match(args)
          .with({ message: P.string }, ({ message }) => ({
            title: message,
            body: suggestedBody,
          }))
          .with({ edit: true }, async () => ({
            title: await inputPrTitle(suggestedTitle),
            // 空入力は「本文を編集しない」の意味に採り、送る集合から導いた提案値を使う。
            // 空のまま送ると、何を送った PR なのかが本文から読めなくなる。
            body: (await inputPrBody(suggestedBody)) ?? suggestedBody,
          }))
          .otherwise(() => ({ title: suggestedTitle, body: suggestedBody }));

        // サマリー表示
        const baseSha = baseCommitSha(ctx.lock);
        const baseHashStr = baseSha ? `  ${pc.dim(`since ${baseSha.slice(0, 7)}`)}` : "";
        logPushSummary(
          `${ghSource.owner}/${ghSource.repo}`,
          `→ ${baseBranch}`,
          baseHashStr,
          title,
          sent,
        );

        if (!args.yes) {
          const confirmed = await confirmAction("Create PR?", { initialValue: true });
          if (!confirmed) {
            log.info("Cancelled.");
            return false;
          }
        }

        log.step("Creating pull request...");
        const result = await withSpinner("Creating PR on GitHub...", () =>
          createPullRequest(token, {
            owner: ghSource.owner,
            repo: ghSource.repo,
            files: pushedFiles(sent.payload),
            deletions: pushedDeletions(sent.payload),
            title,
            body,
            baseBranch,
          }),
        );

        log.success("Pull request created!");
        log.message(
          [
            `${pc.dim("To")} ${pc.bold(`${ghSource.owner}/${ghSource.repo}`)}`,
            `  ${baseSha ? `${pc.dim(baseSha.slice(0, 7))}..` : ""}${pc.green(result.branch)}  ${pc.dim(`(${changedCount(sent.payload)} file${changedCount(sent.payload) === 1 ? "" : "s"} changed)`)}`,
            "",
            `  ${pc.bold(`PR #${result.number}`)}  ${pc.cyan(result.url)}`,
          ].join("\n"),
        );
        outro(`Review and merge at ${pc.cyan(result.url)}`);
        return true;
      },
    }).pipe(Effect.catchAll(pushFailure));
  });
}

/** ローカルテンプレートへの書き込みと lock 更新に要るもの。 */
interface PushToLocalInput {
  readonly localSource: LocalSource;
  readonly target: PushSend;
  readonly ctx: CommandContextShape;
  readonly projectDir: AbsPath;
  readonly args: { yes?: boolean };
  /**
   * テンプレート走査に使うパターン。新規追跡ファイルを含む effectivePatterns を渡すことで、
   * 追跡したファイルもベースに乗り、lock と配置のズレを防ぐ。
   */
  readonly scope: SyncScope;
  /**
   * push される ziku.jsonc の内容をローカルへも残すか（`zikuConfigWriteBack` の判定結果）。
   * ローカルへの書き戻しと同期ベースの前進範囲は、どちらもこの値から決まる。
   */
  readonly configWriteBack: ZikuConfigWriteBack;
  /** push 前からローカルとテンプレートが一致していたパス（`baseAfterPush` が使う）。 */
  readonly alreadySynced: ReadonlySet<RepoRelPath>;
}

/**
 * ローカルテンプレートへ push: ファイルを直接コピーする。
 *
 * PR の代わりにテンプレートディレクトリにファイルを書き込み、lock.json のベースを更新する。
 * ベースを前進させてよい範囲は `baseAfterPush` が決める。
 *
 * @returns push したら true、確認でキャンセルされたら false。
 */
function pushToLocal(input: PushToLocalInput): Effect.Effect<boolean, ZikuFailure> {
  const { localSource, target, ctx, projectDir, args } = input;
  // 失敗の振り分けは `pushToGitHub` と同じ `pushFailure` に委ねる。ファイルコピーと lock の
  // 更新は、書き込み先の権限か空き容量で失敗したときだけユーザーが直せる。
  return Effect.tryPromise({
    catch: (cause) => cause,
    try: async () => {
      logPushSummary(
        localSource.path,
        "(local)",
        "",
        `push ${changedCount(target.payload)} file(s)`,
        target,
      );

      if (!args.yes) {
        const confirmed = await confirmAction("Push to local template?", { initialValue: true });
        if (!confirmed) {
          log.info("Cancelled.");
          return false;
        }
      }

      log.step("Pushing to local template...");

      const files = pushedFiles(target.payload);
      for (const file of files) {
        const destPath = joinAbs(localSource.path, file.path);
        const destDir = dirname(destPath);
        if (!existsSync(destDir)) {
          await mkdir(destDir, { recursive: true });
        }
        // 内容はバイト列へ戻してから書く。バイナリは latin1 の文字列として運ばれており、
        // utf-8 として書くと 1 文字が 2 バイトへ膨らんで別のファイルになる。
        await writeFile(destPath, transportTextToBytes(file.content));
        log.message(`  ${pc.green("+")} ${file.path}`);
      }

      // 削除対象ファイルを処理
      for (const file of pushedDeletions(target.payload)) {
        const destPath = joinAbs(localSource.path, file.path);
        if (existsSync(destPath)) {
          await rm(destPath, { force: true });
          log.message(`  ${pc.red("-")} ${file.path}`);
        }
      }

      const writtenBackToLocal = await writeBackZikuConfig({
        files,
        projectDir,
        writeBack: input.configWriteBack,
      });

      // ベースは push 後のテンプレートを走査して組み立てる。走査結果をそのまま採用せず、
      // 送ったパスと元から一致していたパスだけを前進させる（`baseAfterPush`）。ziku が
      // 組み立てた内容はローカルへ書いたものだけが前進の対象になるので、実際に書いた
      // パスの集合をそのまま渡す。
      const templateHashes = await hashFiles(localSource.path, input.scope);
      await saveLock(
        projectDir,
        markSynced(ctx.lock, {
          hashes: baseAfterPush({
            templateHashes,
            previousBase: baseHashesOf(ctx.lock),
            pushed: target.payload,
            alreadySynced: input.alreadySynced,
            writtenBackToLocal,
          }),
        }),
      );

      log.success(`Pushed ${changedCount(target.payload)} file(s) to ${pc.cyan(localSource.path)}`);
      outro("Push complete");
      return true;
    },
  }).pipe(Effect.catchAll(pushFailure));
}

/**
 * 送った `ziku.jsonc` をローカルにも残し、残したパスを返す。
 *
 * 送る内容はローカルの生の内容ではなく union 結果になる。書き戻さないままベースを
 * テンプレート側へ進めると、次の分類がローカルを `localOnly` と読み、次の push が
 * テンプレート側の追加分を上書きで落とす。書き戻して local == template == base を保つか、
 * 書き戻さずにベースも据え置くかのどちらかにする。
 *
 * スコープ限定 union を書き戻さない理由は {@link ZikuConfigWriteBack} を参照。戻り値を
 * `baseAfterPush` の `writtenBackToLocal` へ渡すことで、書き戻しとベース前進を同じ事実から
 * 導く。
 */
function writeBackZikuConfig(params: {
  readonly files: readonly PushFile[];
  readonly projectDir: AbsPath;
  readonly writeBack: ZikuConfigWriteBack;
}): Promise<ReadonlySet<RepoRelPath>> {
  const config = params.files.find((f) => isZikuConfigPath(f.path));
  if (config === undefined) return Promise.resolve(new Set<RepoRelPath>());

  return match(params.writeBack)
    .with({ _tag: "WriteBack" }, async () => {
      const localConfigPath = joinAbs(params.projectDir, ZIKU_CONFIG_FILE);
      await mkdir(dirname(localConfigPath), { recursive: true });
      await writeFile(localConfigPath, config.content, "utf-8");
      return new Set<RepoRelPath>([config.path]);
    })
    .with({ _tag: "Withhold" }, () => Promise.resolve(new Set<RepoRelPath>()))
    .exhaustive();
}

// ─── サマリー表示 ───

/**
 * 送る内容が 1 件も残らなかったときの案内。
 *
 * dry-run のプレビューと実 push が同じ文言を出す。判定も同じ（`planPushDelivery`）なので、
 * 片方だけが「送れる」と言う状態にならない。
 */
const NOTHING_TO_PUSH = "Nothing to push — the selected file(s) already match the template.";

/** サマリでパスの後ろの情報を揃える桁位置。 */
const PATH_COLUMN_WIDTH = 50;

/** 送るものの件数。内容と削除はどちらも 1 ファイルの変更として数える。 */
function changedCount(payload: PushPayload): number {
  return payload.entries.size;
}

function logPushSummary(
  destination: string,
  branchInfo: string,
  baseHashStr: string,
  title: string,
  send: PushSend,
): void {
  const fileLines = pushSummaryRows(send).map((row) =>
    match(row)
      .with({ _tag: "Change" }, ({ diff, restoresTemplateDeletion }) => {
        const icon = match(diff.type)
          .with("added", () => pc.green("+"))
          .with("modified", () => pc.yellow("~"))
          .with("deleted", () => pc.red("-"))
          .exhaustive();
        // テンプレートが削除したファイルの push は、新規追加ではなく「削除の取り消し」。
        // 同じ `+` 行では区別できないので注記する。
        const note = restoresTemplateDeletion
          ? ` ${pc.yellow("(restores file deleted in template)")}`
          : "";
        return `  ${icon} ${padToWidth(diff.path, PATH_COLUMN_WIDTH)} ${formatStats(calculateDiffStats(diff))}${note}`;
      })
      .with(
        { _tag: "AutoUpdated" },
        ({ path }) =>
          `  ${pc.green("+")} ${padToWidth(path, PATH_COLUMN_WIDTH)} ${pc.dim("(auto-updated)")}`,
      )
      .exhaustive(),
  );

  log.message(
    [
      `${pc.dim("To")} ${pc.bold(destination)}  ${pc.dim(branchInfo)}${baseHashStr}`,
      pc.dim("─".repeat(62)),
      ...fileLines,
      pc.dim("─".repeat(62)),
      `  ${pc.dim("Push:")} ${title}`,
    ].join("\n"),
  );
}

// ─── メインコマンド ───

/**
 * push が受け付けなくなったフラグを検出して中断する。
 *
 * `-f` / `--force` は確認プロンプトの省略を指していた。フラグの意味を「`--force` =
 * 破壊的操作の承認 / `--yes` = 対話の省略」に揃えた結果、push には承認すべき破壊的操作が
 * 無く、`--force` の居場所も無くなった。
 *
 * citty は未知のフラグを黙って無視する。無視させると「確認を飛ばしたつもりが飛んでおらず、
 * 非対話実行が入力待ちで止まる」ため、実行前に何を使えばよいかを案内して終了する。
 * 判定は `args` ではなく `rawArgs` を見る。定義していないフラグは `args` に現れないうえ、
 * 案内のためだけに `--force` を定義すると `--help` に受け付けないフラグが並ぶことになる。
 */
function rejectRemovedFlags(rawArgs: readonly string[]): void {
  const removed = rawArgs.find(
    (arg) => arg === "-f" || arg === "--force" || arg.startsWith("--force="),
  );
  if (removed === undefined) return;

  throw zikuFailure({
    kind: "InvalidArgument",
    argument: "flag",
    value: removed,
    expected:
      "`--yes` (`-y`) to skip confirmation prompts. `ziku push` no longer accepts `-f` / `--force` — `--force` means approving destructive operations, and push has none.",
  });
}

/** CLI 引数のうち、push の進め方を決めるものだけを取り出した形。 */
interface PushArgs {
  readonly dryRun: boolean;
  readonly message: string | undefined;
  readonly yes: boolean;
  readonly edit: boolean;
  readonly files: string | undefined;
  readonly includeDeletions: boolean;
}

export const pushCommand = defineCommand({
  meta: {
    name: "push",
    description: "Push local changes to the template (PR for GitHub, direct copy for local)",
  },
  args: {
    dir: {
      type: "positional",
      description: "Project directory",
      default: ".",
    },
    dryRun: {
      type: "boolean",
      alias: "n",
      description: "Preview only, don't push",
      default: false,
    },
    message: {
      type: "string",
      alias: "m",
      description: "PR title (GitHub only)",
    },
    yes: {
      type: "boolean",
      alias: "y",
      description:
        "Skip prompts (untracked files are reported and left out instead of being selected for tracking)",
      default: false,
    },
    edit: {
      type: "boolean",
      description: "Edit PR title and description before creating (GitHub only)",
      default: false,
    },
    files: {
      type: "string",
      description: "Comma-separated file paths to include (skips file selection prompt)",
    },
    includeDeletions: {
      type: "boolean",
      description: "Include locally deleted files (default: unselected in interactive mode)",
      default: false,
    },
  },
  async run({ args, rawArgs }) {
    rejectRemovedFlags(rawArgs);

    intro("push");

    const targetDir = absPath(args.dir);

    // 控え直した既定ブランチをディスクへ残すかは、この 1 箇所で宣言する。PR を作る経路は
    // lock を書き出さないので、ここで書かなければ控えは残らない。`--dry-run` は何も書かない
    // 実行なので、控えも残さない。
    const ctx = await runCommandEffect(
      loadCommandContext(targetDir, args.dryRun ? "readOnly" : "persist").pipe(
        Effect.mapError(toZikuFailure),
      ),
    );
    const { config, lock, cleanup } = ctx;

    // 解決待ちのマージが残っている間は push できない。取る行動は pull を再開して衝突を
    // 解くことなので、pull が同じ状態で出すのと同じ理由で報告する。
    if (lock.sync === "merging") {
      await cleanup();
      throw zikuFailure({
        kind: "MergePaused",
        conflicts: lock.merge.conflicts.map((c) => c.path),
      });
    }

    // ガードは生の config.include で判定する（走査範囲は ziku.jsonc を常に含むため
    // 0 にならない）。
    if (config.include.length === 0) {
      log.warn("No patterns configured");
      await cleanup();
      return;
    }

    // 走査範囲は全コマンドで同じ規則から決める。pull と範囲がずれると、pull が同期して
    // いるファイルを push が未追跡として報告したり、status が勧めた push を実行できなく
    // なったりする。
    const { scope } = await resolveSyncScope({
      targetDir,
      templateDir: ctx.templateDir,
      include: config.include,
      exclude: config.exclude ?? [],
    });

    const pushArgs: PushArgs = {
      dryRun: args.dryRun,
      message: args.message as string | undefined,
      yes: args.yes,
      edit: args.edit,
      files: args.files as string | undefined,
      includeDeletions: args.includeDeletions,
    };

    // 本体を Effect.promise で包む理由: 本体は Promise を返す I/O を並べるので、失敗は型に
    // 現れず throw で抜ける。Effect.tryPromise の catch で拾うとエラーチャネルが unknown に
    // 潰れるので、defect として運び runCommandEffect が投げられた値をそのまま再スローする。
    await runCommandEffect(
      withCleanup(
        Effect.promise(() => pushProject({ ctx, targetDir, scope, args: pushArgs })),
        cleanup,
      ),
    );
  },
});

/**
 * 差分の検出から送信・追跡の永続化までを進める。
 *
 * 送信対象の判断は `push-plan.ts` の計算に委ね、ここは I/O とユーザーへの問い合わせ、
 * および両者の受け渡しだけを行う。
 */
async function pushProject(params: {
  ctx: CommandContextShape;
  targetDir: AbsPath;
  scope: SyncScope;
  args: PushArgs;
}): Promise<void> {
  const { ctx, targetDir, args } = params;

  // 未追跡ファイルの検知・選択は分類より「前」に行う。分類が送信候補を確定するため、
  // ここで範囲を広げておかないと新規追跡ファイルが候補に乗らない。
  // 永続化（saveZikuConfig）は push 成功後に行う。
  const { effectiveScope, newlyTrackedPaths } = await resolveUntrackedTracking(
    targetDir,
    params.scope,
    args,
  );

  // 分類 + auto-merge。未解決の衝突は控えておき、送信対象に含めようとした時だけ中断する。
  const { candidatePlan, mergedContents, unresolvedConflicts, alreadySynced } =
    await analyzePushTargets({
      targetDir,
      templateDir: ctx.templateDir,
      lock: ctx.lock,
      scope: effectiveScope,
    });

  log.step("Detecting changes...");

  const diff = await withSpinner("Analyzing differences...", () =>
    detectDiff({ targetDir, templateDir: ctx.templateDir, scope: effectiveScope }),
  );

  const candidates = collectPushCandidates(diff.files, candidatePlan.pushablePaths);

  // 既定選択が外す候補。選択を経ずに送信対象を増やす経路（`ziku.jsonc` の自動同梱）が
  // 同じ歯止めを共有するために持ち回る。
  const withheldFromDefault = withheldFromDefaultSelection(candidates, {
    includeDeletions: args.includeDeletions,
    conflictedPaths: unresolvedConflicts,
    restoresTemplateDeletion: candidatePlan.restoresTemplateDeletion,
  });

  // 未解決の衝突は既定では push しない。巻き添えで他ファイルを止めず、明示的に
  // 選択された場合だけ後段で中断する。ここでは存在を知らせて pull での解決を促す。
  if (unresolvedConflicts.size > 0) {
    log.warn(
      `${unresolvedConflicts.size} file(s) have unresolved conflicts (excluded by default):`,
    );
    for (const file of unresolvedConflicts) log.message(`  ${pc.yellow("!")} ${file}`);
    log.info("Run `ziku pull` to resolve them, then push. Selecting them here will stop the push.");
  }

  if (candidates.length === 0) {
    log.info("No changes to push");
    log.step("Current status:");
    logDiffSummary(diff.files);
    return;
  }

  if (args.dryRun) {
    await previewPush({
      targetDir,
      templateDir: ctx.templateDir,
      source: ctx.source,
      candidates,
      mergedContents,
      newlyTrackedPaths,
      diffFiles: diff.files,
      unresolvedConflicts,
      restoresTemplateDeletion: candidatePlan.restoresTemplateDeletion,
      withheldFromDefault,
      args,
    });
    return;
  }

  const selected = await selectFilesToPush(candidates, {
    filesArg: args.files,
    includeDeletions: args.includeDeletions,
    conflictedPaths: unresolvedConflicts,
    restoresTemplateDeletion: candidatePlan.restoresTemplateDeletion,
    yes: args.yes,
  });
  if (selected.length === 0) return;

  // 未解決の衝突を含めて push しようとした場合は確定的に中断する（解決してから push）。
  const blocking = selectedUnresolvedConflicts(selected, unresolvedConflicts);
  if (blocking.length > 0) {
    throw unresolvedConflictFailure(blocking.map((f) => f.path));
  }

  // 送信対象のファイルに必要な include パターンを、同じ push でテンプレの ziku.jsonc へ届ける。
  const configResult = await propagateConfigPatterns({
    targetDir,
    templateDir: ctx.templateDir,
    newlyTrackedPaths,
    selected,
    withheldFromDefault,
    diffFiles: diff.files,
  });
  announceConfigAutoInclude(configResult.inclusion);

  // 選択したファイルが残っていても、送る内容が 1 件も無いことがある（`planPushDelivery`）。
  // dry-run のプレビューも同じ判定を通るので、プレビューに出たのに実行すると何も送られない
  // 組み合わせは作れない。
  const delivery = planPushDelivery({
    selected: configResult.selected,
    mergedContents: withPropagatedConfig(mergedContents, configResult.mergedConfig),
    restoresTemplateDeletion: candidatePlan.restoresTemplateDeletion,
  });
  const target = match(delivery)
    .with({ _tag: "Nothing" }, () => {
      log.info(NOTHING_TO_PUSH);
      return undefined;
    })
    .with({ _tag: "Send" }, ({ send }) => send)
    .exhaustive();
  if (target === undefined) return;

  // ─── 分岐: ソース種別に応じた push 戦略 (ts-pattern + Effect) ───
  //
  // 分岐は解決済みの取得先（`ctx.resolved`）で行う。lock の source で分岐すると、GitHub への
  // push が取得に使った参照を持たず、PR の宛先を決めるために既定ブランチを引き直すことになる。
  const pushed = await runCommandEffect(
    match(ctx.resolved)
      .with({ kind: "github" }, (resolved) =>
        pushToGitHub(resolved.pinned, target, ctx, {
          message: args.message,
          edit: args.edit,
          yes: args.yes,
        }),
      )
      .with({ kind: "local" }, (resolved) =>
        pushToLocal({
          localSource: resolved.source,
          target,
          ctx,
          projectDir: targetDir,
          args: { yes: args.yes },
          scope: effectiveScope,
          configWriteBack: configResult.writeBack,
          alreadySynced,
        }),
      )
      .exhaustive(),
  );

  // ─── push 成功後に追跡を永続化（部分適用の回避）───
  // ziku.jsonc の書き換えは push が実際に成功したときだけ行う。push 失敗（throw）や
  // 確認キャンセル（pushed=false）では設定を変えない。
  if (pushed && newlyTrackedPaths.length > 0) {
    const pushedPaths = new Set<RepoRelPath>(target.payload.entries.keys());
    await persistNewlyTracked(targetDir, newlyTrackedPaths, pushedPaths);
  }
}

// ─── dry-run プレビュー ───

/**
 * 実 push と同じ規則で「実際に送られる集合」を表示する。
 *
 * 選択の絞り込み（`--files` / 既定集合）も、そこから送る集合を導く計算（`planPushDelivery`）も
 * 実 push と同じ関数を通る。プレビューだけ別の規則で組み立てると、表示された集合と実際に
 * 送られる集合が食い違う。
 *
 * 対話選択と、ziku が付け足すファイル（`ziku.jsonc` の自動同梱・README の自動更新）は
 * プレビューでは行わず、実 push で何が起きるかを注意書きで補う（プレビューの集合は
 * 「今の指定で送られるもの」に保つ）。
 */
async function previewPush(params: {
  targetDir: AbsPath;
  templateDir: AbsPath;
  /** 送信先。ziku が付け足すファイルは送信先によって変わるので、予告も送信先で分ける。 */
  source: TemplateSource;
  candidates: readonly ChangedFileDiff[];
  /** 自動マージの結果と `ziku.jsonc` の和集合。実際に送る内容はここが優先される。 */
  mergedContents: ReadonlyMap<RepoRelPath, PushContent>;
  /** 今回の push で追跡すると決めたパス。`ziku.jsonc` の同梱判断に効く。 */
  newlyTrackedPaths: readonly RepoRelPath[];
  /** 検出した差分。テンプレート側の `ziku.jsonc` の内容を取る材料になる。 */
  diffFiles: readonly FileDiff[];
  unresolvedConflicts: ReadonlySet<RepoRelPath>;
  restoresTemplateDeletion: ReadonlySet<RepoRelPath>;
  /** 既定選択が意図的に外した候補のパス。自動同梱の予告も実 push と同じ歯止めを通す。 */
  withheldFromDefault: ReadonlySet<RepoRelPath>;
  args: PushArgs;
}): Promise<void> {
  const { candidates, unresolvedConflicts, restoresTemplateDeletion, args } = params;
  log.info("Dry run mode");

  let previewFiles: readonly ChangedFileDiff[];
  if (args.files) {
    const { filtered, notFound } = filterByFilesArg(candidates, args.files);
    if (notFound.length > 0) log.warn(`Files not found: ${notFound.join(", ")}`);
    previewFiles = filtered;
  } else {
    previewFiles = defaultPushSelection(candidates, {
      includeDeletions: args.includeDeletions,
      conflictedPaths: unresolvedConflicts,
      restoresTemplateDeletion,
    });
  }

  log.step("Files that would be pushed:");
  if (previewFiles.length === 0) {
    log.info("No files match the current selection — nothing would be pushed.");
  } else {
    logPreviewedDelivery(
      planPushDelivery({
        selected: previewFiles,
        mergedContents: params.mergedContents,
        restoresTemplateDeletion,
      }),
    );
  }

  // 予告は実 push と同じ関数の結論から出す。ここで条件を書き写すと、その関数の後段
  // （テンプレートに `ziku.jsonc` があるか）を再現できないまま予告だけが出る。
  const propagation = await propagateConfigPatterns({
    targetDir: params.targetDir,
    templateDir: params.templateDir,
    newlyTrackedPaths: params.newlyTrackedPaths,
    selected: previewFiles,
    withheldFromDefault: params.withheldFromDefault,
    diffFiles: params.diffFiles,
  });
  warnIfConfigWouldBeAutoIncluded(propagation.inclusion);

  // README の自動更新が走るのは GitHub への push だけ（`pushToGitHub`）。ローカルテンプレート
  // への push では触らないので、予告すると起きない更新を予告することになる。
  await match(params.source)
    .with({ kind: "github" }, async () => {
      // 予告の材料は、実 push が README を組み直すときと同じ「送る集合」。表示する一覧
      // （`previewFiles`）は自動同梱を含めない方針なので、README の判断だけは実 push と
      // 同じ入力に揃える。ディスク上の README / `ziku.jsonc` から予告すると、同じ push が
      // 運ぶ `ziku.jsonc` の変更を反映しない予告になる。
      const send = planPushDelivery({
        selected: propagation.selected,
        mergedContents: withPropagatedConfig(params.mergedContents, propagation.mergedConfig),
        restoresTemplateDeletion,
      });
      warnIfReadmeWouldBeRebuilt(
        await match(send)
          .with({ _tag: "Nothing" }, () =>
            Promise.resolve<TemplateReadmeRebuild>({ _tag: "NotRebuilt" }),
          )
          .with({ _tag: "Send" }, ({ send: target }) =>
            planTemplateReadmeRebuild(target, params.templateDir),
          )
          .exhaustive(),
      );
    })
    .with({ kind: "local" }, () => Promise.resolve())
    .exhaustive();

  // 未解決の衝突を --files で明示選択した場合、実 push は中断する。予告して挙動を一致させる。
  const selectedConflicts = selectedUnresolvedConflicts(previewFiles, unresolvedConflicts);
  if (selectedConflicts.length > 0) {
    log.warn(
      `${selectedConflicts.length} selected file(s) have unresolved conflicts and would block the push:`,
    );
    for (const f of selectedConflicts) log.message(`  ${pc.yellow("!")} ${f.path}`);
  }
}

/**
 * プレビューに、実 push が送る集合をそのまま出す。
 *
 * 表示する差分は選択そのものではなく、送る内容で組み直したもの（`pushSummaryRows`）。
 * 自動マージの結果がテンプレートと同一になったファイルは実 push が落とすので、プレビューにも
 * 出さない。1 件も残らない場合は実 push と同じ文言で伝える。
 */
function logPreviewedDelivery(delivery: PushDelivery): void {
  match(delivery)
    .with({ _tag: "Nothing" }, () => {
      log.info(NOTHING_TO_PUSH);
    })
    .with({ _tag: "Send" }, ({ send }) => {
      const shown = pushSummaryRows(send).flatMap((row) =>
        match(row)
          .with({ _tag: "Change" }, ({ diff }) => [diff])
          .with({ _tag: "AutoUpdated" }, () => [])
          .exhaustive(),
      );
      logDiffSummary(shown);
    })
    .exhaustive();
}

/**
 * dry-run プレビューで、実 push なら自動同梱される `ziku.jsonc` をあらかじめ知らせる。
 * プレビュー自体への注入は行わない（dry-run は「実際に push される集合」を見せる方針を保つ）。
 */
function warnIfConfigWouldBeAutoIncluded(inclusion: ZikuConfigInclusion): void {
  match(inclusion)
    .with({ _tag: "Injected" }, ({ patterns }) => {
      if (patterns.length === 0) return;
      log.warn(
        `${ZIKU_CONFIG_FILE} would also be pushed — it registers ${patterns.length} pattern(s) needed by the file(s) above:`,
      );
      for (const p of patterns) log.message(`  ${pc.dim("+")} ${p}`);
    })
    .with({ _tag: "NotInjected" }, () => undefined)
    .exhaustive();
}

// ─── 未追跡ファイルの追跡 ───

/**
 * 未追跡ファイルを検知し、追跡対象を決定する。
 *
 * 対話時はユーザーに追跡対象（include 追加）を選択させ、選択分を足した走査範囲を返す。
 * 対話を省く実行では暗黙追加せず、除外されるファイルを通知する（進め方の判断は
 * `planUntrackedTracking`）。
 *
 * @returns effectiveScope（追跡選択を反映した走査範囲。以降の hash/classify/diff に使う）と
 *   newlyTrackedPaths（push 成功後に永続化する候補パス。対話を省いた場合は空）。
 */
async function resolveUntrackedTracking(
  targetDir: AbsPath,
  scope: SyncScope,
  args: { yes: boolean; dryRun: boolean },
): Promise<{
  effectiveScope: SyncScope;
  newlyTrackedPaths: RepoRelPath[];
}> {
  const untrackedByFolder = await detectUntrackedFiles({ targetDir, scope });
  const untrackedCount = getTotalUntrackedCount(untrackedByFolder);

  const plan = planUntrackedTracking({ untrackedCount, yes: args.yes, dryRun: args.dryRun });

  const selected = await match(plan)
    .with({ _tag: "NoUntracked" }, () => Promise.resolve<RepoRelPath[]>([]))
    .with({ _tag: "SkipTracking" }, ({ reason }) => {
      const headline = match(reason)
        // dry-run は「除外」ではなく判断のスキップなので、恒久的に弾かれたと誤読されない
        // 文面にする。
        .with(
          "dryRun",
          () =>
            `${untrackedCount} untracked file(s) outside the sync whitelist (dry-run: tracking skipped):`,
        )
        .with(
          "yes",
          () =>
            `${untrackedCount} untracked file(s) left out of this push — --yes skips the tracking prompt, so they stay outside the sync whitelist:`,
        )
        .exhaustive();
      logUntrackedFilesNotice(untrackedByFolder, untrackedCount, { headline });
      return Promise.resolve<RepoRelPath[]>([]);
    })
    .with({ _tag: "AskUser" }, () => selectUntrackedToTrack(untrackedByFolder))
    .exhaustive();

  // 選んだファイルは、そのパス 1 本だけに一致する include として範囲へ加える。分類は
  // 送信候補を確定させるので、ここで加えないと追跡したファイルが候補に乗らない。
  return {
    effectiveScope: extendScope(
      scope,
      selected.map((path) => pathAsPattern(path)),
    ),
    newlyTrackedPaths: selected,
  };
}

/**
 * push 成功後に、新規追跡ファイルを ziku.jsonc の include へ永続化する。
 *
 * 永続化は addIncludePattern による include キーのみの部分更新（jsonc の modify）で行う。
 * exclude やコメント等は保持されるため、push 中に外部編集が入っても include 以外は壊さない。
 */
async function persistNewlyTracked(
  targetDir: AbsPath,
  newlyTrackedPaths: readonly RepoRelPath[],
  pushedPaths: ReadonlySet<RepoRelPath>,
): Promise<void> {
  const patterns = patternsToPersist(newlyTrackedPaths, pushedPaths);
  if (patterns.length === 0) return;

  // 分類済みの失敗（不在 / 構文エラー / スキーマ違反）を FailureReason へ落としてから投げる。
  // 素の runPromise だと FiberFailure に包まれ、トップレベルが理由を判別できない。
  const { rawContent } = await runCommandEffect(
    loadZikuConfig(targetDir).pipe(Effect.mapError(toZikuFailure)),
  );
  const updated = addIncludePattern(rawContent, patterns);
  if (updated === rawContent) return;

  await saveZikuConfig(targetDir, updated);
  log.success(`Tracked ${patterns.length} new file(s) in ${ZIKU_CONFIG_FILE}`);
}

/**
 * `ziku.jsonc` を自動同梱したかどうかの決着。
 *
 * 同梱の可否は 2 段で決まる。純粋な判断（`planConfigPropagation`）と、テンプレートに足す先の
 * 文書があるかという I/O を伴う判断（`computeScopedZikuConfig`）で、後段の結論はディスクを
 * 読まないと出ない。結論をこの値に載せて返すことで、実 push の案内も dry-run の予告も
 * {@link propagateConfigPatterns} の結論からしか作れなくなる。条件を書き写した予告は、
 * 後段を再現できないまま「push される」と言い切ることになる。
 */
type ZikuConfigInclusion =
  /** 送信対象へ足した。`patterns` は足す理由になったローカル限定パターン。 */
  | { readonly _tag: "Injected"; readonly patterns: readonly GlobPattern[] }
  /** 足さなかった。 */
  | { readonly _tag: "NotInjected"; readonly reason: ZikuConfigNotInjected };

/** `ziku.jsonc` を自動同梱しなかった理由。 */
type ZikuConfigNotInjected =
  /** `ziku.jsonc` 自体が送信対象に選ばれている。自動同梱の出番が無い。 */
  | "AlreadySelected"
  /** 伝えるパターンが無い、または組み立てた内容がテンプレートと同じ。 */
  | "NoConfigChange"
  /** テンプレートに `ziku.jsonc` が無く、スコープ限定の内容を足す先の文書が無い。 */
  | "NoTemplateConfig";

/**
 * 伝播で組み立てた `ziku.jsonc` の内容を、送る内容の写像へ載せる。
 *
 * 実 push もプレビューも、送る集合はこの写像を通した値から導く。片方だけが伝播の結論を
 * 載せ忘れると、送られる `ziku.jsonc` と、そこから導く README が食い違う。
 */
function withPropagatedConfig(
  mergedContents: ReadonlyMap<RepoRelPath, PushContent>,
  mergedConfig: PushContent | undefined,
): ReadonlyMap<RepoRelPath, PushContent> {
  if (mergedConfig === undefined) return mergedContents;
  return new Map([...mergedContents, [ZIKU_CONFIG_FILE, mergedConfig]]);
}

/** {@link propagateConfigPatterns} の結論。 */
interface ConfigPropagation {
  /** 自動同梱を反映した送信対象。 */
  readonly selected: readonly ChangedFileDiff[];
  /** 送る内容をローカルの `ziku.jsonc` へも残すか。 */
  readonly writeBack: ZikuConfigWriteBack;
  /**
   * テンプレートへ送る `ziku.jsonc` の内容。呼び出し側が送信内容の写像へ載せる。
   * 自動同梱しない場合でも、選択済みの `ziku.jsonc` に送る内容があればここに入る。
   */
  readonly mergedConfig: PushContent | undefined;
  /** 自動同梱の決着。案内と予告はこの値から作る。 */
  readonly inclusion: ZikuConfigInclusion;
}

/**
 * 送信対象のファイルに必要な include パターンを、同じ push でテンプレの `ziku.jsonc` へ届ける。
 *
 * 何を載せるかは `planConfigPropagation` が決め、ここはその計画に沿って `ziku.jsonc` の内容を
 * 組み立て（I/O）、必要なら送信対象へ注入する。ログは出さない。dry-run と実 push で文面が
 * 変わるので、同じ結論から呼び出し側がそれぞれの文面を出す。
 */
async function propagateConfigPatterns(params: {
  targetDir: AbsPath;
  templateDir: AbsPath;
  newlyTrackedPaths: readonly RepoRelPath[];
  selected: readonly ChangedFileDiff[];
  /** 既定選択が意図的に外した候補のパス。自動同梱がその歯止めを越えないようにする。 */
  withheldFromDefault: ReadonlySet<RepoRelPath>;
  diffFiles: readonly FileDiff[];
}): Promise<ConfigPropagation> {
  const { targetDir, templateDir, selected } = params;
  const selectedPaths = selected.map((f) => f.path);

  // `ziku.jsonc` が選択済みなら、その内容としてローカル全体の union が送られるので、
  // ローカル限定パターンの調査は要らない（`planConfigPropagation` も参照しない）。
  const configAlreadySelected = selectedPaths.some((p) => isZikuConfigPath(p));
  const localOnlyPatterns = configAlreadySelected
    ? []
    : await findLocalOnlyPatternsForPaths({ targetDir, templateDir, paths: selectedPaths });

  const plan = planConfigPropagation({
    selectedPaths,
    newlyTrackedPaths: params.newlyTrackedPaths,
    localOnlyPatterns,
    withheldFromDefault: params.withheldFromDefault,
  });
  const writeBack = zikuConfigWriteBack(plan);
  const rendered = await renderPropagatedConfig(plan, { targetDir, templateDir });

  const notInjected = (
    reason: ZikuConfigNotInjected,
    mergedConfig?: PushContent,
  ): ConfigPropagation => ({
    selected,
    writeBack,
    mergedConfig,
    inclusion: { _tag: "NotInjected", reason },
  });

  return match(rendered)
    .with({ _tag: "NoConfigChange" }, () => notInjected("NoConfigChange"))
    .with({ _tag: "NoTemplateConfig" }, () => notInjected("NoTemplateConfig"))
    .with({ _tag: "Rendered" }, ({ content }): ConfigPropagation => {
      const mergedConfig = asPushContent(content);
      // 選択済みなら content は送信内容の写像から採られるので注入は不要。
      if (configAlreadySelected) return notInjected("AlreadySelected", mergedConfig);

      const configDiff = params.diffFiles.find((f) => isZikuConfigPath(f.path));
      const injected = configDiffToInject({
        mergedConfig: content,
        templateConfig: configDiff === undefined ? undefined : templateContentOf(configDiff),
      });
      if (injected === undefined) return notInjected("NoConfigChange", mergedConfig);

      return {
        selected: [...selected, injected],
        writeBack,
        mergedConfig,
        inclusion: { _tag: "Injected", patterns: localOnlyPatterns },
      };
    })
    .exhaustive();
}

/** テンプレートへ送る `ziku.jsonc` の内容を組み立てた結果。 */
type PropagatedConfig =
  /** 送る内容。 */
  | { readonly _tag: "Rendered"; readonly content: string }
  /** 伝える追加パターンが無く、組み直す必要も無い。 */
  | { readonly _tag: "NoConfigChange" }
  /** テンプレートに `ziku.jsonc` が無く、スコープ限定の内容を足す先の文書が無い。 */
  | { readonly _tag: "NoTemplateConfig" };

/**
 * 伝播の計画に沿って、テンプレートへ送る `ziku.jsonc` の内容を組み立てる。
 *
 * 足す先の文書が無い場合を独立したケースにするのは、そこで作れるのが「テンプレートの内容 +
 * 今回の追加分」ではなく「今回の push に関係するパターンだけを持つ新しい文書」だから。それを
 * 送ることはテンプレート側の設定ファイル削除を縮小版で取り消すのと同じになる。設定ファイルを
 * 送るかは候補の一覧から利用者が選ぶ（選ばれた場合はローカル全体の union を送る
 * `MergeLocalConfig` を通る）。
 */
function renderPropagatedConfig(
  plan: ConfigPropagationPlan,
  dirs: { targetDir: AbsPath; templateDir: AbsPath },
): Promise<PropagatedConfig> {
  return match(plan)
    .with({ _tag: "NoConfigChange" }, () =>
      Promise.resolve<PropagatedConfig>({ _tag: "NoConfigChange" }),
    )
    .with({ _tag: "MergeLocalConfig" }, async ({ extraIncludes }) => ({
      _tag: "Rendered" as const,
      content: await computeMergedZikuConfig({ ...dirs, extraIncludes }),
    }))
    .with({ _tag: "MergeScopedConfig" }, async ({ additionalIncludes }) => {
      const scoped = await computeScopedZikuConfig({
        templateDir: dirs.templateDir,
        additionalIncludes,
      });
      return match(scoped)
        .with(
          { _tag: "Scoped" },
          ({ content }): PropagatedConfig => ({ _tag: "Rendered", content }),
        )
        .with({ _tag: "NoTemplateConfig" }, (): PropagatedConfig => ({ _tag: "NoTemplateConfig" }))
        .exhaustive();
    })
    .exhaustive();
}

/**
 * 明示指定されていない `ziku.jsonc` を同梱する理由を伝える。
 *
 * ユーザーが `--files` で挙げていないファイルが PR に出ると意図しない混入に見えるため、
 * 何のために足したか（どのパターンが今回の送信対象に必要か）を並べる。
 */
function announceConfigAutoInclude(inclusion: ZikuConfigInclusion): void {
  match(inclusion)
    .with({ _tag: "Injected" }, ({ patterns }) => {
      if (patterns.length === 0) return;
      log.info(
        `Also pushing ${ZIKU_CONFIG_FILE} — it registers ${patterns.length} pattern(s) needed by the file(s) in this push:`,
      );
      for (const p of patterns) log.message(`  ${pc.dim("+")} ${p}`);
    })
    .with({ _tag: "NotInjected" }, () => undefined)
    .exhaustive();
}

// ─── テンプレート README の自動更新 ───

/**
 * テンプレートの README のマーカー間を組み直し、送信ファイル一覧へ反映する。
 *
 * README を選択単位にしない理由: マーカー間の内容はユーザーが書いたテキストではなく、
 * `ziku.jsonc` の include から機械的に導出される派生物で、SSOT は `ziku.jsonc` にある。
 * 追跡ファイルと同じ選択単位にすると「同期対象一覧だけ古い README」を選べることになり、
 * 選ばなかった側が正しいのか判断する材料がユーザーにも ziku にも無い。派生物は導出元に
 * 従わせ、選択ではなく確認（`Create PR?`）で降りられるようにする。そのため組み直しは
 * 選択によらず行い、送信対象に手を入れた事実を送信前に伝える
 * （{@link announceReadmeRebuild}）。
 *
 * README が追跡ファイルとして既に送信対象に入っているときは、そのエントリを **置き換える**。
 * 足すと同じパスを 2 回送ることになり、GitHub への 2 回目の書き込みが 1 回目で変わった
 * blob SHA と食い違って弾かれる。
 */
async function withTemplateReadme(send: PushSend, templateDir: AbsPath): Promise<PushSend> {
  const rebuild = await planTemplateReadmeRebuild(send, templateDir);

  return match(rebuild)
    .with({ _tag: "NotRebuilt" }, () => send)
    .with({ _tag: "Rebuilt" }, ({ file, base }) => {
      announceReadmeRebuild(base);
      // 置き換えと追加のどちらも `withAutoUpdatedFile` に任せる。送る集合を直に組み直すと、
      // サマリに出ないファイルが PR に載る経路ができる。
      return withAutoUpdatedFile(send, file);
    })
    .exhaustive();
}

/** 組み直す README の土台。案内と予告の文面がここで変わる。 */
type TemplateReadmeBase =
  /** 送信対象に無い README を、ziku が付け足す。 */
  | "AutoIncluded"
  /** 追跡ファイルとして送信対象に選ばれている README の、マーカー間だけを差し替える。 */
  | "Selected";

/**
 * テンプレート README の組み直しの決着。
 *
 * 送信対象そのもの（{@link PushSend}）を材料に取り、結論をこの値で返すことで、実 push の
 * 案内も dry-run の予告も同じ入力・同じ関数の結論からしか作れなくなる。予告側がディスク上の
 * README と `ziku.jsonc` を読み直す入口を残すと、`ziku track` で足したばかりのパターンを
 * 同じ push が運ぶ場合に、予告は「何も起きない」と言い、実 push は README を PR に載せる。
 */
type TemplateReadmeRebuild =
  /** 組み直した内容を送信対象へ載せる。 */
  | { readonly _tag: "Rebuilt"; readonly file: PushFile; readonly base: TemplateReadmeBase }
  /** 組み直さない（README を消す push / README が無い / マーカーが無い / 内容が変わらない）。 */
  | { readonly _tag: "NotRebuilt" };

/**
 * 送信対象から、テンプレート README を組み直した結果を出す。ディスクへは書かない。
 *
 * 生成元は同じ PR に載る内容に採る。README も `ziku.jsonc` もこの PR で書き換わるので、
 * テンプレートのディスク上の内容から作ると、この PR が追加するパターン（`ziku track` した
 * 直後など）を反映しない README を配ることになる。
 *
 * 組み直しの土台に採るのは、追跡ファイルとして送ろうとしているローカルの README。マーカー外は
 * ユーザーが書いた文章で、ziku が選り分ける立場にない。ziku が従わせてよいのはマーカー間だけ
 * なので、土台はユーザーの内容にして、その中のマーカー間だけを `ziku.jsonc` から組み直す。
 *
 * README をテンプレートから消す push では組み直さない。消すと決めたファイルの中身を作る作業に
 * 意味が無く、案内まで出すと「削除する push」を「README も更新する push」と読ませることになる。
 */
async function planTemplateReadmeRebuild(
  send: PushSend,
  templateDir: AbsPath,
): Promise<TemplateReadmeRebuild> {
  if (isPushedDeletion(send.payload, TEMPLATE_README)) return { _tag: "NotRebuilt" };

  const files = pushedFiles(send.payload);
  const tracked = files.find((f) => f.path === TEMPLATE_README);
  const config = files.find((f) => isZikuConfigPath(f.path));

  const rendered = await renderTemplateReadme({
    templateDir,
    readme: tracked?.content,
    config: config?.content,
  });
  if (rendered === null || !rendered.updated) return { _tag: "NotRebuilt" };

  return {
    _tag: "Rebuilt",
    file: {
      path: TEMPLATE_README,
      content: asPushContent(rendered.content),
      // マーカー間は `ziku.jsonc` から導出した内容で、ローカルの README には残らない。
      origin: { _tag: "Synthesized" },
    },
    base: tracked === undefined ? "AutoIncluded" : "Selected",
  };
}

/**
 * 送信対象へ手を入れた事実を、確認プロンプトの前に伝える。
 *
 * 付け足す場合: サマリには `(auto-updated)` の 1 行として並ぶが、記号だけでは「なぜ自分が
 * 選んでいないファイルが PR に出るのか」が読み取れない。導出元を名指しする（`ziku.jsonc` の
 * 自動同梱と同じ扱い）。
 *
 * 選ばれている場合: 追跡ファイルとして選んだ内容がそのまま送られると読めるので、マーカー間
 * だけを差し替えたことを知らせる。
 */
function announceReadmeRebuild(base: TemplateReadmeBase): void {
  log.info(
    match(base)
      .with(
        "AutoIncluded",
        () =>
          `Also pushing ${TEMPLATE_README} — its generated sections are rebuilt from ${ZIKU_CONFIG_FILE}.`,
      )
      .with(
        "Selected",
        () =>
          `Rebuilding the generated sections of ${TEMPLATE_README} from ${ZIKU_CONFIG_FILE} before pushing it.`,
      )
      .exhaustive(),
  );
}

/** dry-run で、実 push が同梱する README の組み直しを予告する。 */
function warnIfReadmeWouldBeRebuilt(rebuild: TemplateReadmeRebuild): void {
  match(rebuild)
    .with({ _tag: "NotRebuilt" }, () => undefined)
    .with({ _tag: "Rebuilt" }, ({ base }) => {
      log.warn(
        match(base)
          .with(
            "AutoIncluded",
            () =>
              `${TEMPLATE_README} would also be pushed — its generated sections are rebuilt from ${ZIKU_CONFIG_FILE}.`,
          )
          .with(
            "Selected",
            () =>
              `${TEMPLATE_README} would be pushed with its generated sections rebuilt from ${ZIKU_CONFIG_FILE}.`,
          )
          .exhaustive(),
      );
    })
    .exhaustive();
}

// ─── ファイル選択 ───

/**
 * 送信対象ファイルを選ぶ。
 *
 * `--files` 指定時はフィルタリング、`--yes` 指定時は既定集合、いずれも無ければ対話選択。
 * `--yes` で対話に落とすと、対話端末を持たない実行（CI）が入力待ちのまま何も送らずに
 * 終了し、成功したように見える。プロンプトを省くフラグである以上、ここも省いて
 * dry-run のプレビューと同じ集合を送る。
 *
 * 選択結果が空の場合はログを出力して空配列を返す。
 */
async function selectFilesToPush(
  candidates: readonly ChangedFileDiff[],
  opts: {
    filesArg: string | undefined;
    includeDeletions: boolean;
    conflictedPaths: Set<RepoRelPath>;
    restoresTemplateDeletion: ReadonlySet<RepoRelPath>;
    yes: boolean;
  },
): Promise<readonly ChangedFileDiff[]> {
  const selection = await chooseSelection(candidates, opts);
  const { selected, notFound } = applyPushSelection(candidates, selection);

  if (notFound.length > 0) log.warn(`Files not found: ${notFound.join(", ")}`);

  match(selection)
    .with({ _tag: "Files" }, () => {
      if (selected.length === 0) log.info("No matching files. Cancelled.");
      else log.info(`${selected.length} file(s) selected via --files`);
    })
    .with({ _tag: "Default" }, () => {
      if (selected.length === 0) log.info("No files to push.");
      else log.info(`${selected.length} file(s) selected (--yes skips the selection prompt)`);
    })
    .with({ _tag: "Chosen" }, () => {
      if (selected.length === 0) log.info("No files selected. Cancelled.");
    })
    .exhaustive();

  return selected;
}

/** 実行モードに応じて選択方法を決める。対話が要る場合だけプロンプトを出す。 */
async function chooseSelection(
  candidates: readonly ChangedFileDiff[],
  opts: {
    filesArg: string | undefined;
    includeDeletions: boolean;
    conflictedPaths: Set<RepoRelPath>;
    restoresTemplateDeletion: ReadonlySet<RepoRelPath>;
    yes: boolean;
  },
): Promise<PushFileSelection> {
  if (opts.filesArg) return { _tag: "Files", filesArg: opts.filesArg };
  if (opts.yes) {
    return {
      _tag: "Default",
      includeDeletions: opts.includeDeletions,
      conflictedPaths: opts.conflictedPaths,
      restoresTemplateDeletion: opts.restoresTemplateDeletion,
    };
  }

  log.step("Selecting files...");
  // 既定から外す集合は非対話実行（`defaultPushSelection`）と揃える。対話実行だけが
  // テンプレート側の削除の取り消しを既定で選んでしまうと、一覧を読み飛ばした利用者が
  // テンプレートの削除を黙って巻き戻す PR を出すことになる。
  const chosen = await selectPushFiles([...candidates], {
    preselectDeletions: opts.includeDeletions,
    conflictedPaths: opts.conflictedPaths,
    restoresTemplateDeletion: opts.restoresTemplateDeletion,
  });
  return { _tag: "Chosen", paths: chosen.map((f) => f.path) };
}

// ─── 分類 + コンフリクト解決 ───

/**
 * ローカル/テンプレート/ベースのハッシュを比較して送信候補を決め、衝突は auto-merge を試みる。
 *
 * 候補の決定は `planPushCandidates` が行い、ここは分類に必要な I/O と、決まった結果に
 * 対する処理（`ziku.jsonc` の union 計算・auto-merge・スキップの通知）を担う。
 *
 * 未解決の衝突があってもここでは中断しない（巻き添えで他ファイルの push を止めないため）。
 */
async function analyzePushTargets(params: {
  targetDir: AbsPath;
  templateDir: AbsPath;
  lock: LockState;
  scope: SyncScope;
}): Promise<{
  candidatePlan: PushCandidatePlan;
  mergedContents: Map<RepoRelPath, PushContent>;
  unresolvedConflicts: Set<RepoRelPath>;
  /** push 前からローカルとテンプレートが一致していたパス。ベースの前進範囲を決めるのに使う。 */
  alreadySynced: ReadonlySet<RepoRelPath>;
}> {
  const { plan, hashes } = await analyzeSync({
    targetDir: params.targetDir,
    templateDir: params.templateDir,
    baseHashes: baseHashesOf(params.lock),
    scope: params.scope,
  });

  // 設定ファイルの案内はパターン集合の実差分まで見て決める。ハッシュ差分だけを見ると、
  // テンプレートがパターンを削除しただけの状態を「pull で取り込める更新」として案内し、
  // 実行しても何も起きない操作を勧めることになる（`planPushCandidates` の drift 引数）。
  const drift = await analyzeConfigDrift(params.targetDir, params.templateDir);
  const candidatePlan = planPushCandidates(plan, drift);
  const mergedContents = new Map<RepoRelPath, PushContent>();

  // 送る場合も生のローカル内容ではなく加法 union を送る。union 内容を mergedContents に
  // 入れておくと後段のペイロード構築で採用される。
  if (candidatePlan.sendsConfigUnion) {
    const merged = await computeMergedZikuConfig({
      targetDir: params.targetDir,
      templateDir: params.templateDir,
    });
    mergedContents.set(ZIKU_CONFIG_FILE, asPushContent(merged));
  }

  if (candidatePlan.skippedTemplateOnly.length > 0) {
    log.info(
      `Skipping ${candidatePlan.skippedTemplateOnly.length} file(s) only changed in template (use \`ziku pull\` to sync):`,
    );
    for (const file of candidatePlan.skippedTemplateOnly) {
      log.message(`  ${pc.dim("↓")} ${pc.dim(file)}`);
    }
  }

  const unresolvedConflicts = new Set<RepoRelPath>();
  if (plan.files.conflicts.length > 0) {
    const unresolved = await resolveConflicts(plan.files.conflicts, {
      targetDir: params.targetDir,
      templateDir: params.templateDir,
      lock: params.lock,
      mergedContents,
    });
    for (const conflict of unresolved) unresolvedConflicts.add(conflict.path);
  }

  return {
    candidatePlan,
    mergedContents,
    unresolvedConflicts,
    alreadySynced: alreadySyncedPaths(hashes),
  };
}

// ─── コンフリクト解決 ───

/**
 * push 時のコンフリクト解決（auto-merge の試行）。
 *
 * ループとベース取得は `mergeConflictFiles` が持つ。ここが担うのは push 固有の後処理、
 * つまり「クリーンにマージできた内容だけをメモリ上の `mergedContents` に保持する」こと。
 * ローカルのファイルには触れない（pull と違い、テンプレートへ送る内容を組み立てるだけ）。
 *
 * 自動マージできなかったファイルのパス一覧を返す。ここでは中断しない。
 * 「未解決の衝突が 1 つでもあれば push 全体を止める」のではなく、未解決ファイルを
 * push 対象から外して非衝突ファイルの push は通し、未解決ファイルが実際に push 対象として
 * 選ばれた場合だけ中断する（呼び出し側の責務）。これによりローカル内容での暗黙の上書きを
 * 防ぎつつ、衝突に巻き込まれない変更まで止めてしまう問題を回避する。
 *
 * @returns auto-merge できなかった未解決ファイルの一覧。
 */
async function resolveConflicts(
  conflicts: readonly RepoRelPath[],
  ctx: {
    targetDir: AbsPath;
    templateDir: AbsPath;
    lock: LockState;
    mergedContents: Map<RepoRelPath, PushContent>;
  },
): Promise<readonly PendingConflict[]> {
  const baseSha = baseCommitSha(ctx.lock);
  const baseInfo = baseSha
    ? `since ${pc.bold(baseSha.slice(0, 7))} (your last sync)`
    : "since your last pull/init";
  log.warn(
    `Template updated ${baseInfo} — ${conflicts.length} conflict(s) detected, attempting auto-merge...`,
  );

  const autoMerged: RepoRelPath[] = [];

  const unresolved = await Effect.runPromise(
    mergeConflictFiles({
      conflicts,
      targetDir: ctx.targetDir,
      templateDir: ctx.templateDir,
      lock: ctx.lock,
      onFileResult: ({ file, outcome }) =>
        Effect.sync(() => {
          match(outcome)
            .with({ _tag: "Clean" }, ({ content }) => {
              ctx.mergedContents.set(file, mergedAsPushContent(content));
              autoMerged.push(file);
            })
            // 未解決の内容はテンプレートへ送らない。ローカルの内容がそのまま push されて
            // テンプレートの更新を上書きするのを防ぐため、呼び出し側が選択時に中断する。
            .with({ _tag: P.union("Conflicted", "NoBase") }, () => undefined)
            .exhaustive();
        }),
    }),
  );

  if (autoMerged.length > 0) {
    log.success(`Auto-merged ${autoMerged.length} file(s):`);
    for (const f of autoMerged) log.message(`  ${pc.green("✓")} ${f}`);
  }

  return unresolved;
}

/**
 * 未解決の衝突を push 対象に含めようとしたときの失敗を生成する。
 *
 * 未解決ファイルはマージ結果ではなくローカルの内容がそのまま push され、テンプレートの
 * 更新を黙って上書きしてしまう（mergedContents に保存されないため localContent が使われる）。
 * これを防ぐため、未解決ファイルが選択された場合は確定的に中断し、`ziku pull` での解決を促す。
 */
function unresolvedConflictFailure(files: RepoRelPath[]): ZikuFailure {
  return zikuFailure({ kind: "PushBlockedByConflicts", files });
}
