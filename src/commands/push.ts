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
  GitHubSource,
  GlobPattern,
  LocalSource,
  LockState,
  PendingConflict,
  RepoRelPath,
  TemplateSource,
} from "../modules/schemas";
import { baseCommitSha, baseHashesOf, markSynced } from "../modules/schemas";
import { LOCK_FILE, saveLock } from "../utils/lock";
import {
  ZIKU_CONFIG_FILE,
  addIncludePattern,
  isZikuConfigPath,
  loadZikuConfig,
  saveZikuConfig,
  withoutConfigTracked,
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
import {
  classifyGitHubApiFailure,
  createPullRequest,
  fetchDefaultBranch,
  getGitHubToken,
  githubApiFailure,
} from "../utils/github";
import { hashFiles } from "../utils/hash";
import { detectReadmeUpdate, renderTemplateReadme } from "../utils/readme";
import { detectUntrackedFiles, getTotalUntrackedCount } from "../utils/untracked";
import type {
  ChangedFileDiff,
  PushCandidatePlan,
  PushContent,
  PushFile,
  PushFileSelection,
  PushPayload,
  ZikuConfigWriteBack,
} from "./push-plan";
import {
  alreadySyncedPaths,
  applyPushSelection,
  asPushContent,
  baseAfterPush,
  buildPushPayload,
  buildPushSummaryRows,
  collectPushCandidates,
  configDiffToInject,
  defaultPushSelection,
  filterByFilesArg,
  mergedAsPushContent,
  patternsToPersist,
  planConfigPropagation,
  planPushCandidates,
  planUntrackedTracking,
  resolvePrBaseBranch,
  selectedUnresolvedConflicts,
  templateContentOf,
  withNewlyTrackedPatterns,
  zikuConfigWriteBack,
} from "./push-plan";

/** テンプレートのリポジトリルートにある README。マーカー間が同期対象一覧の反映先になる。 */
const TEMPLATE_README = repoRelPath("README.md");

export const pushLifecycle: CommandLifecycle = {
  name: "push",
  description: "Push local changes to template (GitHub: PR / local: direct copy)",
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

// ─── Push 戦略: GitHub / Local を Effect で分離 ───

interface PushTarget extends PushPayload {
  readonly pushableFiles: readonly ChangedFileDiff[];
  /**
   * テンプレートが削除したファイルのうち、ローカルの編集を保持したまま push するもの。
   * push はテンプレート側の削除を取り消すことになるので、サマリで明示する。
   */
  readonly restoresTemplateDeletion: ReadonlySet<RepoRelPath>;
}

// ─── push 中の失敗の分類 ───

/**
 * push 中に飛んだ例外を、ユーザーが取れる行動がある失敗と、そうでない defect に振り分ける。
 *
 * `ZikuFailure` として文言で報告するのは、ユーザーが次の一手を選べるものだけ:
 *
 * | 失敗                                       | ユーザーが取る行動               |
 * | ------------------------------------------ | -------------------------------- |
 * | トークンを拒否された (401)                 | トークンを更新する               |
 * | レート制限 (429 / 403 + rate limit ヘッダ) | 待つ、またはトークンを設定する   |
 * | 操作を拒否された (403)                     | 権限と fork の可否を見直す       |
 * | 宛先が見つからない (404)                   | lock の参照を今あるものへ直す    |
 * | GitHub へ届かない                          | 接続を確かめて実行し直す         |
 * | ローカルへの書き込みが権限・容量で失敗     | 権限を直す / 空きを作る          |
 *
 * 呼び出し先が既に `ZikuFailure` として分類した失敗（同期対象が多すぎてツリーを取り切れない等）
 * は、そのまま通す。GitHub API の例外として分類し直すと `Unclassified` に落ちて defect になり、
 * 呼び出し先が用意した案内が消える。
 *
 * これ以外は defect のまま運び、トップレベルが原因とスタックトレースごと見せる。プロンプトの
 * 中断・想定外のレスポンス形・GitHub の 5xx がここに入る。文言に潰すと、ziku の不具合が
 * 「ユーザー側の問題」として案内され、原因を追う材料も消える。
 *
 * ケースを足すときの基準: **ユーザーが次に取る行動を 1 文で書けるか**。書けないなら足さない。
 * 分類されない失敗が defect として出るのは取りこぼしではなく、この設計の正しい出力。
 *
 * @param operation 何をしようとして失敗したか（文中に埋め込むので動詞から始める）。
 */
function pushFailure(operation: string): (cause: unknown) => Effect.Effect<never, ZikuFailure> {
  return (cause) => {
    if (cause instanceof ZikuFailure) return Effect.fail(cause);

    return match(classifyGitHubApiFailure(cause))
      .with(
        {
          _tag: P.union(
            "AuthRejected",
            "RateLimited",
            "PermissionDenied",
            "NotFound",
            "Unreachable",
          ),
        },
        (failure) =>
          // push が GitHub API を呼ぶのはトークンを用意できた後だけなので、レート制限は
          // 常に認証済みクォータのもの。
          Effect.fail(githubApiFailure(failure, { operation, authenticated: true, cause })),
      )
      .with({ _tag: "Unclassified" }, () => localWriteFailure(cause))
      .exhaustive();
  };
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
 * 宛先が定まらない 3 通りは、ユーザーが取る行動が違うので別の失敗にする。タグ・コミットへ
 * 固定されたテンプレートは lock を直せば解決し、トークンを拒否された場合はトークンを入れ直す
 * ことになり、既定ブランチを引けず控えも無い場合は到達性（ネットワーク）を疑うか宛先を
 * 明示することになる。
 *
 * 問い合わせ結果を潰さずに渡すのは、引けなかった理由で宛先の決まり方が変わるため
 * （{@link resolvePrBaseBranch}）。レート制限のように待てば直る失敗では lock に控えた既定
 * ブランチ名が宛先になり、テンプレートの取得が控えへ倒れて続行できる実行で PR だけが
 * 作れない状態を作らない。
 *
 * 既定ブランチの問い合わせは ref を持たないソースだけに要る。ブランチ指定済み・タグ /
 * コミット固定のソースでは結果を使わないので、API を呼ばない。
 */
function prBaseBranch(source: GitHubSource): Effect.Effect<string, ZikuFailure> {
  return Effect.gen(function* () {
    const defaultBranchLookup =
      source.ref === undefined
        ? yield* Effect.promise(() => fetchDefaultBranch(source.owner, source.repo))
        : undefined;

    return yield* match(resolvePrBaseBranch(source, defaultBranchLookup))
      .with({ _tag: "Branch" }, ({ name }) => Effect.succeed(name))
      .with({ _tag: "UnsupportedRef" }, ({ kind }) =>
        Effect.fail(zikuFailure({ kind: "TemplateRefNotBranch", refKind: kind })),
      )
      .with({ _tag: "AuthRejected" }, ({ detail }) =>
        Effect.fail(zikuFailure({ kind: "GitHubAuthRejected", detail })),
      )
      .with({ _tag: "DefaultBranchUnresolved" }, () =>
        Effect.fail(
          zikuFailure({
            kind: "DefaultBranchUnresolved",
            repo: `${source.owner}/${source.repo}`,
          }),
        ),
      )
      .exhaustive();
  });
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
  ghSource: GitHubSource,
  target: PushTarget,
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

        const suggestedTitle = generatePrTitle([...target.pushableFiles]);
        const suggestedBody = generatePrBody([...target.pushableFiles]);

        const { title, body } = await match(args)
          .with({ message: P.string }, ({ message }) => ({
            title: message,
            body: suggestedBody,
          }))
          .with({ edit: true }, async () => ({
            title: await inputPrTitle(suggestedTitle),
            body: await inputPrBody(suggestedBody),
          }))
          .otherwise(() => ({ title: suggestedTitle, body: suggestedBody }));

        const files = await withTemplateReadme(target.files, ctx.templateDir);

        // サマリー表示
        const baseSha = baseCommitSha(ctx.lock);
        const baseHashStr = baseSha ? `  ${pc.dim(`since ${baseSha.slice(0, 7)}`)}` : "";
        logPushSummary(
          `${ghSource.owner}/${ghSource.repo}`,
          `→ ${baseBranch}`,
          baseHashStr,
          title,
          target,
          files,
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
            files,
            deletions: [...target.deletions],
            title,
            body,
            baseBranch,
          }),
        );

        log.success("Pull request created!");
        log.message(
          [
            `${pc.dim("To")} ${pc.bold(`${ghSource.owner}/${ghSource.repo}`)}`,
            `  ${baseSha ? `${pc.dim(baseSha.slice(0, 7))}..` : ""}${pc.green(result.branch)}  ${pc.dim(`(${files.length + target.deletions.length} file${files.length + target.deletions.length === 1 ? "" : "s"} changed)`)}`,
            "",
            `  ${pc.bold(`PR #${result.number}`)}  ${pc.cyan(result.url)}`,
          ].join("\n"),
        );
        outro(`Review and merge at ${pc.cyan(result.url)}`);
        return true;
      },
    }).pipe(Effect.catchAll(pushFailure("create a pull request")));
  });
}

/** ローカルテンプレートへの書き込みと lock 更新に要るもの。 */
interface PushToLocalInput {
  readonly localSource: LocalSource;
  readonly target: PushTarget;
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
        `push ${target.files.length + target.deletions.length} file(s)`,
        target,
        target.files,
      );

      if (!args.yes) {
        const confirmed = await confirmAction("Push to local template?", { initialValue: true });
        if (!confirmed) {
          log.info("Cancelled.");
          return false;
        }
      }

      log.step("Pushing to local template...");

      for (const file of target.files) {
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
      for (const file of target.deletions) {
        const destPath = joinAbs(localSource.path, file.path);
        if (existsSync(destPath)) {
          await rm(destPath, { force: true });
          log.message(`  ${pc.red("-")} ${file.path}`);
        }
      }

      const writtenBackToLocal = await writeBackZikuConfig({
        files: target.files,
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
            pushed: target,
            alreadySynced: input.alreadySynced,
            writtenBackToLocal,
          }),
        }),
      );

      const totalCount = target.files.length + target.deletions.length;
      log.success(`Pushed ${totalCount} file(s) to ${pc.cyan(localSource.path)}`);
      outro("Push complete");
      return true;
    },
  }).pipe(Effect.catchAll(pushFailure("push to the local template")));
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

function logPushSummary(
  destination: string,
  branchInfo: string,
  baseHashStr: string,
  title: string,
  target: PushTarget,
  files: readonly { path: RepoRelPath; content: PushContent }[],
): void {
  /** サマリでパスの後ろの情報を揃える桁位置。 */
  const PATH_COLUMN_WIDTH = 50;

  const rows = buildPushSummaryRows({
    pushableFiles: target.pushableFiles,
    files,
    deletions: target.deletions,
    restoresTemplateDeletion: target.restoresTemplateDeletion,
  });

  const fileLines = rows.map((row) =>
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

    const ctx = await runCommandEffect(
      loadCommandContext(targetDir).pipe(Effect.mapError(toZikuFailure)),
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
      dryRun: args.dryRun as boolean,
      message: args.message as string | undefined,
      yes: args.yes as boolean,
      edit: args.edit as boolean,
      files: args.files as string | undefined,
      includeDeletions: args.includeDeletions as boolean,
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
      unresolvedConflicts,
      restoresTemplateDeletion: candidatePlan.restoresTemplateDeletion,
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
    diffFiles: diff.files,
    mergedContents,
  });

  const payload = buildPushPayload(configResult.selected, mergedContents);

  // 選択したファイルが残っていても、送る内容が 1 件も無いことがある。自動マージの結果や
  // `ziku.jsonc` の和集合がテンプレートと同一になった場合で、送信ペイロードはそれを落とす
  // （`buildPushPayload`）。そのまま進むと差分の無い PR を作ろうとして GitHub に拒まれ、
  // ローカルテンプレートへは書くものが無いまま同期ベースだけが進む。
  if (payload.files.length === 0 && payload.deletions.length === 0) {
    log.info("Nothing to push — the selected file(s) already match the template.");
    return;
  }

  const target: PushTarget = {
    ...payload,
    pushableFiles: configResult.selected,
    restoresTemplateDeletion: candidatePlan.restoresTemplateDeletion,
  };

  // ─── 分岐: ソース種別に応じた push 戦略 (ts-pattern + Effect) ───
  const pushed = await runCommandEffect(
    match(ctx.source)
      .with({ kind: "github" }, (ghSource) =>
        pushToGitHub(ghSource, target, ctx, {
          message: args.message,
          edit: args.edit,
          yes: args.yes,
        }),
      )
      .with({ kind: "local" }, (localSource) =>
        pushToLocal({
          localSource,
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
    const pushedPaths = new Set<RepoRelPath>([
      ...payload.files.map((f) => f.path),
      ...payload.deletions.map((d) => d.path),
    ]);
    await persistNewlyTracked(targetDir, newlyTrackedPaths, pushedPaths);
  }
}

// ─── dry-run プレビュー ───

/**
 * 実 push と同じ規則で「実際に送られる集合」を表示する。
 *
 * プレビューだけ別の規則で組み立てると、表示された集合と実際に送られる集合が食い違う。
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
  unresolvedConflicts: ReadonlySet<RepoRelPath>;
  restoresTemplateDeletion: ReadonlySet<RepoRelPath>;
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
    logDiffSummary([...previewFiles]);
  }

  await warnIfConfigWouldBeAutoIncluded({
    targetDir: params.targetDir,
    templateDir: params.templateDir,
    previewFiles,
  });

  // README の自動更新が走るのは GitHub への push だけ（`pushToGitHub`）。ローカルテンプレート
  // への push では触らないので、予告すると起きない更新を予告することになる。
  await match(params.source)
    .with({ kind: "github" }, () => warnIfReadmeWouldBeAutoUpdated(params.templateDir))
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
 * dry-run プレビューで、実 push なら自動同梱される `ziku.jsonc` をあらかじめ知らせる。
 * プレビュー自体への注入は行わない（dry-run は「実際に push される集合」を見せる方針を保つ）。
 */
async function warnIfConfigWouldBeAutoIncluded(params: {
  targetDir: AbsPath;
  templateDir: AbsPath;
  previewFiles: readonly ChangedFileDiff[];
}): Promise<void> {
  const { targetDir, templateDir, previewFiles } = params;
  if (previewFiles.some((f) => isZikuConfigPath(f.path))) return;

  const relevantPatterns = await findLocalOnlyPatternsForPaths({
    targetDir,
    templateDir,
    paths: previewFiles.map((f) => f.path),
  });
  if (relevantPatterns.length === 0) return;

  log.warn(
    `${ZIKU_CONFIG_FILE} would also be pushed — it registers ${relevantPatterns.length} pattern(s) needed by the file(s) above (#90):`,
  );
  for (const p of relevantPatterns) log.message(`  ${pc.dim("+")} ${p}`);
}

// ─── 未追跡ファイルの追跡 ───

/**
 * 未追跡ファイルを検知し、追跡対象を決定する。
 *
 * 対話時はユーザーに追跡対象（include 追加）を選択させ、選択分を含めた effectivePatterns を返す。
 * 対話を省く実行では暗黙追加せず、除外されるファイルを通知する（進め方の判断は
 * `planUntrackedTracking`）。
 *
 * @returns effectivePatterns（追跡選択を反映したパターン。以降の hash/classify/diff に使う）と
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
  // 未追跡探索は、ユーザーが明示的に追跡すると決めたパターンだけを見る（除外の理由は
  // withoutConfigTracked の JSDoc を参照）。
  const discoveryPatterns = {
    include: withoutConfigTracked(scope.include),
    exclude: scope.exclude,
  };
  const untrackedByFolder = await detectUntrackedFiles({ targetDir, patterns: discoveryPatterns });
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

  const { newlyTrackedPaths } = withNewlyTrackedPatterns(
    { include: [...scope.include], exclude: [...scope.exclude] },
    selected,
  );
  return {
    effectiveScope: extendScope(
      scope,
      newlyTrackedPaths.map((path) => pathAsPattern(path)),
    ),
    newlyTrackedPaths,
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
 * 送信対象のファイルに必要な include パターンを、同じ push でテンプレの `ziku.jsonc` へ届ける。
 *
 * 何を載せるかは `planConfigPropagation` が決め、ここはその計画に沿って `ziku.jsonc` の内容を
 * 組み立て（I/O）、必要なら送信対象へ注入する。
 *
 * @returns 注入後の送信対象と、その内容をローカルの `ziku.jsonc` へも残すか。
 */
async function propagateConfigPatterns(params: {
  targetDir: AbsPath;
  templateDir: AbsPath;
  newlyTrackedPaths: readonly RepoRelPath[];
  selected: readonly ChangedFileDiff[];
  diffFiles: readonly FileDiff[];
  mergedContents: Map<RepoRelPath, PushContent>;
}): Promise<{ selected: readonly ChangedFileDiff[]; writeBack: ZikuConfigWriteBack }> {
  const { targetDir, templateDir, selected, mergedContents } = params;
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
  });
  const writeBack = zikuConfigWriteBack(plan);

  const mergedConfig = await match(plan)
    .with({ _tag: "NoConfigChange" }, () => Promise.resolve(undefined))
    .with({ _tag: "MergeLocalConfig" }, ({ extraIncludes }) =>
      computeMergedZikuConfig({ targetDir, templateDir, extraIncludes }),
    )
    .with({ _tag: "MergeScopedConfig" }, ({ additionalIncludes }) =>
      computeScopedZikuConfig({ templateDir, additionalIncludes }),
    )
    .exhaustive();

  if (mergedConfig === undefined) return { selected, writeBack };
  mergedContents.set(ZIKU_CONFIG_FILE, asPushContent(mergedConfig));

  // 選択済みなら content は mergedContents が採用されるので注入は不要。
  if (configAlreadySelected) return { selected, writeBack };

  const configDiff = params.diffFiles.find((f) => isZikuConfigPath(f.path));
  const injected = configDiffToInject({
    mergedConfig,
    templateConfig: configDiff === undefined ? undefined : templateContentOf(configDiff),
  });
  if (injected === undefined) return { selected, writeBack };

  announceConfigAutoInclude(localOnlyPatterns);
  return { selected: [...selected, injected], writeBack };
}

/**
 * 明示指定されていない `ziku.jsonc` を同梱する理由を伝える。
 *
 * ユーザーが `--files` で挙げていないファイルが PR に出ると意図しない混入に見えるため、
 * 何のために足したか（どのパターンが今回の送信対象に必要か）を並べる。
 */
function announceConfigAutoInclude(localOnlyPatterns: readonly GlobPattern[]): void {
  if (localOnlyPatterns.length === 0) return;
  log.info(
    `Also pushing ${ZIKU_CONFIG_FILE} — it registers ${localOnlyPatterns.length} pattern(s) needed by the file(s) in this push (#90):`,
  );
  for (const p of localOnlyPatterns) log.message(`  ${pc.dim("+")} ${p}`);
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
 * （{@link announceReadmeAutoUpdate} / {@link announceReadmeRebuild}）。
 *
 * 生成元は同じ PR に載る内容に採る。README も `ziku.jsonc` もこの PR で書き換わるので、
 * テンプレートのディスク上の内容から作ると、この PR が追加するパターン（`ziku track` した
 * 直後など）を反映しない README を配ることになる。
 *
 * README が追跡ファイルとして既に送信対象に入っているときは、そのエントリを **置き換える**。
 * 足すと同じパスを 2 回送ることになり、GitHub への 2 回目の書き込みが 1 回目で変わった
 * blob SHA と食い違って弾かれる。組み直しの土台に採るのは自動生成の内容ではなく、追跡
 * ファイルとして送ろうとしているローカルの内容のほう。マーカー外はユーザーが書いた文章で、
 * ziku が選り分ける立場にない。ziku が従わせてよいのはマーカー間だけなので、土台は
 * ユーザーの内容にして、その中のマーカー間だけを `ziku.jsonc` から組み直す。
 */
async function withTemplateReadme(
  files: readonly PushFile[],
  templateDir: AbsPath,
): Promise<readonly PushFile[]> {
  const tracked = files.find((f) => f.path === TEMPLATE_README);
  const config = files.find((f) => isZikuConfigPath(f.path));

  const rendered = await renderTemplateReadme({
    templateDir,
    readme: tracked?.content,
    config: config?.content,
  });
  if (rendered === null || !rendered.updated) return files;

  const rebuilt: PushFile = {
    path: TEMPLATE_README,
    content: asPushContent(rendered.content),
    // マーカー間は `ziku.jsonc` から導出した内容で、ローカルの README には残らない。
    origin: { _tag: "Synthesized" },
  };

  if (tracked === undefined) {
    announceReadmeAutoUpdate();
    return [...files, rebuilt];
  }

  announceReadmeRebuild();
  return files.map((f) => (f.path === TEMPLATE_README ? rebuilt : f));
}

/**
 * 明示指定されていない README を同梱する理由を伝える。
 *
 * サマリには `(auto-updated)` の 1 行として並ぶが、記号だけでは「なぜ自分が選んでいない
 * ファイルが PR に出るのか」が読み取れない。導出元を名指しして、確認プロンプトの前に
 * 判断材料を渡す（`ziku.jsonc` の自動同梱と同じ扱い）。
 */
function announceReadmeAutoUpdate(): void {
  log.info(
    `Also pushing ${TEMPLATE_README} — its generated sections are rebuilt from ${ZIKU_CONFIG_FILE}.`,
  );
}

/**
 * 選ばれた README の中身に手を入れた事実を伝える。
 *
 * 追跡ファイルとして選んだ内容がそのまま送られると読めるので、マーカー間だけ差し替えたことを
 * 確認プロンプトの前に知らせる。
 */
function announceReadmeRebuild(): void {
  log.info(
    `Rebuilding the generated sections of ${TEMPLATE_README} from ${ZIKU_CONFIG_FILE} before pushing it.`,
  );
}

/**
 * dry-run で、実 push なら同梱されるテンプレート README の更新を予告する。
 *
 * 検出だけを行い README へは書き込まない（dry-run は何も変えない）。
 */
async function warnIfReadmeWouldBeAutoUpdated(templateDir: AbsPath): Promise<void> {
  const result = await detectReadmeUpdate(templateDir, templateDir);
  if (!result?.updated) return;

  log.warn(
    `${TEMPLATE_README} would also be pushed — its generated sections are rebuilt from ${ZIKU_CONFIG_FILE}.`,
  );
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
