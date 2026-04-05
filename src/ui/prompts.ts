/**
 * CLI プロンプト — @clack/prompts ベース
 *
 * 背景: prompts/init.ts + prompts/push.ts を統合。
 * @inquirer/prompts の checkbox/select/confirm/input/password を
 * @clack/prompts の multiselect/select/confirm/text/password に置き換え。
 *
 * 全プロンプトは Ctrl+C でキャンセル可能。handleCancel() で統一処理。
 */
import { execFileSync } from "node:child_process";
import { Effect } from "effect";
import * as p from "@clack/prompts";
import pc from "picocolors";
import { match } from "ts-pattern";
import type { FileDiff, OverwriteStrategy, TemplateModule } from "../modules/schemas";

/** ユーザーが Ctrl+C でキャンセルした場合の統一処理 */
function handleCancel(value: unknown): void {
  if (p.isCancel(value)) {
    p.cancel("Cancelled.");
    process.exit(0);
  }
}

// ─── init ─────────────────────────────────────────────────────

/** モジュール選択（TemplateModule[] を返す）— init 時にテンプレートがモジュール形式の場合に使用 */
export async function selectModules(moduleList: TemplateModule[]): Promise<TemplateModule[]> {
  const selected = await p.multiselect({
    message: "Select modules to install",
    options: moduleList.map((m) => ({
      value: m.name,
      label: m.name,
      hint: m.description,
    })),
    initialValues: moduleList.map((m) => m.name),
    required: true,
  });
  handleCancel(selected);
  const selectedNames = new Set(selected as string[]);
  return moduleList.filter((m) => selectedNames.has(m.name));
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
  return strategy as OverwriteStrategy;
}

// ─── init (template resolution) ──────────────────────────────

/**
 * テンプレートソース候補
 */
export interface TemplateCandidate {
  owner: string;
  repo: string;
  label: string;
  /** .ziku/modules.jsonc が存在するか（セットアップ済みか） */
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
  return action as MissingTemplateAction;
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
    },
  });
  handleCancel(source);
  return source as string;
}

/**
 * テンプレートリポジトリに .ziku/modules.jsonc が存在しない場合の確認
 */
export async function confirmScaffoldDevenvPR(owner: string, repo: string): Promise<boolean> {
  p.log.warn(
    `Template ${pc.cyan(`${owner}/${repo}`)} does not contain ${pc.cyan(".ziku/modules.jsonc")}`,
  );
  p.log.message(
    pc.dim(
      "This file defines which modules and file patterns ziku manages.\nIt must exist in the template repository to continue.",
    ),
  );

  const confirmed = await p.confirm({
    message: `Create a PR to add .ziku/modules.jsonc to ${owner}/${repo}?`,
  });
  handleCancel(confirmed);
  return confirmed as boolean;
}

// ─── push ─────────────────────────────────────────────────────

/**
 * ファイルの行数統計を "+N -M" 形式で返す（hint テキスト用）。
 */
function fileStatHint(file: FileDiff): string {
  let additions = 0;
  let deletions = 0;

  if (file.type === "added" && file.localContent) {
    additions = file.localContent.split("\n").length;
  } else if (file.type === "deleted" && file.templateContent) {
    deletions = file.templateContent.split("\n").length;
  } else if (file.type === "modified") {
    const local = file.localContent?.split("\n").length ?? 0;
    const tmpl = file.templateContent?.split("\n").length ?? 0;
    additions = Math.max(0, local - tmpl);
    deletions = Math.max(0, tmpl - local);
    if (additions === 0 && deletions === 0 && file.localContent !== file.templateContent) {
      additions = 1;
      deletions = 1;
    }
  }

  const parts: string[] = [];
  if (additions > 0) parts.push(pc.green(`+${additions}`));
  if (deletions > 0) parts.push(pc.red(`-${deletions}`));
  return parts.join(" ");
}

/**
 * push 対象ファイルの選択（+N -M 統計付き）
 */
export async function selectPushFiles(files: FileDiff[]): Promise<FileDiff[]> {
  const typeIcon = (type: string) =>
    match(type)
      .with("added", () => pc.green("+"))
      .with("modified", () => pc.yellow("~"))
      .with("deleted", () => pc.red("-"))
      .otherwise(() => " ");

  const selected = await p.multiselect({
    message: "Select files to include in PR",
    options: files.map((f) => {
      const hint = fileStatHint(f);
      return {
        value: f.path,
        label: `${typeIcon(f.type)} ${f.path}`,
        hint: hint || undefined,
      };
    }),
    initialValues: files.map((f) => f.path),
    required: false,
  });
  handleCancel(selected);
  const selectedPaths = new Set(selected as string[]);
  return files.filter((f) => selectedPaths.has(f.path));
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
    },
  });
  handleCancel(title);
  return title as string;
}

/**
 * 変更ファイル一覧から PR タイトルを自動生成する。
 */
export function generatePrTitle(files: FileDiff[]): string {
  const added = files.filter((f) => f.type === "added");
  const modified = files.filter((f) => f.type === "modified");

  // 変更種別に応じた prefix
  const prefix = added.length > 0 && modified.length === 0 ? "feat" : "chore";

  // ファイルパスからモジュール名（トップディレクトリ）を抽出
  const moduleNames = new Set<string>();
  for (const f of files) {
    const firstSegment = f.path.split("/")[0];
    moduleNames.add(firstSegment);
  }

  const names = [...moduleNames];
  if (names.length === 1) {
    const action = added.length > 0 && modified.length === 0 ? "add" : "update";
    return `${prefix}: ${action} ${names[0]} config`;
  }
  if (names.length <= 3) {
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
 * 変更ファイル一覧から PR 本文を自動生成する。
 */
export function generatePrBody(files: FileDiff[]): string {
  const added = files.filter((f) => f.type === "added");
  const modified = files.filter((f) => f.type === "modified");

  const sections: string[] = ["## Changes", ""];

  if (added.length > 0) {
    sections.push("**Added:**");
    for (const f of added) {
      sections.push(`- \`${f.path}\``);
    }
    sections.push("");
  }

  if (modified.length > 0) {
    sections.push("**Modified:**");
    for (const f of modified) {
      sections.push(`- \`${f.path}\``);
    }
    sections.push("");
  }

  sections.push("---");
  sections.push(
    "Generated by [ziku](https://github.com/tktcorporation/.github/tree/main/packages/ziku)",
  );

  return sections.join("\n");
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

/**
 * テンプレートで削除されたファイルの中から、ローカルでも削除するものを選択する。
 */
export async function selectDeletedFiles(files: string[]): Promise<string[]> {
  const result = await p.multiselect({
    message: "These files were deleted in template. Select to delete locally:",
    options: files.map((f) => ({ value: f, label: f })),
    required: false,
  });
  if (p.isCancel(result)) {
    p.cancel("Operation cancelled.");
    process.exit(0);
  }
  return result as string[];
}

/**
 * コンフリクトのあるファイルを $EDITOR で開く。
 */
export function openEditorForConflicts(filePaths: string[]): void {
  const editor = process.env.VISUAL || process.env.EDITOR || "vi";
  for (const filePath of filePaths) {
    // エディタが見つからない場合はスキップ
    Effect.runSync(
      Effect.try(() => execFileSync(editor, [filePath], { stdio: "inherit" })).pipe(
        Effect.orElseSucceed(() => {}),
      ),
    );
  }
}
