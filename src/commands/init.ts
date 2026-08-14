import { existsSync, mkdirSync, readdirSync, rmdirSync } from "node:fs";
import { defineCommand } from "citty";
import { Effect } from "effect";
import { dirname } from "pathe";
import { withCleanup } from "../effect-helpers";
import { runCommandEffect, toZikuFailure } from "../services/command-context";
import { loadTemplateConfig, extractDirectoryEntries } from "../utils/template-config";
import type { CommandLifecycle } from "../docs/lifecycle-types";
import { SYNCED_FILES } from "../docs/lifecycle-types";
import type {
  AbsPath,
  CommitSha,
  FileOperationResult,
  GitHubSource,
  HashMap,
  OverwriteStrategy,
  RepoRelPath,
  TemplateRef,
  TemplateSource,
  ZikuConfig,
} from "../modules/schemas";
import { match } from "ts-pattern";
import { zikuFailure } from "../errors";
import type { ZikuFailure } from "../errors";
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
  resolveSourceCommitSha,
  scaffoldTemplateRepo,
  unauthorizedError,
} from "../utils/github";
import type { RepoExistence } from "../utils/github";
import { hashFiles } from "../utils/hash";
import { resolveDeclaredScope } from "../utils/sync-scope";
import { absPath, joinAbs, repoRelPath } from "../utils/paths";
import { LOCK_FILE, saveLock } from "../utils/lock";
import { ZIKU_CONFIG_FILE, generateZikuJsonc, zikuConfigExists } from "../utils/ziku-config";
import {
  buildTemplateSource,
  downloadTemplateToTemp,
  fetchTemplates,
  writeFileWithStrategy,
} from "../utils/template";
import { resolveGitHubFetchSource } from "../utils/template-resolve";
import type { FlatPatterns } from "../utils/patterns";
import { intro, log, logFileResults, outro, pc, withSpinner } from "../ui/renderer";
import {
  asNonEmpty,
  buildInitialLock,
  buildOwnerCandidates,
  decideRepoProbe,
  deduplicateByOwner,
  gateProbeResults,
  orderProbedCandidates,
  planDirectorySelection,
  planFromArg,
  planInitOutcome,
  planInteractiveSource,
  planLockBaseHashes,
  planMissingTemplateAction,
  planNonInteractiveSource,
  planOverwriteStrategy,
  preferReadyCandidate,
  requiresDevcontainerEnvExample,
  selectedFlatPatterns,
  splitOwnerRepo,
  withReadyFlags,
} from "./init-plan";
import type { BlockingExistence, InitOutcome, ProbeGate, UnverifiedExistence } from "./init-plan";

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
      note: "テンプレートの include パターンを取得し、ディレクトリ選択 UI の候補にする",
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

/** CLI から読み取った init の実行条件。判断は `init-plan.ts` がこの値だけを見て行う。 */
interface InitArgs {
  readonly force: boolean;
  readonly yes: boolean;
  readonly dirs: string | undefined;
  readonly overwriteStrategy: string | undefined;
  readonly from: string | undefined;
  readonly fromDir: string | undefined;
  readonly dryRun: boolean;
}

/** テンプレートの実体と、それをどこから得たか。 */
interface AcquiredTemplate {
  readonly templateDir: AbsPath;
  /**
   * lock の `source` に記録する取得元。GitHub ソースで ref を指定しなかった場合は、解決した
   * ブランチ名を `ref` へ書き戻さず未指定のまま残す。未指定は「そのリポジトリの既定ブランチを
   * 追う」という指定であり、解決結果で固定すると既定ブランチが改名されたときに追随できなくなる。
   * 解決したブランチ名は `defaultBranch` の控えとしてだけ載せる（追随はやめず、GitHub へ
   * 問い合わせられないときの取得先だけを決める）。
   */
  readonly source: TemplateSource;
  /**
   * 配置したファイルが実際に由来する ref。GitHub ソースで ref を指定しなかった場合は、取得に
   * 使った既定ブランチが入る。lock の `base.ref` に載せる SHA はここから引く（`source.ref` から
   * 引き直すと、解決が二重になったうえ取得したツリーと別のブランチを指しうる）。
   */
  readonly fetchedRef: TemplateRef | undefined;
  /** 一時ディレクトリの後始末。ローカルソースでは何もしない。 */
  readonly cleanup: () => void;
}

/** GitHub 上のテンプレートリポジトリの所在。 */
interface GitHubTemplateRef {
  readonly sourceOwner: string;
  readonly sourceRepo: string;
}

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
      description: "Approve overwriting existing files with the template version",
      default: false,
    },
    yes: {
      type: "boolean",
      alias: "y",
      description:
        "Skip prompts (apply every template directory; existing files are kept, not overwritten)",
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
    dryRun: {
      type: "boolean",
      alias: "n",
      description: "Preview which files would be created/overwritten, without writing them",
      default: false,
    },
  },
  async run({ args }) {
    intro();

    const initArgs: InitArgs = {
      force: args.force,
      yes: args.yes,
      dirs: args.dirs as string | undefined,
      overwriteStrategy: args["overwrite-strategy"] as string | undefined,
      from: args.from as string | undefined,
      fromDir: args["from-dir"] as string | undefined,
      dryRun: args.dryRun,
    };
    const targetDir = absPath(args.dir);

    log.info(`Target: ${pc.cyan(targetDir)}`);
    if (initArgs.dryRun) {
      log.info("Dry run mode");
    }

    await initProject(targetDir, initArgs);
  },
});

/**
 * テンプレートの取得から適用までを進める。
 *
 * 何を配置し・既存ファイルをどう扱い・lock に何を書くかの判断は `init-plan.ts` の計算に
 * 委ね、ここは I/O とユーザーへの問い合わせ、および両者の受け渡しだけを行う。
 */
async function initProject(targetDir: AbsPath, args: InitArgs): Promise<void> {
  // targetDir 自身だけでなく、存在しない祖先ディレクトリも giget が recursive:true で
  // まとめて作ってしまう（例: targetDir が /tmp/new-parent/project で new-parent も
  // 未作成の場合、両方が副作用で作られる）。dryRun 終了後にどこまで後始末してよいかの
  // 基準点として、実行前から存在していた最も近い祖先を記録しておく。
  const existingAncestor = findExistingAncestor(targetDir);
  createTargetDir(targetDir, existingAncestor, args.dryRun);

  const template = await acquireTemplate(targetDir, args, existingAncestor);

  // dryRun で targetDir やその祖先が存在しなかった場合、giget のダウンロード
  // （tempDir 作成）がそれらを副作用的に作ってしまうことがある。テンプレート側の
  // cleanup（tempDir 削除）の後に、existingAncestor に達するまで空のディレクトリを
  // 削除する。
  const cleanupWithTargetDir = (): void => {
    template.cleanup();
    removeEmptyDryRunDirs(targetDir, args.dryRun, existingAncestor);
  };

  // 本体を Effect.promise で包む理由: 本体はテンプレート展開・プロンプト・ファイル書き込みを
  // Promise で連ねており、失敗は型に現れず throw で抜ける。Effect.tryPromise の catch で
  // 拾うとエラーチャネルが unknown に潰れるので、defect として運び runCommandEffect が
  // 投げられた値をそのまま再スローする。
  await runCommandEffect(
    withCleanup(
      Effect.promise(() => applyTemplate(targetDir, args, template)),
      cleanupWithTargetDir,
    ),
  );
}

/**
 * ターゲットディレクトリを用意する。
 *
 * dryRun 中は作成しない — giget や writeFileWithStrategy は書き込み時に親ディレクトリを
 * 自動作成するため targetDir の事前存在は不要で、ここで作成すると「何も書き込まなかった」
 * という dryRun の保証に反してしまう。
 */
function createTargetDir(targetDir: AbsPath, existingAncestor: string, dryRun: boolean): void {
  if (existingAncestor === targetDir) return;

  if (dryRun) {
    log.message(pc.dim(`Would create directory: ${targetDir}`));
    return;
  }
  mkdirSync(targetDir, { recursive: true });
  log.message(pc.dim(`Created directory: ${targetDir}`));
}

/**
 * テンプレートの実体を用意する。
 *
 * `--from-dir` はローカルディレクトリをそのまま使うのでダウンロードが要らない。GitHub
 * ソースはソースを確定させてから一時ディレクトリへ展開する。
 */
async function acquireTemplate(
  targetDir: AbsPath,
  args: InitArgs,
  existingAncestor: string,
): Promise<AcquiredTemplate> {
  const fromDir = args.fromDir;
  if (fromDir) {
    const templateDir = absPath(fromDir);
    log.info(`Template: ${pc.cyan(templateDir)} (local)`);
    return {
      templateDir,
      source: { kind: "local", path: templateDir },
      fetchedRef: undefined,
      cleanup: () => {},
    };
  }

  const resolved = await resolveTemplateSourceWithCheck(args.from, args.yes, args.dryRun);
  log.info(`Template: ${pc.cyan(`${resolved.sourceOwner}/${resolved.sourceRepo}`)}`);

  const repo: GitHubSource = {
    kind: "github",
    owner: resolved.sourceOwner,
    repo: resolved.sourceRepo,
  };
  // 取得先の決め方と、決まらないときに止める理由は resolveGitHubFetchSource を参照。
  // ここで止まってもディスクには何も足されていない（giget を呼ぶのはこの後）。
  const fetched = await runCommandEffect(
    resolveGitHubFetchSource(repo).pipe(Effect.mapError(toZikuFailure)),
  );

  // 引けた既定ブランチ名を lock へ控える。init が控えを残さないと、以降の実行はレート制限に
  // かかった時点で取得先を決められなくなる（gitHubSourceSchema の defaultBranch）。
  const source: GitHubSource =
    fetched.defaultBranch === undefined ? repo : { ...repo, defaultBranch: fetched.defaultBranch };

  log.step("Fetching template...");
  // giget は tempDir (targetDir/.ziku-temp) の親ディレクトリも再帰的に作成するため、
  // dryRun かつ targetDir が未作成だった場合、ここで targetDir 自体が副作用的に
  // 作られてしまう。ダウンロードが失敗した場合も同じ副作用は起きているのに、
  // 失敗時は initProject の cleanupWithTargetDir の構築まで到達せず後始末が漏れるため、
  // ここでも失敗経路を捕まえて同じ後始末を行う（try/catch は ast-grep で禁止のため
  // Promise.then(onFulfilled, onRejected) を使う）。
  const downloaded = await withSpinner("Downloading template from GitHub...", () =>
    downloadTemplateToTemp(targetDir, buildTemplateSource(fetched.pinned)),
  ).then(
    (result) => result,
    (error: unknown) => {
      removeEmptyDryRunDirs(targetDir, args.dryRun, existingAncestor);
      throw error;
    },
  );

  return {
    templateDir: downloaded.templateDir,
    source,
    fetchedRef: fetched.pinned.ref,
    cleanup: downloaded.cleanup,
  };
}

/**
 * テンプレートを適用し、`.ziku/ziku.jsonc` と `.ziku/lock.json` を書き出す。
 */
async function applyTemplate(
  targetDir: AbsPath,
  args: InitArgs,
  template: AcquiredTemplate,
): Promise<void> {
  const templateConfig = await runCommandEffect(
    loadInitTemplateConfig(template.templateDir, template.source),
  );

  const flatPatterns = await chooseDirectories(templateConfig, args);
  if (flatPatterns.include.length === 0) {
    log.warn("No patterns to apply");
    return;
  }

  const strategy = await chooseOverwriteStrategy(args, targetDir);

  log.step("Applying templates...");
  const allResults: FileOperationResult[] = [
    ...(await fetchTemplates({
      targetDir,
      overwriteStrategy: strategy,
      patterns: flatPatterns,
      templateDir: template.templateDir,
      dryRun: args.dryRun,
    })),
  ];

  const writesEnvExample = requiresDevcontainerEnvExample(flatPatterns.include);
  if (writesEnvExample) {
    allResults.push(await createEnvExample(targetDir, strategy, args.dryRun));
  }

  // テンプレートファイルのハッシュを計算（pull 時の差分検出用）。走査範囲は配置した
  // パターン、つまりユーザーが選んだ範囲に限る。テンプレート側のパターンをここで取り込むと、
  // 選ばなかったディレクトリのファイルまでベースに載り、次の pull がユーザーの既存ファイルを
  // 確認なく置き換える（resolveDeclaredScope の JSDoc）。取り込みは pull / status が
  // resolveSyncScope で行うので、選ばなかったパターンも次の同期でユーザーへ提示される。
  const scope = await resolveDeclaredScope({
    targetDir,
    templateDir: template.templateDir,
    include: flatPatterns.include,
    exclude: flatPatterns.exclude,
  });
  const templateHashes = await hashFiles(template.templateDir, scope);
  const generatedConfigContent = generateZikuJsonc({
    include: flatPatterns.include,
    exclude: flatPatterns.exclude,
  });

  // .ziku/ziku.jsonc を書き出し（パターン定義のみ、source なし）。
  // lock のベースには書き込み後の中身が要るので、lock より先に書く。
  allResults.push(
    await writeFileWithStrategy({
      destPath: joinAbs(targetDir, ZIKU_CONFIG_FILE),
      content: generatedConfigContent,
      strategy,
      relativePath: ZIKU_CONFIG_FILE,
      dryRun: args.dryRun,
    }),
  );

  // init が自分で組み立てて書くファイルの本文。テンプレートに同じパスがあっても、書き込みが
  // 起きた後のディスクにはこちらの本文が載る。
  const generatedContents = new Map<RepoRelPath, string>([
    [ZIKU_CONFIG_FILE, generatedConfigContent],
    ...(writesEnvExample ? [[ENV_EXAMPLE_PATH, ENV_EXAMPLE_CONTENT] as const] : []),
  ]);

  const baseHashes = planLockBaseHashes({
    templateHashes,
    generatedContents,
    results: allResults,
  });

  // ベースのコミット SHA: GitHub ソースの場合のみ取得。
  // テンプレートを取得した ref とベースの SHA が食い違うと、3-way マージのベースが
  // 別ブランチのツリーになるため、取得に使った ref をそのまま渡す。
  const baseCommit = await match(template.source)
    .with({ kind: "github" }, (s) => resolveSourceCommitSha(s.owner, s.repo, template.fetchedRef))
    .with({ kind: "local" }, () => Promise.resolve(undefined))
    .exhaustive();

  // .ziku/lock.json を書き出し（source + 同期状態）
  allResults.push(
    await writeLockFile(targetDir, {
      source: template.source,
      baseHashes,
      baseCommit,
      dryRun: args.dryRun,
    }),
  );

  reportOutcome(planInitOutcome({ summary: logFileResults(allResults), dryRun: args.dryRun }));
}

/**
 * テンプレートの `.ziku/ziku.jsonc` を読み込む。
 *
 * 読めない理由（未セットアップ / 壊れている）をそのまま利用者向けの失敗へ変換する。
 * どのテンプレートの話かはソース種別で表記が変わるので、ここで文字列に落とす。
 */
function loadInitTemplateConfig(
  templateDir: AbsPath,
  source: TemplateSource,
): Effect.Effect<ZikuConfig, ZikuFailure> {
  return loadTemplateConfig(templateDir).pipe(
    Effect.catchTag("TemplateNotConfiguredError", () => {
      const templateRef = match(source)
        .with({ kind: "local" }, (s) => s.path)
        .with({ kind: "github" }, (s) => `${s.owner}/${s.repo}`)
        .exhaustive();
      return Effect.fail(zikuFailure({ kind: "TemplateNotConfigured", templateRef }));
    }),
    Effect.catchTag("ParseError", (err) =>
      Effect.fail(
        zikuFailure(
          { kind: "ConfigUnparsable", path: err.path, detail: String(err.cause) },
          { cause: err.cause },
        ),
      ),
    ),
  );
}

/**
 * 配置するディレクトリを決める。
 *
 * include パターンをトップレベルディレクトリでグループ化し、選択の単位にする。
 */
async function chooseDirectories(
  templateConfig: ZikuConfig,
  args: InitArgs,
): Promise<FlatPatterns> {
  const entries = extractDirectoryEntries(templateConfig.include);

  const selected = await match(
    planDirectorySelection(entries, { yes: args.yes, dirsArg: args.dirs }),
  )
    .with({ _tag: "SelectAll" }, ({ patterns, directoryCount }) => {
      log.info(`Selected ${pc.cyan(directoryCount.toString())} directories`);
      return patterns;
    })
    .with({ _tag: "SelectNamed" }, ({ patterns }) => patterns)
    .with({ _tag: "UnknownDirs" }, ({ unknown, available }): never => {
      throw zikuFailure({
        kind: "InvalidArgument",
        argument: "--dirs",
        value: unknown.join(", "),
        expected: `one of ${available.join(", ")}`,
      });
    })
    .with({ _tag: "AskUser" }, () => {
      log.step("Selecting directories...");
      return selectDirectories(entries);
    })
    .exhaustive();

  return selectedFlatPatterns(templateConfig, selected);
}

/** 既存ファイルの扱いを決める。対話が必要なときだけユーザーに聞く。 */
function chooseOverwriteStrategy(args: InitArgs, targetDir: AbsPath): Promise<OverwriteStrategy> {
  return match(
    planOverwriteStrategy({
      force: args.force,
      strategyArg: args.overwriteStrategy,
      yes: args.yes,
    }),
  )
    .with({ _tag: "Decided" }, ({ strategy }) => Promise.resolve(strategy))
    .with({ _tag: "InvalidStrategy" }, ({ value }): never => {
      throw zikuFailure({
        kind: "InvalidArgument",
        argument: "--overwrite-strategy",
        value,
        expected: "overwrite, skip, or prompt",
      });
    })
    .with({ _tag: "AskUser" }, () =>
      selectOverwriteStrategy({ isReinit: zikuConfigExists(targetDir) }),
    )
    .exhaustive();
}

/** 適用の結果をユーザーへ伝える。 */
function reportOutcome(outcome: InitOutcome): void {
  match(outcome)
    .with({ _tag: "NoChanges" }, () => {
      log.info("No changes were made");
    })
    .with({ _tag: "DryRunPreview" }, () => {
      outro(
        [
          "Dry run complete — no files were written.",
          "",
          pc.dim("Run the same command without --dryRun to apply these changes."),
        ].join("\n"),
      );
    })
    .with({ _tag: "Applied" }, () => {
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
    })
    .exhaustive();
}

/** devcontainer の環境変数サンプルの置き場所。lock のベースを決めるときも同じ定数を使う。 */
const ENV_EXAMPLE_PATH: RepoRelPath = repoRelPath(".devcontainer/devcontainer.env.example");

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

/**
 * dir から見て、実行前から存在していた最も近い祖先ディレクトリを返す。dir 自身が
 * 既に存在する場合は dir 自身を返す。dryRun 終了後の後始末で「どこまで削除して
 * よいか」の基準点として使う。
 */
function findExistingAncestor(dir: string): string {
  let current = dir;
  while (!existsSync(current)) {
    const parent = dirname(current);
    if (parent === current) return current; // ルートに到達（通常は起きない）
    current = parent;
  }
  return current;
}

/**
 * dryRun 中に targetDir、あるいはその祖先ディレクトリが副作用（giget の
 * recursive:true な tempDir 作成等）で新規作成された場合、空のままなら
 * existingAncestor に達するまで削除して「dryRun は何も書き込まない」という
 * 保証を守る。existingAncestor より上（実行前から存在した部分）や、中身が
 * 残っているディレクトリ（何らかの理由で書き込みが発生した場合）は削除しない。
 * ダウンロード成功時・失敗時の両方から呼ばれる（失敗時に呼ばないと、途中まで
 * 作られたディレクトリが残ってしまう）。
 */
function removeEmptyDryRunDirs(
  targetDir: AbsPath,
  dryRun: boolean,
  existingAncestor: string,
): void {
  if (!dryRun) return;

  let current: string = targetDir;
  while (current !== existingAncestor) {
    if (!existsSync(current) || readdirSync(current).length > 0) return;
    rmdirSync(current);
    current = dirname(current);
  }
}

function createEnvExample(
  targetDir: AbsPath,
  strategy: OverwriteStrategy,
  dryRun = false,
): Promise<FileOperationResult> {
  return writeFileWithStrategy({
    destPath: joinAbs(targetDir, ENV_EXAMPLE_PATH),
    content: ENV_EXAMPLE_CONTENT,
    strategy,
    relativePath: ENV_EXAMPLE_PATH,
    dryRun,
  });
}

/**
 * .ziku/lock.json を書き出す（source + 同期状態: 常に上書き）。
 *
 * lock.json は overwrite-strategy を持たず常に上書きするため、writeFileWithStrategy を
 * 経由しない。dryRun: true の場合は判定結果（created/overwritten）だけ返し、saveLock は呼ばない。
 */
async function writeLockFile(
  targetDir: AbsPath,
  opts: {
    source: TemplateSource;
    baseHashes: HashMap;
    baseCommit: CommitSha | undefined;
    dryRun?: boolean;
  },
): Promise<FileOperationResult> {
  const lock = buildInitialLock({
    version,
    installedAt: new Date().toISOString(),
    source: opts.source,
    baseHashes: opts.baseHashes,
    baseCommit: opts.baseCommit,
  });

  const isNew = !existsSync(joinAbs(targetDir, LOCK_FILE));
  if (!opts.dryRun) {
    await saveLock(targetDir, lock);
  }

  return {
    action: isNew ? "created" : "overwritten",
    path: LOCK_FILE,
  };
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
  dryRun: boolean,
): Promise<GitHubTemplateRef> {
  if (from) return resolveExplicitSource(from);

  const { allCandidates, existingCandidates, deduplicatedCandidates } =
    await discoverTemplateCandidates();

  if (nonInteractive) {
    return match(planNonInteractiveSource(deduplicatedCandidates, allCandidates))
      .with({ _tag: "Use" }, ({ owner, repo }) => ({ sourceOwner: owner, sourceRepo: repo }))
      .with({ _tag: "Ambiguous" }, ({ candidates }): never => {
        throw zikuFailure({ kind: "AmbiguousTemplateSource", candidates });
      })
      .with({ _tag: "NotFound" }, ({ repos }): never => {
        throw zikuFailure({ kind: "TemplateRepoNotFound", repos });
      })
      .with({ _tag: "Undetectable" }, (): never => {
        throw zikuFailure({ kind: "TemplateSourceUndetectable" });
      })
      .exhaustive();
  }

  return match(planInteractiveSource(existingCandidates, allCandidates))
    .with({ _tag: "ChooseCandidate" }, async ({ candidates }) => {
      const selected = await selectTemplateCandidate([...candidates]);
      if (selected === "specify-other") return promptTemplateSource(dryRun);
      return { sourceOwner: selected.owner, sourceRepo: selected.repo };
    })
    .with({ _tag: "OfferCreation" }, ({ owner, repo }) =>
      handleMissingTemplate(owner, repo, dryRun),
    )
    .with({ _tag: "AskInput" }, () => {
      log.warn("Could not detect template source from git remote.");
      return promptTemplateSource(dryRun);
    })
    .exhaustive();
}

/**
 * 判別不能 (Unknown) レスポンスを受け取ったときに警告を出す。
 *
 * Unknown は 5xx やネットワーク断など "リポジトリ無し" とは断定できないケース。
 * 呼び出し側は続行を選択できるため、ここではログだけ出して戻る。
 */
function warnUnknownRepo(owner: string, repo: string, u: UnverifiedExistence): void {
  const statusPart = u.status !== undefined ? ` (HTTP ${u.status})` : "";
  log.warn(
    `Could not verify ${owner}/${repo}${statusPart}: ${u.reason}. Proceeding and letting the download step surface any real error.`,
  );
}

/**
 * 並列存在チェックの結果を受けて、続行するか中断するかを実行する。
 *
 * 判定を降格して続行する場合は、何が起きたのかをユーザーへ見せる（黙って結果が変わると、
 * 選ばれた候補が想定と違ったときに原因を追えない）。
 */
function applyProbeGate(gate: ProbeGate, context: string): void {
  match(gate)
    .with({ _tag: "Proceed" }, ({ degraded }) => {
      for (const existence of degraded) {
        log.warn(degradedProbeMessage(context, existence));
      }
    })
    .with({ _tag: "Blocked" }, ({ existence }): never => {
      throw blockedProbeError(existence);
    })
    .exhaustive();
}

function degradedProbeMessage(context: string, existence: BlockingExistence): string {
  return match(existence)
    .with(
      { _tag: "RateLimited" },
      () =>
        `Rate-limited probing ${context}, but at least one verified candidate is available — proceeding with the verified one.`,
    )
    .with(
      { _tag: "Unauthorized" },
      (u) =>
        `Auth check failed probing ${context} (${u.message}), but at least one verified candidate is available — proceeding with the verified one.`,
    )
    .exhaustive();
}

/** 存在確認そのものが成立しなかったことを、利用者向けの失敗へ変換する。 */
function blockedProbeError(existence: BlockingExistence): ZikuFailure {
  return match(existence)
    .with({ _tag: "RateLimited" }, (r) => rateLimitedError(r))
    .with({ _tag: "Unauthorized" }, (u) => unauthorizedError(u))
    .exhaustive();
}

/** リポジトリ 1 つの存在を問い合わせ、対象と組にして返す。 */
async function probeRepo<T>(
  item: T,
  owner: string,
  repo: string,
): Promise<{ item: T; existence: RepoExistence }> {
  return { item, existence: await checkRepoExists(owner, repo) };
}

/** リポジトリ 1 つのセットアップ状態を問い合わせ、対象と組にして返す。 */
async function probeSetup<T>(
  item: T,
  owner: string,
  repo: string,
): Promise<{ item: T; ready: boolean }> {
  return { item, ready: await checkRepoSetup(owner, repo) };
}

/**
 * --from で明示指定されたソースを解決する。
 * owner/repo 形式ならそのまま存在チェック、owner のみならデフォルトリポジトリを探索。
 */
function resolveExplicitSource(from: string): Promise<GitHubTemplateRef> {
  return match(planFromArg(from))
    .with({ _tag: "Invalid" }, ({ value }): never => {
      throw invalidFromArg(value);
    })
    .with({ _tag: "Repo" }, ({ owner, repo }) => resolveExplicitRepo(owner, repo))
    .with({ _tag: "OwnerOnly" }, ({ owner }) => resolveDefaultRepoForOwner(owner))
    .exhaustive();
}

/** 明示された owner/repo の存在を確かめる。 */
async function resolveExplicitRepo(owner: string, repo: string): Promise<GitHubTemplateRef> {
  const ref: GitHubTemplateRef = { sourceOwner: owner, sourceRepo: repo };
  return match(decideRepoProbe(await checkRepoExists(owner, repo)))
    .with({ _tag: "Verified" }, () => ref)
    .with({ _tag: "Unverified" }, ({ existence }) => {
      warnUnknownRepo(owner, repo, existence);
      return ref;
    })
    .with({ _tag: "Absent" }, (): never => {
      throw zikuFailure({ kind: "TemplateRepoNotFound", repos: [`${owner}/${repo}`] });
    })
    .with({ _tag: "Blocked" }, ({ existence }): never => {
      throw blockedProbeError(existence);
    })
    .exhaustive();
}

/** owner だけが指定されたときに、既定リポジトリ候補からセットアップ済みを優先して選ぶ。 */
async function resolveDefaultRepoForOwner(owner: string): Promise<GitHubTemplateRef> {
  const probes = await Promise.all(
    DEFAULT_TEMPLATE_REPOS.map((repo) => probeRepo(repo, owner, repo)),
  );
  applyProbeGate(gateProbeResults(probes.map((p) => p.existence)), `${owner}/<default repos>`);

  const ordered = orderProbedCandidates(probes);
  const usable = asNonEmpty(ordered.usable);
  if (usable === undefined) {
    throw zikuFailure({
      kind: "TemplateRepoNotFound",
      repos: DEFAULT_TEMPLATE_REPOS.map((repo) => `${owner}/${repo}`),
    });
  }

  // Unknown のみの候補には警告を出す（ユーザーが次のステップで何が起きているか分かるように）
  for (const { item, existence } of ordered.unverified) {
    warnUnknownRepo(owner, item, existence);
  }

  const setups = await Promise.all(usable.map((repo) => probeSetup(repo, owner, repo)));
  return { sourceOwner: owner, sourceRepo: preferReadyCandidate(setups, usable[0]) };
}

/**
 * 認証ユーザー・git remote オーナーからテンプレート候補を収集し、
 * 存在チェックとセットアップ状態の確認を行う。
 */
async function discoverTemplateCandidates(): Promise<{
  /** 存在チェックを行った候補全体。1 件も存在しなかったときの案内に使う。 */
  allCandidates: TemplateCandidate[];
  /** 存在を確かめられた候補（セットアップ状態付き）。 */
  existingCandidates: TemplateCandidate[];
  /** オーナー単位に絞った候補。 */
  deduplicatedCandidates: TemplateCandidate[];
}> {
  const detectedOwner = detectGitHubOwner();
  const authenticatedUser = await getAuthenticatedUserLogin();
  const allCandidates = buildOwnerCandidates({
    authenticatedUser: authenticatedUser ?? undefined,
    detectedOwner: detectedOwner ?? undefined,
    repos: DEFAULT_TEMPLATE_REPOS,
  });

  const probes = await Promise.all(
    allCandidates.map((candidate) => probeRepo(candidate, candidate.owner, candidate.repo)),
  );
  applyProbeGate(gateProbeResults(probes.map((p) => p.existence)), "auto-detected templates");

  const ordered = orderProbedCandidates(probes);
  for (const { item, existence } of ordered.unverified) {
    warnUnknownRepo(item.owner, item.repo, existence);
  }

  const setups = await Promise.all(
    ordered.usable.map((candidate) => probeSetup(candidate, candidate.owner, candidate.repo)),
  );
  const existingCandidates = withReadyFlags(setups);

  return {
    allCandidates,
    existingCandidates,
    deduplicatedCandidates: deduplicateByOwner(existingCandidates),
  };
}

/**
 * ユーザーにテンプレートソースを入力させ、存在チェックを行う
 */
async function promptTemplateSource(dryRun: boolean): Promise<GitHubTemplateRef> {
  const { owner, repo } = splitOwnerRepo(await inputTemplateSource());
  const ref: GitHubTemplateRef = { sourceOwner: owner, sourceRepo: repo };

  return match(decideRepoProbe(await checkRepoExists(owner, repo)))
    .with({ _tag: "Verified" }, () => ref)
    .with({ _tag: "Unverified" }, ({ existence }) => {
      warnUnknownRepo(owner, repo, existence);
      return ref;
    })
    .with({ _tag: "Absent" }, () => handleMissingTemplate(owner, repo, dryRun))
    .with({ _tag: "Blocked" }, ({ existence }): never => {
      throw blockedProbeError(existence);
    })
    .exhaustive();
}

/**
 * テンプレートリポジトリが見つからない場合のインタラクティブハンドリング。
 */
async function handleMissingTemplate(
  owner: string,
  repo: string,
  dryRun: boolean,
): Promise<GitHubTemplateRef> {
  const action = await selectMissingTemplateAction(owner, repo);

  return match(planMissingTemplateAction(action, { owner, repo, dryRun }))
    .with({ _tag: "CreationBlocked" }, ({ operation }): never => {
      throw zikuFailure({ kind: "DryRunBlocked", operation });
    })
    .with({ _tag: "CreateRepo" }, () => createTemplateRepo(owner, repo))
    .with({ _tag: "AskInput" }, () => promptTemplateSource(dryRun))
    .exhaustive();
}

/** テンプレートリポジトリを新規作成し、取得できる状態になるまで待つ。 */
async function createTemplateRepo(owner: string, repo: string): Promise<GitHubTemplateRef> {
  const token = getGitHubToken();
  if (!token) {
    throw zikuFailure({ kind: "GitHubTokenMissing", operation: "create a repository" });
  }

  log.step(`Creating ${pc.cyan(`${owner}/${repo}`)}...`);
  const { url } = await scaffoldTemplateRepo(token, owner, repo);
  log.success(`Created template repository: ${pc.cyan(url)}`);
  log.info(pc.dim("Waiting for repository to be ready..."));
  // 作成直後のリポジトリは取得に失敗することがあるため、初期化が終わるのを待ってから進む。
  await new Promise((done) => {
    setTimeout(done, 5000);
  });

  return { sourceOwner: owner, sourceRepo: repo };
}

/** `--from` の値が owner / owner/repo のどちらとしても読めないときの失敗。 */
function invalidFromArg(from: string): ZikuFailure {
  return zikuFailure({
    kind: "InvalidArgument",
    argument: "--from",
    value: from,
    expected: "owner or owner/repo (e.g., my-org or my-org/my-templates)",
  });
}

/**
 * テンプレートソースを解決する（純粋な解決ロジック、存在チェックなし）。
 * 存在チェックなしのため、デフォルトリポジトリ候補の先頭を使用する。
 */
export function resolveTemplateSource(from: string | undefined): GitHubTemplateRef | null {
  if (from) {
    return match(planFromArg(from))
      .with({ _tag: "Repo" }, ({ owner, repo }) => ({ sourceOwner: owner, sourceRepo: repo }))
      .with({ _tag: "OwnerOnly" }, ({ owner }) => ({
        sourceOwner: owner,
        sourceRepo: DEFAULT_TEMPLATE_REPO,
      }))
      .with({ _tag: "Invalid" }, ({ value }): never => {
        throw invalidFromArg(value);
      })
      .exhaustive();
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
