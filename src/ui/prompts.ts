/**
 * CLI のプロンプトを一箇所に集める。
 *
 * どのコマンドから呼ばれても Ctrl+C の扱いと表示の作法が揃うようにするため、
 * 対話の入口はここだけにする。全プロンプトは handleCancel() を通り、
 * キャンセルされたらその場でプロセスを終える。
 */
import { execFileSync } from "node:child_process";
import { Effect } from "effect";
import * as p from "@clack/prompts";
import pc from "picocolors";
import { match } from "ts-pattern";
import type { PushSend } from "../commands/push-plan";
import { pushSummaryRows } from "../commands/push-plan";
import type {
  GlobPattern,
  FileDiff,
  OverwriteStrategy,
  RepoRelPath,
  UnmergedConflict,
} from "../modules/schemas";
import type { UntrackedFilesByFolder } from "../utils/untracked";
import { getTypeIcon } from "./diff-view";
import type { FileSelectionMarks } from "./file-select-with-diff";
import {
  fileSelectionHint,
  isPreselectedByDefault,
  selectFilesWithDiffPreview,
} from "./file-select-with-diff";

/**
 * ユーザーが Ctrl+C でキャンセルした場合の統一処理。
 *
 * clack のプロンプトはキャンセルを戻り値の symbol で表すため、戻り値の型は
 * 常に「本来の値 | symbol」になる。この関数を通した後は symbol であれば
 * プロセスが終わっているので、呼び出し側は本来の値だけを扱えばよい。それを
 * 型アサーションではなく assertion signature で表し、絞り込みを型に担保させる。
 */
function handleCancel<T>(value: T | symbol): asserts value is T {
  if (p.isCancel(value)) {
    p.cancel("Cancelled.");
    process.exit(0);
  }
}

// ─── init ─────────────────────────────────────────────────────

/**
 * テンプレートのトップレベルディレクトリを選択する。
 *
 * テンプレートの include パターンからトップレベルディレクトリとルートファイルを抽出し、
 * ユーザーに選択させる。選択結果はパターン文字列の配列。
 */
export async function selectDirectories(
  entries: Array<{ label: string; patterns: GlobPattern[] }>,
): Promise<GlobPattern[]> {
  const selected = await p.multiselect({
    message: "Select directories to sync",
    options: entries.map((e) => ({
      value: e.label,
      label: e.label,
      hint: e.patterns.join(", "),
    })),
    initialValues: entries.map((e) => e.label),
    required: true,
  });
  handleCancel(selected);
  const selectedLabels = new Set(selected as string[]);
  return entries.filter((e) => selectedLabels.has(e.label)).flatMap((e) => e.patterns);
}

/**
 * 上書き戦略の選択（プロジェクト状態に応じたスマートデフォルト付き）
 */
export async function selectOverwriteStrategy(options?: {
  isReinit?: boolean;
}): Promise<OverwriteStrategy> {
  const isReinit = options?.isReinit ?? false;

  const strategy = await p.select({
    message: isReinit
      ? "How to handle existing files? (re-init detected → Skip recommended)"
      : "How to handle existing files?",
    initialValue: isReinit ? ("skip" as const) : ("overwrite" as const),
    options: [
      { value: "overwrite" as const, label: "Overwrite all" },
      { value: "skip" as const, label: "Skip (keep existing)" },
      { value: "prompt" as const, label: "Ask for each file" },
    ],
  });
  handleCancel(strategy);
  return strategy;
}

// ─── init (template resolution) ──────────────────────────────

/**
 * テンプレートソース候補
 */
export interface TemplateCandidate {
  owner: string;
  repo: string;
  label: string;
  /** .ziku/ziku.jsonc が存在するか（セットアップ済みか） */
  ready?: boolean;
}

/**
 * 検出されたテンプレート候補からユーザーに選択させる。
 *
 * 候補が1つの場合は確認、複数の場合は選択肢を表示する。
 * いずれの場合も「別のリポジトリを指定する」オプションを含む。
 */
export async function selectTemplateCandidate(
  candidates: TemplateCandidate[],
): Promise<{ owner: string; repo: string } | "specify-other"> {
  const options = [
    ...candidates.map((c) => {
      const readyHint = c.ready === true ? " (ready)" : c.ready === false ? " (not set up)" : "";
      return {
        value: `${c.owner}/${c.repo}` as string,
        label: `${c.owner}/${c.repo}`,
        hint: `${c.label}${readyHint}`,
      };
    }),
    {
      value: "__other__" as string,
      label: "Specify a different repository",
      hint: "Enter owner/repo manually",
    },
  ];

  const selected = await p.select({
    message: "Which template repository to use?",
    options,
    initialValue: options[0].value,
  });
  handleCancel(selected);

  if (selected === "__other__") {
    return "specify-other";
  }

  const slashIndex = (selected as string).indexOf("/");
  return {
    owner: (selected as string).slice(0, slashIndex),
    repo: (selected as string).slice(slashIndex + 1),
  };
}

/** テンプレートリポジトリが見つからない場合のアクション */
export type MissingTemplateAction = "create-repo" | "specify-source";

/**
 * テンプレートリポジトリが見つからない場合のアクション選択
 */
export async function selectMissingTemplateAction(
  owner: string,
  repo: string,
): Promise<MissingTemplateAction> {
  p.log.warn(`Template repository ${pc.cyan(`${owner}/${repo}`)} was not found.`);
  p.log.message(
    pc.dim(
      "This repository is used as a dev environment template source.\nYou can create one or specify an existing repository.",
    ),
  );

  const action = await p.select({
    message: "How would you like to proceed?",
    options: [
      {
        value: "create-repo" as const,
        label: `Create ${owner}/${repo}`,
        hint: "Create an empty template repository (requires GitHub token)",
      },
      {
        value: "specify-source" as const,
        label: "Specify a different repository",
        hint: "Enter owner/repo manually",
      },
    ],
  });
  handleCancel(action);
  return action;
}

/**
 * テンプレートソースの入力
 */
export async function inputTemplateSource(defaultValue?: string): Promise<string> {
  const source = await p.text({
    message: "Template source (owner/repo)",
    defaultValue,
    placeholder: defaultValue ?? "my-org/my-templates",
    validate: (value) => {
      if (!value?.trim()) return "Source is required";
      const slashIndex = value.indexOf("/");
      if (slashIndex === -1 || slashIndex === 0 || slashIndex === value.length - 1) {
        return "Expected format: owner/repo";
      }
      return undefined;
    },
  });
  handleCancel(source);
  return source as string;
}

// ─── push ─────────────────────────────────────────────────────

/**
 * push 対象ファイルの選択（Diff プレビュー付き）
 *
 * TTY 環境では diff プレビュー付きのカスタムセレクタを使い、
 * 非 TTY 環境（テスト・CI）では @clack/prompts のフォールバックを使う。
 */
export function selectPushFiles(files: FileDiff[], marks: FileSelectionMarks): Promise<FileDiff[]> {
  // TTY: diff プレビュー付きカスタムセレクタ
  // stdin と stdout の両方が TTY であることを確認する。
  // stdout がリダイレクトされている場合（例: ziku push > out.txt）、
  // ANSI 制御シーケンスが非対話ストリームに出力され操作不能になる。
  if (process.stdin.isTTY && process.stdout.isTTY) {
    return selectFilesWithDiffPreview(files, marks);
  }

  // 非 TTY フォールバック: @clack/prompts multiselect
  return selectPushFilesFallback(files, marks);
}

/**
 * 非 TTY 環境用フォールバック（@clack/prompts multiselect）
 *
 * テスト・パイプ経由の実行で使われる。
 */
export async function selectPushFilesFallback(
  files: FileDiff[],
  marks: FileSelectionMarks,
): Promise<FileDiff[]> {
  const selected = await p.multiselect({
    message: "Select files to include in PR",
    options: files.map((f) => ({
      value: f.path,
      label: `${getTypeIcon(f.type)} ${f.path}`,
      hint: fileSelectionHint(f, marks) || undefined,
    })),
    initialValues: files.filter((f) => isPreselectedByDefault(f, marks)).map((f) => f.path),
    required: false,
  });
  handleCancel(selected);
  const selectedPaths = new Set(selected as string[]);
  return files.filter((f) => selectedPaths.has(f.path));
}

/**
 * 監視フォルダ内の未追跡ファイルから、追跡対象（include 追加）にするものを選択させる。
 *
 * git の interactive add 相当の体験。push 時に検知した「ホワイトリスト外の新規ファイル」を
 * その場で追跡対象に取り込めるようにする。デフォルトは全未選択にする（暗黙追加を避け、
 * ユーザーが明示的に選んだものだけを include へ昇格させるため）。
 *
 * @returns 選択されたファイルパスの配列（= include に追加するパターン）。0 件なら何も追跡しない。
 */
export async function selectUntrackedToTrack(
  untrackedByFolder: UntrackedFilesByFolder[],
): Promise<RepoRelPath[]> {
  const options = untrackedByFolder.flatMap((group) =>
    group.files.map((file) => ({
      value: file.path,
      label: file.path,
      hint: group.folder,
    })),
  );

  const selected = await p.multiselect({
    message: "Untracked files found. Select files to track and include in this push:",
    options,
    // 明示的に選ばせる（暗黙の include 追加を避ける）
    initialValues: [],
    required: false,
  });
  handleCancel(selected);
  return selected;
}

/**
 * 未追跡ファイル一覧と `track` コマンドの案内を表示する。
 *
 * push の非対話時（--yes / --dry-run）と diff で共用する。対話 push では
 * selectUntrackedToTrack のプロンプト自体が案内面を兼ねるため、こちらは使わない。
 *
 * @param headline 先頭の警告文。push と diff で文脈が異なるため差し替え可能にする。
 */
export function logUntrackedFilesNotice(
  untrackedByFolder: UntrackedFilesByFolder[],
  untrackedCount: number,
  opts?: { headline?: string },
): void {
  const headline =
    opts?.headline ?? `${untrackedCount} untracked file(s) found outside the sync whitelist:`;
  p.log.warn(headline);
  const untrackedLines = untrackedByFolder.flatMap((group) =>
    group.files.map((file) => `  ${pc.dim("•")} ${file.path}`),
  );
  p.log.message(untrackedLines.join("\n"));
  p.log.info(
    `To include these files in sync, add them to tracking with the ${pc.cyan("track")} command:`,
  );
  p.log.message(pc.dim(`  npx ziku track "<pattern>"`));
  p.log.message(
    pc.dim(
      `  Example: npx ziku track "${untrackedByFolder[0]?.files[0]?.path || ".cloud/rules/*.md"}"`,
    ),
  );
}

/**
 * PR タイトル入力（変更内容からスマートなデフォルトを生成）
 */
export async function inputPrTitle(defaultTitle?: string): Promise<string> {
  const title = await p.text({
    message: "PR title",
    defaultValue: defaultTitle,
    placeholder: defaultTitle ? undefined : "feat: update template config",
    validate: (value) => {
      if (!value?.trim()) return "Title is required";
      return undefined;
    },
  });
  handleCancel(title);
  return title as string;
}

/**
 * PR の文面が使うファイル一覧を、種別ごとに分けたもの。
 */
interface PrFileGroups {
  readonly added: readonly RepoRelPath[];
  readonly modified: readonly RepoRelPath[];
  readonly deleted: readonly RepoRelPath[];
  /** 選択によらず ziku が付け足したファイル。 */
  readonly autoUpdated: readonly RepoRelPath[];
}

/**
 * 送信対象を、PR の文面が使うグループへ振り分ける。
 *
 * 種別は選択時の差分ではなく、実際に送る内容から決め直したもの（{@link pushSummaryRows}）を
 * 使う。端末のサマリと PR の文面が同じ行から作られるので、同じ push について両者が別の
 * ファイル一覧を示すことがない。
 */
function groupPrFiles(send: PushSend): PrFileGroups {
  const added: RepoRelPath[] = [];
  const modified: RepoRelPath[] = [];
  const deleted: RepoRelPath[] = [];
  const autoUpdated: RepoRelPath[] = [];

  for (const row of pushSummaryRows(send)) {
    match(row)
      .with({ _tag: "Change" }, ({ diff }) => {
        match(diff.type)
          .with("added", () => added.push(diff.path))
          .with("modified", () => modified.push(diff.path))
          .with("deleted", () => deleted.push(diff.path))
          .exhaustive();
      })
      .with({ _tag: "AutoUpdated" }, ({ path }) => {
        autoUpdated.push(path);
      })
      .exhaustive();
  }

  return { added, modified, deleted, autoUpdated };
}

/**
 * 送信対象から PR タイトルを組み立てる。
 *
 * 引数を {@link PushSend} に限るのは、PR の文面を「実際に送る集合」以外から組み立てられ
 * ないようにするため。選択そのものを受け取れると、送信直前に足したファイルが載らない・
 * 送るのをやめたファイルが載る、という食い違いを型が止められない。
 *
 * 名前に採るのは ziku が付け足したファイルではなく、利用者が変えたファイルのモジュール名。
 * 付け足す側は導出物（`ziku.jsonc` から組み直す README など）で、その push が何をする
 * ものかを表さない。
 */
export function generatePrTitle(send: PushSend): string {
  const { added, modified, deleted } = groupPrFiles(send);

  // 変更種別に応じた prefix
  const prefix =
    added.length > 0 && modified.length === 0 && deleted.length === 0 ? "feat" : "chore";

  // ファイルパスからモジュール名（トップディレクトリ）を抽出
  const moduleNames = new Set<string>();
  for (const path of [...added, ...modified, ...deleted]) {
    const firstSegment = path.split("/")[0];
    moduleNames.add(firstSegment);
  }

  const names = [...moduleNames];
  if (names.length === 1) {
    const action = added.length > 0 && modified.length === 0 ? "add" : "update";
    return `${prefix}: ${action} ${names[0]} config`;
  }
  if (names.length > 0 && names.length <= 3) {
    return `${prefix}: update ${names.join(", ")} config`;
  }
  return `${prefix}: update template configuration`;
}

/**
 * PR 本文入力（変更一覧から自動生成したデフォルト付き）
 */
export async function inputPrBody(defaultBody?: string): Promise<string | undefined> {
  const body = await p.text({
    message: "PR description (Enter to accept, or edit)",
    defaultValue: defaultBody,
    placeholder: defaultBody ? undefined : "Optional description",
  });
  handleCancel(body);
  const result = (body as string)?.trim();
  return result || undefined;
}

/**
 * 送信対象から PR 本文を組み立てる。
 *
 * 引数を {@link PushSend} に限る理由は {@link generatePrTitle} と同じ。本文は端末サマリと
 * 同格の「送る内容の提示」なので、同じ集合からしか作れないようにする。
 *
 * 選択によらず ziku が付け足したファイルは `Auto-updated` として別に並べる。利用者が
 * 選んだ変更と混ぜると、テンプレート側のレビュアーがどれを人が書いたものとして読むべきか
 * 判断できない。
 */
export function generatePrBody(send: PushSend): string {
  const { added, modified, deleted, autoUpdated } = groupPrFiles(send);

  const sections: string[] = ["## Changes", ""];

  appendFileList(sections, "**Added:**", added);
  appendFileList(sections, "**Modified:**", modified);
  appendFileList(sections, "**Deleted:**", deleted);
  appendFileList(sections, "**Auto-updated:**", autoUpdated);

  sections.push("---");
  sections.push(
    "Generated by [ziku](https://github.com/tktcorporation/.github/tree/main/packages/ziku)",
  );

  return sections.join("\n");
}

/** 見出しとファイル一覧を本文へ足す。空のグループは見出しごと出さない。 */
function appendFileList(sections: string[], heading: string, paths: readonly RepoRelPath[]): void {
  if (paths.length === 0) return;
  sections.push(heading);
  for (const path of paths) sections.push(`- \`${path}\``);
  sections.push("");
}

/** GitHub トークン入力 */
export async function inputGitHubToken(): Promise<string> {
  p.log.warn("GitHub token not found.");
  p.log.message(
    [
      "Set one of these environment variables:",
      `  ${pc.cyan("GITHUB_TOKEN")} or ${pc.cyan("GH_TOKEN")}`,
      "",
      "Or enter it below:",
    ].join("\n"),
  );

  const token = await p.password({
    message: "GitHub Personal Access Token",
    validate: (value) => {
      if (!value?.trim()) return "Token is required";
      if (
        !value.startsWith("ghp_") &&
        !value.startsWith("gho_") &&
        !value.startsWith("github_pat_")
      ) {
        return "Invalid GitHub token format";
      }
      return undefined;
    },
  });
  handleCancel(token);
  return token as string;
}

/**
 * 確認プロンプト
 */
export async function confirmAction(
  message: string,
  options?: { initialValue?: boolean },
): Promise<boolean> {
  const confirmed = await p.confirm({
    message,
    initialValue: options?.initialValue ?? false,
  });
  handleCancel(confirmed);
  return confirmed as boolean;
}

// ─── pull (conflict resolution) ──────────────────────────────

/**
 * コンフリクトマーカーが残っている場合にリトライを確認する。
 */
export async function confirmRetryConflictResolution(): Promise<boolean> {
  const result = await p.confirm({
    message: "Conflict markers remain. Open editor again?",
    initialValue: true,
  });
  if (p.isCancel(result)) {
    p.cancel("Operation cancelled.");
    process.exit(0);
  }
  return result;
}

/** 削除候補ファイルの multiselect。選択されなかったファイルはローカルに残る。 */
async function selectFilesToDelete(
  message: string,
  options: Array<{ value: RepoRelPath; label: string; hint?: string }>,
): Promise<RepoRelPath[]> {
  const result = await p.multiselect({ message, options, required: false });
  if (p.isCancel(result)) {
    p.cancel("Operation cancelled.");
    process.exit(0);
  }
  return result as RepoRelPath[];
}

/**
 * テンプレートで削除されたファイルの中から、ローカルでも削除するものを選択する。
 */
export function selectDeletedFiles(files: readonly RepoRelPath[]): Promise<RepoRelPath[]> {
  return selectFilesToDelete(
    "These files were deleted in template. Select to delete locally:",
    files.map((f) => ({ value: f, label: f })),
  );
}

/**
 * テンプレートで削除され、かつローカルに編集があるファイルの削除対象を選択する。
 *
 * 削除するとローカルの編集が失われる。選択を省略できる操作にしないため、
 * `--force` を含むどの経路でもこのプロンプトを通す。
 */
export function selectDeletedFilesWithLocalEdits(
  files: readonly RepoRelPath[],
): Promise<RepoRelPath[]> {
  return selectFilesToDelete(
    "These files were deleted in template but you edited them locally. Select to delete (your edits will be lost):",
    files.map((f) => ({ value: f, label: f, hint: "locally edited" })),
  );
}

/**
 * 自動マージできなかったファイルについて、どちらの内容を残すか。
 *
 * どちらを選んでも同期ベースはテンプレート側へ前進する。`keepLocal` は git の `--ours` と
 * 同じく「テンプレートの変更を意図して拒否した」という意思表示になる。
 */
export type UnmergedResolution = "keepLocal" | "takeTemplate";

/**
 * 自動マージできなかった 1 ファイルの扱いを選ばせる。
 *
 * ziku がこのファイルに何も書いていないため、ローカルの内容だけでは「解決済みか」を
 * 判定できない。既定はローカル維持で、テンプレートの内容を取る側だけがファイルを
 * 上書きする（失って困るのはユーザーが書いた内容のほう）。
 */
export async function selectUnmergedResolution(
  conflict: UnmergedConflict,
): Promise<UnmergedResolution> {
  const why = match(conflict.reason)
    .with(
      "noBase",
      () => "the base version is unavailable, so local and template changes can't be told apart",
    )
    .with("binary", () => "binary files have no lines to merge")
    .exhaustive();

  const resolution = await p.select({
    message: `${pc.cyan(conflict.path)} — ${why}. Which version should stay?`,
    initialValue: "keepLocal" as UnmergedResolution,
    options: [
      {
        value: "keepLocal" as const,
        label: "Keep my local version",
        hint: "rejects the template's change for this file",
      },
      {
        value: "takeTemplate" as const,
        label: "Take the template version",
        hint: "overwrites your local file",
      },
    ],
  });
  handleCancel(resolution);
  return resolution;
}

/**
 * コンフリクトのあるファイルを $EDITOR で開く。
 */
export function openEditorForConflicts(filePaths: readonly string[]): void {
  const editor = process.env.VISUAL || process.env.EDITOR || "vi";
  for (const filePath of filePaths) {
    // エディタ起動失敗は None → スキップ（呼び出し側で対処不要な fire-and-forget）
    Effect.runSync(
      Effect.try(() => execFileSync(editor, [filePath], { stdio: "inherit" })).pipe(Effect.option),
    );
  }
}
