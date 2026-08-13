import { existsSync, mkdirSync, readdirSync, rmdirSync } from "node:fs";
import { defineCommand } from "citty";
import { Effect } from "effect";
import { dirname } from "pathe";
import { withCleanup } from "../effect-helpers";
import { runCommandEffect } from "../services/command-context";
import { loadTemplateConfig, extractDirectoryEntries } from "../utils/template-config";
import type { CommandLifecycle } from "../docs/lifecycle-types";
import { SYNCED_FILES } from "../docs/lifecycle-types";
import type {
  AbsPath,
  CommitSha,
  ContentHash,
  FileOperationResult,
  GlobPattern,
  HashMap,
  LockState,
  OverwriteStrategy,
  TemplateSource,
} from "../modules/schemas";
import { createPendingLock, markSynced } from "../modules/schemas";
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
import { hashContent, hashFiles } from "../utils/hash";
import { absPath, joinAbs } from "../utils/paths";
import { LOCK_FILE, saveLock } from "../utils/lock";
import {
  ZIKU_CONFIG_FILE,
  generateZikuJsonc,
  withConfigTracked,
  zikuConfigExists,
} from "../utils/ziku-config";
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
    // ヘッダー表示
    intro();

    // "init" という引数は無視して現在のディレクトリを使用
    const dir = args.dir === "init" ? "." : args.dir;
    const targetDir = absPath(dir);
    const dryRun = args.dryRun as boolean;
    // targetDir 自身だけでなく、存在しない祖先ディレクトリも giget が recursive:true で
    // まとめて作ってしまう（例: targetDir が /tmp/new-parent/project で new-parent も
    // 未作成の場合、両方が副作用で作られる）。dryRun 終了後にどこまで後始末してよいかの
    // 基準点として、実行前から存在していた最も近い祖先を記録しておく。
    const existingAncestor = findExistingAncestor(targetDir);
    const targetDirPreexisted = existingAncestor === targetDir;

    log.info(`Target: ${pc.cyan(targetDir)}`);
    if (dryRun) {
      log.info("Dry run mode");
    }

    // ディレクトリ作成。dryRun 中は作成しない — giget や writeFileWithStrategy は
    // 書き込み時に親ディレクトリを自動作成するため targetDir の事前存在は不要で、
    // ここで作成すると「何も書き込まなかった」という dryRun の保証に反してしまう。
    if (!targetDirPreexisted) {
      if (dryRun) {
        log.message(pc.dim(`Would create directory: ${targetDir}`));
      } else {
        mkdirSync(targetDir, { recursive: true });
        log.message(pc.dim(`Created directory: ${targetDir}`));
      }
    }

    // ─── 入り口: テンプレートソースの解決 ───
    const fromDir = args["from-dir"] as string | undefined;

    let templateDir: AbsPath;
    let cleanup: () => void;
    let source: TemplateSource;

    if (fromDir) {
      // ローカルディレクトリをテンプレートとして使用（ダウンロード不要）
      templateDir = absPath(fromDir);
      cleanup = () => {};
      source = { kind: "local", path: templateDir };
      log.info(`Template: ${pc.cyan(templateDir)} (local)`);
    } else {
      // GitHub リポジトリからダウンロード
      const resolved = await resolveTemplateSourceWithCheck(
        args.from as string | undefined,
        args.yes as boolean,
        dryRun,
      );
      source = { kind: "github", owner: resolved.sourceOwner, repo: resolved.sourceRepo };

      log.info(`Template: ${pc.cyan(`${resolved.sourceOwner}/${resolved.sourceRepo}`)}`);

      log.step("Fetching template...");
      // giget は tempDir (targetDir/.ziku-temp) の親ディレクトリも再帰的に作成するため、
      // dryRun かつ targetDir が未作成だった場合、ここで targetDir 自体が副作用的に
      // 作られてしまう。ダウンロードが失敗した場合も同じ副作用は起きているのに、
      // 失敗時は cleanupWithTargetDir の構築（このブロックの外）まで到達せず後始末が
      // 漏れるため、ここでも失敗経路を捕まえて同じ後始末を行う（try/catch は
      // ast-grep で禁止のため Promise.then(onFulfilled, onRejected) を使う）。
      const downloaded = await withSpinner("Downloading template from GitHub...", () =>
        downloadTemplateToTemp(targetDir, `gh:${resolved.sourceOwner}/${resolved.sourceRepo}`),
      ).then(
        (result) => result,
        (error: unknown) => {
          removeEmptyDryRunDirs(targetDir, dryRun, existingAncestor);
          throw error;
        },
      );
      templateDir = downloaded.templateDir;
      cleanup = downloaded.cleanup;
    }

    // dryRun で targetDir やその祖先が存在しなかった場合、giget のダウンロード
    // （tempDir 作成）がそれらを副作用的に作ってしまうことがある。テンプレート側の
    // cleanup（tempDir 削除）の後に、existingAncestor に達するまで空のディレクトリを
    // 削除する。
    const cleanupWithTargetDir = (): void => {
      cleanup();
      removeEmptyDryRunDirs(targetDir, dryRun, existingAncestor);
    };

    // ─── 共通処理: テンプレート適用 ───
    // 本体を Effect.promise で包む理由: 本体はテンプレート展開・プロンプト・ファイル書き込みを
    // Promise で連ねており、失敗は型に現れず throw で抜ける。Effect.tryPromise の catch で
    // 拾うとエラーチャネルが unknown に潰れるので、defect として運び runCommandEffect が
    // 投げられた値をそのまま再スローする。
    await runCommandEffect(
      withCleanup(
        Effect.promise(async () => {
          // テンプレートの ziku.jsonc を Effect で読み込む
          const templateConfig = await runCommandEffect(
            loadTemplateConfig(templateDir).pipe(
              Effect.catchTag("TemplateNotConfiguredError", (_err) => {
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
            dryRun,
          });

          const allResults: FileOperationResult[] = [...templateResults];

          // devcontainer.env.example を戦略に従って作成
          const hasDevcontainer = flatPatterns.include.some((p) => p.startsWith(".devcontainer/"));
          if (hasDevcontainer) {
            const envResult = await createEnvExample(targetDir, effectiveStrategy, dryRun);
            allResults.push(envResult);
          }

          // テンプレートファイルのハッシュを計算（pull 時の差分検出用）。
          // ziku.jsonc 自体も追跡ファイルになったため withConfigTracked で含める。
          const baseHashes = await hashFiles(
            templateDir,
            withConfigTracked(flatPatterns.include),
            flatPatterns.exclude,
          );

          // ziku.jsonc の base（共通祖先）を決める。init は「テンプレートのパターンの部分集合」
          // だけを選んで導入できるため、ローカル ziku.jsonc はテンプレより少ないことがある。
          // base をどちらに置くかで初回 push/pull の安全性が決まる → resolveConfigBaseHash が
          // そのポリシーを担う（テンプレートを壊さないための安全装置）。
          //
          // ただしテンプレートに ziku.jsonc が存在する場合（= hashFiles が値を返した場合）のみ
          // base を記録する。テンプレに無いのに base を記録すると、次回 pull で
          // {base 有・local 有・template 無} → deletedFiles と判定され、ローカルの制御ファイル
          // ziku.jsonc が削除されてしまう（codex P1）。テンプレに無い場合は base 未記録のまま
          // にしておき、ziku.jsonc は localOnly 扱いになる。
          if (baseHashes[ZIKU_CONFIG_FILE] !== undefined) {
            const localConfigContent = generateZikuJsonc({
              include: flatPatterns.include,
              exclude: flatPatterns.exclude,
            });
            baseHashes[ZIKU_CONFIG_FILE] = resolveConfigBaseHash({
              localConfigContent,
              templateConfigHash: baseHashes[ZIKU_CONFIG_FILE],
            });
          }

          // ベースのコミット SHA: GitHub ソースの場合のみ取得。
          // テンプレートを取得した ref とベースの SHA が食い違うと、3-way マージのベースが
          // 別ブランチのツリーになるため ref をそのまま渡す。
          const baseCommit = await match(source)
            .with({ kind: "github" }, (s) => resolveSourceCommitSha(s.owner, s.repo, s.ref))
            .with({ kind: "local" }, () => Promise.resolve(undefined))
            .exhaustive();

          // .ziku/ziku.jsonc を書き出し（パターン定義のみ、source なし）
          const zikuJsoncResult = await writeZikuJsonc(targetDir, {
            patterns: flatPatterns,
            strategy: effectiveStrategy,
            dryRun,
          });
          allResults.push(zikuJsoncResult);

          // .ziku/lock.json を書き出し（source + 同期状態）
          const lockResult = await writeLockFile(targetDir, {
            source,
            baseHashes,
            baseCommit,
            dryRun,
          });
          allResults.push(lockResult);

          // ファイル操作結果を表示（サマリー含む）
          const summary = logFileResults(allResults);

          // 変更がない場合
          if (summary.added === 0 && summary.updated === 0) {
            log.info("No changes were made");
            return;
          }

          if (dryRun) {
            outro(
              [
                "Dry run complete — no files were written.",
                "",
                pc.dim("Run the same command without --dryRun to apply these changes."),
              ].join("\n"),
            );
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
        }),
        cleanupWithTargetDir,
      ),
    );
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
    destPath: joinAbs(targetDir, ".devcontainer/devcontainer.env.example"),
    content: ENV_EXAMPLE_CONTENT,
    strategy,
    relativePath: ".devcontainer/devcontainer.env.example",
    dryRun,
  });
}

/**
 * init 時に lock の同期ベースへ `.ziku/ziku.jsonc` のハッシュとして記録する値を決める。
 *
 * ## なぜ専用ロジックが必要か
 * `ziku.jsonc` を「他の追跡ファイルと同じ 3-way マージ対象」にしたことで、共通祖先
 * （base）を何にするかが初回 push/pull の挙動を左右する。init はテンプレートのパターンの
 * **部分集合**だけを選んで導入できる（ユーザーが dir を選択）ため、ローカル `ziku.jsonc`
 * はテンプレより少ないことがある。
 *
 * ## トレードオフ（2 つの妥当なポリシー）
 * - base = テンプレートの ziku.jsonc ハッシュ:
 *     local(部分集合) != base(full) == template → push が「local がパターンを削除した」と
 *     解釈し、**テンプレートからパターンを削ってしまう**（全下流プロジェクトに波及する事故）。
 * - base = ローカル(部分集合) の ziku.jsonc ハッシュ:
 *     local == base → push 対象外（テンプレート安全）。
 *     pull 時は template != base==local → autoUpdate でテンプレの full 設定が降りてくる。
 *
 * @param opts.localConfigContent  init で書き出すローカル ziku.jsonc の中身
 * @param opts.templateConfigHash  テンプレートの ziku.jsonc のハッシュ（無い場合 undefined）
 * @returns 同期ベースの `.ziku/ziku.jsonc` に入れるハッシュ値
 */
export function resolveConfigBaseHash(opts: {
  localConfigContent: string;
  templateConfigHash: ContentHash | undefined;
}): ContentHash {
  // テンプレート保護のため base はローカル（部分集合）側に置く。
  // これにより local == base となり、初回 push でテンプレのパターンを削らない。
  return hashContent(opts.localConfigContent);
}

/**
 * .ziku/ziku.jsonc を書き出す（パターン定義のみ、source は lock.json に分離）
 */
function writeZikuJsonc(
  targetDir: AbsPath,
  opts: {
    patterns: FlatPatterns;
    strategy: OverwriteStrategy;
    dryRun?: boolean;
  },
): Promise<FileOperationResult> {
  const content = generateZikuJsonc({
    include: opts.patterns.include,
    exclude: opts.patterns.exclude,
  });

  return writeFileWithStrategy({
    destPath: joinAbs(targetDir, ZIKU_CONFIG_FILE),
    content,
    strategy: opts.strategy,
    relativePath: ZIKU_CONFIG_FILE,
    dryRun: opts.dryRun,
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
  const pending = createPendingLock({
    version,
    installedAt: new Date().toISOString(),
    source: opts.source,
  });
  // ハッシュが 1 件も取れなかった場合はベース未確定のまま残す。空のベースを「確定した
  // ベース」として書くと、次回以降テンプレート全体が新規扱いになる事実が読み取れなくなる。
  const lock: LockState =
    Object.keys(opts.baseHashes).length > 0
      ? markSynced(pending, { hashes: opts.baseHashes, commitSha: opts.baseCommit })
      : pending;

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
 * テンプレートの ziku.jsonc からパターンを解決する。
 *
 * include パターンをトップレベルディレクトリでグループ化し、
 * ユーザーにディレクトリ単位で選択させる。
 */
async function resolveTemplatePatterns(
  templateConfig: { include: GlobPattern[]; exclude?: GlobPattern[] },
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
  entries: Array<{ label: string; patterns: GlobPattern[] }>,
  nonInteractive: boolean,
  dirsArg: string | undefined,
): Promise<GlobPattern[]> {
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
      throw zikuFailure({
        kind: "InvalidArgument",
        argument: "--dirs",
        value: invalidLabels.join(", "),
        expected: `one of ${validLabels.join(", ")}`,
      });
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
 *
 * `--yes` が `skip` を選ぶのは、`--yes` が「プロンプトを省く」だけのフラグで、既存ファイルを
 * 失う承認を含まないため。既存の内容を捨ててよいかはユーザーにしか決められないので、
 * 承認が無い非対話実行では既存ファイルを残す側に倒す。上書きしたい場合は `--force`
 * （破壊的操作の承認）か `--overwrite-strategy overwrite`（明示指定）を使う。
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
      throw zikuFailure({
        kind: "InvalidArgument",
        argument: "--overwrite-strategy",
        value: strategyArg,
        expected: "overwrite, skip, or prompt",
      });
    }
    return strategyArg;
  }

  if (nonInteractive) return "skip";

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
  dryRun: boolean,
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
    if (selected === "specify-other") return promptTemplateSource(dryRun);
    return { sourceOwner: selected.owner, sourceRepo: selected.repo };
  }

  if (candidateEntries.length > 0) {
    const firstCandidate = candidateEntries[0];
    return handleMissingTemplate(firstCandidate.owner, firstCandidate.repo, dryRun);
  }

  log.warn("Could not detect template source from git remote.");
  return promptTemplateSource(dryRun);
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
 * 並列存在チェックの結果から、RateLimited / Unauthorized を即失敗にすべきか判断する。
 *
 * 背景: `Promise.all` で複数候補を並列に問い合わせると、クォータ境界で
 * `[Exists, RateLimited]` のように混在することがある。確認済みの Exists が
 * 1 つでもあれば、RateLimited / Unauthorized は警告に降格して候補選択を続行する
 * （以前の楽観的フォールバックに近い挙動を保つ）。Exists が無ければ、判定が
 * 全く不能なので RateLimited → Unauthorized の順で即時に明確なエラーを投げる。
 */
function ensureProbeUnblocked(results: readonly RepoExistence[], context: string): void {
  const hasExists = results.some((r) => r._tag === "Exists");
  if (hasExists) {
    for (const r of results) {
      if (r._tag === "RateLimited") {
        log.warn(
          `Rate-limited probing ${context}, but at least one verified candidate is available — proceeding with the verified one.`,
        );
      } else if (r._tag === "Unauthorized") {
        log.warn(
          `Auth check failed probing ${context} (${r.message}), but at least one verified candidate is available — proceeding with the verified one.`,
        );
      }
    }
    return;
  }
  // Exists が 1 つも無い: 候補判定が不能なので即失敗
  const rateLimited = results.find(
    (r): r is Extract<RepoExistence, { readonly _tag: "RateLimited" }> => r._tag === "RateLimited",
  );
  if (rateLimited) throw rateLimitedError(rateLimited);
  const unauthorized = results.find(
    (r): r is Extract<RepoExistence, { readonly _tag: "Unauthorized" }> =>
      r._tag === "Unauthorized",
  );
  if (unauthorized) throw unauthorizedError(unauthorized);
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
        throw zikuFailure({
          kind: "TemplateRepoNotFound",
          repos: [`${resolved.sourceOwner}/${resolved.sourceRepo}`],
        });
      })
      .with({ _tag: "RateLimited" }, (r): never => {
        throw rateLimitedError(r);
      })
      .with({ _tag: "Unauthorized" }, (u): never => {
        throw unauthorizedError(u);
      })
      .exhaustive();
  }

  // owner のみ指定 → デフォルトリポジトリ候補を順に探索（セットアップ済みを優先）
  const results = await Promise.all(
    DEFAULT_TEMPLATE_REPOS.map((repo) => checkRepoExists(resolved.sourceOwner, repo)),
  );

  // 並列チェックで Exists と RateLimited が混在しても、Exists があれば続行する。
  // Exists が皆無のときだけ RateLimited / Unauthorized を即失敗にする。
  ensureProbeUnblocked(results, `${resolved.sourceOwner}/<default repos>`);

  // Exists または Unknown (5xx/ネットワーク断等) を「ありえる候補」として採用。
  // NotFound のみ除外する。
  //
  // 並び: Exists を先頭、Unknown を末尾。末尾の readyRepo フォールバック
  // (candidateRepos[0]) が確認済み候補を優先するようにする。
  // 例: results=[Unknown(.ziku), Exists(.github)] の時、素朴に DEFAULT_TEMPLATE_REPOS 順
  // にすると .ziku が先頭に来て、ready でないケースで transient な .ziku を選んでしまう。
  // Exists/Unknown 内の相対順序は DEFAULT_TEMPLATE_REPOS の順（.ziku → .github）を保つ。
  const candidateRepos: string[] = [];
  for (let i = 0; i < DEFAULT_TEMPLATE_REPOS.length; i++) {
    if (results[i]._tag === "Exists") candidateRepos.push(DEFAULT_TEMPLATE_REPOS[i]);
  }
  for (let i = 0; i < DEFAULT_TEMPLATE_REPOS.length; i++) {
    if (results[i]._tag === "Unknown") candidateRepos.push(DEFAULT_TEMPLATE_REPOS[i]);
  }
  if (candidateRepos.length === 0) {
    throw zikuFailure({
      kind: "TemplateRepoNotFound",
      repos: DEFAULT_TEMPLATE_REPOS.map((repo) => `${resolved.sourceOwner}/${repo}`),
    });
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

  // 並列チェックで Exists と RateLimited が混在しても、Exists があれば続行する。
  // Exists が皆無のときだけ RateLimited / Unauthorized を即失敗にする。
  ensureProbeUnblocked(existenceResults, "auto-detected templates");

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
  // Exists を先頭、Unknown を末尾に配置。deduplicateByOwner / resolveNonInteractive は
  // 先頭の候補を採用するため、Unknown より確認済みの Exists を優先させる。
  // 同タグ内の相対順序（candidateEntries 順 = owner × DEFAULT_TEMPLATE_REPOS の積順）は保つ。
  const existingCandidates: TemplateCandidate[] = [
    ...candidateEntries.filter((_, i) => existenceResults[i]._tag === "Exists"),
    ...candidateEntries.filter((_, i) => existenceResults[i]._tag === "Unknown"),
  ];

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
    throw zikuFailure({
      kind: "AmbiguousTemplateSource",
      candidates: deduplicatedCandidates.map((c) => `${c.owner}/${c.repo}`),
    });
  }
  if (candidateEntries.length > 0) {
    const firstCandidate = candidateEntries[0];
    throw zikuFailure({
      kind: "TemplateRepoNotFound",
      repos: [`${firstCandidate.owner}/${firstCandidate.repo}`],
    });
  }
  throw zikuFailure({ kind: "TemplateSourceUndetectable" });
}

/**
 * ユーザーにテンプレートソースを入力させ、存在チェックを行う
 */
async function promptTemplateSource(
  dryRun: boolean,
): Promise<{ sourceOwner: string; sourceRepo: string }> {
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
    .with({ _tag: "NotFound" }, () => handleMissingTemplate(owner, repo, dryRun))
    .with({ _tag: "RateLimited" }, (r): never => {
      throw rateLimitedError(r);
    })
    .with({ _tag: "Unauthorized" }, (u): never => {
      throw unauthorizedError(u);
    })
    .exhaustive();
}

/**
 * テンプレートリポジトリが見つからない場合のインタラクティブハンドリング。
 *
 * dryRun: true では "create-repo" を選んでも実際には作成しない。リポジトリ作成は
 * ローカルの取り消し不能な変更ではなく GitHub 上への実書き込みで、他の dryRun 分岐
 * （ファイル書き込みの省略）と違って「実行したふり」ができない。プレビューを続行
 * するための有効なソースを作れないため、ここで中断してユーザーに選択肢を示す。
 */
async function handleMissingTemplate(
  owner: string,
  repo: string,
  dryRun: boolean,
): Promise<{ sourceOwner: string; sourceRepo: string }> {
  const action = await selectMissingTemplateAction(owner, repo);

  return match(action)
    .with("create-repo", async () => {
      if (dryRun) {
        throw zikuFailure({
          kind: "DryRunBlocked",
          operation: `Would create template repository ${owner}/${repo}`,
        });
      }

      const token = getGitHubToken();
      if (!token) {
        throw zikuFailure({ kind: "GitHubTokenMissing", operation: "create a repository" });
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
    .with("specify-source", () => promptTemplateSource(dryRun))
    .exhaustive();
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
      throw invalidFromArg(from);
    }
    return {
      sourceOwner: from,
      sourceRepo: DEFAULT_TEMPLATE_REPO,
    };
  }
  if (slashIndex === 0 || slashIndex === from.length - 1) {
    throw invalidFromArg(from);
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
