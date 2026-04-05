import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import { defineCommand } from "citty";
import { join, resolve } from "pathe";
import { MODULES_FILE, getModulesFilePath, modulesFileExists } from "../modules/index";
import type { CommandLifecycle } from "../docs/lifecycle-types";
import { MODULES_SCHEMA_URL } from "../modules/loader";
import type { TemplateModule } from "../modules/schemas";
import { ZikuError } from "../errors";
import { confirmScaffoldDevenvPR } from "../ui/prompts";
import { checkRepoExists, createDevenvScaffoldPR, getGitHubToken } from "../utils/github";
import { detectGitHubOwner, DEFAULT_TEMPLATE_REPO } from "../utils/git-remote";
import { intro, log, outro, pc } from "../ui/renderer";

// ビルド時に置換される定数
declare const __VERSION__: string;
const version = typeof __VERSION__ !== "undefined" ? __VERSION__ : "dev";

/**
 * setup コマンドのファイル操作メタデータ。
 * テンプレートリポジトリに .ziku/modules.jsonc を作成する。
 */
export const setupLifecycle: CommandLifecycle = {
  name: "setup",
  description: "テンプレートリポジトリの初期化",
  ops: [
    {
      file: MODULES_FILE,
      location: "template",
      op: "create",
      note: "デフォルトモジュールで生成（既存ならスキップ）",
    },
  ],
};

/**
 * AI agent の設定共有を主な用途として想定したデフォルトモジュール構成。
 * Claude Code のルール・スキル・フックと、MCP 設定、開発環境設定をグループ化する。
 */
const DEFAULT_SCAFFOLD_MODULES: TemplateModule[] = [
  {
    name: "Claude",
    description: "Claude Code rules, skills, and hooks",
    include: [
      ".claude/settings.json",
      ".claude/rules/*.md",
      ".claude/skills/**",
      ".claude/hooks/**",
    ],
  },
  {
    name: "MCP",
    description: "MCP server configuration",
    include: [".mcp.json"],
  },
  {
    name: "DevContainer",
    description: "VS Code DevContainer setup",
    include: [".devcontainer/**"],
  },
  {
    name: "GitHub",
    description: "GitHub Actions workflows",
    include: [".github/**"],
  },
];

/**
 * モジュール形式の modules.jsonc コンテンツを生成する。
 * テンプレートリポジトリの scaffold 用。
 */
export function generateDefaultModulesJsonc(): string {
  return JSON.stringify(
    {
      $schema: MODULES_SCHEMA_URL,
      modules: DEFAULT_SCAFFOLD_MODULES,
    },
    null,
    2,
  );
}

export const setupCommand = defineCommand({
  meta: {
    name: "setup",
    version,
    description: "Initialize a template repository with .ziku/modules.jsonc",
  },
  args: {
    dir: {
      type: "positional",
      description: "Template repository directory",
      default: ".",
    },
    remote: {
      type: "boolean",
      description: "Create a PR to set up a remote template repository instead of local",
      default: false,
    },
    from: {
      type: "string",
      description: "Remote template repository as owner/repo (used with --remote)",
    },
  },
  async run({ args }) {
    intro("setup");

    if (args.remote) {
      await handleRemoteSetup(args.from as string | undefined);
      return;
    }

    const targetDir = resolve(args.dir);
    handleLocalSetup(targetDir);
  },
});

/**
 * ローカルのテンプレートリポジトリに .ziku/modules.jsonc を作成する。
 *
 * テンプレートリポジトリのルートで `ziku setup` を実行した場合の処理。
 * modules.jsonc が既にあればスキップ。
 */
function handleLocalSetup(targetDir: string): void {
  log.info(`Target: ${pc.cyan(targetDir)}`);

  if (modulesFileExists(targetDir)) {
    log.success(".ziku/modules.jsonc already exists");
    outro("Template repository is already configured.");
    return;
  }

  log.step("Generating .ziku/modules.jsonc...");

  const modulesContent = generateDefaultModulesJsonc();
  const modulesDir = join(targetDir, ".ziku");
  if (!existsSync(modulesDir)) {
    mkdirSync(modulesDir, { recursive: true });
  }
  const modulesPath = getModulesFilePath(targetDir);
  writeFileSync(modulesPath, modulesContent);

  log.success("Created .ziku/modules.jsonc");

  outro(
    [
      "Template initialized!",
      "",
      pc.bold("Next steps:"),
      `  ${pc.cyan("1.")} Review and customize ${pc.dim(".ziku/modules.jsonc")}`,
      `  ${pc.cyan("2.")} ${pc.cyan("git add .ziku/ && git commit -m 'chore: add ziku config'")}`,
      `  ${pc.dim("Then other projects can use this template with")} ${pc.cyan("npx ziku init")}`,
    ].join("\n"),
  );
}

/**
 * リモートのテンプレートリポジトリに scaffold PR を作成する。
 *
 * テンプレートリポジトリに modules.jsonc がない場合に、
 * GitHub API 経由で PR を作成して追加する。
 */
async function handleRemoteSetup(from: string | undefined): Promise<void> {
  const { owner, repo } = resolveRemoteTarget(from);

  log.info(`Template: ${pc.cyan(`${owner}/${repo}`)}`);

  const exists = await checkRepoExists(owner, repo);
  if (!exists) {
    throw new ZikuError(
      `Repository ${owner}/${repo} not found`,
      "Check the --from value or create the repository first",
    );
  }

  const confirmed = await confirmScaffoldDevenvPR(owner, repo);
  if (!confirmed) {
    log.info("Cancelled.");
    return;
  }

  const token = getGitHubToken();
  if (!token) {
    throw new ZikuError(
      "GitHub token required to create a PR",
      "Set GITHUB_TOKEN or GH_TOKEN, or run: gh auth login",
    );
  }

  const modulesContent = generateDefaultModulesJsonc();
  log.step(`Creating PR to add .ziku/modules.jsonc to ${pc.cyan(`${owner}/${repo}`)}...`);
  const result = await createDevenvScaffoldPR(token, owner, repo, modulesContent);
  log.success(`Created PR: ${pc.cyan(result.url)}`);

  outro(
    [
      "PR created!",
      "",
      pc.bold("Next steps:"),
      `  ${pc.cyan("1.")} Review and merge the PR: ${pc.dim(result.url)}`,
      `  ${pc.cyan("2.")} Then run ${pc.cyan("npx ziku init")} in your project`,
    ].join("\n"),
  );
}

/**
 * --from 引数またはgit remoteからリモートテンプレートのowner/repoを解決する。
 */
function resolveRemoteTarget(from: string | undefined): { owner: string; repo: string } {
  if (from) {
    const slashIndex = from.indexOf("/");
    if (slashIndex === -1) {
      return { owner: from, repo: DEFAULT_TEMPLATE_REPO };
    }
    return { owner: from.slice(0, slashIndex), repo: from.slice(slashIndex + 1) };
  }

  const detectedOwner = detectGitHubOwner();
  if (detectedOwner) {
    return { owner: detectedOwner, repo: DEFAULT_TEMPLATE_REPO };
  }

  throw new ZikuError(
    "Cannot detect template source",
    "Specify --from <owner> or --from <owner/repo>",
  );
}
