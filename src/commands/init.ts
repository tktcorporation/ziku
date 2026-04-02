import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import { defineCommand } from "citty";
import { Effect } from "effect";
import { join, resolve } from "pathe";
import { withFinally } from "../effect-helpers";
import {
  getModulesFilePath,
  loadPatternsFile,
  loadTemplateModulesFile,
  modulesFileExists,
} from "../modules/index";
import { MODULES_SCHEMA_URL } from "../modules/loader";
import type { FileOperationResult, OverwriteStrategy, TemplateModule } from "../modules/schemas";
import { match } from "ts-pattern";
import { ZikuError } from "../errors";
import {
  confirmScaffoldDevenvPR,
  inputTemplateSource,
  selectMissingTemplateAction,
  selectModules,
  selectOverwriteStrategy,
  selectTemplateCandidate,
} from "../ui/prompts";
import type { TemplateCandidate } from "../ui/prompts";
import { DEFAULT_TEMPLATE_REPO, detectGitHubOwner, detectGitHubRepo } from "../utils/git-remote";
import {
  checkRepoExists,
  createDevenvScaffoldPR,
  getAuthenticatedUserLogin,
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
      description: "Non-interactive mode (accept all defaults)",
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
      description: "Overwrite strategy: overwrite, skip, or prompt",
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

    await withFinally(async () => {
      if (!modulesFileExists(templateDir)) {
        // .ziku/modules.jsonc がテンプレートに存在しない場合のハンドリング
        await handleMissingDevenv(sourceOwner, sourceRepo, args.yes as boolean);
      }

      // テンプレートの modules.jsonc を読み込み、パターンを解決する。
      // モジュール形式 → モジュール選択 UI → フラット化
      // フラット形式 → そのまま使用
      const flatPatterns = await resolveTemplatePatterns(
        templateDir,
        args.yes as boolean,
        args.modules as string | undefined,
      );

      if (flatPatterns.include.length === 0) {
        log.warn("No patterns to apply");
        return;
      }

      // 上書き戦略の解決
      const effectiveStrategy: OverwriteStrategy = await resolveEffectiveStrategy(
        args.force as boolean,
        args["overwrite-strategy"] as string | undefined,
        args.yes as boolean,
        existsSync(resolve(targetDir, ".ziku.json")),
      );

      // Step 2: ファイルをコピー
      log.step("Applying templates...");

      const templateResults = await fetchTemplates({
        targetDir,
        overwriteStrategy: effectiveStrategy,
        patterns: flatPatterns,
        templateDir,
      });

      const allResults: FileOperationResult[] = [...templateResults];

      // devcontainer.env.example を戦略に従って作成
      const hasDevcontainer = flatPatterns.include.some((p) => p.startsWith(".devcontainer/"));
      if (hasDevcontainer) {
        const envResult = await createEnvExample(targetDir, effectiveStrategy);
        allResults.push(envResult);
      }

      // modules.jsonc をローカルに保存（テンプレートのパターンをそのまま使用）
      const modulesJsoncResult = await writeFlatModulesJsonc(
        targetDir,
        flatPatterns,
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
    }, cleanup);
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
 * フラットパターンで modules.jsonc をローカルに書き出す
 */
async function writeFlatModulesJsonc(
  targetDir: string,
  patterns: FlatPatterns,
  strategy: OverwriteStrategy,
): Promise<FileOperationResult> {
  const modulesRelPath = ".ziku/modules.jsonc";
  const content = generateFlatPatternsJsonc(patterns);

  return writeFileWithStrategy({
    destPath: getModulesFilePath(targetDir),
    content,
    strategy,
    relativePath: modulesRelPath,
  });
}

/**
 * テンプレートの modules.jsonc からパターンを解決する。
 *
 * - モジュール形式: モジュール選択 UI を表示し、選択されたモジュールをフラット化
 * - フラット形式: そのまま使用（モジュール選択なし）
 */
async function resolveTemplatePatterns(
  templateDir: string,
  nonInteractive: boolean,
  modulesArg: string | undefined,
): Promise<FlatPatterns> {
  // まずモジュール形式として読み込みを試行（失敗時はフラット形式にフォールバック）
  const templateModules = await Effect.runPromise(
    Effect.tryPromise(() => loadTemplateModulesFile(templateDir).then((r) => r.modules)).pipe(
      Effect.orElseSucceed(() => null),
    ),
  );

  if (templateModules) {
    // モジュール形式: モジュール選択
    const selectedModules = await selectModulesFromTemplate(
      templateModules,
      nonInteractive,
      modulesArg,
    );
    return {
      include: selectedModules.flatMap((m) => m.include),
      exclude: selectedModules.flatMap((m) => m.exclude ?? []),
    };
  }

  // フラット形式: そのまま使用
  const loaded = await loadPatternsFile(templateDir);
  return { include: loaded.include, exclude: loaded.exclude };
}

/**
 * テンプレートのモジュール一覧からモジュールを選択する。
 * --yes: 全モジュール、--modules: 指定モジュール、それ以外: インタラクティブ選択
 */
async function selectModulesFromTemplate(
  moduleList: TemplateModule[],
  nonInteractive: boolean,
  modulesArg: string | undefined,
): Promise<TemplateModule[]> {
  const hasModulesArg = typeof modulesArg === "string" && modulesArg.length > 0;

  if (nonInteractive && !hasModulesArg) {
    // --yes: 全モジュール選択
    log.info(`Selected ${pc.cyan(moduleList.length.toString())} modules`);
    return [...moduleList];
  }

  if (hasModulesArg) {
    // --modules: 指定モジュール選択
    const requestedNames = modulesArg.split(",").map((s) => s.trim());
    const validNames = moduleList.map((m) => m.name);
    const invalidNames = requestedNames.filter((name) => !validNames.includes(name));
    if (invalidNames.length > 0) {
      throw new ZikuError(
        `Unknown module(s): ${invalidNames.join(", ")}`,
        `Available modules: ${validNames.join(", ")}`,
      );
    }
    return moduleList.filter((m) => requestedNames.includes(m.name));
  }

  // インタラクティブ: モジュール選択 UI
  log.step("Selecting modules...");
  return selectModules(moduleList);
}

/**
 * 上書き戦略を CLI 引数・フラグから解決する。
 *
 * 優先順位: --force > --overwrite-strategy > --yes > インタラクティブ選択
 */
async function resolveEffectiveStrategy(
  force: boolean,
  strategyArg: string | undefined,
  nonInteractive: boolean,
  configExists: boolean,
): Promise<OverwriteStrategy> {
  if (force) return "overwrite";

  if (strategyArg) {
    if (strategyArg !== "overwrite" && strategyArg !== "skip" && strategyArg !== "prompt") {
      throw new ZikuError(
        `Invalid overwrite strategy: ${strategyArg}`,
        "Must be: overwrite, skip, or prompt",
      );
    }
    return strategyArg;
  }

  if (nonInteractive) return "overwrite";

  return selectOverwriteStrategy({ isReinit: configExists });
}

/**
 * テンプレートソースを解決する（存在チェック付き）。
 *
 * 候補の優先順位:
 *   1. --from で明示指定 → そのまま使用
 *   2. 自動検出（認証ユーザーの .github + git remote オーナーの .github）
 *      → 存在する候補をインタラクティブに選択
 *   3. 候補なし → 手動入力
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
      throw new ZikuError(
        `Template repository "${resolved.sourceOwner}/${resolved.sourceRepo}" not found`,
        "Check the --from value or create the repository first",
      );
    }
    return resolved;
  }

  // 候補を収集: 認証ユーザー + git remote オーナー
  const detectedOwner = detectGitHubOwner();
  const authenticatedUser = await getAuthenticatedUserLogin();

  const candidateEntries: TemplateCandidate[] = [];
  const seen = new Set<string>();

  // 候補1: 認証ユーザーの .github
  if (authenticatedUser) {
    const key = `${authenticatedUser}/${DEFAULT_TEMPLATE_REPO}`;
    if (!seen.has(key)) {
      seen.add(key);
      candidateEntries.push({
        owner: authenticatedUser,
        repo: DEFAULT_TEMPLATE_REPO,
        label: "Your account",
      });
    }
  }

  // 候補2: git remote オーナーの .github
  if (detectedOwner) {
    const key = `${detectedOwner}/${DEFAULT_TEMPLATE_REPO}`;
    if (!seen.has(key)) {
      seen.add(key);
      candidateEntries.push({
        owner: detectedOwner,
        repo: DEFAULT_TEMPLATE_REPO,
        label: "Git remote owner",
      });
    }
  }

  // 存在チェックを並列で実行
  const existsResults = await Promise.all(
    candidateEntries.map((c) => checkRepoExists(c.owner, c.repo)),
  );
  const existingCandidates = candidateEntries.filter((_, i) => existsResults[i]);

  // 候補が見つかった場合
  if (existingCandidates.length > 0) {
    if (nonInteractive) {
      // 非インタラクティブ: 最初の候補を使用
      return { sourceOwner: existingCandidates[0].owner, sourceRepo: existingCandidates[0].repo };
    }

    // インタラクティブ: ユーザーに選択させる
    const selected = await selectTemplateCandidate(existingCandidates);
    if (selected === "specify-other") {
      return promptTemplateSource();
    }
    return { sourceOwner: selected.owner, sourceRepo: selected.repo };
  }

  // 候補はあったが全て存在しない場合
  if (candidateEntries.length > 0) {
    const firstCandidate = candidateEntries[0];
    if (nonInteractive) {
      throw new ZikuError(
        `Template repository "${firstCandidate.owner}/${firstCandidate.repo}" not found`,
        `Create it first, or specify --from owner/repo`,
      );
    }
    return handleMissingTemplate(firstCandidate.owner, firstCandidate.repo);
  }

  // 候補が一つもない場合（git remote なし + 認証なし）
  if (nonInteractive) {
    throw new ZikuError(
      "Cannot detect template source: no git remote origin found",
      "Specify --from owner/repo",
    );
  }

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

  return match(action)
    .with("create-repo", async () => {
      const token = getGitHubToken();
      if (!token) {
        throw new ZikuError(
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
    })
    .with("specify-source", () => promptTemplateSource())
    .exhaustive();
}

/**
 * テンプレートに .ziku/modules.jsonc がない場合のハンドリング。
 * テンプレートリポジトリに scaffold PR を作成するフローに誘導する。
 */
async function handleMissingDevenv(
  owner: string,
  repo: string,
  nonInteractive: boolean,
): Promise<never> {
  if (nonInteractive) {
    throw new ZikuError(
      `Template ${owner}/${repo} has no .ziku/modules.jsonc`,
      "Add .ziku/modules.jsonc to the template repository first, or run interactively to create a PR",
    );
  }

  const confirmed = await confirmScaffoldDevenvPR(owner, repo);

  if (!confirmed) {
    throw new ZikuError(
      ".ziku/modules.jsonc is required",
      "Add it to the template repository manually, then run ziku init again",
    );
  }

  const token = getGitHubToken();
  if (!token) {
    throw new ZikuError(
      "GitHub token required to create a PR",
      "Set GITHUB_TOKEN or GH_TOKEN, or run: gh auth login",
    );
  }

  // デフォルトのフラットパターンで scaffold PR を作成
  const modulesContent = generateFlatPatternsJsonc(DEFAULT_SCAFFOLD_PATTERNS);
  log.step(`Creating PR to add .ziku/modules.jsonc to ${pc.cyan(`${owner}/${repo}`)}...`);
  const result = await createDevenvScaffoldPR(token, owner, repo, modulesContent);
  log.success(`Created PR: ${pc.cyan(result.url)}`);

  throw new ZikuError("Merge the PR first, then run ziku init again", `PR: ${result.url}`);
}

/**
 * テンプレートリポジトリ scaffold 時のデフォルトパターン。
 * テンプレートに modules.jsonc がない場合に提案する初期パターン。
 */
const DEFAULT_SCAFFOLD_PATTERNS: FlatPatterns = {
  include: [
    ".devcontainer/**",
    ".github/**",
    ".vscode/**",
    ".claude/**",
    ".editorconfig",
    ".mcp.json",
    ".mise.toml",
  ],
  exclude: [],
};

/**
 * フラット形式の modules.jsonc コンテンツを生成する。
 */
export function generateFlatPatternsJsonc(patterns: FlatPatterns): string {
  const content: Record<string, unknown> = {
    $schema: MODULES_SCHEMA_URL,
    include: patterns.include,
  };
  if (patterns.exclude.length > 0) {
    content.exclude = patterns.exclude;
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
 * フラット形式の modules.jsonc を生成する。
 */
async function handleTemplateRepoInit(targetDir: string, _nonInteractive: boolean): Promise<void> {
  log.info(`Detected: running inside the template repository`);

  if (modulesFileExists(targetDir)) {
    log.success(".ziku/modules.jsonc already exists");
    outro("Template repository is already configured.");
    return;
  }

  log.step("Generating .ziku/modules.jsonc...");

  const modulesContent = generateFlatPatternsJsonc(DEFAULT_SCAFFOLD_PATTERNS);
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
    throw new ZikuError(
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
