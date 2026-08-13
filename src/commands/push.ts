import { existsSync } from "node:fs";
import { mkdir, rm, writeFile } from "node:fs/promises";
import { defineCommand } from "citty";
import { Effect } from "effect";
import { dirname, join, resolve } from "pathe";
import { P, match } from "ts-pattern";
import { z } from "zod/v4";
import { withFinally } from "../effect-helpers";
import { ZikuError, zikuFailure } from "../errors";
import type { FileDiff, GitHubSource, LocalSource, LockState } from "../modules/schemas";
import { baseCommitSha, baseHashesOf, markSynced } from "../modules/schemas";
import { LOCK_FILE, saveLock } from "../utils/lock";
import {
  ZIKU_CONFIG_FILE,
  addIncludePattern,
  loadZikuConfig,
  saveZikuConfig,
  withConfigTracked,
} from "../utils/ziku-config";
import { loadCommandContext, runCommandEffect, toZikuError } from "../services/command-context";
import type { MergedContent } from "../utils/merge";
import { mergeConflictFiles } from "../utils/merge";
import { analyzeSync } from "../utils/sync-analysis";
import { transportTextToBytes } from "../utils/file-content";
import {
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
import { intro, log, logDiffSummary, outro, pc, withSpinner } from "../ui/renderer";
import { detectDiff } from "../utils/diff";
import { createPullRequest, getGitHubToken } from "../utils/github";
import { hashFiles } from "../utils/hash";
import { detectAndUpdateReadme } from "../utils/readme";
import { detectUntrackedFiles, getTotalUntrackedCount } from "../utils/untracked";

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
    { file: LOCK_FILE, location: "local", op: "update", note: "同期ベースを更新" },
  ],
  notes: [
    "`ziku.jsonc` 自体が追跡ファイルとして同期対象に含まれる。`ziku track` で追加したローカルパターンは、push 時にテンプレートの `ziku.jsonc` へ加法 union マージで伝播する（pull と双方向）。パターンの削除は自動伝播しない。",
  ],
};

// ─── テンプレートへ送る内容 ───

/**
 * テンプレートへ送るファイル内容。PR の本文にも、ローカルテンプレートへの書き込みにも
 * この型しか渡らない。
 *
 * 送るものは 2 系統ある。ユーザーがローカルに書いた内容（および ziku が組み立てた
 * `ziku.jsonc` の和集合）と、3-way マージの結果。前者はユーザー自身のテキストなので
 * ziku が中身を選り分ける立場にない。後者は ziku が生成したものなので、コンフリクト
 * マーカーを含んだままテンプレートへ配ってしまう事故が起こりうる。
 *
 * そこでマージ結果の入口を `mergedAsPushContent` だけに絞り、その引数を
 * `MergedContent`（マーカー非混入が検証済み）に限定する。マーカー入りと確定した
 * `ConflictedContent` は、この型へ変換する手段が無いので送信対象へ入れられない。
 */
const PushContentSchema = z.string().brand("PushContent");
type PushContent = z.infer<typeof PushContentSchema>;

/** ローカルに実在する内容（ユーザーが書いたファイル・ziku が組み立てた設定）を送る。 */
function asPushContent(content: string): PushContent {
  return PushContentSchema.parse(content);
}

/** 3-way マージの結果を送る。クリーンと判定された内容だけがこの経路を通れる。 */
function mergedAsPushContent(content: MergedContent): PushContent {
  return PushContentSchema.parse(content);
}

// ─── Push 戦略: GitHub / Local を Effect で分離 ───

interface PushTarget {
  readonly files: Array<{ path: string; content: PushContent }>;
  readonly deletions: Array<{ path: string }>;
  readonly pushableFiles: FileDiff[];
  /**
   * テンプレートが削除したファイルのうち、ローカルの編集を保持したまま push するもの。
   * push はテンプレート側の削除を取り消すことになるので、サマリで明示する。
   */
  readonly restoresTemplateDeletion: ReadonlySet<string>;
}

/**
 * PR のベースブランチを決める。
 *
 * GitHub の PR はブランチにしか向けられない（ベースの解決に使う `repos.getBranch` は
 * タグやコミット SHA で 404 になる）。ref を持たないソースは既定ブランチ名を使い、
 * タグ・コミットへ固定されたソースは PR の宛先が定まらないので中断する。
 */
function resolvePrBaseBranch(source: GitHubSource): string {
  return match(source.ref)
    .with(undefined, () => "main")
    .with({ kind: "branch" }, (branch) => branch.name)
    .with({ kind: P.union("tag", "commit") }, (): never => {
      throw new ZikuError(
        "Cannot open a pull request against a template pinned to a tag or commit",
        `Point .ziku/lock.json's source.ref at a branch (for example { "kind": "branch", "name": "main" }) and run push again.`,
      );
    })
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
  ghSource: GitHubSource,
  target: PushTarget,
  ctx: CommandContextShape,
  args: { message?: string; edit?: boolean; yes?: boolean },
): Effect.Effect<boolean, ZikuError> {
  return Effect.tryPromise({
    try: async () => {
      let token = getGitHubToken();
      if (!token) {
        token = await inputGitHubToken();
      }

      const suggestedTitle = generatePrTitle(target.pushableFiles);
      const suggestedBody = generatePrBody(target.pushableFiles);

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

      const readmeResult = await detectAndUpdateReadme(ctx.templateDir, ctx.templateDir);
      const files = [...target.files];
      if (readmeResult?.updated) {
        files.push({ path: "README.md", content: asPushContent(readmeResult.content) });
      }

      // サマリー表示
      const baseBranch = resolvePrBaseBranch(ghSource);
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
          deletions: target.deletions,
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
    catch: (e) => (e instanceof ZikuError ? e : new ZikuError("Push failed", String(e))),
  });
}

/**
 * ローカルテンプレートへ push: ファイルを直接コピーする。
 *
 * PR の代わりにテンプレートディレクトリにファイルを書き込み、
 * lock.json の baseHashes を更新する。
 *
 * @param patterns baseHashes 再計算に使うパターン。新規追跡ファイルを含む effectivePatterns を
 *   渡すことで、追跡したファイルが baseHashes に反映され、lock と配置のズレを防ぐ。
 * @param configWriteBackSafe push される ziku.jsonc の内容をローカルへそのまま書き戻して
 *   よいか。`applyNewlyTrackedConfigToPush` がスコープ限定 union（#90）を使った場合は
 *   false になり、書き戻しをスキップする（詳細は同関数の JSDoc を参照）。
 * @returns push したら true、確認でキャンセルされたら false。
 */
function pushToLocal(
  localSource: LocalSource,
  target: PushTarget,
  ctx: CommandContextShape,
  projectDir: string,
  args: { yes?: boolean },
  patterns: { include: string[]; exclude: string[] },
  configWriteBackSafe: boolean,
): Effect.Effect<boolean, ZikuError> {
  return Effect.tryPromise({
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
        const destPath = join(localSource.path, file.path);
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
        const destPath = join(localSource.path, file.path);
        if (existsSync(destPath)) {
          await rm(destPath, { force: true });
          log.message(`  ${pc.red("-")} ${file.path}`);
        }
      }

      // ziku.jsonc が衝突解決で union マージされた場合、push される内容はローカルの生
      // 内容ではなく union 結果になる。ローカルを更新しないと、テンプレ・ローカルが
      // 乖離したまま baseHashes をテンプレ（union）へ進めてしまい、次回 push で
      // ローカルが localOnly 判定 → テンプレ側の追加分を上書きで落とす（codex P2）。
      // ローカルにも merged 内容を書き戻して local==template==base を保つ。
      //
      // ただし #90 のスコープ限定 union（computeScopedZikuConfig）はテンプレ + 関連
      // パターンのみで、ローカルの他の未 push パターンを含まない部分集合になり得る。
      // これをそのままローカルへ書き戻すと、無関係なローカル限定パターンを消してしまう
      // （union は削除しないという原則違反）。configWriteBackSafe=false のときは
      // 書き戻しをスキップする（ローカルは元々正しい内容を保持しているので何もしなくてよい）。
      const mergedConfig = target.files.find((f) => f.path === ZIKU_CONFIG_FILE);
      if (mergedConfig && configWriteBackSafe) {
        const localConfigPath = join(projectDir, ZIKU_CONFIG_FILE);
        await mkdir(dirname(localConfigPath), { recursive: true });
        await writeFile(localConfigPath, mergedConfig.content, "utf-8");
      }

      // lock.json の baseHashes を更新（テンプレート側のハッシュを再計算）。
      // 新規追跡ファイルと ziku.jsonc を含む effectivePatterns で計算するため、
      // 追跡したファイルも ziku.jsonc も baseHashes に入る（push 後はテンプレと一致する）。
      const baseHashes = await hashFiles(localSource.path, patterns.include, patterns.exclude);
      await saveLock(projectDir, markSynced(ctx.lock, { hashes: baseHashes }));

      const totalCount = target.files.length + target.deletions.length;
      log.success(`Pushed ${totalCount} file(s) to ${pc.cyan(localSource.path)}`);
      outro("Push complete");
      return true;
    },
    catch: (e) => (e instanceof ZikuError ? e : new ZikuError("Push failed", String(e))),
  });
}

// ─── サマリー表示 ───

function logPushSummary(
  destination: string,
  branchInfo: string,
  baseHashStr: string,
  title: string,
  target: PushTarget,
  files: Array<{ path: string; content: PushContent }>,
): void {
  const { pushableFiles, deletions, restoresTemplateDeletion } = target;
  const fileLines: string[] = [];
  // files の content は mergedContent を含むため、detectDiff の localContent ではなく
  // 実際に push される content でサマリーを計算する（PR の差分行数と一致させる）
  const pushedContentMap = new Map(files.map((f) => [f.path, f.content]));
  for (const pf of pushableFiles) {
    const pushedContent = pushedContentMap.get(pf.path);
    const isDeletion = deletions.some((d) => d.path === pf.path);
    if (pushedContent === undefined && !isDeletion) continue;

    // 実際に push される content と templateContent から正しい type と stat を算出
    const effectiveDiff = buildEffectiveDiff(pf, pushedContent);
    // push 内容がテンプレートと同一なら表示不要
    if (effectiveDiff.type === "unchanged") continue;
    const stat = formatFileStat(effectiveDiff);
    const icon = match(effectiveDiff.type)
      .with("added", () => pc.green("+"))
      .with("modified", () => pc.yellow("~"))
      .with("deleted", () => pc.red("-"))
      .exhaustive();
    // テンプレートが削除したファイルの push は、新規追加ではなく「削除の取り消し」。
    // 同じ `+` 行では区別できないので注記する。
    const note = restoresTemplateDeletion.has(pf.path)
      ? ` ${pc.yellow("(restores file deleted in template)")}`
      : "";
    fileLines.push(`  ${icon} ${pf.path.padEnd(50)} ${stat}${note}`);
  }
  for (const f of files) {
    if (!pushableFiles.some((pf) => pf.path === f.path)) {
      fileLines.push(`  ${pc.green("+")} ${f.path.padEnd(50)} ${pc.dim("(auto-updated)")}`);
    }
  }

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

/**
 * push される実際のコンテンツに基づいて FileDiff を再構築する。
 *
 * 背景: detectDiff の FileDiff はディスク上の localContent を持つが、
 * auto-merge 後の push では mergedContent が使われる。PR の差分行数と
 * 一致させるため、pushed content と templateContent で type を再判定する。
 */
function buildEffectiveDiff(original: FileDiff, pushedContent: string | undefined): FileDiff {
  // 削除の場合はそのまま
  if (pushedContent === undefined) return original;

  const templateContent = templateContentOf(original);

  // templateContent がない → テンプレートに新規追加
  if (templateContent === undefined) {
    return { path: original.path, type: "added", localContent: pushedContent };
  }

  // push される内容がテンプレートと同一 → 変更なし
  if (pushedContent === templateContent) {
    return {
      path: original.path,
      type: "unchanged",
      localContent: pushedContent,
      templateContent,
    };
  }

  // テンプレートと異なる → modified として unified diff で統計計算
  return {
    path: original.path,
    type: "modified",
    localContent: pushedContent,
    templateContent,
  };
}

/**
 * テンプレート側の内容を、持っている種別からだけ取り出す。
 *
 * 「テンプレートにそのファイルがあるか」を判断したい呼び出し元のための問い合わせで、
 * `added` の undefined は欠損ではなく「テンプレートに存在しない」という事実を表す。
 */
function templateContentOf(diff: FileDiff): string | undefined {
  return match(diff)
    .with({ type: "added" }, () => undefined)
    .with({ type: P.union("deleted", "modified", "unchanged") }, (f) => f.templateContent)
    .exhaustive();
}

function formatFileStat(file: FileDiff): string {
  const stats = calculateDiffStats(file);
  return formatStats(stats);
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

    const targetDir = resolve(args.dir);

    const ctx = await runCommandEffect(
      loadCommandContext(targetDir).pipe(Effect.mapError(toZikuError)),
    );
    const { config, lock, source, templateDir, cleanup } = ctx;

    if (lock.sync === "merging") {
      await cleanup();
      throw new ZikuError(
        "Unresolved merge conflicts from `ziku pull`",
        "Resolve conflicts in these files, then run `ziku pull --continue`:\n" +
          lock.merge.conflicts.map((f) => `  • ${f}`).join("\n"),
      );
    }

    const patterns = {
      // `.ziku/ziku.jsonc` 自体を追跡対象に含める。これにより `ziku track` で
      // 追加したローカルパターンが、加法 union マージ経由でテンプレートの ziku.jsonc へ
      // 伝播する（孤児化バグの修正）。
      include: withConfigTracked(config.include),
      exclude: config.exclude ?? [],
    };

    // ガードは生の config.include で判定する（patterns.include は ziku.jsonc を
    // 常に含むため 0 にならない）。
    if (config.include.length === 0) {
      log.warn("No patterns configured");
      await cleanup();
      return;
    }

    await withFinally(async () => {
      // ─── 共通: 差分検出 + ファイル選択 ───

      const mergedContents = new Map<string, PushContent>();

      // ─── 未追跡ファイルの追跡フロー ───
      // 検知・選択・include へのマージは classify より「前」に行う必要がある。
      // classify が pushableFilePaths を確定するため、ここで include を広げておかないと
      // 新規追跡ファイルが push 対象に乗らない。永続化（saveZikuConfig）は push 成功後に行う。
      const { effectivePatterns, newlyTrackedPaths } = await resolveUntrackedTracking(
        targetDir,
        patterns,
        { yes: args.yes as boolean, dryRun: args.dryRun as boolean },
      );

      // 分類 + auto-merge。未解決の衝突は控えておき、push 対象に含めようとした時だけ中断する。
      // ziku.jsonc の加法 union マージは classifyAndResolveConflicts 内で処理する。
      const { pushableFilePaths, unresolvedConflicts, deletedWithLocalEdits } =
        await classifyAndResolveConflicts({
          targetDir,
          templateDir,
          lock,
          patterns: effectivePatterns,
          mergedContents,
        });

      log.step("Detecting changes...");

      const diff = await withSpinner("Analyzing differences...", () =>
        detectDiff({ targetDir, templateDir, patterns: effectivePatterns }),
      );

      let pushableFiles = diff.files.filter(
        (f) =>
          (f.type === "added" || f.type === "modified" || f.type === "deleted") &&
          pushableFilePaths.has(f.path),
      );

      // 未解決の衝突は既定では push しない。巻き添えで他ファイルを止めず、明示的に
      // 選択された場合だけ後段で中断する。ここでは存在を知らせて pull での解決を促す。
      if (unresolvedConflicts.size > 0) {
        log.warn(
          `${unresolvedConflicts.size} file(s) have unresolved conflicts (excluded by default):`,
        );
        for (const file of unresolvedConflicts) log.message(`  ${pc.yellow("!")} ${file}`);
        log.info(
          "Run `ziku pull` to resolve them, then push. Selecting them here will stop the push.",
        );
      }

      if (pushableFiles.length === 0) {
        log.info("No changes to push");
        log.step("Current status:");
        logDiffSummary(diff.files);
        return;
      }

      if (args.dryRun) {
        log.info("Dry run mode");

        // #81: dry-run プレビューを実 push と一致させる。
        // 旧実装は `--files` 適用前の全 diff を表示していたため、実際に push される
        // 集合とプレビューが食い違っていた。実 push と同じフィルタ規則
        // （--files 指定・未解決衝突の除外・削除の既定除外）を適用して
        // 「実際に push される集合」を表示する。対話選択は dry-run では行わない。
        const filesArg = args.files as string | undefined;
        let previewFiles: FileDiff[];
        if (filesArg) {
          const { filtered, notFound } = filterByFilesArg(pushableFiles, filesArg);
          if (notFound.length > 0) log.warn(`Files not found: ${notFound.join(", ")}`);
          previewFiles = filtered;
        } else {
          // --files 未指定時は対話選択の既定集合（selectPushFiles の initialValues と
          // 同じ規則）を非対話で再現する。
          previewFiles = defaultPushSelection(pushableFiles, {
            includeDeletions: args.includeDeletions as boolean,
            conflictedPaths: unresolvedConflicts,
          });
        }

        log.step("Files that would be pushed:");
        if (previewFiles.length === 0) {
          log.info("No files match the current selection — nothing would be pushed.");
        } else {
          logDiffSummary(previewFiles);
        }

        // #90: --files でファイル本体だけを指定すると、事前に `ziku track` 済みの
        // パターンが ziku.jsonc 除外により push 候補から漏れうる。実 push では
        // applyNewlyTrackedConfigToPush が自動的に注入するので、dry-run でも
        // 同じ注意書きを出して挙動を一致させる（プレビュー自体への注入はしない）。
        await warnIfConfigWouldBeAutoIncluded({ targetDir, templateDir, previewFiles });

        // 未解決の衝突を --files で明示選択した場合、実 push は中断する（unresolvedConflictError）。
        // dry-run でも同じ予告を出して挙動を一致させる。
        const selectedConflicts = previewFiles.filter((f) => unresolvedConflicts.has(f.path));
        if (selectedConflicts.length > 0) {
          log.warn(
            `${selectedConflicts.length} selected file(s) have unresolved conflicts and would block the push:`,
          );
          for (const f of selectedConflicts) log.message(`  ${pc.yellow("!")} ${f.path}`);
        }
        return;
      }

      // ファイル選択（未解決の衝突は既定で未選択にし、マークして見せる）
      pushableFiles = await selectFilesToPush(pushableFiles, {
        filesArg: args.files as string | undefined,
        includeDeletions: args.includeDeletions as boolean,
        conflictedPaths: unresolvedConflicts,
        yes: args.yes as boolean,
      });
      if (pushableFiles.length === 0) return;

      // 未解決の衝突を含めて push しようとした場合は確定的に中断する（解決してから push）。
      const selectedConflicts = pushableFiles.filter((f) => unresolvedConflicts.has(f.path));
      if (selectedConflicts.length > 0) {
        throw unresolvedConflictError(selectedConflicts.map((f) => f.path));
      }

      // 対話 push で新規追跡したファイルの include パターンを、ファイル本体と同じ push で
      // テンプレの ziku.jsonc にも反映する（codex P2 / #90）。
      const configResult = await applyNewlyTrackedConfigToPush({
        targetDir,
        templateDir,
        newlyTrackedPaths,
        pushableFiles,
        diffFiles: diff.files,
        mergedContents,
      });
      pushableFiles = configResult.pushableFiles;

      const files = pushableFiles
        .filter((f) => f.type !== "deleted")
        .map((f) => ({
          path: f.path,
          // 自動マージ済みならその内容、それ以外はローカルの内容をそのまま送る。
          content: mergedContents.get(f.path) ?? asPushContent(f.localContent),
        }));

      const deletions = pushableFiles
        .filter((f) => f.type === "deleted")
        .map((f) => ({ path: f.path }));

      // ─── 分岐: ソース���別に応じた push 戦略 (ts-pattern + Effect) ───

      const target: PushTarget = {
        files,
        deletions,
        pushableFiles,
        restoresTemplateDeletion: deletedWithLocalEdits,
      };

      const pushed = await runCommandEffect(
        match(source)
          .with({ kind: "github" }, (ghSource) =>
            pushToGitHub(ghSource, target, ctx, {
              message: args.message as string | undefined,
              edit: args.edit as boolean,
              yes: args.yes as boolean,
            }),
          )
          .with({ kind: "local" }, (localSource) =>
            pushToLocal(
              localSource,
              target,
              ctx,
              targetDir,
              { yes: args.yes as boolean },
              effectivePatterns,
              configResult.configWriteBackSafe,
            ),
          )
          .exhaustive(),
      );

      // ─── push 成功後に追跡を永続化（M2: 部分適用の回避）───
      // ziku.jsonc の書き換えは push が実際に成功したときだけ行う。push 失敗（throw）や
      // 確認キャンセル（pushed=false）では設定を変えない。
      if (pushed && newlyTrackedPaths.length > 0) {
        const pushedPaths = new Set([...files.map((f) => f.path), ...deletions.map((d) => d.path)]);
        await persistNewlyTracked(targetDir, newlyTrackedPaths, pushedPaths);
      }
    }, cleanup);
  },
});

// ─── 未追跡ファイルの追跡 ───

/**
 * 未追跡ファイルを検知し、追跡対象を決定する。
 *
 * 対話時はユーザーに追跡対象（include 追加）を選択させ、選択分を含めた effectivePatterns を返す。
 * 非対話（--yes）/ プレビュー（--dry-run）時は暗黙追加せず、除外されるファイルを通知する。
 * 暗黙の include 膨張を避けるため、設定変更は人間の明示操作（選択）に限定する。
 *
 * `--yes` は「対話の省略」であって「追跡しない指定」ではないため、省略の結果として
 * push から外れたファイルを黙って落とさない。何件が・なぜ外れたか・追跡するには何をするかを
 * 通知に載せる（フラグ名からは追跡選択の省略まで読み取れないため）。
 *
 * @returns effectivePatterns（追跡選択を反映したパターン。以降の hash/classify/diff に使う）と
 *   newlyTrackedPaths（push 成功後に永続化する候補パス。非対話時は空）。
 */
async function resolveUntrackedTracking(
  targetDir: string,
  patterns: { include: string[]; exclude: string[] },
  args: { yes: boolean; dryRun: boolean },
): Promise<{
  effectivePatterns: { include: string[]; exclude: string[] };
  newlyTrackedPaths: string[];
}> {
  // 未追跡探索には config-tracked の合成エントリ（`.ziku/ziku.jsonc`）を含めない。
  // これを含めると detectUntrackedFiles が `.ziku` をスコープ基点とみなして `.ziku/**` を
  // 走査し、同期対象外の `.ziku/lock.json`（取得元 source を含むローカル専用ファイル）まで
  // 「未追跡」として追跡候補に出してしまう（codex P2）。`ziku.jsonc` 自体は常に追跡される
  // SSOT なので、未追跡探索の対象から外しても追跡漏れは起きない。
  const discoveryPatterns = {
    include: patterns.include.filter((p) => p !== ZIKU_CONFIG_FILE),
    exclude: patterns.exclude,
  };
  const untrackedByFolder = await detectUntrackedFiles({ targetDir, patterns: discoveryPatterns });
  const untrackedCount = getTotalUntrackedCount(untrackedByFolder);
  if (untrackedCount === 0) {
    return { effectivePatterns: patterns, newlyTrackedPaths: [] };
  }

  if (args.yes || args.dryRun) {
    // --dry-run は「除外」ではなくプレビューなので追跡判断をスキップしているだけ。
    // 恒久的に弾かれたと誤読されないよう headline を分ける。
    const headline = args.dryRun
      ? `${untrackedCount} untracked file(s) outside the sync whitelist (dry-run: tracking skipped):`
      : `${untrackedCount} untracked file(s) left out of this push — --yes skips the tracking prompt, so they stay outside the sync whitelist:`;
    logUntrackedFilesNotice(untrackedByFolder, untrackedCount, { headline });
    return { effectivePatterns: patterns, newlyTrackedPaths: [] };
  }

  const selected = await selectUntrackedToTrack(untrackedByFolder);
  if (selected.length === 0) {
    return { effectivePatterns: patterns, newlyTrackedPaths: [] };
  }

  return {
    effectivePatterns: {
      include: [...patterns.include, ...selected],
      exclude: patterns.exclude,
    },
    newlyTrackedPaths: selected,
  };
}

/**
 * push 成功後に、新規追跡ファイルを ziku.jsonc の include へ永続化する。
 *
 * 実際に push されたファイルのパターンのみ追記する。これによりファイル選択で外された
 * 追跡候補を除外し、「追跡したのに push していない」状態を作らない。
 * パターン = ファイルパス（個別追跡）の前提。ディレクトリ glob 対応は将来拡張。
 *
 * 永続化は addIncludePattern による include キーのみの部分更新（jsonc の modify）で行う。
 * exclude やコメント等は保持されるため、push 中に外部編集が入っても include 以外は壊さない。
 */
async function persistNewlyTracked(
  targetDir: string,
  newlyTrackedPaths: string[],
  pushedPaths: Set<string>,
): Promise<void> {
  const patternsToPersist = newlyTrackedPaths.filter((p) => pushedPaths.has(p));
  if (patternsToPersist.length === 0) return;

  // 分類済みの失敗（不在 / 構文エラー / スキーマ違反）を ZikuError へ落としてから投げる。
  // 素の runPromise だと FiberFailure に包まれ、トップレベルが理由を判別できない。
  const { rawContent } = await runCommandEffect(
    loadZikuConfig(targetDir).pipe(Effect.mapError(toZikuError)),
  );
  const updated = addIncludePattern(rawContent, patternsToPersist);
  if (updated === rawContent) return;

  await saveZikuConfig(targetDir, updated);
  log.success(`Tracked ${patternsToPersist.length} new file(s) in ${ZIKU_CONFIG_FILE}`);
}

/**
 * 対話 push で新規追跡したファイル、および事前に `ziku track` 済みのファイルの
 * include パターンを、ファイル本体と同じ push でテンプレの `ziku.jsonc` にも
 * 届くよう調整する（codex P2 / #90）。
 *
 * 背景（新規追跡分）: ディスク上の `ziku.jsonc` は push 成功後（`persistNewlyTracked`）まで
 * 更新されない。そのため classify / detectDiff は旧内容を見て `ziku.jsonc` を
 * 「変更なし」と判定し、push 対象から漏らし得る。
 *
 * 背景（事前追跡分・#90）: `ziku track <path>` は即座にディスクの `ziku.jsonc` を更新するため
 * classify / detectDiff は `ziku.jsonc` の変更を正しく検出する。しかし `ziku push --files=<path>`
 * のようにファイル本体だけを `--files` に指定すると、`ziku.jsonc` は候補一覧に残っていても
 * `filterByFilesArg` で除外され、push 対象から漏れる。この場合ファイル本体だけがテンプレに
 * 届き、include パターンが届かないため、他プロジェクトの `pull` がそのファイルを検出できない。
 *
 * どちらの場合も放置すると、テンプレにファイル本体だけ届いて include パターンが届かず、
 * 他プロジェクトの `init` / `pull` が拾えるのが 2 回目の push 後になる。
 *
 * 「実際に push される」パスに関連するパターンだけを union に乗せ（無関係なローカル限定
 * パターンまで巻き込まない）、必要なら `ziku.jsonc` を push 候補へ注入する。
 *
 * @returns ziku.jsonc を補完した push 対象 FileDiff 配列と、その内容をローカルの
 *   `ziku.jsonc` へそのまま書き戻してよいか（`configWriteBackSafe`）。スコープ限定
 *   union（テンプレ + 関連パターンのみ）はローカルの他パターンを含まない部分集合になり
 *   得るため、`pushToLocal` の書き戻しにそのまま使うと無関係なローカル限定パターンを
 *   消してしまう。ローカル全体を和集合した場合（`configAlreadySelected` あるいは注入
 *   なし）だけ `true` を返す。
 */
async function applyNewlyTrackedConfigToPush(params: {
  targetDir: string;
  templateDir: string;
  newlyTrackedPaths: string[];
  pushableFiles: FileDiff[];
  diffFiles: FileDiff[];
  mergedContents: Map<string, PushContent>;
}): Promise<{ pushableFiles: FileDiff[]; configWriteBackSafe: boolean }> {
  const { targetDir, templateDir, newlyTrackedPaths, pushableFiles, diffFiles, mergedContents } =
    params;

  const configAlreadySelected = pushableFiles.some((f) => f.path === ZIKU_CONFIG_FILE);

  const selectedPaths = pushableFiles.map((f) => f.path);
  const selectedPathSet = new Set(selectedPaths);
  const trackedAndPushed = newlyTrackedPaths.filter((p) => selectedPathSet.has(p));

  // `--files` でファイル本体だけが指定され、事前に `ziku track` 済みのパターンが
  // ziku.jsonc の push 候補から漏れているケースを検出する（#90）。ziku.jsonc が既に
  // 選択済みなら classifyAndResolveConflicts が全パターンを union 済みなので不要。
  const preexistingRelevant = configAlreadySelected
    ? []
    : await findLocalOnlyPatternsForPaths({ targetDir, templateDir, paths: selectedPaths });

  if (trackedAndPushed.length === 0 && preexistingRelevant.length === 0) {
    return { pushableFiles, configWriteBackSafe: true };
  }

  // ziku.jsonc が既に明示選択済みなら、ユーザーの意図が明確なのでローカル全体を
  // 通常どおり和集合する（書き戻しも安全）。未選択のまま自動同梱する場合は、無関係な
  // ローカル限定パターンを漏らさないよう、テンプレ + 関連パターンだけに絞った和集合に
  // する（#90）。この部分集合はローカルへの書き戻しには使えない。
  //
  // configWriteBackSafe は「実際に使った merge 関数」と 1:1 で決まる値なので、
  // どの return 経路でも configAlreadySelected からその都度導出する（分岐ごとに
  // 別々の真偽値をハードコードすると、将来の変更でここだけ更新漏れが起きうる）。
  const configWriteBackSafe = configAlreadySelected;
  const mergedConfig = configAlreadySelected
    ? await computeMergedZikuConfig({ targetDir, templateDir, extraIncludes: trackedAndPushed })
    : await computeScopedZikuConfig({
        templateDir,
        additionalIncludes: [...trackedAndPushed, ...preexistingRelevant],
      });
  mergedContents.set(ZIKU_CONFIG_FILE, asPushContent(mergedConfig));

  // ziku.jsonc が既に push 候補にあれば content は mergedContents が採用されるので注入不要。
  if (configAlreadySelected) return { pushableFiles, configWriteBackSafe };

  // union がテンプレと同一なら伝える追加パターンは無い（注入しない）。
  const configDiff = diffFiles.find((f) => f.path === ZIKU_CONFIG_FILE);
  const templateConfig = configDiff === undefined ? undefined : templateContentOf(configDiff);
  if (mergedConfig === templateConfig) {
    return { pushableFiles, configWriteBackSafe };
  }

  if (preexistingRelevant.length > 0) {
    log.info(
      `Also pushing ${ZIKU_CONFIG_FILE} — it registers ${preexistingRelevant.length} pattern(s) needed by the file(s) in this push (#90):`,
    );
    for (const p of preexistingRelevant) log.message(`  ${pc.dim("+")} ${p}`);
  }

  // detectDiff が unchanged 判定で漏らしたケース → union を内容とする差分を注入する。
  // テンプレに ziku.jsonc が無ければ新規追加、あればその内容からの変更として表す。
  const configFileDiff: FileDiff =
    templateConfig === undefined
      ? { path: ZIKU_CONFIG_FILE, type: "added", localContent: mergedConfig }
      : {
          path: ZIKU_CONFIG_FILE,
          type: "modified",
          localContent: mergedConfig,
          templateContent: templateConfig,
        };

  return {
    pushableFiles: [...pushableFiles, configFileDiff],
    configWriteBackSafe,
  };
}

/**
 * dry-run プレビューで、実 push なら `applyNewlyTrackedConfigToPush` が自動同梱する
 * `ziku.jsonc` をあらかじめ知らせる（#90）。プレビュー自体への注入は行わない
 * （dry-run は「実際に push される集合」を見せる方針を保つ）。
 */
async function warnIfConfigWouldBeAutoIncluded(params: {
  targetDir: string;
  templateDir: string;
  previewFiles: FileDiff[];
}): Promise<void> {
  const { targetDir, templateDir, previewFiles } = params;
  if (previewFiles.some((f) => f.path === ZIKU_CONFIG_FILE)) return;

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

// ─── ファイル選択 ───

/**
 * `--files` 引数で push 対象を絞り込む純粋関数。
 *
 * dry-run プレビューと実 push の両方で同じフィルタ規則を使うために共有する。
 * 共有しないと「プレビューに出た集合」と「実際に push される集合」が
 * 食い違う（#81 の不具合の原因）。
 *
 * @returns filtered: 指定パスに一致した候補、notFound: 候補に存在しなかった指定パス。
 */
function filterByFilesArg(
  candidates: FileDiff[],
  filesArg: string,
): { filtered: FileDiff[]; notFound: string[] } {
  const requestedPaths = filesArg
    .split(",")
    .map((p) => p.trim())
    .filter(Boolean);
  const availablePaths = new Set(candidates.map((f) => f.path));
  const notFound = requestedPaths.filter((p) => !availablePaths.has(p));
  const requestedSet = new Set(requestedPaths);
  const filtered = candidates.filter((f) => requestedSet.has(f.path));
  return { filtered, notFound };
}

/**
 * 対話選択を経由せずに push 対象の既定集合を算出する（dry-run プレビュー用）。
 *
 * selectPushFiles の initialValues と同じ規則: 未解決の衝突と、
 * --include-deletions でない削除を既定で除外する。実 push の既定選択と
 * プレビューを一致させるために同一の規則を共有する。
 */
function defaultPushSelection(
  candidates: FileDiff[],
  opts: { includeDeletions: boolean; conflictedPaths: Set<string> },
): FileDiff[] {
  return candidates.filter(
    (f) => !opts.conflictedPaths.has(f.path) && (opts.includeDeletions || f.type !== "deleted"),
  );
}

/**
 * push 対象ファイルを選択する。
 *
 * `--files` 指定時はフィルタリング、`--yes` 指定時は既定集合、いずれも無ければ対話選択。
 * `--yes` で対話に落とすと、対話端末を持たない実行（CI）が入力待ちのまま何も送らずに
 * 終了し、成功したように見える。プロンプトを省くフラグである以上、ここも省いて
 * dry-run のプレビューと同じ集合を送る。
 *
 * 選択結果が空の場合はログを出力して空配列を返す。
 */
async function selectFilesToPush(
  candidates: FileDiff[],
  opts: {
    filesArg: string | undefined;
    includeDeletions: boolean;
    conflictedPaths: Set<string>;
    yes: boolean;
  },
): Promise<FileDiff[]> {
  if (opts.filesArg) {
    const { filtered, notFound } = filterByFilesArg(candidates, opts.filesArg);
    if (notFound.length > 0) log.warn(`Files not found: ${notFound.join(", ")}`);
    if (filtered.length === 0) {
      log.info("No matching files. Cancelled.");
      return [];
    }
    log.info(`${filtered.length} file(s) selected via --files`);
    return filtered;
  }

  if (opts.yes) {
    const selected = defaultPushSelection(candidates, opts);
    if (selected.length === 0) {
      log.info("No files to push.");
      return [];
    }
    log.info(`${selected.length} file(s) selected (--yes skips the selection prompt)`);
    return selected;
  }

  log.step("Selecting files...");
  const selected = await selectPushFiles(candidates, {
    preselectDeletions: opts.includeDeletions,
    conflictedPaths: opts.conflictedPaths,
  });
  if (selected.length === 0) {
    log.info("No files selected. Cancelled.");
  }
  return selected;
}

// ─── 分類 + コンフリクト解決 ───

/**
 * ローカル/テンプレート/ベースのハッシュを比較して push 対象を分類し、衝突は auto-merge を試みる。
 *
 * - localOnly / conflicts / deletedLocally / deletedWithLocalEdits を push 対象候補
 *   （pushableFilePaths）に含める。
 * - autoUpdate（テンプレートのみ変更）は push 対象外としてスキップ理由を表示する。
 * - 衝突は auto-merge を試行し、成功分は mergedContents に保存、失敗分は unresolvedConflicts に返す。
 *
 * 未解決の衝突があってもここでは中断しない（巻き添えで他ファイルの push を止めないため）。
 */
async function classifyAndResolveConflicts(params: {
  targetDir: string;
  templateDir: string;
  lock: LockState;
  patterns: { include: string[]; exclude: string[] };
  mergedContents: Map<string, PushContent>;
}): Promise<{
  pushableFilePaths: Set<string>;
  unresolvedConflicts: Set<string>;
  /** テンプレートが削除したがローカルに編集があるファイル。push はその削除を取り消す。 */
  deletedWithLocalEdits: Set<string>;
}> {
  const { classification } = await analyzeSync({
    targetDir: params.targetDir,
    templateDir: params.templateDir,
    baseHashes: baseHashesOf(params.lock),
    include: params.patterns.include,
    exclude: params.patterns.exclude,
  });

  const pushableFilePaths = new Set<string>();
  for (const file of classification.localOnly) pushableFilePaths.add(file);
  for (const file of classification.conflicts) pushableFilePaths.add(file);
  for (const file of classification.deletedLocally) pushableFilePaths.add(file);
  // テンプレートに無く、ローカルにだけ編集済みの内容がある状態。テンプレートへ送る候補
  // としては localOnly と同じ扱いになる（送るとテンプレート側の削除が取り消される点だけが
  // 異なり、それはサマリで明示する）。
  const deletedWithLocalEdits = new Set(classification.deletedWithLocalEdits);
  for (const file of deletedWithLocalEdits) pushableFilePaths.add(file);

  if (classification.autoUpdate.length > 0) {
    log.info(
      `Skipping ${classification.autoUpdate.length} file(s) only changed in template (use \`ziku pull\` to sync):`,
    );
    for (const file of classification.autoUpdate) {
      log.message(`  ${pc.dim("↓")} ${pc.dim(file)}`);
    }
  }

  // ziku.jsonc が push 対象なら、常に加法 union を送る（localOnly でも生のローカル
  // 内容を送らない）。生のローカルを送ると、ローカルがパターンを削除していた場合に
  // テンプレ側のパターンも消してしまい「削除は自動伝播しない」方針に反する（codex P2）。
  // union 内容を mergedContents に入れておくと、後段の files 構築で採用される。
  // ここで先に処理し、diff3（mergeOneFile）には ziku.jsonc を渡さない。
  if (pushableFilePaths.has(ZIKU_CONFIG_FILE)) {
    const merged = await computeMergedZikuConfig({
      targetDir: params.targetDir,
      templateDir: params.templateDir,
    });
    params.mergedContents.set(ZIKU_CONFIG_FILE, asPushContent(merged));
  }

  const unresolvedConflicts = new Set<string>();
  // ziku.jsonc は上で union 解決済みなので diff3 の対象から外す。
  const conflictsToResolve = classification.conflicts.filter((f) => f !== ZIKU_CONFIG_FILE);
  if (conflictsToResolve.length > 0) {
    const unresolved = await resolveConflicts(conflictsToResolve, {
      targetDir: params.targetDir,
      templateDir: params.templateDir,
      lock: params.lock,
      mergedContents: params.mergedContents,
    });
    for (const file of unresolved) unresolvedConflicts.add(file);
  }

  return { pushableFilePaths, unresolvedConflicts, deletedWithLocalEdits };
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
 * @returns auto-merge できなかった未解決ファイルのパス一覧。
 */
async function resolveConflicts(
  conflicts: string[],
  ctx: {
    targetDir: string;
    templateDir: string;
    lock: LockState;
    mergedContents: Map<string, PushContent>;
  },
): Promise<readonly string[]> {
  const baseSha = baseCommitSha(ctx.lock);
  const baseInfo = baseSha
    ? `since ${pc.bold(baseSha.slice(0, 7))} (your last sync)`
    : "since your last pull/init";
  log.warn(
    `Template updated ${baseInfo} — ${conflicts.length} conflict(s) detected, attempting auto-merge...`,
  );

  const autoMerged: string[] = [];

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
 * 未解決の衝突を push 対象に含めようとしたときの中断エラーを生成する。
 *
 * 未解決ファイルはマージ結果ではなくローカルの内容がそのまま push され、テンプレートの
 * 更新を黙って上書きしてしまう（mergedContents に保存されないため localContent が使われる）。
 * これを防ぐため、未解決ファイルが選択された場合は確定的に中断し、`ziku pull` での解決を促す。
 */
function unresolvedConflictError(files: string[]): ZikuError {
  return new ZikuError(
    `${files.length} selected file(s) have conflicts that couldn't be auto-merged`,
    "Resolve these conflicts before pushing:\n" +
      files.map((f) => `  • ${f}`).join("\n") +
      "\n\nRun `ziku pull` to bring in the template changes and resolve the conflicts, then push again.",
  );
}
