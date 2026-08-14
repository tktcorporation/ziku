import { defineCommand } from "citty";
import { Effect } from "effect";
import { P, match } from "ts-pattern";
import type { CommandLifecycle } from "../docs/lifecycle-types";
import { zikuFailure } from "../errors";
import type { ZikuFailure } from "../errors";
import type { AbsPath, GlobPattern } from "../modules/schemas";
import { runCommandEffect } from "../services/command-context";
import {
  checkRepoExists,
  getGitHubToken,
  createPullRequest,
  fetchDefaultBranch,
  fetchRepoSetupState,
  rateLimitedError,
  unauthorizedError,
} from "../utils/github";
import type { RepoSetupState } from "../utils/github";
import { detectGitHubOwner, DEFAULT_TEMPLATE_REPO } from "../utils/git-remote";
import { absPath, globPatterns } from "../utils/paths";
import {
  ZIKU_CONFIG_FILE,
  generateZikuJsonc,
  saveZikuConfig,
  zikuConfigExists,
} from "../utils/ziku-config";
import { confirmAction } from "../ui/prompts";
import { intro, log, outro, pc } from "../ui/renderer";

// ビルド時に置換される定数
declare const __VERSION__: string;
const version = typeof __VERSION__ !== "undefined" ? __VERSION__ : "dev";

/**
 * setup コマンドのファイル操作メタデータ。
 * テンプレートリポジトリに .ziku/ziku.jsonc を作成する。
 */
export const setupLifecycle: CommandLifecycle = {
  name: "setup",
  description: "Initialize a template repository",
  ops: [
    {
      file: ZIKU_CONFIG_FILE,
      location: "template",
      op: "create",
      note: "デフォルト include パターンで生成（既存ならスキップ）",
    },
  ],
};

/**
 * AI agent の設定共有を主な用途として想定したデフォルト include パターン。
 * Claude Code のルール・スキル・フック、MCP 設定、開発環境設定をカバーする。
 */
const DEFAULT_INCLUDE_PATTERNS: GlobPattern[] = globPatterns([
  ".claude/settings.json",
  ".claude/rules/*.md",
  ".claude/skills/**",
  ".claude/hooks/**",
  ".mcp.json",
  ".devcontainer/**",
  ".github/**",
]);

export const setupCommand = defineCommand({
  meta: {
    name: "setup",
    version,
    description: "Initialize a template repository with .ziku/ziku.jsonc",
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
    dryRun: {
      type: "boolean",
      alias: "n",
      description: "Preview what would be created, without writing files or opening a PR",
      default: false,
    },
    yes: {
      type: "boolean",
      alias: "y",
      description: "Skip prompts (with --remote, the PR is opened without asking to confirm)",
      default: false,
    },
  },
  async run({ args }) {
    intro("setup");

    const dryRun = args.dryRun as boolean;

    if (args.remote) {
      await handleRemoteSetup(args.from as string | undefined, { dryRun, yes: args.yes });
      return;
    }

    const targetDir = absPath(args.dir);
    await runCommandEffect(handleLocalSetup(targetDir, dryRun));
  },
});

/**
 * setup が行う操作。
 *
 * 生成した内容は `Create` からしか取り出せない。書き込み先（ローカルのファイル / リモートへの
 * PR）がどちらでも、内容を得るには {@link planSetup} を通る必要があるので、片方の経路にだけ
 * ガードが無い状態を作れない。
 */
type SetupPlan =
  | { readonly _tag: "AlreadyConfigured" }
  | { readonly _tag: "Create"; readonly content: string };

/**
 * テンプレートの設定状態から、setup が行う操作を決める。
 *
 * 既に設定済みなら何もしない。`ziku setup` は「まだ ziku を使っていないテンプレートに規定の
 * 設定を置く」操作で、既存の設定を規定値へ戻すと、そのテンプレートを使う全プロジェクトの
 * 同期対象が変わってしまう。
 *
 * 確認できなかった場合は進める。リポジトリの存在確認と同じ扱いで、一時的な障害で作業を
 * 止めない。取り違えたまま進んでも、規定値で既存の設定を置き換える PR は作成の直前に
 * 止まる（`createPullRequest` の `onExistingFiles`）。
 */
function planSetup(state: RepoSetupState): SetupPlan {
  const create = (): SetupPlan => ({
    _tag: "Create",
    content: generateZikuJsonc({ include: DEFAULT_INCLUDE_PATTERNS, exclude: [] }),
  });

  return match(state)
    .with({ _tag: "Configured" }, (): SetupPlan => ({ _tag: "AlreadyConfigured" }))
    .with({ _tag: "NotConfigured" }, create)
    .with({ _tag: "Unknown" }, ({ reason }) => {
      log.warn(`Could not verify whether ${ZIKU_CONFIG_FILE} already exists: ${reason}.`);
      return create();
    })
    .exhaustive();
}

/** ローカルのテンプレートが設定済みか。ディスクを見るので確認不能にはならない。 */
function localSetupState(targetDir: AbsPath): RepoSetupState {
  return zikuConfigExists(targetDir) ? { _tag: "Configured" } : { _tag: "NotConfigured" };
}

/**
 * 書き出す `ziku.jsonc` の内容を返す。設定済みなら結びまで表示して `undefined` を返す。
 *
 * ローカル実行もリモート実行もここを通ってから内容を得る。書き込みの直前に別の判断を
 * 足せる場所が無いので、片方の経路だけ設定済みのテンプレートを書き換える状態にならない。
 *
 * @param where 設定済みだったときに名指しする対象（ローカルはディレクトリ、リモートは owner/repo）。
 */
function setupContentFor(state: RepoSetupState, where: string): string | undefined {
  return match(planSetup(state))
    .with({ _tag: "AlreadyConfigured" }, () => {
      log.success(`${where} already has ${ZIKU_CONFIG_FILE}`);
      outro("Template repository is already configured.");
      return undefined;
    })
    .with({ _tag: "Create" }, (plan) => plan.content)
    .exhaustive();
}

/**
 * ローカルのテンプレートリポジトリに .ziku/ziku.jsonc を作成する。
 *
 * テンプレートリポジトリのルートで `ziku setup` を実行した場合の処理。
 * 作るか何もしないかは {@link planSetup} が決める（リモートと同じ判断）。
 */
function handleLocalSetup(targetDir: AbsPath, dryRun: boolean): Effect.Effect<void, ZikuFailure> {
  return Effect.gen(function* () {
    log.info(`Target: ${pc.cyan(targetDir)}`);

    const content = setupContentFor(localSetupState(targetDir), targetDir);
    if (content === undefined) return;

    if (dryRun) {
      log.info("Dry run mode");
      log.message(previewIncludePatterns(`Would create ${ZIKU_CONFIG_FILE} with:`));
      outro(`Dry run complete — ${ZIKU_CONFIG_FILE} was not written`);
      return;
    }

    log.step("Generating .ziku/ziku.jsonc...");

    yield* Effect.tryPromise({
      try: () => saveZikuConfig(targetDir, content),
      catch: (cause) =>
        zikuFailure(
          {
            kind: "FileWriteFailed",
            path: ZIKU_CONFIG_FILE,
            directory: targetDir,
            detail: String(cause),
          },
          { cause },
        ),
    });

    log.success("Created .ziku/ziku.jsonc");

    outro(
      [
        "Template initialized!",
        "",
        pc.bold("Next steps:"),
        `  ${pc.cyan("1.")} Review and customize ${pc.dim(".ziku/ziku.jsonc")}`,
        `  ${pc.cyan("2.")} ${pc.cyan("git add .ziku/ && git commit -m 'chore: add ziku config'")}`,
        `  ${pc.dim("Then other projects can use this template with")} ${pc.cyan("npx ziku init")}`,
      ].join("\n"),
    );
  });
}

/** --dryRun のプレビュー本文: 生成される include パターンを列挙する */
function previewIncludePatterns(heading: string): string {
  return [heading, ...DEFAULT_INCLUDE_PATTERNS.map((p) => `  ${pc.green("+")} ${p}`)].join("\n");
}

/**
 * リモートのテンプレートリポジトリに ziku.jsonc を追加する PR を作成する。
 *
 * @param opts.yes 確認プロンプトを省く。他コマンドと同じく対話の省略だけを意味し、破壊的
 *   操作の承認は含まない。ここで行うのは PR の作成で、テンプレートに変更が入るかはレビュー側が
 *   決めるため、承認を別に求めずそのまま作成まで進む。
 */
async function handleRemoteSetup(
  from: string | undefined,
  opts: { dryRun: boolean; yes: boolean },
): Promise<void> {
  const { owner, repo } = resolveRemoteTarget(from);

  log.info(`Template: ${pc.cyan(`${owner}/${repo}`)}`);

  const existence = await checkRepoExists(owner, repo);
  match(existence)
    .with({ _tag: "Exists" }, () => {})
    .with({ _tag: "Unknown" }, (u) => {
      // 確認不能（5xx/ネットワーク断等）は続行し、後続の PR 作成で本当のエラーを出させる
      const statusPart = u.status !== undefined ? ` (HTTP ${u.status})` : "";
      log.warn(`Could not verify ${owner}/${repo}${statusPart}: ${u.reason}. Proceeding anyway.`);
    })
    .with({ _tag: "NotFound" }, (): never => {
      throw zikuFailure({ kind: "TemplateRepoNotFound", repos: [`${owner}/${repo}`] });
    })
    .with({ _tag: "RateLimited" }, (r): never => {
      throw rateLimitedError(r);
    })
    .with({ _tag: "Unauthorized" }, (u): never => {
      throw unauthorizedError(u);
    })
    .exhaustive();

  // 設定済みかの確認はローカルと同じ判断へ通す（{@link planSetup}）。片方の経路だけが
  // 既存の設定を規定値で書き戻す PR を作れる状態にしない。
  const content = setupContentFor(await fetchRepoSetupState(owner, repo), `${owner}/${repo}`);
  if (content === undefined) return;

  if (opts.dryRun) {
    log.info("Dry run mode");
    log.message(
      previewIncludePatterns(
        `Would open a PR on ${owner}/${repo} adding ${ZIKU_CONFIG_FILE} with:`,
      ),
    );
    outro("Dry run complete — no PR was created");
    return;
  }

  // 宛先ブランチは確認プロンプトやトークン取得より先に決める。宛先が定まらないまま対話を
  // 進めると、必ず中断する作業をユーザーにさせることになる。
  const baseBranch = await resolvePrBaseBranch(owner, repo);

  if (!opts.yes) {
    const confirmed = await confirmAction(
      `Create a PR to add .ziku/ziku.jsonc to ${owner}/${repo} (→ ${baseBranch})?`,
      { initialValue: true },
    );
    if (!confirmed) {
      log.info("Cancelled.");
      return;
    }
  }

  const token = getGitHubToken();
  if (!token) {
    throw zikuFailure({ kind: "GitHubTokenMissing", operation: "create a PR" });
  }

  log.step(`Creating PR to add .ziku/ziku.jsonc to ${pc.cyan(`${owner}/${repo}`)}...`);
  const result = await createPullRequest(token, {
    owner,
    repo,
    files: [{ path: ZIKU_CONFIG_FILE, content }],
    title: "chore: add .ziku/ziku.jsonc for ziku",
    body: `## Summary\n\nAdd \`.ziku/ziku.jsonc\` to enable ziku template management.\n\nThis file defines the include/exclude patterns that ziku tracks for\nbi-directional synchronization between this template and downstream projects.\n\n---\nGenerated by [ziku](https://github.com/tktcorporation/ziku)\n`,
    baseBranch,
    // setup は足すだけの操作。宛先の確認と PR の作成の間に誰かが設定した場合も、
    // 規定値で置き換えず止まる。
    onExistingFiles: "fail",
  });
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
 * PR の宛先ブランチを決める。
 *
 * 既定ブランチは `main` とは限らない（`master` / `trunk` 等）。名前を仮定すると、
 * 存在しないブランチを宛先にした PR 作成が GitHub API の 404 で落ち、ziku 側の不具合として
 * 表示される。引けなかったときは宛先が定まらないので、仮定せず失敗として報告する。
 *
 * 引けなかった理由は潰さずに受け取る（{@link fetchDefaultBranch}）。トークンを拒否された
 * 場合に取る行動はトークンを入れ直すことで、`DefaultBranchUnresolved` が案内する
 * `.ziku/lock.json` の `source.ref` は setup の対象リポジトリにまだ存在しない。
 */
async function resolvePrBaseBranch(owner: string, repo: string): Promise<string> {
  return match(await fetchDefaultBranch(owner, repo))
    .with({ _tag: "Resolved" }, (r) => r.name)
    .with({ _tag: "AuthRejected" }, (f): never => {
      throw zikuFailure({ kind: "GitHubAuthRejected", detail: f.detail });
    })
    .with({ _tag: "Unresolved" }, (): never => {
      throw zikuFailure({ kind: "DefaultBranchUnresolved", repo: `${owner}/${repo}` });
    })
    .exhaustive();
}

/**
 * --from 引数またはgit remoteからリモートテンプレートのowner/repoを解決する。
 */
function resolveRemoteTarget(from: string | undefined): { owner: string; repo: string } {
  // 空文字列も検証対象にするため、値の有無は undefined で判定する。
  // `--from ""` を「未指定」として git remote 検出へ流すと、意図と違うリポジトリに
  // PR を作りにいく。
  if (from !== undefined) {
    return parseFromArg(from);
  }

  const detectedOwner = detectGitHubOwner();
  if (detectedOwner) {
    return { owner: detectedOwner, repo: DEFAULT_TEMPLATE_REPO };
  }

  throw zikuFailure({ kind: "TemplateSourceUndetectable" });
}

/**
 * `--from` の値を owner / repo へ分解する。
 *
 * 受け付ける形式は `owner`（リポジトリ名はデフォルトで補完）と `owner/repo` の 2 つだけ。
 * 空のセグメント（`a/`、`/b`、``）とスラッシュ 2 つ以上（`a/b/c`）は、そのまま渡すと
 * 存在しない owner / repo への API 呼び出しになるため入口で弾く。
 */
function parseFromArg(from: string): { owner: string; repo: string } {
  const invalid = zikuFailure({
    kind: "InvalidArgument",
    argument: "--from",
    value: from,
    expected: "owner or owner/repo (e.g., my-org or my-org/my-templates)",
  });

  const segments = from.split("/");

  return match(segments)
    .with([P.string], ([owner]) => {
      if (!owner.trim()) throw invalid;
      return { owner, repo: DEFAULT_TEMPLATE_REPO };
    })
    .with([P.string, P.string], ([owner, repo]) => {
      if (!owner.trim() || !repo.trim()) throw invalid;
      return { owner, repo };
    })
    .otherwise((): never => {
      throw invalid;
    });
}
