/**
 * CLI プロンプト — @clack/prompts ベース
 *
 * 背景: prompts/init.ts + prompts/push.ts を統合。
 * @inquirer/prompts の checkbox/select/confirm/input/password を
 * @clack/prompts の multiselect/select/confirm/text/password に置き換え。
 *
 * 全プロンプトは Ctrl+C でキャンセル可能。handleCancel() で統一処理。
 */
import { execSync } from "node:child_process";
import * as p from "@clack/prompts";
import pc from "picocolors";
import type { FileDiff, OverwriteStrategy, TemplateModule } from "../modules/schemas";

/** ユーザーが Ctrl+C でキャンセルした場合の統一処理 */
function handleCancel(value: unknown): void {
  if (p.isCancel(value)) {
    p.cancel("Cancelled.");
    process.exit(0);
  }
}

// ─── init ─────────────────────────────────────────────────────

/** モジュール選択 */
export async function selectModules(moduleList: TemplateModule[]): Promise<string[]> {
  const selected = await p.multiselect({
    message: "Select modules to install",
    options: moduleList.map((m) => ({
      value: m.id,
      label: m.name,
      hint: m.description,
    })),
    initialValues: moduleList.map((m) => m.id),
    required: true,
  });
  handleCancel(selected);
  return selected as string[];
}

/**
 * 上書き戦略の選択（プロジェクト状態に応じたスマートデフォルト付き）
 *
 * 背景: 新規プロジェクトでは overwrite が自然だが、再実行時（.devenv.json 既存）は
 * カスタマイズ済みファイルを誤って上書きしないよう skip をデフォルトにする。
 * ユーザーが毎回3択を読んで判断する必要をなくす。
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

/** テンプレートリポジトリが見つからない場合のアクション */
export type MissingTemplateAction = "create-repo" | "specify-source";

/**
 * テンプレートリポジトリが見つからない場合のアクション選択
 *
 * 背景: `{owner}/.github` が存在しない場合、ユーザーにリカバリ方法を提示する。
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

/** .devenv スキャフォールディング時のアクション */
export type ScaffoldDevenvAction = "scaffold-pr" | "scaffold-local" | "continue-without";

/**
 * テンプレートリポジトリに .devenv/modules.jsonc が存在しない場合のアクション選択
 *
 * 背景: テンプレートリポジトリが存在するが .devenv 構成がない場合、
 * デフォルトの modules.jsonc を生成して PR を作るか、ローカルでデフォルトを使うか選ばせる。
 */
export async function selectScaffoldDevenvAction(
  owner: string,
  repo: string,
): Promise<ScaffoldDevenvAction> {
  p.log.warn(
    `Template ${pc.cyan(`${owner}/${repo}`)} does not contain ${pc.cyan(".devenv/modules.jsonc")}`,
  );
  p.log.message(
    pc.dim(
      "This file defines which modules and file patterns ziku manages.\nYou can create it now to enable full template synchronization.",
    ),
  );

  const action = await p.select({
    message: "How would you like to proceed?",
    options: [
      {
        value: "scaffold-pr" as const,
        label: `Create PR to ${owner}/${repo}`,
        hint: "Generate .devenv/modules.jsonc and submit as a PR (requires GitHub token)",
      },
      {
        value: "scaffold-local" as const,
        label: "Use default modules locally",
        hint: "Continue with built-in defaults, no changes to the template repo",
      },
      {
        value: "continue-without" as const,
        label: "Continue without .devenv",
        hint: "Use built-in defaults (same as above, you can set up later)",
      },
    ],
  });
  handleCancel(action);
  return action as ScaffoldDevenvAction;
}

// ─── push ─────────────────────────────────────────────────────

/**
 * ファイルの行数統計を "+N -M" 形式で返す（hint テキスト用）。
 * git push の出力に合わせ、変更規模をひと目で把握できるようにする。
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
 *
 * 背景: git の `git add -p` に相当するファイル選択 UI。
 * 変更規模（行数増減）をヒントとして表示し、何を同期するか判断しやすくする。
 */
export async function selectPushFiles(files: FileDiff[]): Promise<FileDiff[]> {
  const typeIcon = (type: string) => {
    switch (type) {
      case "added":
        return pc.green("+");
      case "modified":
        return pc.yellow("~");
      case "deleted":
        return pc.red("-");
      default:
        return " ";
    }
  };

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
 *
 * 背景: ユーザーが空欄からタイトルを考える手間を省く。
 * 変更ファイルのパスからモジュール名を推測し、自動生成したタイトルを
 * デフォルト値として表示する。Enter でそのまま採用可能。
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
 *
 * 背景: "feat: add .devcontainer config" のような具体的なタイトルを
 * ファイルのパスと変更種別から推測し、ユーザーの入力負担を減らす。
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
 *
 * 背景: 以前は「追加する？」→「入力して」の2ステップだったが、
 * 変更ファイル一覧を自動生成してデフォルト表示することで
 * 1ステップ（Enter で採用 or 編集）に短縮する。
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
 *
 * 背景: ユーザーが本文を一から書く手間を省く。
 * 変更種別ごとにファイルを分類し、箇条書きで表示する。
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
 *
 * 背景: デフォルト値をコンテキストに応じて変更可能にする。
 * ファイル選択後の確認では true（ユーザーは既にレビュー済み）、
 * 破壊的操作の確認では false が適切。
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
 * 背景: pull 時の 3-way マージでコンフリクトが自動解決できなかった場合、
 * ユーザーにエディタで再解決するか、スキップするかを選ばせる。
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
 * 背景: テンプレートから削除されたファイルを自動削除すると意図しないデータ損失の
 * リスクがあるため、ユーザーに明示的に選ばせる。
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
 * 背景: 3-way マージでコンフリクトが発生した場合、ユーザーが手動で解決する必要がある。
 * $VISUAL → $EDITOR → vi の優先順でエディタを選択する。
 */
export function openEditorForConflicts(filePaths: string[]): void {
  const editor = process.env.VISUAL || process.env.EDITOR || "vi";
  for (const filePath of filePaths) {
    try {
      execSync(`${editor} ${filePath}`, { stdio: "inherit" });
    } catch {
      // エディタが見つからない場合はスキップ
    }
  }
}
