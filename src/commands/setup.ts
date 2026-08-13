import { defineCommand } from "citty";
import { Effect } from "effect";
import { resolve } from "pathe";
import { P, match } from "ts-pattern";
import type { CommandLifecycle } from "../docs/lifecycle-types";
import { ZikuError } from "../errors";
import { runCommandEffect } from "../services/command-context";
import {
  checkRepoExists,
  getGitHubToken,
  createPullRequest,
  rateLimitedError,
  unauthorizedError,
} from "../utils/github";
import { detectGitHubOwner, DEFAULT_TEMPLATE_REPO } from "../utils/git-remote";
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
const DEFAULT_INCLUDE_PATTERNS: string[] = [
  ".claude/settings.json",
  ".claude/rules/*.md",
  ".claude/skills/**",
  ".claude/hooks/**",
  ".mcp.json",
  ".devcontainer/**",
  ".github/**",
];

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
  },
  async run({ args }) {
    intro("setup");

    const dryRun = args.dryRun as boolean;

    if (args.remote) {
      await handleRemoteSetup(args.from as string | undefined, dryRun);
      return;
    }

    const targetDir = resolve(args.dir);
    await runCommandEffect(handleLocalSetup(targetDir, dryRun));
  },
});

/**
 * ローカルのテンプレートリポジトリに .ziku/ziku.jsonc を作成する。
 *
 * テンプレートリポジトリのルートで `ziku setup` を実行した場合の処理。
 * ziku.jsonc が既にあればスキップ。
 */
function handleLocalSetup(targetDir: string, dryRun: boolean): Effect.Effect<void, ZikuError> {
  return Effect.gen(function* () {
    log.info(`Target: ${pc.cyan(targetDir)}`);

    if (zikuConfigExists(targetDir)) {
      log.success(".ziku/ziku.jsonc already exists");
      outro("Template repository is already configured.");
      return;
    }

    const content = generateZikuJsonc({
      include: DEFAULT_INCLUDE_PATTERNS,
      exclude: [],
    });

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
        new ZikuError(
          `Failed to write ${ZIKU_CONFIG_FILE}: ${String(cause)}`,
          `Check write permissions for ${targetDir}`,
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
 */
async function handleRemoteSetup(from: string | undefined, dryRun: boolean): Promise<void> {
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
      throw new ZikuError(
        `Repository ${owner}/${repo} not found`,
        "Check the --from value or create the repository first",
      );
    })
    .with({ _tag: "RateLimited" }, (r): never => {
      throw rateLimitedError(r);
    })
    .with({ _tag: "Unauthorized" }, (u): never => {
      throw unauthorizedError(u);
    })
    .exhaustive();

  if (dryRun) {
    log.info("Dry run mode");
    log.message(
      previewIncludePatterns(
        `Would open a PR on ${owner}/${repo} adding ${ZIKU_CONFIG_FILE} with:`,
      ),
    );
    outro("Dry run complete — no PR was created");
    return;
  }

  const confirmed = await confirmAction(
    `Create a PR to add .ziku/ziku.jsonc to ${owner}/${repo}?`,
    { initialValue: true },
  );
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

  const content = generateZikuJsonc({
    include: DEFAULT_INCLUDE_PATTERNS,
    exclude: [],
  });

  log.step(`Creating PR to add .ziku/ziku.jsonc to ${pc.cyan(`${owner}/${repo}`)}...`);
  const result = await createPullRequest(token, {
    owner,
    repo,
    files: [{ path: ZIKU_CONFIG_FILE, content }],
    title: "chore: add .ziku/ziku.jsonc for ziku",
    body: `## Summary\n\nAdd \`.ziku/ziku.jsonc\` to enable ziku template management.\n\nThis file defines the include/exclude patterns that ziku tracks for\nbi-directional synchronization between this template and downstream projects.\n\n---\nGenerated by [ziku](https://github.com/tktcorporation/ziku)\n`,
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

  throw new ZikuError(
    "Cannot detect template source",
    "Specify --from <owner> or --from <owner/repo>",
  );
}

/**
 * `--from` の値を owner / repo へ分解する。
 *
 * 受け付ける形式は `owner`（リポジトリ名はデフォルトで補完）と `owner/repo` の 2 つだけ。
 * 空のセグメント（`a/`、`/b`、``）とスラッシュ 2 つ以上（`a/b/c`）は、そのまま渡すと
 * 存在しない owner / repo への API 呼び出しになるため入口で弾く。
 */
function parseFromArg(from: string): { owner: string; repo: string } {
  const invalid = new ZikuError(
    `Invalid --from format: "${from}"`,
    "Expected: owner or owner/repo (e.g., my-org or my-org/my-templates)",
  );

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
