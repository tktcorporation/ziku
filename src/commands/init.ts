import { existsSync, mkdirSync } from "node:fs";
import { defineCommand } from "citty";
import { join, resolve } from "pathe";
import {
  defaultModules,
  getModuleById,
  getModulesFilePath,
  getPatternsByModuleIds,
  loadModulesFile,
  modulesFileExists,
} from "../modules/index";
import type {
  Answers,
  FileOperationResult,
  OverwriteStrategy,
  TemplateModule,
} from "../modules/schemas";
import { BermError } from "../errors";
import {
  inputTemplateSource,
  selectMissingTemplateAction,
  selectModules,
  selectOverwriteStrategy,
} from "../ui/prompts";
import {
  DEFAULT_TEMPLATE_OWNER,
  DEFAULT_TEMPLATE_REPO,
  detectGitHubOwner,
} from "../utils/git-remote";
import {
  checkRepoExists,
  getGitHubToken,
  resolveLatestCommitSha,
  scaffoldTemplateRepo,
} from "../utils/github";
import { hashFiles } from "../utils/hash";
import {
  buildTemplateSource,
  copyFile,
  downloadTemplateToTemp,
  fetchTemplates,
  writeFileWithStrategy,
} from "../utils/template";
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
      description: "Comma-separated module IDs to apply (non-interactive)",
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
        const { modules: loadedModules } = await loadModulesFile(templateDir);
        moduleList = loadedModules;
      } else {
        moduleList = defaultModules;
      }

      // Step 2: モジュール選択
      log.step("Selecting modules...");

      let answers: Answers;
      const hasModulesArg = typeof args.modules === "string" && args.modules.length > 0;
      const hasStrategyArg =
        typeof args["overwrite-strategy"] === "string" && args["overwrite-strategy"].length > 0;

      if (args.yes || hasModulesArg) {
        // --yes: 全モジュール選択、--modules: 指定モジュール選択
        let selectedModules: string[];
        if (hasModulesArg) {
          const requestedIds = (args.modules as string).split(",").map((s) => s.trim());
          const validIds = moduleList.map((m) => m.id);
          const invalidIds = requestedIds.filter((id) => !validIds.includes(id));
          if (invalidIds.length > 0) {
            throw new BermError(
              `Unknown module(s): ${invalidIds.join(", ")}`,
              `Available modules: ${validIds.join(", ")}`,
            );
          }
          selectedModules = requestedIds;
        } else {
          selectedModules = moduleList.map((m) => m.id);
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
          modules: selectedModules,
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
        answers = { modules: selectedModules, overwriteStrategy };
      } else {
        const selectedModules = await selectModules(moduleList);
        // .devenv.json が既に存在する場合は再実行と判断し、skip をデフォルトに推奨する
        const configExists = existsSync(resolve(targetDir, ".devenv.json"));
        const overwriteStrategy = await selectOverwriteStrategy({ isReinit: configExists });
        answers = { modules: selectedModules, overwriteStrategy };
      }

      if (answers.modules.length === 0) {
        log.warn("No modules selected");
        return;
      }

      // Step 3: ファイルをコピー
      log.step("Applying templates...");

      const effectiveStrategy: OverwriteStrategy = args.force
        ? "overwrite"
        : answers.overwriteStrategy;

      // テンプレート取得・適用（サイレントモード - 後でまとめて表示）
      const templateResults = await fetchTemplates({
        targetDir,
        modules: answers.modules,
        overwriteStrategy: effectiveStrategy,
        moduleList,
        templateDir,
      });

      const allResults: FileOperationResult[] = [...templateResults];

      // devcontainer.env.example を戦略に従って作成
      if (answers.modules.includes("devcontainer")) {
        const envResult = await createEnvExample(targetDir, effectiveStrategy);
        allResults.push(envResult);
      }

      // modules.jsonc をテンプレートからコピー（track コマンドが必要とする）
      const modulesJsoncResult = await copyModulesJsonc(templateDir, targetDir, effectiveStrategy);
      allResults.push(modulesJsoncResult);

      // テンプレートファイルのハッシュを計算（pull 時の差分検出用）
      const patterns = getPatternsByModuleIds(answers.modules, moduleList);
      const baseHashes = await hashFiles(templateDir, patterns);

      // テンプレートリポジトリの最新コミット SHA を取得（3-way マージのベース用）
      const baseRef = await resolveLatestCommitSha(sourceOwner, sourceRepo);

      // 設定ファイル生成（常に更新）
      const configResult = await createDevEnvConfig(targetDir, answers.modules, {
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
      displayModuleDescriptions(answers.modules, allResults, moduleList);

      // 成功メッセージと次のステップ
      outro(
        [
          "Setup complete!",
          "",
          `${pc.bold("Next steps:")}`,
          `  ${pc.cyan("git add . && git commit -m 'chore: add devenv config'")}`,
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
 * 設定ファイル (.devenv.json) を生成する。常に上書き。
 *
 * 背景: baseHashes を記録することで、pull 時に「ユーザーがローカルで変更したか」を
 * ファイル全体のコピーを保持せずに判定できる。
 */
async function createDevEnvConfig(
  targetDir: string,
  selectedModules: string[],
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
    modules: selectedModules,
    source: { owner: source.owner, repo: source.repo },
  };

  if (source.baseRef) {
    config.baseRef = source.baseRef;
  }

  if (source.baseHashes && Object.keys(source.baseHashes).length > 0) {
    config.baseHashes = source.baseHashes;
  }

  // .devenv.json は常に上書き（設定管理ファイルなので）
  return writeFileWithStrategy({
    destPath: resolve(targetDir, ".devenv.json"),
    content: JSON.stringify(config, null, 2),
    strategy: "overwrite",
    relativePath: ".devenv.json",
  });
}

/**
 * テンプレートから modules.jsonc をコピー
 */
async function copyModulesJsonc(
  templateDir: string,
  targetDir: string,
  strategy: OverwriteStrategy,
): Promise<FileOperationResult> {
  const modulesRelPath = ".devenv/modules.jsonc";
  const srcPath = join(templateDir, modulesRelPath);
  const destPath = getModulesFilePath(targetDir);

  if (!existsSync(srcPath)) {
    return { action: "skipped", path: modulesRelPath };
  }

  return copyFile(srcPath, destPath, strategy, modulesRelPath);
}

/**
 * モジュール別の説明を表示
 *
 * 背景: 選択されたモジュールが実際に変更を加えた場合のみ、
 * 各モジュールの名前と説明を一覧表示する。ユーザーが何がインストールされたかを確認できる。
 */
function displayModuleDescriptions(
  selectedModules: string[],
  fileResults: FileOperationResult[],
  moduleList: TemplateModule[],
): void {
  const hasChanges = fileResults.some(
    (r) => r.action === "copied" || r.action === "created" || r.action === "overwritten",
  );

  if (!hasChanges) {
    return;
  }

  log.info(pc.bold("Installed modules:"));

  const lines: string[] = [];
  for (const moduleId of selectedModules) {
    const mod = getModuleById(moduleId, moduleList);
    if (mod) {
      const description = mod.setupDescription || mod.description;
      lines.push(`  ${pc.cyan("\u25C6")} ${pc.bold(mod.name)}`);
      if (description) {
        lines.push(`    ${pc.dim(description)}`);
      }
    }
  }
  if (lines.length > 0) {
    log.message(lines.join("\n"));
  }
}

/**
 * テンプレートソースを解決する（存在チェック付き）。
 *
 * 優先順位:
 *   1. --from owner/repo が指定されていればそのまま使用
 *   2. git remote origin から owner を検出 → {owner}/.github
 *   3. フォールバック: tktcorporation/.github
 *
 * 解決後、テンプレートリポジトリの存在を確認し、見つからない場合は
 * ユーザーにリカバリ方法を提示する。
 */
async function resolveTemplateSourceWithCheck(
  from: string | undefined,
  nonInteractive: boolean,
): Promise<{
  sourceOwner: string;
  sourceRepo: string;
}> {
  const resolved = resolveTemplateSource(from);

  // --from で明示指定された場合は存在チェックのみ（リカバリなし）
  if (from) {
    const exists = await checkRepoExists(resolved.sourceOwner, resolved.sourceRepo);
    if (!exists) {
      throw new BermError(
        `Template repository "${resolved.sourceOwner}/${resolved.sourceRepo}" not found`,
        "Check the --from value or create the repository first",
      );
    }
    return resolved;
  }

  // デフォルトテンプレートの場合は存在チェック不要
  if (
    resolved.sourceOwner === DEFAULT_TEMPLATE_OWNER &&
    resolved.sourceRepo === DEFAULT_TEMPLATE_REPO
  ) {
    return resolved;
  }

  // 自動検出されたソースの存在チェック
  const exists = await checkRepoExists(resolved.sourceOwner, resolved.sourceRepo);
  if (exists) {
    return resolved;
  }

  // 非インタラクティブモードではデフォルトにフォールバック
  if (nonInteractive) {
    log.warn(
      `Template ${pc.cyan(`${resolved.sourceOwner}/${resolved.sourceRepo}`)} not found, using default`,
    );
    return {
      sourceOwner: DEFAULT_TEMPLATE_OWNER,
      sourceRepo: DEFAULT_TEMPLATE_REPO,
    };
  }

  // インタラクティブモード: ユーザーにアクション選択を促す
  return handleMissingTemplate(resolved.sourceOwner, resolved.sourceRepo);
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
    case "use-default":
      return {
        sourceOwner: DEFAULT_TEMPLATE_OWNER,
        sourceRepo: DEFAULT_TEMPLATE_REPO,
      };

    case "create-repo": {
      const token = getGitHubToken();
      if (!token) {
        throw new BermError(
          "GitHub token required to create a repository",
          "Set GITHUB_TOKEN or GH_TOKEN, or run: gh auth login",
        );
      }

      log.step(`Creating ${pc.cyan(`${owner}/${repo}`)} from default template...`);
      const { url } = await scaffoldTemplateRepo(
        token,
        owner,
        repo,
        DEFAULT_TEMPLATE_OWNER,
        DEFAULT_TEMPLATE_REPO,
      );
      log.success(`Created template repository: ${pc.cyan(url)}`);
      log.info(pc.dim("Waiting for repository to be ready..."));
      // フォーク同期を待つ
      await new Promise((resolve) => setTimeout(resolve, 5000));

      return { sourceOwner: owner, sourceRepo: repo };
    }

    case "specify-source": {
      const source = await inputTemplateSource();
      const slashIndex = source.indexOf("/");
      const newOwner = source.slice(0, slashIndex);
      const newRepo = source.slice(slashIndex + 1);

      // 指定されたソースの存在チェック
      const exists = await checkRepoExists(newOwner, newRepo);
      if (!exists) {
        throw new BermError(
          `Template repository "${newOwner}/${newRepo}" not found`,
          "Check the repository name and try again",
        );
      }

      return { sourceOwner: newOwner, sourceRepo: newRepo };
    }
  }
}

/**
 * テンプレートソースを解決する（純粋な解決ロジック、存在チェックなし）。
 *
 * 優先順位:
 *   1. --from owner/repo が指定されていればそのまま使用
 *   2. git remote origin から owner を検出 → {owner}/.github
 *   3. フォールバック: tktcorporation/.github
 */
export function resolveTemplateSource(from: string | undefined): {
  sourceOwner: string;
  sourceRepo: string;
} {
  if (from) {
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

  const detectedOwner = detectGitHubOwner();
  if (detectedOwner) {
    return {
      sourceOwner: detectedOwner,
      sourceRepo: DEFAULT_TEMPLATE_REPO,
    };
  }

  return {
    sourceOwner: DEFAULT_TEMPLATE_OWNER,
    sourceRepo: DEFAULT_TEMPLATE_REPO,
  };
}
