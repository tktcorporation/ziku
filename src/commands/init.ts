import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import { defineCommand } from "citty";
import { join, resolve } from "pathe";
import {
  getModulesFilePath,
  loadTemplateModulesFile,
  modulesFileExists,
} from "../modules/index";
import { MODULES_SCHEMA_URL } from "../modules/loader";
import type {
  Answers,
  FileOperationResult,
  OverwriteStrategy,
  TemplateModule,
} from "../modules/schemas";
import { BermError } from "../errors";
import {
  confirmScaffoldDevenvPR,
  inputTemplateSource,
  selectMissingTemplateAction,
  selectModules,
  selectOverwriteStrategy,
  selectTemplateModules,
} from "../ui/prompts";
import { DEFAULT_TEMPLATE_REPO, detectGitHubOwner, detectGitHubRepo } from "../utils/git-remote";
import {
  checkRepoExists,
  createDevenvScaffoldPR,
  getGitHubToken,
  resolveLatestCommitSha,
  scaffoldTemplateRepo,
} from "../utils/github";
import { hashFiles } from "../utils/hash";
import {
  buildTemplateSource,
  downloadTemplateToTemp,
  fetchTemplates,
  writeFileWithStrategy,
} from "../utils/template";
import type { FlatPatterns } from "../utils/patterns";
import { intro, log, logFileResults, outro, pc, withSpinner } from "../ui/renderer";

// ビルド時に置換される定数
declare const __VERSION__: string;
const version = typeof __VERSION__ !== "undefined" ? __VERSION__ : "dev";

export const initCommand = defineCommand({
  meta: {
    name: "ziku",
    version,
    description: "Apply dev environment template to your project",
  },
  args: {
    dir: {
      type: "positional",
      description: "Target directory",
      default: ".",
    },
    force: {
      type: "boolean",
      description: "Overwrite existing files",
      default: false,
    },
    yes: {
      type: "boolean",
      alias: "y",
      description: "Select all modules (non-interactive mode)",
      default: false,
    },
    modules: {
      type: "string",
      alias: "m",
      description: "Comma-separated module names to apply (non-interactive)",
    },
    "overwrite-strategy": {
      type: "string",
      alias: "s",
      description: "Overwrite strategy: overwrite, skip, or prompt (non-interactive)",
    },
    from: {
      type: "string",
      description: "Template source as owner/repo (e.g., my-org/my-templates)",
    },
  },
  async run({ args }) {
    // ヘッダー表示
    intro();

    // "init" という引数は無視して現在のディレクトリを使用
    const dir = args.dir === "init" ? "." : args.dir;
    const targetDir = resolve(dir);

    log.info(`Target: ${pc.cyan(targetDir)}`);

    // ディレクトリ作成
    if (!existsSync(targetDir)) {
      mkdirSync(targetDir, { recursive: true });
      log.message(pc.dim(`Created directory: ${targetDir}`));
    }

    // テンプレートソースを解決（テンプレートリポジトリの存在チェック含む）
    const { sourceOwner, sourceRepo } = await resolveTemplateSourceWithCheck(
      args.from as string | undefined,
      args.yes as boolean,
    );

    // テンプレートリポジトリ自体で実行されているか判定
    if (isCurrentRepoTemplate(targetDir, sourceOwner, sourceRepo)) {
      await handleTemplateRepoInit(targetDir, args.yes as boolean);
      return;
    }

    const templateSourceStr = buildTemplateSource({
      owner: sourceOwner,
      repo: sourceRepo,
    });
    log.info(`Template: ${pc.cyan(`${sourceOwner}/${sourceRepo}`)}`);

    // Step 1: テンプレートをダウンロード
    log.step("Fetching template...");

    const { templateDir, cleanup } = await withSpinner("Downloading template from GitHub...", () =>
      downloadTemplateToTemp(targetDir, templateSourceStr),
    );

    try {
      // modules.jsonc からモジュールを読み込み
      let moduleList: TemplateModule[];
      if (modulesFileExists(templateDir)) {
        const { modules: loadedModules } = await loadTemplateModulesFile(templateDir);
        moduleList = loadedModules;
      } else {
        // .ziku/modules.jsonc がテンプレートに存在しない場合のハンドリング
        moduleList = await handleMissingDevenv(sourceOwner, sourceRepo, args.yes as boolean);
      }

      // Step 2: モジュール選択
      log.step("Selecting modules...");

      let answers: Answers;
      const hasModulesArg = typeof args.modules === "string" && args.modules.length > 0;
      const hasStrategyArg =
        typeof args["overwrite-strategy"] === "string" && args["overwrite-strategy"].length > 0;

      if (args.yes || hasModulesArg) {
        // --yes: 全モジュール選択、--modules: 指定モジュール選択
        let selectedModules: TemplateModule[];
        if (hasModulesArg) {
          const requestedNames = (args.modules as string).split(",").map((s) => s.trim());
          const validNames = moduleList.map((m) => m.name);
          const invalidNames = requestedNames.filter((name) => !validNames.includes(name));
          if (invalidNames.length > 0) {
            throw new BermError(
              `Unknown module(s): ${invalidNames.join(", ")}`,
              `Available modules: ${validNames.join(", ")}`,
            );
          }
          selectedModules = moduleList.filter((m) => requestedNames.includes(m.name));
        } else {
          selectedModules = [...moduleList];
        }

        // --overwrite-strategy: 指定戦略、なければ overwrite
        let overwriteStrategy: OverwriteStrategy = "overwrite";
        if (hasStrategyArg) {
          const strategy = args["overwrite-strategy"] as string;
          if (strategy !== "overwrite" && strategy !== "skip" && strategy !== "prompt") {
            throw new BermError(
              `Invalid overwrite strategy: ${strategy}`,
              "Must be: overwrite, skip, or prompt",
            );
          }
          overwriteStrategy = strategy;
        }

        answers = {
          selectedModules,
          overwriteStrategy,
        };
        log.info(`Selected ${pc.cyan(selectedModules.length.toString())} modules`);
      } else if (hasStrategyArg) {
        // --overwrite-strategy のみ指定：モジュール選択はインタラクティブ
        const strategy = args["overwrite-strategy"] as string;
        if (strategy !== "overwrite" && strategy !== "skip" && strategy !== "prompt") {
          throw new BermError(
            `Invalid overwrite strategy: ${strategy}`,
            "Must be: overwrite, skip, or prompt",
          );
        }
        const selectedModules = await selectModules(moduleList);
        const overwriteStrategy = strategy;
        answers = { selectedModules, overwriteStrategy };
      } else {
        const selectedModules = await selectModules(moduleList);
        // .ziku.json が既に存在する場合は再実行と判断し、skip をデフォルトに推奨する
        const configExists = existsSync(resolve(targetDir, ".ziku.json"));
        const overwriteStrategy = await selectOverwriteStrategy({ isReinit: configExists });
        answers = { selectedModules, overwriteStrategy };
      }

      if (answers.selectedModules.length === 0) {
        log.warn("No modules selected");
        return;
      }

      // Step 3: ファイルをコピー
      log.step("Applying templates...");

      const effectiveStrategy: OverwriteStrategy = args.force
        ? "overwrite"
        : answers.overwriteStrategy;

      // 選択されたモジュールからフラットパターンを構築
      const flatPatterns: FlatPatterns = {
        include: answers.selectedModules.flatMap((m) => m.include),
        exclude: answers.selectedModules.flatMap((m) => m.exclude ?? []),
      };

      // テンプレート取得・適用（サイレントモード - 後でまとめて表示）
      const templateResults = await fetchTemplates({
        targetDir,
        overwriteStrategy: effectiveStrategy,
        patterns: flatPatterns,
        templateDir,
      });

      const allResults: FileOperationResult[] = [...templateResults];

      // devcontainer.env.example を戦略に従って作成
      const hasDevcontainer = flatPatterns.include.some((p) =>
        p.startsWith(".devcontainer/"),
      );
      if (hasDevcontainer) {
        const envResult = await createEnvExample(targetDir, effectiveStrategy);
        allResults.push(envResult);
      }

      // 選択されたモジュールのみで modules.jsonc を生成してローカルに保存
      const modulesJsoncResult = await writeSelectedModulesJsonc(
        targetDir,
        answers.selectedModules,
        effectiveStrategy,
      );
      allResults.push(modulesJsoncResult);

      // テンプレートファイルのハッシュを計算（pull 時の差分検出用）
      const baseHashes = await hashFiles(templateDir, flatPatterns.include, flatPatterns.exclude);

      // テンプレートリポジトリの最新コミット SHA を取得（3-way マージのベース用）
      const baseRef = await resolveLatestCommitSha(sourceOwner, sourceRepo);

      // 設定ファイル生成（常に更新）
      const configResult = await createDevEnvConfig(targetDir, {
        owner: sourceOwner,
        repo: sourceRepo,
        baseHashes,
        baseRef,
      });
      allResults.push(configResult);

      // ファイル操作結果を表示（サマリー含む）
      const summary = logFileResults(allResults);

      // 変更がない場合
      if (summary.added === 0 && summary.updated === 0) {
        log.info("No changes were made");
        return;
      }

      // モジュール別の説明を表示
      displayModuleDescriptions(answers.selectedModules, allResults);

      // 成功メッセージと次のステップ
      outro(
        [
          "Setup complete!",
          "",
          `${pc.bold("Next steps:")}`,
          `  ${pc.cyan("git add . && git commit -m 'chore: add ziku config'")}`,
          `  ${pc.dim("Commit the changes")}`,
          `  ${pc.cyan("npx ziku diff")}`,
          `  ${pc.dim("Check for updates from upstream")}`,
        ].join("\n"),
      );
    } finally {
      cleanup();
    }
  },
});

const ENV_EXAMPLE_CONTENT = `# 環境変数サンプル
# このファイルを devcontainer.env にコピーして値を設定してください

# GitHub Personal Access Token
GH_TOKEN=

# AWS Credentials (optional)
AWS_ACCESS_KEY_ID=
AWS_SECRET_ACCESS_KEY=
AWS_DEFAULT_REGION=ap-northeast-1

# WakaTime API Key (optional)
WAKATIME_API_KEY=
`;

async function createEnvExample(
  targetDir: string,
  strategy: OverwriteStrategy,
): Promise<FileOperationResult> {
  return writeFileWithStrategy({
    destPath: resolve(targetDir, ".devcontainer/devcontainer.env.example"),
    content: ENV_EXAMPLE_CONTENT,
    strategy,
    relativePath: ".devcontainer/devcontainer.env.example",
  });
}

/**
 * 設定ファイル (.ziku.json) を生成する。常に上書き。
 */
async function createDevEnvConfig(
  targetDir: string,
  source: {
    owner: string;
    repo: string;
    baseHashes?: Record<string, string>;
    baseRef?: string;
  },
): Promise<FileOperationResult> {
  const config: Record<string, unknown> = {
    version: "0.1.0",
    installedAt: new Date().toISOString(),
    source: { owner: source.owner, repo: source.repo },
  };

  if (source.baseRef) {
    config.baseRef = source.baseRef;
  }

  if (source.baseHashes && Object.keys(source.baseHashes).length > 0) {
    config.baseHashes = source.baseHashes;
  }

  // .ziku.json は常に上書き（設定管理ファイルなので）
  return writeFileWithStrategy({
    destPath: resolve(targetDir, ".ziku.json"),
    content: JSON.stringify(config, null, 2),
    strategy: "overwrite",
    relativePath: ".ziku.json",
  });
}

/**
 * 選択されたモジュールをフラット化して modules.jsonc をローカルに書き出す
 */
async function writeSelectedModulesJsonc(
  targetDir: string,
  selectedModules: TemplateModule[],
  strategy: OverwriteStrategy,
): Promise<FileOperationResult> {
  const modulesRelPath = ".ziku/modules.jsonc";
  const content = generateFlatPatternsJsonc(selectedModules);

  return writeFileWithStrategy({
    destPath: getModulesFilePath(targetDir),
    content,
    strategy,
    relativePath: modulesRelPath,
  });
}

/**
 * モジュール別の説明を表示
 */
function displayModuleDescriptions(
  selectedModules: TemplateModule[],
  fileResults: FileOperationResult[],
): void {
  const hasChanges = fileResults.some(
    (r) => r.action === "copied" || r.action === "created" || r.action === "overwritten",
  );

  if (!hasChanges) {
    return;
  }

  log.info(pc.bold("Installed modules:"));

  const lines: string[] = [];
  for (const mod of selectedModules) {
    const description = mod.setupDescription || mod.description;
    lines.push(`  ${pc.cyan("\u25C6")} ${pc.bold(mod.name)}`);
    if (description) {
      lines.push(`    ${pc.dim(description)}`);
    }
  }
  if (lines.length > 0) {
    log.message(lines.join("\n"));
  }
}

/**
 * テンプレートソースを解決する（存在チェック付き）。
 */
async function resolveTemplateSourceWithCheck(
  from: string | undefined,
  nonInteractive: boolean,
): Promise<{
  sourceOwner: string;
  sourceRepo: string;
}> {
  // --from で明示指定
  if (from) {
    const resolved = parseFromArg(from);
    const exists = await checkRepoExists(resolved.sourceOwner, resolved.sourceRepo);
    if (!exists) {
      throw new BermError(
        `Template repository "${resolved.sourceOwner}/${resolved.sourceRepo}" not found`,
        "Check the --from value or create the repository first",
      );
    }
    return resolved;
  }

  // git remote から候補を検出
  const detectedOwner = detectGitHubOwner();
  if (detectedOwner) {
    const candidate = { sourceOwner: detectedOwner, sourceRepo: DEFAULT_TEMPLATE_REPO };
    const exists = await checkRepoExists(candidate.sourceOwner, candidate.sourceRepo);
    if (exists) {
      return candidate;
    }

    // 非インタラクティブモードではリポジトリが見つからなければエラー
    if (nonInteractive) {
      throw new BermError(
        `Template repository "${candidate.sourceOwner}/${candidate.sourceRepo}" not found`,
        `Create it first, or specify --from owner/repo`,
      );
    }

    // インタラクティブ: リポジトリが見つからない → アクション選択
    return handleMissingTemplate(candidate.sourceOwner, candidate.sourceRepo);
  }

  // git remote がない場合
  if (nonInteractive) {
    throw new BermError(
      "Cannot detect template source: no git remote origin found",
      "Specify --from owner/repo",
    );
  }

  // インタラクティブ: ユーザーに入力を促す
  log.warn("Could not detect template source from git remote.");
  return promptTemplateSource();
}

/**
 * ユーザーにテンプレートソースを入力させ、存在チェックを行う
 */
async function promptTemplateSource(): Promise<{ sourceOwner: string; sourceRepo: string }> {
  const source = await inputTemplateSource();
  const slashIndex = source.indexOf("/");
  const owner = source.slice(0, slashIndex);
  const repo = source.slice(slashIndex + 1);

  const exists = await checkRepoExists(owner, repo);
  if (!exists) {
    // 存在しないリポジトリ → 作成を提案
    return handleMissingTemplate(owner, repo);
  }

  return { sourceOwner: owner, sourceRepo: repo };
}

/**
 * テンプレートリポジトリが見つからない場合のインタラクティブハンドリング
 */
async function handleMissingTemplate(
  owner: string,
  repo: string,
): Promise<{ sourceOwner: string; sourceRepo: string }> {
  const action = await selectMissingTemplateAction(owner, repo);

  switch (action) {
    case "create-repo": {
      const token = getGitHubToken();
      if (!token) {
        throw new BermError(
          "GitHub token required to create a repository",
          "Set GITHUB_TOKEN or GH_TOKEN, or run: gh auth login",
        );
      }

      log.step(`Creating ${pc.cyan(`${owner}/${repo}`)}...`);
      const { url } = await scaffoldTemplateRepo(token, owner, repo);
      log.success(`Created template repository: ${pc.cyan(url)}`);
      log.info(pc.dim("Waiting for repository to be ready..."));
      await new Promise((resolve) => setTimeout(resolve, 5000));

      return { sourceOwner: owner, sourceRepo: repo };
    }

    case "specify-source": {
      return promptTemplateSource();
    }
  }
}

/**
 * テンプレートに .ziku/modules.jsonc がない場合のハンドリング
 */
async function handleMissingDevenv(
  owner: string,
  repo: string,
  nonInteractive: boolean,
): Promise<never> {
  if (nonInteractive) {
    throw new BermError(
      `Template ${owner}/${repo} has no .ziku/modules.jsonc`,
      "Add .ziku/modules.jsonc to the template repository first, or run interactively to create a PR",
    );
  }

  const confirmed = await confirmScaffoldDevenvPR(owner, repo);

  if (!confirmed) {
    throw new BermError(
      ".ziku/modules.jsonc is required",
      "Add it to the template repository manually, then run ziku init again",
    );
  }

  const token = getGitHubToken();
  if (!token) {
    throw new BermError(
      "GitHub token required to create a PR",
      "Set GITHUB_TOKEN or GH_TOKEN, or run: gh auth login",
    );
  }

  const selectedModules = await selectTemplateModules(MODULE_PRESETS);
  const modulesContent = generateTemplateModulesJsonc(selectedModules);
  log.step(`Creating PR to add .ziku/modules.jsonc to ${pc.cyan(`${owner}/${repo}`)}...`);
  const result = await createDevenvScaffoldPR(token, owner, repo, modulesContent);
  log.success(`Created PR: ${pc.cyan(result.url)}`);

  throw new BermError("Merge the PR first, then run ziku init again", `PR: ${result.url}`);
}

/**
 * 初期モジュールのプリセットカタログ。
 */
export const MODULE_PRESETS: TemplateModule[] = [
  {
    name: "DevContainer",
    description: "VS Code DevContainer setup",
    include: [".devcontainer/**"],
  },
  {
    name: "GitHub",
    description: "GitHub Actions workflows and configuration",
    include: [".github/**"],
  },
  {
    name: "VS Code",
    description: "VS Code workspace settings and extensions",
    include: [".vscode/**"],
  },
  {
    name: "Claude",
    description: "Claude Code project settings",
    include: [".claude/**"],
  },
  {
    name: "Root Config",
    description: "Root-level configuration files (EditorConfig, MCP, mise)",
    include: [".editorconfig", ".mcp.json", ".mise.toml"],
  },
];

/**
 * テンプレート用 modules.jsonc を生成（グループ形式 — テンプレートリポジトリ用）
 */
export function generateInitialModulesJsonc(selectedNames?: string[]): string {
  const modules = selectedNames
    ? MODULE_PRESETS.filter((m) => selectedNames.includes(m.name))
    : MODULE_PRESETS;

  return generateTemplateModulesJsonc(modules);
}

/**
 * テンプレート用 modules.jsonc コンテンツを生成（グループ形式）
 */
function generateTemplateModulesJsonc(modules: TemplateModule[]): string {
  const content = {
    $schema: MODULES_SCHEMA_URL,
    modules: modules.map((m) => ({
      name: m.name,
      description: m.description,
      include: m.include,
      ...(m.exclude && m.exclude.length > 0 ? { exclude: m.exclude } : {}),
    })),
  };
  return JSON.stringify(content, null, 2);
}

/**
 * ローカル用 modules.jsonc コンテンツを生成（フラット形式）
 * 選択されたモジュールの include/exclude をフラット化する
 */
function generateFlatPatternsJsonc(modules: TemplateModule[]): string {
  const include = modules.flatMap((m) => m.include);
  const exclude = modules.flatMap((m) => m.exclude ?? []);
  const content: Record<string, unknown> = {
    $schema: MODULES_SCHEMA_URL,
    include,
  };
  if (exclude.length > 0) {
    content.exclude = exclude;
  }
  return JSON.stringify(content, null, 2);
}

/**
 * 現在のリポジトリがテンプレートリポジトリ自体かどうかを判定する。
 */
export function isCurrentRepoTemplate(
  targetDir: string,
  sourceOwner: string,
  sourceRepo: string,
): boolean {
  const currentRepo = detectGitHubRepo(targetDir);
  if (!currentRepo) return false;
  return (
    currentRepo.owner.toLowerCase() === sourceOwner.toLowerCase() &&
    currentRepo.repo.toLowerCase() === sourceRepo.toLowerCase()
  );
}

/**
 * テンプレートリポジトリ自体で init を実行した場合のハンドリング。
 */
async function handleTemplateRepoInit(targetDir: string, nonInteractive: boolean): Promise<void> {
  log.info(`Detected: running inside the template repository`);

  if (modulesFileExists(targetDir)) {
    log.success(".ziku/modules.jsonc already exists");
    outro("Template repository is already configured.");
    return;
  }

  log.step("Generating .ziku/modules.jsonc...");

  let selectedModules: TemplateModule[];
  if (!nonInteractive) {
    selectedModules = await selectTemplateModules(MODULE_PRESETS);
  } else {
    selectedModules = MODULE_PRESETS;
  }

  const modulesContent = generateTemplateModulesJsonc(selectedModules);
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
      `${pc.bold("Next steps:")}`,
      `  ${pc.cyan("1.")} Review and customize ${pc.dim(".ziku/modules.jsonc")}`,
      `  ${pc.cyan("2.")} ${pc.cyan("git add .ziku/ && git commit -m 'chore: add ziku config'")}`,
      `  ${pc.dim("Then other projects can use this template with")} ${pc.cyan("npx ziku init")}`,
    ].join("\n"),
  );
}

/**
 * --from 引数をパースする
 */
function parseFromArg(from: string): { sourceOwner: string; sourceRepo: string } {
  const slashIndex = from.indexOf("/");
  if (slashIndex === -1 || slashIndex === 0 || slashIndex === from.length - 1) {
    throw new BermError(
      `Invalid --from format: "${from}"`,
      "Expected: owner/repo (e.g., my-org/my-templates)",
    );
  }
  return {
    sourceOwner: from.slice(0, slashIndex),
    sourceRepo: from.slice(slashIndex + 1),
  };
}

/**
 * テンプレートソースを解決する（純粋な解決ロジック、存在チェックなし）。
 */
export function resolveTemplateSource(from: string | undefined): {
  sourceOwner: string;
  sourceRepo: string;
} | null {
  if (from) {
    return parseFromArg(from);
  }

  const detectedOwner = detectGitHubOwner();
  if (detectedOwner) {
    return {
      sourceOwner: detectedOwner,
      sourceRepo: DEFAULT_TEMPLATE_REPO,
    };
  }

  return null;
}
