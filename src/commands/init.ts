import { existsSync, mkdirSync } from "node:fs";
import { defineCommand } from "citty";
import { Effect } from "effect";
import { join, resolve } from "pathe";
import { withFinally } from "../effect-helpers";
import { loadTemplateConfig, extractDirectoryEntries } from "../utils/template-config";
import type { CommandLifecycle } from "../docs/lifecycle-types";
import { SYNCED_FILES } from "../docs/lifecycle-types";
import type {
  FileOperationResult,
  LockState,
  OverwriteStrategy,
  TemplateSource,
} from "../modules/schemas";
import { P, match } from "ts-pattern";
import { ZikuError } from "../errors";
import {
  inputTemplateSource,
  selectMissingTemplateAction,
  selectDirectories,
  selectOverwriteStrategy,
  selectTemplateCandidate,
} from "../ui/prompts";
import type { TemplateCandidate } from "../ui/prompts";
import {
  DEFAULT_TEMPLATE_REPO,
  DEFAULT_TEMPLATE_REPOS,
  detectGitHubOwner,
} from "../utils/git-remote";
import {
  checkRepoExists,
  checkRepoSetup,
  getAuthenticatedUserLogin,
  getGitHubToken,
  rateLimitedError,
  resolveLatestCommitSha,
  scaffoldTemplateRepo,
} from "../utils/github";
import type { RepoExistence } from "../utils/github";
import { hashFiles } from "../utils/hash";
import { LOCK_FILE, saveLock } from "../utils/lock";
import { ZIKU_CONFIG_FILE, generateZikuJsonc, zikuConfigExists } from "../utils/ziku-config";
import { downloadTemplateToTemp, fetchTemplates, writeFileWithStrategy } from "../utils/template";
import type { FlatPatterns } from "../utils/patterns";
import { intro, log, logFileResults, outro, pc, withSpinner } from "../ui/renderer";

// ビルド時に置換される定数
declare const __VERSION__: string;
const version = typeof __VERSION__ !== "undefined" ? __VERSION__ : "dev";

/**
 * init (user project) のファイル操作メタデータ。
 * ドキュメント自動生成（npm run docs）の SSOT として使われる。
 */
export const initUserLifecycle: CommandLifecycle = {
  name: "init (user project)",
  description: "Initialize user project from template",
  ops: [
    {
      file: ZIKU_CONFIG_FILE,
      location: "template",
      op: "read",
      note: "テンプレートの include パターンを取得",
    },
    {
      file: ZIKU_CONFIG_FILE,
      location: "local",
      op: "create",
      note: "選択パターンを保存",
    },
    {
      file: LOCK_FILE,
      location: "local",
      op: "create",
      note: "ソース情報 + ベースコミット SHA + ハッシュを記録",
    },
    {
      file: SYNCED_FILES,
      location: "local",
      op: "create",
      note: "テンプレートからパターンに一致するファイルをコピー",
    },
  ],
  notes: [
    "`ziku.jsonc` はテンプレートとユーザープロジェクトの両方に存在する。同一フォーマット（include/exclude パターンのみ）で、source 情報は含まない。",
    "テンプレートの取得元（owner/repo またはローカルパス）は `lock.json` に保存される。これにより `ziku.jsonc` はテンプレート・ユーザー間で完全に同一フォーマットになる。",
  ],
};

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
    dirs: {
      type: "string",
      alias: "d",
      description: "Comma-separated directory names to apply (non-interactive)",
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
    "from-dir": {
      type: "string",
      description: "Local directory to use as template source (skips GitHub download)",
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

    // ─── 入り口: テンプレートソースの解決 ───
    const fromDir = args["from-dir"] as string | undefined;

    let templateDir: string;
    let cleanup: () => void;
    let source: TemplateSource;

    if (fromDir) {
      // ローカルディレクトリをテンプレートとして使用（ダウンロード不要）
      templateDir = resolve(fromDir);
      cleanup = () => {};
      source = { path: templateDir };
      log.info(`Template: ${pc.cyan(templateDir)} (local)`);
    } else {
      // GitHub リポジトリからダウンロード
      const resolved = await resolveTemplateSourceWithCheck(
        args.from as string | undefined,
        args.yes as boolean,
      );
      source = { owner: resolved.sourceOwner, repo: resolved.sourceRepo };

      log.info(`Template: ${pc.cyan(`${resolved.sourceOwner}/${resolved.sourceRepo}`)}`);

      log.step("Fetching template...");
      const downloaded = await withSpinner("Downloading template from GitHub...", () =>
        downloadTemplateToTemp(targetDir, `gh:${resolved.sourceOwner}/${resolved.sourceRepo}`),
      );
      templateDir = downloaded.templateDir;
      cleanup = downloaded.cleanup;
    }

    // ─── 共通処理: テンプレート適用 ───
    await withFinally(async () => {
      // テンプレートの ziku.jsonc を Effect で読み込む
      const templateConfig = await Effect.runPromise(
        loadTemplateConfig(templateDir).pipe(
          Effect.catchTag("TemplateNotConfiguredError", (_err) => {
            const hint = match(source)
              .with({ path: P.string }, (s) => `Add .ziku/ziku.jsonc to ${s.path}`)
              .with(
                { owner: P.string, repo: P.string },
                (s) => `Add .ziku/ziku.jsonc to ${s.owner}/${s.repo}`,
              )
              .exhaustive();
            return Effect.fail(new ZikuError(`Template has no .ziku/ziku.jsonc`, hint));
          }),
          Effect.catchTag("ParseError", (err) =>
            Effect.fail(
              new ZikuError(`Failed to parse template .ziku/ziku.jsonc`, String(err.cause)),
            ),
          ),
        ),
      );

      const flatPatterns = await resolveTemplatePatterns(
        templateConfig,
        args.yes as boolean,
        args.dirs as string | undefined,
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
        zikuConfigExists(targetDir),
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

      // テンプレートファイルのハッシュを計算（pull 時の差分検出用）
      const baseHashes = await hashFiles(templateDir, flatPatterns.include, flatPatterns.exclude);

      // baseRef: GitHub ソースの場合のみコミット SHA を取得
      const baseRef = await match(source)
        .with({ owner: P.string, repo: P.string }, (s) => resolveLatestCommitSha(s.owner, s.repo))
        .with({ path: P.string }, () => Promise.resolve(undefined))
        .exhaustive();

      // .ziku/ziku.jsonc を書き出し（パターン定義のみ、source なし）
      const zikuJsoncResult = await writeZikuJsonc(targetDir, {
        patterns: flatPatterns,
        strategy: effectiveStrategy,
      });
      allResults.push(zikuJsoncResult);

      // .ziku/lock.json を書き出し（source + 同期状態）
      const lockResult = await writeLockFile(targetDir, { source, baseHashes, baseRef });
      allResults.push(lockResult);

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
          pc.bold("Next steps:"),
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

function createEnvExample(
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
 * .ziku/ziku.jsonc を書き出す（パターン定義のみ、source は lock.json に分離）
 */
function writeZikuJsonc(
  targetDir: string,
  opts: {
    patterns: FlatPatterns;
    strategy: OverwriteStrategy;
  },
): Promise<FileOperationResult> {
  const content = generateZikuJsonc({
    include: opts.patterns.include,
    exclude: opts.patterns.exclude,
  });

  return writeFileWithStrategy({
    destPath: resolve(targetDir, ZIKU_CONFIG_FILE),
    content,
    strategy: opts.strategy,
    relativePath: ZIKU_CONFIG_FILE,
  });
}

/**
 * .ziku/lock.json を書き出す（source + 同期状態: 常に上書き）
 */
async function writeLockFile(
  targetDir: string,
  opts: {
    source: TemplateSource;
    baseHashes?: Record<string, string>;
    baseRef?: string;
  },
): Promise<FileOperationResult> {
  const lock: LockState = {
    version,
    installedAt: new Date().toISOString(),
    source: opts.source,
    ...(opts.baseRef ? { baseRef: opts.baseRef } : {}),
    ...(opts.baseHashes && Object.keys(opts.baseHashes).length > 0
      ? { baseHashes: opts.baseHashes }
      : {}),
  };

  const isNew = !existsSync(join(targetDir, LOCK_FILE));
  await saveLock(targetDir, lock);

  return {
    action: isNew ? "created" : "overwritten",
    path: LOCK_FILE,
  };
}

/**
 * テンプレートの ziku.jsonc からパターンを解決する。
 *
 * include パターンをトップレベルディレクトリでグループ化し、
 * ユーザーにディレクトリ単位で選択させる。
 */
async function resolveTemplatePatterns(
  templateConfig: { include: string[]; exclude?: string[] },
  nonInteractive: boolean,
  dirsArg: string | undefined,
): Promise<FlatPatterns> {
  const allInclude = templateConfig.include;
  const allExclude = templateConfig.exclude ?? [];

  const entries = extractDirectoryEntries(allInclude);
  const selectedPatterns = await selectDirsFromTemplate(entries, nonInteractive, dirsArg);

  // 選択されたパターンに対応する exclude を絞り込む
  // （exclude は全て適用しても安全なので、そのまま返す）
  return {
    include: selectedPatterns,
    exclude: allExclude,
  };
}

/**
 * テンプレートのディレクトリエントリからディレクトリを選択する。
 * --yes: 全ディレクトリ、--dirs: 指定ディレクトリ、それ以外: インタラクティブ選択
 */
async function selectDirsFromTemplate(
  entries: Array<{ label: string; patterns: string[] }>,
  nonInteractive: boolean,
  dirsArg: string | undefined,
): Promise<string[]> {
  const hasDirsArg = typeof dirsArg === "string" && dirsArg.length > 0;

  if (nonInteractive && !hasDirsArg) {
    // --yes: 全ディレクトリ選択
    const allPatterns = entries.flatMap((e) => e.patterns);
    log.info(`Selected ${pc.cyan(entries.length.toString())} directories`);
    return allPatterns;
  }

  if (hasDirsArg) {
    // --dirs: 指定ディレクトリ選択
    const requestedLabels = dirsArg.split(",").map((s) => s.trim());
    const validLabels = entries.map((e) => e.label);
    const invalidLabels = requestedLabels.filter((l) => !validLabels.includes(l));
    if (invalidLabels.length > 0) {
      throw new ZikuError(
        `Unknown directory(ies): ${invalidLabels.join(", ")}`,
        `Available directories: ${validLabels.join(", ")}`,
      );
    }
    return entries.filter((e) => requestedLabels.includes(e.label)).flatMap((e) => e.patterns);
  }

  // インタラクティブ: ディレクトリ選択 UI
  log.step("Selecting directories...");
  return await selectDirectories(entries);
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

  return await selectOverwriteStrategy({ isReinit: configExists });
}

/**
 * テンプレートソースを解決する（存在チェック付き）。
 *
 * 候補の優先順位:
 *   1. --from で明示指定 → そのまま使用
 *   2. 自動検出（認証ユーザー・git remote オーナー × .ziku / .github）
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
  if (from) return resolveExplicitSource(from);

  // 自動検出: 候補を収集し、存在チェック＋セットアップ状態を確認
  const { candidateEntries, deduplicatedCandidates, existingCandidates } =
    await discoverTemplateCandidates();

  if (nonInteractive) {
    return resolveNonInteractive(deduplicatedCandidates, candidateEntries);
  }

  // ─── インタラクティブモード ───

  if (existingCandidates.length > 0) {
    const selected = await selectTemplateCandidate(existingCandidates);
    if (selected === "specify-other") return promptTemplateSource();
    return { sourceOwner: selected.owner, sourceRepo: selected.repo };
  }

  if (candidateEntries.length > 0) {
    const firstCandidate = candidateEntries[0];
    return handleMissingTemplate(firstCandidate.owner, firstCandidate.repo);
  }

  log.warn("Could not detect template source from git remote.");
  return promptTemplateSource();
}

/**
 * 判別不能 (Unknown) レスポンスを受け取ったときに警告を出す。
 *
 * Unknown は 5xx やネットワーク断など "リポジトリ無し" とは断定できないケース。
 * 呼び出し側は続行を選択できるため、ここではログだけ出して戻る。
 */
function warnUnknownRepo(
  owner: string,
  repo: string,
  u: Extract<RepoExistence, { readonly _tag: "Unknown" }>,
): void {
  const statusPart = u.status !== undefined ? ` (HTTP ${u.status})` : "";
  log.warn(
    `Could not verify ${owner}/${repo}${statusPart}: ${u.reason}. Proceeding and letting the download step surface any real error.`,
  );
}

/**
 * --from で明示指定されたソースを解決する。
 * owner/repo 形式ならそのまま存在チェック、owner のみならデフォルトリポジトリを探索。
 */
async function resolveExplicitSource(
  from: string,
): Promise<{ sourceOwner: string; sourceRepo: string }> {
  const resolved = parseFromArg(from);

  // owner/repo 形式
  if (from.includes("/")) {
    const existence = await checkRepoExists(resolved.sourceOwner, resolved.sourceRepo);
    return match(existence)
      .with({ _tag: "Exists" }, () => resolved)
      .with({ _tag: "Unknown" }, (u) => {
        warnUnknownRepo(resolved.sourceOwner, resolved.sourceRepo, u);
        return resolved;
      })
      .with({ _tag: "NotFound" }, (): never => {
        throw new ZikuError(
          `Template repository "${resolved.sourceOwner}/${resolved.sourceRepo}" not found`,
          "Check the --from value or create the repository first",
        );
      })
      .with({ _tag: "RateLimited" }, (r): never => {
        throw rateLimitedError(r);
      })
      .exhaustive();
  }

  // owner のみ指定 → デフォルトリポジトリ候補を順に探索（セットアップ済みを優先）
  const results = await Promise.all(
    DEFAULT_TEMPLATE_REPOS.map((repo) => checkRepoExists(resolved.sourceOwner, repo)),
  );

  // レート制限は即失敗: 候補判定自体が信頼できないため続行しない
  const rateLimited = results.find(
    (r): r is Extract<RepoExistence, { readonly _tag: "RateLimited" }> => r._tag === "RateLimited",
  );
  if (rateLimited) throw rateLimitedError(rateLimited);

  // Exists または Unknown (5xx/ネットワーク断等) を「ありえる候補」として採用。
  // NotFound のみ除外する。
  const candidateRepos = DEFAULT_TEMPLATE_REPOS.filter((_, i) => results[i]._tag !== "NotFound");
  if (candidateRepos.length === 0) {
    throw new ZikuError(
      `No template repository found for "${resolved.sourceOwner}" (checked: ${DEFAULT_TEMPLATE_REPOS.join(", ")})`,
      "Check the --from value or create the repository first",
    );
  }

  // Unknown のみの候補には警告を出す（ユーザーが次のステップで何が起きているか分かるように）
  for (let i = 0; i < DEFAULT_TEMPLATE_REPOS.length; i++) {
    const r = results[i];
    if (r._tag === "Unknown") warnUnknownRepo(resolved.sourceOwner, DEFAULT_TEMPLATE_REPOS[i], r);
  }

  const setupResults = await Promise.all(
    candidateRepos.map((repo) => checkRepoSetup(resolved.sourceOwner, repo)),
  );
  const readyRepo = candidateRepos.find((_, i) => setupResults[i]);
  return {
    sourceOwner: resolved.sourceOwner,
    sourceRepo: readyRepo ?? candidateRepos[0],
  };
}

/**
 * 認証ユーザー・git remote オーナーからテンプレート候補を収集し、
 * 存在チェックとセットアップ状態の確認を行う。
 */
async function discoverTemplateCandidates(): Promise<{
  candidateEntries: TemplateCandidate[];
  existingCandidates: TemplateCandidate[];
  deduplicatedCandidates: TemplateCandidate[];
}> {
  const detectedOwner = detectGitHubOwner();
  const authenticatedUser = await getAuthenticatedUserLogin();

  const candidateEntries: TemplateCandidate[] = [];
  const seen = new Set<string>();

  const owners: Array<{ name: string; label: string }> = [];
  if (authenticatedUser) owners.push({ name: authenticatedUser, label: "Your account" });
  if (detectedOwner) owners.push({ name: detectedOwner, label: "Git remote owner" });

  for (const owner of owners) {
    for (const repo of DEFAULT_TEMPLATE_REPOS) {
      const key = `${owner.name}/${repo}`;
      if (!seen.has(key)) {
        seen.add(key);
        candidateEntries.push({ owner: owner.name, repo, label: owner.label });
      }
    }
  }

  const existenceResults = await Promise.all(
    candidateEntries.map((c) => checkRepoExists(c.owner, c.repo)),
  );

  // 自動検出中にレート制限に当たると全候補が誤って NotFound 扱いになりがち。
  // 明示的に失敗させ、ユーザーが GITHUB_TOKEN 設定などの対処を取れるようにする。
  const rateLimited = existenceResults.find(
    (r): r is Extract<RepoExistence, { readonly _tag: "RateLimited" }> => r._tag === "RateLimited",
  );
  if (rateLimited) throw rateLimitedError(rateLimited);

  // Exists と Unknown を「ありえる候補」として扱う。Unknown は 5xx・ネットワーク断・
  // 予期しない 403 など確認不能なケースで、除外すると transient 障害時に本来存在する
  // リポジトリが誤って "not found" 扱いされる（非インタラクティブでエラー、
  // インタラクティブでは既存リポを「作成しますか」と聞く）退行になる。
  // 判別できないリポは候補に含め、実取得時に giget が本来のエラーを出す余地を残す。
  // 警告は resolveExplicitSource 同様ユーザーに可視化する。
  for (let i = 0; i < candidateEntries.length; i++) {
    const r = existenceResults[i];
    if (r._tag === "Unknown")
      warnUnknownRepo(candidateEntries[i].owner, candidateEntries[i].repo, r);
  }
  const existingCandidates = candidateEntries.filter(
    (_, i) => existenceResults[i]._tag !== "NotFound",
  );

  const setupResults = await Promise.all(
    existingCandidates.map((c) => checkRepoSetup(c.owner, c.repo)),
  );
  for (let i = 0; i < existingCandidates.length; i++) {
    existingCandidates[i].ready = setupResults[i];
  }

  const deduplicatedCandidates = deduplicateByOwner(existingCandidates);

  return { candidateEntries, existingCandidates, deduplicatedCandidates };
}

/**
 * non-interactive モードでのテンプレートソース解決。
 * 候補が1つなら使用、複数なら曖昧エラー、0ならエラー。
 */
function resolveNonInteractive(
  deduplicatedCandidates: TemplateCandidate[],
  candidateEntries: TemplateCandidate[],
): { sourceOwner: string; sourceRepo: string } {
  if (deduplicatedCandidates.length === 1) {
    return {
      sourceOwner: deduplicatedCandidates[0].owner,
      sourceRepo: deduplicatedCandidates[0].repo,
    };
  }
  if (deduplicatedCandidates.length > 1) {
    const candidateList = deduplicatedCandidates.map((c) => `${c.owner}/${c.repo}`).join(", ");
    throw new ZikuError(
      `Multiple template candidates found: ${candidateList}`,
      "Specify --from <owner> or --from <owner/repo> to disambiguate",
    );
  }
  if (candidateEntries.length > 0) {
    const firstCandidate = candidateEntries[0];
    throw new ZikuError(
      `Template repository "${firstCandidate.owner}/${firstCandidate.repo}" not found`,
      "Create it first, or specify --from <owner> or --from <owner/repo>",
    );
  }
  throw new ZikuError(
    "Cannot detect template source: no git remote origin found",
    "Specify --from <owner> or --from <owner/repo>",
  );
}

/**
 * ユーザーにテンプレートソースを入力させ、存在チェックを行う
 */
async function promptTemplateSource(): Promise<{ sourceOwner: string; sourceRepo: string }> {
  const source = await inputTemplateSource();
  const slashIndex = source.indexOf("/");
  const owner = source.slice(0, slashIndex);
  const repo = source.slice(slashIndex + 1);

  const existence = await checkRepoExists(owner, repo);
  return match(existence)
    .with({ _tag: "Exists" }, () => ({ sourceOwner: owner, sourceRepo: repo }))
    .with({ _tag: "Unknown" }, (u) => {
      warnUnknownRepo(owner, repo, u);
      return { sourceOwner: owner, sourceRepo: repo };
    })
    .with({ _tag: "NotFound" }, () => handleMissingTemplate(owner, repo))
    .with({ _tag: "RateLimited" }, (r): never => {
      throw rateLimitedError(r);
    })
    .exhaustive();
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
      await new Promise((done) => {
        setTimeout(done, 5000);
      });

      return { sourceOwner: owner, sourceRepo: repo };
    })
    .with("specify-source", () => promptTemplateSource())
    .exhaustive();
}

/**
 * --from 引数をパースする。
 *
 * - "owner/repo" → { sourceOwner: "owner", sourceRepo: "repo" }
 * - "owner" (/ なし) → { sourceOwner: "owner", sourceRepo: ".github" }
 */
function parseFromArg(from: string): { sourceOwner: string; sourceRepo: string } {
  const slashIndex = from.indexOf("/");
  if (slashIndex === -1) {
    // オーナー名のみ → デフォルトの .github リポジトリを補完
    if (!from.trim()) {
      throw new ZikuError(
        `Invalid --from format: "${from}"`,
        "Expected: owner or owner/repo (e.g., my-org or my-org/my-templates)",
      );
    }
    return {
      sourceOwner: from,
      sourceRepo: DEFAULT_TEMPLATE_REPO,
    };
  }
  if (slashIndex === 0 || slashIndex === from.length - 1) {
    throw new ZikuError(
      `Invalid --from format: "${from}"`,
      "Expected: owner or owner/repo (e.g., my-org or my-org/my-templates)",
    );
  }
  return {
    sourceOwner: from.slice(0, slashIndex),
    sourceRepo: from.slice(slashIndex + 1),
  };
}

/**
 * 同一オーナーの候補を重複排除する。
 * セットアップ済み（ready=true）の候補を優先し、同順ならリスト順（.ziku → .github）で選択する。
 */
function deduplicateByOwner(candidates: TemplateCandidate[]): TemplateCandidate[] {
  const byOwner = new Map<string, TemplateCandidate>();
  for (const c of candidates) {
    const key = c.owner.toLowerCase();
    const existing = byOwner.get(key);
    if (!existing) {
      byOwner.set(key, c);
    } else if (c.ready && !existing.ready) {
      // セットアップ済みの候補を優先
      byOwner.set(key, c);
    }
  }
  return [...byOwner.values()];
}

/**
 * テンプレートソースを解決する（純粋な解決ロジック、存在チェックなし）。
 * 存在チェックなしのため、デフォルトリポジトリ候補の先頭（.ziku）を使用する。
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
