import { vol } from "memfs";
import { Effect, Option } from "effect";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { FileNotFoundError, ZikuFailure, zikuFailure } from "../../errors";
import type {
  AbsPath,
  CommitSha,
  FileDiff,
  GitHubSource,
  LockState,
  ResumableLockState,
  TemplateSource,
} from "../../modules/schemas";
import {
  createPendingLock,
  markMerging,
  markSynced,
  templateRefToString,
} from "../../modules/schemas";
import type { FileMergeOutcome, MergeConflictFilesInput } from "../../utils/merge";

// fs モジュールをモック
vi.mock("node:fs", async () => {
  const memfs = await import("memfs");
  return memfs.fs;
});

// writeFile だけ差し替え可能にして、書き込み失敗の分類を検証できるようにする。
// 既定の挙動は memfs のまま。
vi.mock("node:fs/promises", async () => {
  const memfs = await import("memfs");
  const promises = memfs.fs.promises;
  return {
    ...promises,
    writeFile: vi.fn((...args: Parameters<typeof promises.writeFile>) =>
      promises.writeFile(...args),
    ),
  };
});

// loadCommandContext をモック（DI の恩恵: 低レベルモック不要）
// runCommandEffect / toZikuFailure は実際の実装を使い、loadCommandContext だけモックする
vi.mock("../../services/command-context", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../../services/command-context")>();
  return {
    ...actual,
    loadCommandContext: vi.fn(),
  };
});

// utils/diff をモック
vi.mock("../../utils/diff", () => ({
  detectDiff: vi.fn(),
  generateUnifiedDiff: vi.fn(() => ""),
}));

// utils/github をモック。失敗の分類（classifyGitHubApiFailure / githubApiFailure）は
// 検証対象そのものなので実装を通す。
vi.mock("../../utils/github", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../../utils/github")>();
  return {
    ...actual,
    getGitHubToken: vi.fn(),
    createPullRequest: vi.fn(),
    fetchDefaultBranch: vi.fn(() =>
      Promise.resolve<import("../../utils/github").DefaultBranchResolution>({
        _tag: "Resolved",
        name: "main",
      }),
    ),
  };
});

// utils/readme をモック
vi.mock("../../utils/readme", () => ({
  renderTemplateReadme: vi.fn(() => Promise.resolve(null)),
  detectReadmeUpdate: vi.fn(() => Promise.resolve(null)),
}));

// utils/untracked をモック
vi.mock("../../utils/untracked", () => ({
  detectUntrackedFiles: vi.fn(() => []),
  getTotalUntrackedCount: vi.fn((groups: Array<{ files: unknown[] }>) =>
    groups.reduce((sum, g) => sum + g.files.length, 0),
  ),
}));

// utils/hash をモック
vi.mock("../../utils/hash", () => ({
  hashFiles: vi.fn(() => ({})),
}));

// utils/merge をモック
vi.mock("../../utils/merge", async () => {
  const effectMod = await import("effect");

  const mergeOneFile = vi.fn();
  type BaseDownload = { templateDir: string; cleanup: () => void } | null;
  const downloadBaseForMerge = vi.fn(
    (_opts: {
      lock: import("../../modules/schemas").LockState;
      targetDir: string;
    }): import("effect").Effect.Effect<BaseDownload> => effectMod.Effect.succeed(null),
  );

  return {
    classifyFiles: vi.fn(() => ({
      autoUpdate: [],
      localOnly: [],
      conflicts: [],
      newFiles: [],
      deletedFiles: [],
      deletedWithLocalEdits: [],
      deletedLocally: [],
      unchanged: [],
    })),
    // conflict-io の共通ユーティリティ
    mergeOneFile,
    downloadBaseForMerge,
    // ベース取得と 1 ファイル単位のマージは上の 2 つのモックへ委ね、ループだけを再現する。
    // 「ベースを取得できなければ内容を読まず全て未解決」という本体の規則は、push 側の
    // 後処理（送る内容に採用するか / 除外するか）を検証するために代替側でも同じにしておく。
    mergeConflictFiles: vi.fn((input: MergeConflictFilesInput) =>
      effectMod.Effect.gen(function* () {
        const unresolved: Array<{ path: string; reason: "markers" | "noBase" | "binary" }> = [];
        if (input.conflicts.length === 0) return unresolved;

        const downloaded = yield* downloadBaseForMerge({
          lock: input.lock,
          targetDir: input.targetDir,
        });
        for (const file of input.conflicts) {
          const outcome: FileMergeOutcome =
            downloaded === null
              ? { _tag: "NoBase" }
              : (yield* mergeOneFile({
                  file,
                  targetDir: input.targetDir,
                  templateDir: input.templateDir,
                  base: { kind: "with-base", dir: downloaded.templateDir },
                })).outcome;
          yield* input.onFileResult({ file, outcome });
          if (outcome._tag === "Conflicted") unresolved.push({ path: file, reason: "markers" });
          if (outcome._tag === "NoBase") unresolved.push({ path: file, reason: "noBase" });
        }
        downloaded?.cleanup();
        return unresolved;
      }),
    ),
  };
});

// utils/template をモック（push 内部で base ダウンロード時に直接 import される）
vi.mock("../../utils/template", () => ({
  downloadTemplateToTemp: vi.fn(() =>
    Promise.resolve({ templateDir: "/tmp/base-template", cleanup: vi.fn() }),
  ),
  buildTemplateSource: vi.fn((source: GitHubSource) => {
    const base = `gh:${source.owner}/${source.repo}`;
    return source.ref ? `${base}#${templateRefToString(source.ref)}` : base;
  }),
  buildCommitPinnedSource: vi.fn(
    (source: GitHubSource, sha: string) => `gh:${source.owner}/${source.repo}#${sha}`,
  ),
}));

// ui/prompts をモック
vi.mock("../../ui/prompts", () => ({
  confirmAction: vi.fn(),
  generatePrTitle: vi.fn(() => "feat: add file.txt config"),
  generatePrBody: vi.fn(() => "## Changes\n\n**Added:**\n- `file.txt`"),
  inputGitHubToken: vi.fn(),
  inputPrTitle: vi.fn(),
  inputPrBody: vi.fn(),
  selectPushFiles: vi.fn(),
  selectUntrackedToTrack: vi.fn(() => []),
  logUntrackedFilesNotice: vi.fn(),
}));

// ui/renderer をモック
vi.mock("../../ui/renderer", () => ({
  intro: vi.fn(),
  outro: vi.fn(),
  log: {
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    success: vi.fn(),
    step: vi.fn(),
    message: vi.fn(),
  },
  logDiffSummary: vi.fn(),
  pc: {
    cyan: (s: string) => s,
    bold: (s: string) => s,
    dim: (s: string) => s,
    green: (s: string) => s,
    yellow: (s: string) => s,
    red: (s: string) => s,
  },
  withSpinner: vi.fn(async (_text: string, fn: () => Promise<unknown>) => fn()),
}));

// モック後にインポート
const { pushCommand } = await import("../push");
const { writeFile } = await import("node:fs/promises");
const { loadCommandContext } = await import("../../services/command-context");
const { detectDiff } = await import("../../utils/diff");
const { getGitHubToken, createPullRequest, fetchDefaultBranch } =
  await import("../../utils/github");
const {
  confirmAction,
  inputGitHubToken,
  inputPrTitle,
  inputPrBody,
  selectPushFiles,
  selectUntrackedToTrack,
  logUntrackedFilesNotice,
} = await import("../../ui/prompts");
const { detectUntrackedFiles } = await import("../../utils/untracked");
const { renderTemplateReadme, detectReadmeUpdate } = await import("../../utils/readme");
const { log, logDiffSummary } = await import("../../ui/renderer");
const { hashFiles } = await import("../../utils/hash");
const { classifyFiles, mergeOneFile, downloadBaseForMerge } = await import("../../utils/merge");
// マージ結果の判定は本物を使う（"../../utils/merge" のモックは index 経由の import だけを
// 置き換えるので、実装モジュールを直接読み込めば素の関数が得られる）。
const { classifyMergeOutcome } = await import("../../utils/merge/types");
const { absPath, commitSha, globPatterns, hashMap, pendingConflict, repoRelPath, repoRelPaths } =
  await import("../../__tests__/brands");
const mockWriteFile = vi.mocked(writeFile);
const mockLoadCommandContext = vi.mocked(loadCommandContext);
const mockDetectDiff = vi.mocked(detectDiff);
const mockGetGitHubToken = vi.mocked(getGitHubToken);
const mockCreatePullRequest = vi.mocked(createPullRequest);
const mockFetchDefaultBranch = vi.mocked(fetchDefaultBranch);
const mockConfirmAction = vi.mocked(confirmAction);
const mockInputGitHubToken = vi.mocked(inputGitHubToken);
const mockInputPrTitle = vi.mocked(inputPrTitle);
const mockInputPrBody = vi.mocked(inputPrBody);
const mockSelectPushFiles = vi.mocked(selectPushFiles);
const mockSelectUntrackedToTrack = vi.mocked(selectUntrackedToTrack);
const mockLogUntrackedFilesNotice = vi.mocked(logUntrackedFilesNotice);
const mockDetectUntrackedFiles = vi.mocked(detectUntrackedFiles);
const mockRenderTemplateReadme = vi.mocked(renderTemplateReadme);
const mockDetectReadmeUpdate = vi.mocked(detectReadmeUpdate);
const mockLog = vi.mocked(log);
const mockLogDiffSummary = vi.mocked(logDiffSummary);
const mockHashFiles = vi.mocked(hashFiles);
const mockClassifyFiles = vi.mocked(classifyFiles);
const mockMergeOneFile = vi.mocked(mergeOneFile);
const mockDownloadBaseForMerge = vi.mocked(downloadBaseForMerge);

const validZikuConfig = {
  include: globPatterns([".github/**"]),
  exclude: [],
};

const githubSource: TemplateSource = { kind: "github", owner: "tktcorporation", repo: ".github" };
const localTemplateSource: TemplateSource = { kind: "local", path: absPath("/local/template") };

const validLock: ResumableLockState = {
  version: "0.1.0",
  installedAt: "2024-01-01T00:00:00.000Z",
  source: githubSource,
  sync: "pending",
};

/** validLock のソースとベースを差し替えたロックを作る。 */
function lockWith(opts: {
  source?: TemplateSource;
  hashes?: Record<string, string>;
  commitSha?: string;
}): LockState {
  const base = createPendingLock({
    version: validLock.version,
    installedAt: validLock.installedAt,
    source: opts.source ?? githubSource,
  });
  return opts.hashes === undefined && opts.commitSha === undefined
    ? base
    : markSynced(base, {
        hashes: hashMap(opts.hashes ?? {}),
        commitSha: opts.commitSha === undefined ? undefined : commitSha(opts.commitSha),
      });
}

const emptyDiff = {
  files: [],
};

/** 何も push 対象にしない分類結果。`classifyFiles` の既定戻り値。 */
const emptyClassification = {
  autoUpdate: [],
  localOnly: [],
  conflicts: [],
  newFiles: [],
  deletedFiles: [],
  deletedWithLocalEdits: [],
  deletedLocally: [],
  unchanged: [],
};

/**
 * テスト用の CommandContext を生成するヘルパー。
 * DI のおかげでテンプレートダウンロードや設定読み込みのモックが不要。
 */
function mockContext(overrides?: {
  config?: typeof validZikuConfig;
  lock?: LockState;
  source?: TemplateSource;
  templateDir?: AbsPath;
}) {
  const cleanup = vi.fn();
  const source = overrides?.source ?? githubSource;
  return {
    effect: Effect.succeed({
      config: overrides?.config ?? validZikuConfig,
      lock: overrides?.lock ?? validLock,
      source,
      templateDir: overrides?.templateDir ?? absPath("/tmp/template"),
      cleanup,
      resolveBaseRef: Effect.succeed(Option.none<CommitSha>()),
    }),
    cleanup,
  };
}

/**
 * classification と detectDiff を同時にセットアップするヘルパー。
 * メインの push フローでは classifyFiles が pushable files の決定権を持ち、
 * detectDiff はコンテンツ提供のみを担うため、両方の整合性を取る必要がある。
 */
function setupPushableFiles(files: FileDiff[]) {
  // classification: 全ファイルを localOnly に分類（push 対象）
  mockClassifyFiles.mockReturnValueOnce({
    autoUpdate: [],
    localOnly: files.map((f) => f.path),
    conflicts: [],
    newFiles: [],
    deletedFiles: [],
    deletedWithLocalEdits: [],
    deletedLocally: [],
    unchanged: [],
  });

  // detectDiff: ファイル内容を提供
  mockDetectDiff.mockResolvedValueOnce({ files });
}

/**
 * モックを毎テストの初期状態へ戻す。
 *
 * `vi.clearAllMocks()` が消すのは呼び出し履歴だけで、`mockResolvedValueOnce` /
 * `mockReturnValueOnce` のキューは残る。push はフラグ次第で呼ぶ関数が変わる
 * （`--files` / `--yes` は選択プロンプトを呼ばない）ため、消費されなかったキューが
 * 次のテストに漏れて無関係なテストを壊す。キューごと落とす `mockReset()` を使い、
 * モジュールモックが持っていた既定の戻り値をここで貼り直す。
 */
function resetPushMocks(): void {
  vi.clearAllMocks();

  for (const mock of [
    mockLoadCommandContext,
    mockSelectPushFiles,
    mockConfirmAction,
    mockCreatePullRequest,
    mockGetGitHubToken,
    mockInputGitHubToken,
    mockInputPrTitle,
    mockInputPrBody,
    mockMergeOneFile,
  ]) {
    mock.mockReset();
  }

  mockClassifyFiles.mockReset();
  mockClassifyFiles.mockReturnValue(emptyClassification);
  mockDetectDiff.mockReset();
  mockDetectDiff.mockResolvedValue(emptyDiff);
  mockDetectUntrackedFiles.mockReset();
  mockDetectUntrackedFiles.mockResolvedValue([]);
  mockSelectUntrackedToTrack.mockReset();
  mockSelectUntrackedToTrack.mockResolvedValue([]);
  mockDownloadBaseForMerge.mockReset();
  mockDownloadBaseForMerge.mockReturnValue(Effect.succeed(null));
  mockHashFiles.mockReset();
  mockHashFiles.mockResolvedValue({});
  mockRenderTemplateReadme.mockReset();
  mockRenderTemplateReadme.mockResolvedValue(null);
  mockDetectReadmeUpdate.mockReset();
  mockDetectReadmeUpdate.mockResolvedValue(null);
  mockFetchDefaultBranch.mockReset();
  mockFetchDefaultBranch.mockResolvedValue({ _tag: "Resolved", name: "main" });
}

describe("pushCommand", () => {
  beforeEach(() => {
    vol.reset();
    resetPushMocks();

    // デフォルトのモック設定: 正常な CommandContext を返す
    const { effect } = mockContext();
    mockLoadCommandContext.mockReturnValue(effect);
  });

  describe("meta", () => {
    it("コマンドメタデータが正しい", () => {
      expect((pushCommand.meta as { name: string }).name).toBe("push");
      expect((pushCommand.meta as { description: string }).description).toBe(
        "Push local changes to the template (PR for GitHub, direct copy for local)",
      );
    });
  });

  describe("args", () => {
    it("dir 引数のデフォルト値は '.'", () => {
      const args = pushCommand.args as { dir: { default: string } };
      expect(args.dir.default).toBe(".");
    });

    it("dryRun 引数のデフォルト値は false", () => {
      const args = pushCommand.args as { dryRun: { default: boolean } };
      expect(args.dryRun.default).toBe(false);
    });

    it("yes 引数のデフォルト値は false", () => {
      const args = pushCommand.args as { yes: { default: boolean } };
      expect(args.yes.default).toBe(false);
    });

    it("yes の別名は -y だけ（-f は force 用の記号なので割り当てない）", () => {
      const args = pushCommand.args as { yes: { alias: string | string[] } };
      expect(args.yes.alias).toBe("y");
    });

    it("edit 引数のデフォルト値は false", () => {
      const args = pushCommand.args as { edit: { default: boolean } };
      expect(args.edit.default).toBe(false);
    });
  });

  describe("受け付けなくなったフラグ", () => {
    it.each(["-f", "--force", "--force=true"])("%s は案内を出して中断する", async (flag) => {
      await expect(
        (pushCommand.run as any)({
          args: { dir: "/test", dryRun: false, yes: false, edit: false },
          rawArgs: [flag],
          cmd: pushCommand,
        }),
      ).rejects.toThrow(`Invalid flag: "${flag}"`);
    });

    it("案内は代わりに使うフラグを示す", async () => {
      const error = await (pushCommand.run as any)({
        args: { dir: "/test", dryRun: false, yes: false, edit: false },
        rawArgs: ["-f"],
        cmd: pushCommand,
      }).catch((e: { hint: string }) => e);

      expect(error.hint).toContain("--yes");
      expect(error.hint).toContain("no longer accepts");
    });

    it("フラグを渡さなければ通常どおり実行する", async () => {
      await (pushCommand.run as any)({
        args: { dir: "/test", dryRun: false, yes: false, edit: false },
        rawArgs: ["--dir", "/test"],
        cmd: pushCommand,
      });

      expect(mockLog.info).toHaveBeenCalledWith("No changes to push");
    });
  });

  describe("run", () => {
    it(".ziku/ziku.jsonc が存在しない場合はエラー", async () => {
      mockLoadCommandContext.mockReturnValue(
        Effect.fail(new FileNotFoundError({ path: ".ziku/ziku.jsonc" })),
      );

      await expect(
        (pushCommand.run as any)({
          args: { dir: "/test", dryRun: false, yes: false, edit: false },
          rawArgs: [],
          cmd: pushCommand,
        }),
      ).rejects.toThrow(".ziku/ziku.jsonc not found.");
    });

    it(".ziku/lock.json が存在しない場合はエラー", async () => {
      mockLoadCommandContext.mockReturnValue(
        Effect.fail(new FileNotFoundError({ path: ".ziku/lock.json" })),
      );

      await expect(
        (pushCommand.run as any)({
          args: { dir: "/test", dryRun: false, yes: false, edit: false },
          rawArgs: [],
          cmd: pushCommand,
        }),
      ).rejects.toThrow(".ziku/lock.json not found.");
    });

    it("無効な .ziku/lock.json 形式の場合はエラー", async () => {
      // ParseError は toZikuFailure で対象ファイル名付きのメッセージに変換される
      const { ParseError } = await import("../../errors");
      mockLoadCommandContext.mockReturnValue(
        Effect.fail(new ParseError({ path: ".ziku/lock.json", cause: "invalid format" })),
      );

      await expect(
        (pushCommand.run as any)({
          args: { dir: "/test", dryRun: false, yes: false, edit: false },
          rawArgs: [],
          cmd: pushCommand,
        }),
      ).rejects.toThrow("Failed to parse .ziku/lock.json");
    });

    it("patterns が空の場合は警告", async () => {
      const { effect } = mockContext({
        config: { include: [], exclude: [] },
      });
      mockLoadCommandContext.mockReturnValue(effect);

      await (pushCommand.run as any)({
        args: { dir: "/test", dryRun: false, yes: false, edit: false },
        rawArgs: [],
        cmd: pushCommand,
      });

      expect(mockLog.warn).toHaveBeenCalledWith("No patterns configured");
    });

    it("push 対象ファイルがない場合は情報メッセージ", async () => {
      await (pushCommand.run as any)({
        args: { dir: "/test", dryRun: false, yes: false, edit: false },
        rawArgs: [],
        cmd: pushCommand,
      });

      expect(mockLog.info).toHaveBeenCalledWith("No changes to push");
    });

    it("--dry-run オプションで PR を作成しない", async () => {
      setupPushableFiles([
        { path: repoRelPath("file.txt"), type: "added", localContent: "content" },
      ]);

      await (pushCommand.run as any)({
        args: { dir: "/test", dryRun: true, yes: false, edit: false },
        rawArgs: [],
        cmd: pushCommand,
      });

      expect(mockLog.info).toHaveBeenCalledWith("Dry run mode");
      // dry-run ではファイルリストを表示して終了
      expect(mockCreatePullRequest).not.toHaveBeenCalled();
    });

    describe("テンプレート README の自動更新", () => {
      const rebuiltReadme = {
        updated: true,
        content: "# Template\n\n<!-- FILES:START -->\n- `.github/**`\n<!-- FILES:END -->\n",
      };
      const updatedReadme = { ...rebuiltReadme, readmePath: "/tmp/template/README.md" };

      /** README 以外に 1 件だけ送るものがある状態を作る。 */
      function setupSinglePushableFile(): void {
        setupPushableFiles([
          { path: repoRelPath("file.txt"), type: "added", localContent: "content" },
        ]);
        mockGetGitHubToken.mockReturnValue("ghp_token");
        mockCreatePullRequest.mockResolvedValueOnce({
          url: "https://github.com/owner/repo/pull/1",
          branch: "update-template-123",
          number: 1,
        });
      }

      it("マーカーがあると README の更新を同梱し、サマリと案内に出す", async () => {
        setupSinglePushableFile();
        mockRenderTemplateReadme.mockResolvedValueOnce(rebuiltReadme);

        await (pushCommand.run as any)({
          args: { dir: "/test", dryRun: false, yes: true, edit: false },
          rawArgs: [],
          cmd: pushCommand,
        });

        const prArg = mockCreatePullRequest.mock.calls[0]?.[1];
        expect(prArg?.files.map((f) => f.path)).toContain("README.md");

        // 選んでいないファイルが PR に出る理由を、送信前に名指しで伝える
        expect(mockLog.info).toHaveBeenCalledWith(
          "Also pushing README.md — its generated sections are rebuilt from .ziku/ziku.jsonc.",
        );

        const summary = mockLog.message.mock.calls
          .map((call) => call[0])
          .find((text) => text.includes("README.md"));
        expect(summary).toContain("(auto-updated)");
      });

      it("README が追跡ファイルとして送信対象に入っていても、同じパスは 1 度しか送らない", async () => {
        // 同じパスを 2 回送ると、2 回目の書き込みが 1 回目で変わった blob SHA と食い違って
        // 弾かれる。組み直した内容で既存のエントリを置き換える。
        setupPushableFiles([
          {
            path: repoRelPath("README.md"),
            type: "modified",
            localContent: "# Written by the user\n",
            templateContent: "# Template\n",
          },
        ]);
        mockGetGitHubToken.mockReturnValue("ghp_token");
        mockCreatePullRequest.mockResolvedValueOnce({
          url: "https://github.com/owner/repo/pull/1",
          branch: "update-template-123",
          number: 1,
        });
        mockRenderTemplateReadme.mockResolvedValueOnce(rebuiltReadme);

        await (pushCommand.run as any)({
          args: { dir: "/test", dryRun: false, yes: true, edit: false },
          rawArgs: [],
          cmd: pushCommand,
        });

        const prArg = mockCreatePullRequest.mock.calls[0]?.[1] as {
          files: readonly { path: string; content: string }[];
        };
        const readmeEntries = prArg.files.filter((f) => f.path === "README.md");
        expect(readmeEntries).toHaveLength(1);
        expect(readmeEntries[0]?.content).toBe(rebuiltReadme.content);
        // 組み直しの土台は、追跡ファイルとして送ろうとしているローカルの内容
        expect(mockRenderTemplateReadme).toHaveBeenCalledWith(
          expect.objectContaining({ readme: "# Written by the user\n" }),
        );
      });

      it("マーカーが無ければ同梱も案内もしない", async () => {
        setupSinglePushableFile();

        await (pushCommand.run as any)({
          args: { dir: "/test", dryRun: false, yes: true, edit: false },
          rawArgs: [],
          cmd: pushCommand,
        });

        const prArg = mockCreatePullRequest.mock.calls[0]?.[1];
        expect(prArg?.files.map((f) => f.path)).toEqual(["file.txt"]);
        expect(
          mockLog.info.mock.calls.map((call) => call[0]).filter((text) => text.includes("README")),
        ).toEqual([]);
      });

      it("--dry-run のプレビューでも README が同梱されることを予告する", async () => {
        setupPushableFiles([
          { path: repoRelPath("file.txt"), type: "added", localContent: "content" },
        ]);
        mockDetectReadmeUpdate.mockResolvedValueOnce(updatedReadme);

        await (pushCommand.run as any)({
          args: { dir: "/test", dryRun: true, yes: false, edit: false },
          rawArgs: [],
          cmd: pushCommand,
        });

        expect(mockLog.warn).toHaveBeenCalledWith(
          "README.md would also be pushed — its generated sections are rebuilt from .ziku/ziku.jsonc.",
        );
        // プレビューは何も書き換えない
        expect(mockRenderTemplateReadme).not.toHaveBeenCalled();
      });

      it("ローカルテンプレートへの --dry-run では README の更新を予告しない", async () => {
        // README の自動更新は GitHub への push でしか走らない。ローカルテンプレートへの
        // push で予告すると、実際には起きない更新を予告することになる。
        const { effect } = mockContext({
          source: localTemplateSource,
          templateDir: absPath("/local/template"),
          lock: lockWith({ source: localTemplateSource }),
        });
        mockLoadCommandContext.mockReturnValue(effect);
        setupPushableFiles([
          { path: repoRelPath("file.txt"), type: "added", localContent: "content" },
        ]);
        mockDetectReadmeUpdate.mockResolvedValueOnce(updatedReadme);

        await (pushCommand.run as any)({
          args: { dir: "/test", dryRun: true, yes: false, edit: false },
          rawArgs: [],
          cmd: pushCommand,
        });

        expect(
          mockLog.warn.mock.calls.map((call) => call[0]).filter((text) => text.includes("README")),
        ).toEqual([]);
        expect(mockDetectReadmeUpdate).not.toHaveBeenCalled();
      });

      it("--dry-run でマーカーが無ければ予告しない", async () => {
        setupPushableFiles([
          { path: repoRelPath("file.txt"), type: "added", localContent: "content" },
        ]);

        await (pushCommand.run as any)({
          args: { dir: "/test", dryRun: true, yes: false, edit: false },
          rawArgs: [],
          cmd: pushCommand,
        });

        expect(
          mockLog.warn.mock.calls.map((call) => call[0]).filter((text) => text.includes("README")),
        ).toEqual([]);
      });
    });

    it("--dry-run + --files はプレビューを指定ファイルだけに絞る（#81）", async () => {
      // push 候補を複数用意し、--files で 1 つだけ指定する
      mockClassifyFiles.mockReturnValueOnce({
        autoUpdate: [],
        localOnly: repoRelPaths(["a.txt", "b.txt"]),
        conflicts: [],
        newFiles: [],
        deletedFiles: [],
        deletedWithLocalEdits: [],
        deletedLocally: [],
        unchanged: [],
      });
      mockDetectDiff.mockResolvedValueOnce({
        files: [
          { path: repoRelPath("a.txt"), type: "added", localContent: "a" },
          { path: repoRelPath("b.txt"), type: "added", localContent: "b" },
        ],
      });

      await (pushCommand.run as any)({
        args: { dir: "/test", dryRun: true, yes: false, edit: false, files: "a.txt" },
        rawArgs: [],
        cmd: pushCommand,
      });

      // プレビューは --files で絞った集合のみ（実 push と一致）
      const previewArg = mockLogDiffSummary.mock.calls.at(-1)?.[0] ?? [];
      expect(previewArg.map((f) => f.path)).toEqual(["a.txt"]);
      expect(mockCreatePullRequest).not.toHaveBeenCalled();
    });

    it("--dry-run + --files で存在しないファイルは not found を警告する（#81）", async () => {
      setupPushableFiles([{ path: repoRelPath("a.txt"), type: "added", localContent: "a" }]);

      await (pushCommand.run as any)({
        args: { dir: "/test", dryRun: true, yes: false, edit: false, files: "missing.txt" },
        rawArgs: [],
        cmd: pushCommand,
      });

      expect(mockLog.warn).toHaveBeenCalledWith("Files not found: missing.txt");
      expect(mockLog.info).toHaveBeenCalledWith(
        "No files match the current selection — nothing would be pushed.",
      );
      expect(mockCreatePullRequest).not.toHaveBeenCalled();
    });

    it("--dry-run は未解決の衝突を既定でプレビューから除外する（#81）", async () => {
      const { effect } = mockContext({
        lock: lockWith({ hashes: { "conflict.txt": "abc123" } }),
      });
      mockLoadCommandContext.mockReturnValue(effect);

      mockClassifyFiles.mockReturnValueOnce({
        autoUpdate: [],
        localOnly: repoRelPaths(["normal.txt"]),
        conflicts: repoRelPaths(["conflict.txt"]),
        newFiles: [],
        deletedFiles: [],
        deletedWithLocalEdits: [],
        deletedLocally: [],
        unchanged: [],
      });
      mockDetectDiff.mockResolvedValueOnce({
        files: [
          {
            path: repoRelPath("normal.txt"),
            type: "modified",
            localContent: "n",
            templateContent: "nt",
          },
          {
            path: repoRelPath("conflict.txt"),
            type: "modified",
            localContent: "c",
            templateContent: "ct",
          },
        ],
      });
      // downloadBaseForMerge は既定で null を返すため conflict.txt は auto-merge 不可 → unresolved

      await (pushCommand.run as any)({
        args: { dir: "/test", dryRun: true, yes: false, edit: false },
        rawArgs: [],
        cmd: pushCommand,
      });

      // 未解決の衝突 conflict.txt はプレビューに含めない
      const previewArg = mockLogDiffSummary.mock.calls.at(-1)?.[0] ?? [];
      expect(previewArg.map((f) => f.path)).toEqual(["normal.txt"]);
      expect(mockCreatePullRequest).not.toHaveBeenCalled();
    });

    it("--dry-run + --files で衝突ファイルを指定すると push が中断する旨を警告する（#81）", async () => {
      const { effect } = mockContext({
        lock: lockWith({ hashes: { "conflict.txt": "abc123" } }),
      });
      mockLoadCommandContext.mockReturnValue(effect);

      mockClassifyFiles.mockReturnValueOnce({
        autoUpdate: [],
        localOnly: [],
        conflicts: repoRelPaths(["conflict.txt"]),
        newFiles: [],
        deletedFiles: [],
        deletedWithLocalEdits: [],
        deletedLocally: [],
        unchanged: [],
      });
      mockDetectDiff.mockResolvedValueOnce({
        files: [
          {
            path: repoRelPath("conflict.txt"),
            type: "modified",
            localContent: "c",
            templateContent: "ct",
          },
        ],
      });
      // downloadBaseForMerge は既定で null を返すため conflict.txt は unresolved

      await (pushCommand.run as any)({
        args: { dir: "/test", dryRun: true, yes: false, edit: false, files: "conflict.txt" },
        rawArgs: [],
        cmd: pushCommand,
      });

      // dry-run でも「実 push なら中断する」ことを予告する（実挙動と一致）
      expect(mockLog.warn).toHaveBeenCalledWith(expect.stringContaining("would block the push"));
      expect(mockCreatePullRequest).not.toHaveBeenCalled();
    });

    it("deletedWithLocalEdits は候補に入るが、非対話の既定集合からは外れる", async () => {
      const setupRestore = () => {
        mockClassifyFiles.mockReturnValueOnce({
          autoUpdate: [],
          localOnly: [],
          conflicts: [],
          newFiles: [],
          deletedFiles: [],
          deletedWithLocalEdits: repoRelPaths(["edited.md"]),
          deletedLocally: [],
          unchanged: [],
        });
        mockDetectDiff.mockResolvedValueOnce({
          files: [{ path: repoRelPath("edited.md"), type: "added", localContent: "local edits" }],
        });
      };

      setupRestore();
      await (pushCommand.run as any)({
        args: { dir: "/test", dryRun: true, yes: false, edit: false },
        rawArgs: [],
        cmd: pushCommand,
      });

      // 候補が空なら "No changes to push" で先に終わる。選択の結果として外れたことを区別する。
      expect(mockLog.info).toHaveBeenCalledWith(
        expect.stringContaining("No files match the current selection"),
      );
      expect(mockLog.info).not.toHaveBeenCalledWith(expect.stringContaining("No changes to push"));

      setupRestore();
      await (pushCommand.run as any)({
        args: { dir: "/test", dryRun: true, yes: false, edit: false, files: "edited.md" },
        rawArgs: [],
        cmd: pushCommand,
      });

      const previewArg = mockLogDiffSummary.mock.calls.at(-1)?.[0] ?? [];
      expect(previewArg.map((f) => f.path)).toEqual(["edited.md"]);
    });

    it("--yes はテンプレートの削除を取り消さない", async () => {
      mockClassifyFiles.mockReturnValueOnce({
        autoUpdate: [],
        localOnly: repoRelPaths(["plain.txt"]),
        conflicts: [],
        newFiles: [],
        deletedFiles: [],
        deletedWithLocalEdits: repoRelPaths(["edited.md"]),
        deletedLocally: [],
        unchanged: [],
      });
      mockDetectDiff.mockResolvedValueOnce({
        files: [
          { path: repoRelPath("edited.md"), type: "added", localContent: "local edits" },
          { path: repoRelPath("plain.txt"), type: "added", localContent: "plain" },
        ],
      });
      mockGetGitHubToken.mockReturnValue("ghp_token");
      mockCreatePullRequest.mockResolvedValueOnce({
        url: "https://github.com/owner/repo/pull/1",
        branch: "update-template-123",
        number: 1,
      });

      await (pushCommand.run as any)({
        args: { dir: "/test", dryRun: false, yes: true, edit: false },
        rawArgs: [],
        cmd: pushCommand,
      });

      // 削除の取り消しはテンプレートを使う全プロジェクトへ配られる。確認画面を見ていない
      // 実行では送らない。
      const prArg = mockCreatePullRequest.mock.calls[0]?.[1];
      expect(prArg?.files.map((f) => f.path)).toEqual(["plain.txt"]);
    });

    it("deletedWithLocalEdits を対話で明示選択すると送られ、削除の取り消しだとサマリで示す", async () => {
      mockClassifyFiles.mockReturnValueOnce({
        autoUpdate: [],
        localOnly: repoRelPaths(["plain.txt"]),
        conflicts: [],
        newFiles: [],
        deletedFiles: [],
        deletedWithLocalEdits: repoRelPaths(["edited.md"]),
        deletedLocally: [],
        unchanged: [],
      });
      const files: FileDiff[] = [
        { path: repoRelPath("edited.md"), type: "added", localContent: "local edits" },
        { path: repoRelPath("plain.txt"), type: "added", localContent: "plain" },
      ];
      mockDetectDiff.mockResolvedValueOnce({ files });
      mockSelectPushFiles.mockResolvedValueOnce(files);
      mockGetGitHubToken.mockReturnValue("ghp_token");
      mockConfirmAction.mockResolvedValueOnce(true);
      mockCreatePullRequest.mockResolvedValueOnce({
        url: "https://github.com/owner/repo/pull/1",
        branch: "update-template-123",
        number: 1,
      });

      await (pushCommand.run as any)({
        args: { dir: "/test", dryRun: false, yes: false, edit: false },
        rawArgs: [],
        cmd: pushCommand,
      });

      const prArg = mockCreatePullRequest.mock.calls[0]?.[1];
      expect(prArg?.files.map((f) => f.path)).toEqual(["edited.md", "plain.txt"]);

      const summary = mockLog.message.mock.calls
        .map((call) => call[0])
        .find((text) => text.includes("edited.md"));
      expect(summary).toContain("restores file deleted in template");
      // 注記は該当ファイルの行だけに付く
      expect(summary?.split("\n").find((line) => line.includes("plain.txt"))).not.toContain(
        "restores file deleted in template",
      );
    });

    it("対話の一覧では、削除の取り消しを既定で選ばずそれと分かる印を付ける", async () => {
      mockClassifyFiles.mockReturnValueOnce({
        autoUpdate: [],
        localOnly: repoRelPaths(["plain.txt"]),
        conflicts: [],
        newFiles: [],
        deletedFiles: [],
        deletedWithLocalEdits: repoRelPaths(["edited.md"]),
        deletedLocally: [],
        unchanged: [],
      });
      mockDetectDiff.mockResolvedValueOnce({
        files: [
          { path: repoRelPath("edited.md"), type: "added", localContent: "local edits" },
          { path: repoRelPath("plain.txt"), type: "added", localContent: "plain" },
        ],
      });
      mockSelectPushFiles.mockResolvedValueOnce([]);

      await (pushCommand.run as any)({
        args: { dir: "/test", dryRun: false, yes: false, edit: false },
        rawArgs: [],
        cmd: pushCommand,
      });

      // 選択画面は「送ると削除が取り消される」ファイルを知らないと、既定チェックのまま
      // 送られる。集合を渡すことで既定から外れ、行にも注記が付く。
      const selectOptions = mockSelectPushFiles.mock.calls[0]?.[1];
      expect([...(selectOptions?.restoresTemplateDeletion ?? [])]).toEqual(["edited.md"]);
    });

    it("既定ブランチが master のテンプレートには master 宛の PR を出す", async () => {
      setupPushableFiles([
        { path: repoRelPath("file.txt"), type: "added", localContent: "content" },
      ]);
      mockGetGitHubToken.mockReturnValue("ghp_token");
      mockFetchDefaultBranch.mockResolvedValueOnce({ _tag: "Resolved", name: "master" });
      mockCreatePullRequest.mockResolvedValueOnce({
        url: "https://github.com/owner/repo/pull/1",
        branch: "update-template-123",
        number: 1,
      });

      await (pushCommand.run as any)({
        args: { dir: "/test", dryRun: false, yes: true, edit: false },
        rawArgs: [],
        cmd: pushCommand,
      });

      expect(mockCreatePullRequest.mock.calls[0]?.[1]).toMatchObject({ baseBranch: "master" });
    });

    it("レート制限では、控えた既定ブランチ宛の PR を出して実行を続ける", async () => {
      const recordedSource: TemplateSource = { ...githubSource, defaultBranch: "master" };
      const { effect } = mockContext({
        source: recordedSource,
        lock: lockWith({ source: recordedSource }),
      });
      mockLoadCommandContext.mockReturnValue(effect);

      setupPushableFiles([
        { path: repoRelPath("file.txt"), type: "added", localContent: "content" },
      ]);
      mockGetGitHubToken.mockReturnValue("ghp_token");
      mockFetchDefaultBranch.mockResolvedValueOnce({
        _tag: "Unresolved",
        reason: "API rate limit exceeded",
      });
      mockCreatePullRequest.mockResolvedValueOnce({
        url: "https://github.com/owner/repo/pull/1",
        branch: "update-template-123",
        number: 1,
      });

      await (pushCommand.run as any)({
        args: { dir: "/test", dryRun: false, yes: true, edit: false },
        rawArgs: [],
        cmd: pushCommand,
      });

      expect(mockCreatePullRequest.mock.calls[0]?.[1]).toMatchObject({ baseBranch: "master" });
    });

    it("トークンを拒否されたら、控えがあっても PR を作らずトークンの直し方を案内する", async () => {
      const recordedSource: TemplateSource = { ...githubSource, defaultBranch: "master" };
      const { effect } = mockContext({
        source: recordedSource,
        lock: lockWith({ source: recordedSource }),
      });
      mockLoadCommandContext.mockReturnValue(effect);

      setupPushableFiles([
        { path: repoRelPath("file.txt"), type: "added", localContent: "content" },
      ]);
      mockGetGitHubToken.mockReturnValue("ghp_token");
      mockFetchDefaultBranch.mockResolvedValueOnce({
        _tag: "AuthRejected",
        detail: "Bad credentials",
      });

      await expect(
        (pushCommand.run as any)({
          args: { dir: "/test", dryRun: false, yes: true, edit: false },
          rawArgs: [],
          cmd: pushCommand,
        }),
      ).rejects.toMatchObject({
        reason: { kind: "GitHubAuthRejected", detail: "Bad credentials" },
      });

      expect(mockCreatePullRequest).not.toHaveBeenCalled();
    });

    it("既定ブランチを引けず控えも無ければ PR を作らず、宛先の決め方を案内する", async () => {
      setupPushableFiles([
        { path: repoRelPath("file.txt"), type: "added", localContent: "content" },
      ]);
      mockGetGitHubToken.mockReturnValue("ghp_token");
      mockFetchDefaultBranch.mockResolvedValueOnce({
        _tag: "Unresolved",
        reason: "API rate limit exceeded",
      });

      await expect(
        (pushCommand.run as any)({
          args: { dir: "/test", dryRun: false, yes: true, edit: false },
          rawArgs: [],
          cmd: pushCommand,
        }),
      ).rejects.toMatchObject({
        reason: { kind: "DefaultBranchUnresolved", repo: "tktcorporation/.github" },
      });

      // main を仮定して 404 を踏ませない
      expect(mockCreatePullRequest).not.toHaveBeenCalled();
    });

    it("ブランチ指定済みのソースでは既定ブランチを問い合わせない", async () => {
      const branchSource: TemplateSource = {
        kind: "github",
        owner: "tktcorporation",
        repo: ".github",
        ref: { kind: "branch", name: "develop" },
      };
      const { effect } = mockContext({
        source: branchSource,
        lock: lockWith({ source: branchSource }),
      });
      mockLoadCommandContext.mockReturnValue(effect);

      setupPushableFiles([
        { path: repoRelPath("file.txt"), type: "added", localContent: "content" },
      ]);
      mockGetGitHubToken.mockReturnValue("ghp_token");
      mockCreatePullRequest.mockResolvedValueOnce({
        url: "https://github.com/owner/repo/pull/1",
        branch: "update-template-123",
        number: 1,
      });

      await (pushCommand.run as any)({
        args: { dir: "/test", dryRun: false, yes: true, edit: false },
        rawArgs: [],
        cmd: pushCommand,
      });

      expect(mockFetchDefaultBranch).not.toHaveBeenCalled();
      expect(mockCreatePullRequest.mock.calls[0]?.[1]).toMatchObject({ baseBranch: "develop" });
    });

    it("タグに固定されたテンプレートへは PR を出さず、lock の直し方を案内する", async () => {
      const taggedSource: TemplateSource = {
        kind: "github",
        owner: "tktcorporation",
        repo: ".github",
        ref: { kind: "tag", name: "v1.0.0" },
      };
      const { effect, cleanup } = mockContext({
        source: taggedSource,
        lock: lockWith({ source: taggedSource }),
      });
      mockLoadCommandContext.mockReturnValue(effect);

      setupPushableFiles([
        { path: repoRelPath("file.txt"), type: "added", localContent: "content" },
      ]);
      mockGetGitHubToken.mockReturnValue("ghp_token");

      await expect(
        (pushCommand.run as any)({
          args: { dir: "/test", dryRun: false, yes: true, edit: false },
          rawArgs: [],
          cmd: pushCommand,
        }),
      ).rejects.toMatchObject({
        reason: { kind: "TemplateRefNotBranch", refKind: "tag" },
        hint: expect.stringContaining("source.ref"),
      });

      expect(mockCreatePullRequest).not.toHaveBeenCalled();
      expect(cleanup).toHaveBeenCalled();
    });

    it("ファイル選択をキャンセルすると PR を作成しない", async () => {
      setupPushableFiles([
        { path: repoRelPath("file.txt"), type: "added", localContent: "content" },
      ]);

      mockSelectPushFiles.mockResolvedValueOnce([]);

      await (pushCommand.run as any)({
        args: { dir: "/test", dryRun: false, yes: false, edit: false },
        rawArgs: [],
        cmd: pushCommand,
      });

      expect(mockLog.info).toHaveBeenCalledWith("No files selected. Cancelled.");
      expect(mockCreatePullRequest).not.toHaveBeenCalled();
    });

    it("--yes は選択プロンプトを出さず既定集合を push する", async () => {
      setupPushableFiles([
        { path: repoRelPath("file.txt"), type: "added", localContent: "content" },
        {
          path: repoRelPath("other.txt"),
          type: "modified",
          localContent: "new",
          templateContent: "old",
        },
      ]);
      mockGetGitHubToken.mockReturnValue("ghp_token");
      mockCreatePullRequest.mockResolvedValueOnce({
        url: "https://github.com/owner/repo/pull/1",
        branch: "update-template-123",
        number: 1,
      });

      await (pushCommand.run as any)({
        args: { dir: "/test", dryRun: false, yes: true, edit: false },
        rawArgs: [],
        cmd: pushCommand,
      });

      // 対話端末を持たない実行で選択を待つと、何も送らないまま成功に見える
      expect(mockSelectPushFiles).not.toHaveBeenCalled();
      expect(mockCreatePullRequest).toHaveBeenCalled();
      const pushedPaths = mockCreatePullRequest.mock.calls[0]?.[1].files.map((f) => f.path);
      expect(pushedPaths).toEqual(expect.arrayContaining(["file.txt", "other.txt"]));
    });

    it("--yes でトークンが無ければ入力を促さず、渡し方を案内して中断する", async () => {
      setupPushableFiles([
        { path: repoRelPath("file.txt"), type: "added", localContent: "content" },
      ]);
      mockGetGitHubToken.mockReturnValue(undefined);

      const failure = await (pushCommand.run as any)({
        args: { dir: "/test", dryRun: false, yes: true, edit: false },
        rawArgs: [],
        cmd: pushCommand,
      }).catch((e: unknown) => e);

      // プロンプトを省くフラグの下で入力を待つと、対話端末を持たない実行が止まる
      expect(mockInputGitHubToken).not.toHaveBeenCalled();
      expect(mockCreatePullRequest).not.toHaveBeenCalled();
      expect(failure).toMatchObject({ reason: { kind: "GitHubTokenMissing" } });
    });

    it("--yes --include-deletions の既定集合は削除ファイルも含む", async () => {
      mockClassifyFiles.mockReturnValueOnce({
        autoUpdate: [],
        localOnly: repoRelPaths(["keep.txt"]),
        conflicts: [],
        newFiles: [],
        deletedFiles: [],
        deletedWithLocalEdits: [],
        deletedLocally: repoRelPaths(["gone.txt"]),
        unchanged: [],
      });
      mockDetectDiff.mockResolvedValueOnce({
        files: [
          { path: repoRelPath("keep.txt"), type: "added", localContent: "k" },
          { path: repoRelPath("gone.txt"), type: "deleted", templateContent: "g" },
        ],
      });
      mockGetGitHubToken.mockReturnValue("ghp_token");
      mockCreatePullRequest.mockResolvedValueOnce({
        url: "https://github.com/owner/repo/pull/1",
        branch: "update-template-123",
        number: 1,
      });

      await (pushCommand.run as any)({
        args: { dir: "/test", dryRun: false, yes: true, edit: false, includeDeletions: true },
        rawArgs: [],
        cmd: pushCommand,
      });

      const prArg = mockCreatePullRequest.mock.calls[0]?.[1];
      expect(prArg?.files.map((f) => f.path)).toEqual(["keep.txt"]);
      expect(prArg?.deletions?.map((d) => d.path)).toEqual(["gone.txt"]);
    });

    it("--yes の既定集合が空なら push せずに終わる", async () => {
      // 削除だけの変更を --include-deletions なしで push すると、既定集合は空になる
      mockClassifyFiles.mockReturnValueOnce({
        autoUpdate: [],
        localOnly: [],
        conflicts: [],
        newFiles: [],
        deletedFiles: [],
        deletedWithLocalEdits: [],
        deletedLocally: repoRelPaths(["gone.txt"]),
        unchanged: [],
      });
      mockDetectDiff.mockResolvedValueOnce({
        files: [{ path: repoRelPath("gone.txt"), type: "deleted", templateContent: "g" }],
      });

      await (pushCommand.run as any)({
        args: { dir: "/test", dryRun: false, yes: true, edit: false },
        rawArgs: [],
        cmd: pushCommand,
      });

      expect(mockLog.info).toHaveBeenCalledWith("No files to push.");
      expect(mockCreatePullRequest).not.toHaveBeenCalled();
    });

    it("PR 作成前の確認でキャンセル", async () => {
      const pushableFile = {
        path: repoRelPath("file.txt"),
        type: "added" as const,
        localContent: "content",
      };

      setupPushableFiles([pushableFile]);
      mockSelectPushFiles.mockResolvedValueOnce([pushableFile]);
      mockGetGitHubToken.mockReturnValue("ghp_token");
      mockConfirmAction.mockResolvedValueOnce(false);

      await (pushCommand.run as any)({
        args: { dir: "/test", dryRun: false, yes: false, edit: false },
        rawArgs: [],
        cmd: pushCommand,
      });

      expect(mockLog.info).toHaveBeenCalledWith("Cancelled.");
      expect(mockCreatePullRequest).not.toHaveBeenCalled();
    });

    it("PR 作成成功（タイトル・本文は自動生成）", async () => {
      const pushableFile = {
        path: repoRelPath("file.txt"),
        type: "added" as const,
        localContent: "content",
      };

      setupPushableFiles([pushableFile]);
      mockSelectPushFiles.mockResolvedValueOnce([pushableFile]);
      mockGetGitHubToken.mockReturnValue("ghp_token");
      mockConfirmAction.mockResolvedValueOnce(true);
      mockCreatePullRequest.mockResolvedValueOnce({
        url: "https://github.com/owner/repo/pull/1",
        branch: "update-template-123",
        number: 1,
      });

      await (pushCommand.run as any)({
        args: { dir: "/test", dryRun: false, yes: false, edit: false },
        rawArgs: [],
        cmd: pushCommand,
      });

      expect(mockLog.success).toHaveBeenCalledWith("Pull request created!");
      // ファイル選択は常に呼ばれる（--files 未指定時）
      expect(mockSelectPushFiles).toHaveBeenCalled();
      // タイトル入力・本文入力のプロンプトは呼ばれない
      expect(mockInputPrTitle).not.toHaveBeenCalled();
      expect(mockInputPrBody).not.toHaveBeenCalled();
      expect(mockCreatePullRequest).toHaveBeenCalledWith(
        "ghp_token",
        expect.objectContaining({
          owner: "tktcorporation",
          repo: ".github",
          title: "feat: add file.txt config",
          body: "## Changes\n\n**Added:**\n- `file.txt`",
        }),
      );
    });

    it("GitHub トークンがない場合はプロンプト", async () => {
      const pushableFile = {
        path: repoRelPath("file.txt"),
        type: "added" as const,
        localContent: "content",
      };

      setupPushableFiles([pushableFile]);
      mockSelectPushFiles.mockResolvedValueOnce([pushableFile]);
      mockGetGitHubToken.mockReturnValue(undefined);
      mockInputGitHubToken.mockResolvedValueOnce("ghp_prompted_token");
      mockConfirmAction.mockResolvedValueOnce(true);
      mockCreatePullRequest.mockResolvedValueOnce({
        url: "https://github.com/owner/repo/pull/1",
        branch: "update-template-123",
        number: 1,
      });

      await (pushCommand.run as any)({
        args: { dir: "/test", dryRun: false, yes: false, edit: false },
        rawArgs: [],
        cmd: pushCommand,
      });

      expect(mockInputGitHubToken).toHaveBeenCalled();
      expect(mockCreatePullRequest).toHaveBeenCalledWith("ghp_prompted_token", expect.anything());
    });

    it("--message オプションで PR タイトルを指定", async () => {
      const pushableFile = {
        path: repoRelPath("file.txt"),
        type: "added" as const,
        localContent: "content",
      };

      setupPushableFiles([pushableFile]);
      mockSelectPushFiles.mockResolvedValueOnce([pushableFile]);
      mockGetGitHubToken.mockReturnValue("ghp_token");
      mockConfirmAction.mockResolvedValueOnce(true);
      mockCreatePullRequest.mockResolvedValueOnce({
        url: "https://github.com/owner/repo/pull/1",
        branch: "update-template-123",
        number: 1,
      });

      await (pushCommand.run as any)({
        args: {
          dir: "/test",
          dryRun: false,
          yes: false,
          edit: false,
          message: "Custom PR title",
        },
        rawArgs: [],
        cmd: pushCommand,
      });

      // inputPrTitle は呼ばれない
      expect(mockInputPrTitle).not.toHaveBeenCalled();
      expect(mockCreatePullRequest).toHaveBeenCalledWith(
        "ghp_token",
        expect.objectContaining({
          title: "Custom PR title",
        }),
      );
    });

    it("--files オプションで指定ファイルのみ PR に含める", async () => {
      const file1 = {
        path: repoRelPath(".claude/statusline.sh"),
        type: "added" as const,
        localContent: "#!/bin/bash\necho hello",
      };
      const file2 = {
        path: repoRelPath(".claude/settings.json"),
        type: "modified" as const,
        localContent: '{"statusLine": "script"}',
        templateContent: '{"statusLine": "default"}',
      };
      const file3 = {
        path: repoRelPath(".devcontainer/devcontainer.json"),
        type: "modified" as const,
        localContent: '{"name": "new"}',
        templateContent: '{"name": "old"}',
      };

      setupPushableFiles([file1, file2, file3]);
      mockGetGitHubToken.mockReturnValue("ghp_token");
      mockConfirmAction.mockResolvedValueOnce(true);
      mockCreatePullRequest.mockResolvedValueOnce({
        url: "https://github.com/owner/repo/pull/1",
        branch: "update-template-123",
        number: 1,
      });

      await (pushCommand.run as any)({
        args: {
          dir: "/test",
          dryRun: false,
          yes: false,
          edit: false,
          files: ".claude/statusline.sh,.claude/settings.json",
        },
        rawArgs: [],
        cmd: pushCommand,
      });

      // --files が指定された場合はインタラクティブ選択をスキップ
      expect(mockSelectPushFiles).not.toHaveBeenCalled();
      expect(mockCreatePullRequest).toHaveBeenCalledWith(
        "ghp_token",
        expect.objectContaining({
          files: expect.arrayContaining([
            expect.objectContaining({ path: ".claude/statusline.sh" }),
            expect.objectContaining({ path: ".claude/settings.json" }),
          ]),
        }),
      );
      // file3 は含まれない
      const callArgs = mockCreatePullRequest.mock.calls[0][1];
      expect(callArgs.files.some((f: any) => f.path === ".devcontainer/devcontainer.json")).toBe(
        false,
      );
    });

    it("--files に存在しないファイルを指定すると警告", async () => {
      const file1 = {
        path: repoRelPath("file.txt"),
        type: "added" as const,
        localContent: "content",
      };

      setupPushableFiles([file1]);
      mockGetGitHubToken.mockReturnValue("ghp_token");
      mockConfirmAction.mockResolvedValueOnce(true);
      mockCreatePullRequest.mockResolvedValueOnce({
        url: "https://github.com/owner/repo/pull/1",
        branch: "update-template-123",
        number: 1,
      });

      await (pushCommand.run as any)({
        args: {
          dir: "/test",
          dryRun: false,
          yes: false,
          edit: false,
          files: "file.txt,nonexistent.txt",
        },
        rawArgs: [],
        cmd: pushCommand,
      });

      expect(mockLog.warn).toHaveBeenCalledWith("Files not found: nonexistent.txt");
      expect(mockCreatePullRequest).toHaveBeenCalled();
    });

    it("--files に一致するファイルがない場合はキャンセル", async () => {
      setupPushableFiles([
        { path: repoRelPath("file.txt"), type: "added", localContent: "content" },
      ]);

      await (pushCommand.run as any)({
        args: {
          dir: "/test",
          dryRun: false,
          yes: false,
          edit: false,
          files: "nonexistent.txt",
        },
        rawArgs: [],
        cmd: pushCommand,
      });

      expect(mockLog.info).toHaveBeenCalledWith("No matching files. Cancelled.");
      expect(mockCreatePullRequest).not.toHaveBeenCalled();
    });

    it("--yes オプションで確認をスキップ", async () => {
      const pushableFile = {
        path: repoRelPath("file.txt"),
        type: "added" as const,
        localContent: "content",
      };

      setupPushableFiles([pushableFile]);
      mockGetGitHubToken.mockReturnValue("ghp_token");
      mockCreatePullRequest.mockResolvedValueOnce({
        url: "https://github.com/owner/repo/pull/1",
        branch: "update-template-123",
        number: 1,
      });

      await (pushCommand.run as any)({
        args: { dir: "/test", dryRun: false, yes: true, edit: false },
        rawArgs: [],
        cmd: pushCommand,
      });

      // --yes: ファイル選択・タイトル入力・確認プロンプトをすべてスキップする
      expect(mockSelectPushFiles).not.toHaveBeenCalled();
      expect(mockInputPrTitle).not.toHaveBeenCalled();
      expect(mockInputPrBody).not.toHaveBeenCalled();
      expect(mockConfirmAction).not.toHaveBeenCalled();
      expect(mockCreatePullRequest).toHaveBeenCalled();
    });

    it("コンフリクト解決待ちの場合は、解決待ちのファイルを挙げて pull の再開へ誘導する", async () => {
      const { effect } = mockContext({
        lock: markMerging(validLock, { hashes: {} }, [pendingConflict(".mcp.json")]),
      });
      mockLoadCommandContext.mockReturnValue(effect);

      await expect(
        (pushCommand.run as any)({
          args: { dir: "/test", dryRun: false, yes: false, edit: false },
          rawArgs: [],
          cmd: pushCommand,
        }),
      ).rejects.toMatchObject({
        reason: { kind: "MergePaused", conflicts: [".mcp.json"] },
        hint: expect.stringMatching(/ziku pull --continue[\s\S]*\.mcp\.json/),
      });
    });

    it("ローカルソースの場合はファイルを直接テンプレートにコピー", async () => {
      const { effect } = mockContext({
        source: localTemplateSource,
        lock: lockWith({ source: localTemplateSource }),
      });
      mockLoadCommandContext.mockReturnValue(effect);

      // ローカル push はエラーにならず正常終了する
      await (pushCommand.run as any)({
        args: { dir: "/test", dryRun: false, yes: true, edit: false },
        rawArgs: [],
        cmd: pushCommand,
      });

      // PR は作成されない
      expect(mockCreatePullRequest).not.toHaveBeenCalled();
    });

    /**
     * `ziku.jsonc` が localOnly に分類された状態を作る。
     *
     * ローカル・テンプレートそれぞれの内容だけを変えて、パターン集合の実差分（drift）が
     * push の結論をどう変えるかを見る。
     */
    function setupLocalOnlyConfig(opts: { localInclude: string[]; templateInclude: string[] }): {
      localConfig: string;
    } {
      const { effect } = mockContext({
        lock: lockWith({ hashes: { ".ziku/ziku.jsonc": "oldhash" } }),
      });
      mockLoadCommandContext.mockReturnValue(effect);

      const localConfig = JSON.stringify({ include: opts.localInclude }, null, 2);
      const templateConfig = JSON.stringify({ include: opts.templateInclude }, null, 2);
      vol.fromJSON({
        "/test/.ziku/ziku.jsonc": localConfig,
        "/tmp/template/.ziku/ziku.jsonc": templateConfig,
      });

      mockClassifyFiles.mockReturnValueOnce({
        ...emptyClassification,
        localOnly: repoRelPaths([".ziku/ziku.jsonc"]),
      });

      const pushableFile = {
        path: repoRelPath(".ziku/ziku.jsonc"),
        type: "modified" as const,
        localContent: localConfig,
        templateContent: templateConfig,
      };
      mockDetectDiff.mockResolvedValueOnce({ files: [pushableFile] });
      mockSelectPushFiles.mockResolvedValueOnce([pushableFile]);
      mockConfirmAction.mockResolvedValueOnce(true);
      mockGetGitHubToken.mockReturnValue("ghp_token");
      mockCreatePullRequest.mockResolvedValueOnce({
        url: "https://github.com/owner/repo/pull/1",
        branch: "b",
        number: 1,
      });

      return { localConfig };
    }

    it("localOnly で ziku.jsonc がローカル削除されていてもテンプレのパターンは消さない", async () => {
      // ローカルが .github/** を削除しただけ。union はテンプレの内容と一致するので、送っても
      // パターンが 1 つも増えない PR になる。status もこの状態を同期済みとして見せるため、
      // push は何も送らない（削除は自動伝播しない）。
      setupLocalOnlyConfig({
        localInclude: [".claude/**"],
        templateInclude: [".claude/**", ".github/**"],
      });

      await (pushCommand.run as any)({
        args: { dir: "/test", dryRun: false, yes: false, edit: false },
        rawArgs: [],
        cmd: pushCommand,
      });

      expect(mockCreatePullRequest).not.toHaveBeenCalled();
      expect(mockLog.info).toHaveBeenCalledWith("No changes to push");
    });

    it("localOnly でテンプレに無いパターンがあれば union を送り、テンプレ側の削除も起きない", async () => {
      setupLocalOnlyConfig({
        localInclude: [".claude/**", "extra/**"],
        templateInclude: [".claude/**", ".github/**"],
      });

      await (pushCommand.run as any)({
        args: { dir: "/test", dryRun: false, yes: false, edit: false },
        rawArgs: [],
        cmd: pushCommand,
      });

      const prArg = mockCreatePullRequest.mock.calls[0]?.[1] as {
        files: readonly { path: string; content: string }[];
      };
      const configFile = prArg.files.find((f) => f.path === ".ziku/ziku.jsonc");
      expect(configFile).toBeDefined();
      const pushed = JSON.parse(configFile?.content as string);
      // 生のローカルではなく union が送られる。ローカルが持たない .github/** も残る。
      expect(pushed.include).toContain("extra/**");
      expect(pushed.include).toContain(".github/**");
      expect(pushed.include).toContain(".claude/**");
    });

    it("ローカルテンプレへの push: ziku.jsonc の union 結果をローカルにも書き戻す", async () => {
      const { effect } = mockContext({
        source: localTemplateSource,
        // ローカルソースでは templateDir は localSource.path に解決される
        templateDir: absPath("/local/template"),
        lock: lockWith({
          source: localTemplateSource,
          hashes: { ".ziku/ziku.jsonc": "oldhash" },
        }),
      });
      mockLoadCommandContext.mockReturnValue(effect);

      const localConfig = JSON.stringify({ include: [".claude/**", ".foo"] }, null, 2);
      const templateConfig = JSON.stringify({ include: [".claude/**", ".bar"] }, null, 2);
      vol.fromJSON({
        "/test/.ziku/ziku.jsonc": localConfig,
        "/local/template/.ziku/ziku.jsonc": templateConfig,
      });

      mockClassifyFiles.mockReturnValueOnce({
        autoUpdate: [],
        localOnly: [],
        conflicts: repoRelPaths([".ziku/ziku.jsonc"]),
        newFiles: [],
        deletedFiles: [],
        deletedWithLocalEdits: [],
        deletedLocally: [],
        unchanged: [],
      });

      const pushableFile = {
        path: repoRelPath(".ziku/ziku.jsonc"),
        type: "modified" as const,
        localContent: localConfig,
        templateContent: templateConfig,
      };
      mockDetectDiff.mockResolvedValueOnce({
        files: [pushableFile],
      });

      await (pushCommand.run as any)({
        args: { dir: "/test", dryRun: false, yes: true, edit: false },
        rawArgs: [],
        cmd: pushCommand,
      });

      const expectedUnion = [".claude/**", ".foo", ".bar"];
      // テンプレートに union が書かれる
      const templateWritten = JSON.parse(
        vol.readFileSync("/local/template/.ziku/ziku.jsonc", "utf8") as string,
      );
      expect(templateWritten.include).toEqual(expectedUnion);
      // ローカルにも同じ union が書き戻される（local==template で次回 push の取りこぼしを防ぐ）
      const localWritten = JSON.parse(vol.readFileSync("/test/.ziku/ziku.jsonc", "utf8") as string);
      expect(localWritten.include).toEqual(expectedUnion);
    });

    it("テンプレートが ziku.jsonc のパターンを削除しただけなら pull を案内しない", async () => {
      // pull は削除を伝播しないので、この状態で pull を勧めても何も起きない。
      const { effect } = mockContext({
        lock: lockWith({
          hashes: { ".ziku/ziku.jsonc": "oldhash" },
        }),
      });
      mockLoadCommandContext.mockReturnValue(effect);

      const localConfig = JSON.stringify({ include: [".claude/**", ".github/**"] }, null, 2);
      const templateConfig = JSON.stringify({ include: [".claude/**"] }, null, 2);
      vol.fromJSON({
        "/test/.ziku/ziku.jsonc": localConfig,
        "/tmp/template/.ziku/ziku.jsonc": templateConfig,
      });

      mockClassifyFiles.mockReturnValueOnce({
        autoUpdate: repoRelPaths([".ziku/ziku.jsonc"]),
        localOnly: [],
        conflicts: [],
        newFiles: [],
        deletedFiles: [],
        deletedWithLocalEdits: [],
        deletedLocally: [],
        unchanged: [],
      });
      mockDetectDiff.mockResolvedValueOnce({
        files: [
          {
            path: repoRelPath(".ziku/ziku.jsonc"),
            type: "modified" as const,
            localContent: localConfig,
            templateContent: templateConfig,
          },
        ],
      });

      await (pushCommand.run as any)({
        args: { dir: "/test", dryRun: false, yes: true, edit: false },
        rawArgs: [],
        cmd: pushCommand,
      });

      expect(mockLog.info).not.toHaveBeenCalledWith(
        expect.stringContaining("only changed in template"),
      );
      expect(mockLog.info).toHaveBeenCalledWith("No changes to push");
      expect(mockCreatePullRequest).not.toHaveBeenCalled();
    });

    it("ローカルの ziku.jsonc が消えていても --include-deletions でテンプレートの ziku.jsonc を消さない", async () => {
      // テンプレートの設定ファイルが消えると、そのテンプレートを使う全プロジェクトの
      // init / pull が同期対象パターンを引けなくなる。
      const { effect } = mockContext({
        lock: lockWith({
          hashes: { ".ziku/ziku.jsonc": "oldhash", "gone.txt": "g" },
        }),
      });
      mockLoadCommandContext.mockReturnValue(effect);

      const templateConfig = JSON.stringify({ include: [".claude/**"] }, null, 2);
      vol.fromJSON({ "/tmp/template/.ziku/ziku.jsonc": templateConfig });

      mockClassifyFiles.mockReturnValueOnce({
        autoUpdate: [],
        localOnly: [],
        conflicts: [],
        newFiles: [],
        deletedFiles: [],
        deletedWithLocalEdits: [],
        deletedLocally: repoRelPaths([".ziku/ziku.jsonc", "gone.txt"]),
        unchanged: [],
      });
      mockDetectDiff.mockResolvedValueOnce({
        files: [
          {
            path: repoRelPath(".ziku/ziku.jsonc"),
            type: "deleted" as const,
            templateContent: templateConfig,
          },
          { path: repoRelPath("gone.txt"), type: "deleted" as const, templateContent: "g" },
        ],
      });
      mockGetGitHubToken.mockReturnValue("ghp_token");
      mockCreatePullRequest.mockResolvedValueOnce({
        url: "https://github.com/owner/repo/pull/1",
        branch: "b",
        number: 1,
      });

      await (pushCommand.run as any)({
        args: { dir: "/test", dryRun: false, yes: true, edit: false, includeDeletions: true },
        rawArgs: [],
        cmd: pushCommand,
      });

      const prArg = mockCreatePullRequest.mock.calls[0]?.[1];
      // 通常ファイルの削除は従来どおり送られる
      expect(prArg?.deletions?.map((d) => d.path)).toEqual(["gone.txt"]);
      expect(prArg?.files.map((f) => f.path)).not.toContain(".ziku/ziku.jsonc");
    });

    it("未解決の衝突は既定では push されず警告のみ（巻き添えで中断しない）", async () => {
      const { effect } = mockContext({
        lock: lockWith({
          hashes: {
            "file.txt": "abc123",
          },
        }),
      });
      mockLoadCommandContext.mockReturnValue(effect);

      vol.fromJSON({
        "/test/file.txt": "local content",
        "/tmp/template/file.txt": "template content",
      });

      // classifyFiles がコンフリクトを返す（ベースの SHA なし → 3-way マージ不可 → unresolved）
      mockClassifyFiles.mockReturnValueOnce({
        autoUpdate: [],
        localOnly: [],
        conflicts: repoRelPaths(["file.txt"]),
        newFiles: [],
        deletedFiles: [],
        deletedWithLocalEdits: [],
        deletedLocally: [],
        unchanged: [],
      });
      // 衝突ファイルは候補として現れる
      mockDetectDiff.mockResolvedValueOnce({
        files: [
          {
            path: repoRelPath("file.txt"),
            type: "modified",
            localContent: "local content",
            templateContent: "template content",
          },
        ],
      });
      // 衝突ファイルは既定で未選択 → ユーザーは何も選ばない
      mockSelectPushFiles.mockResolvedValueOnce([]);

      // 中断せず正常終了する（衝突ファイルは除外されるだけ）
      await (pushCommand.run as any)({
        args: { dir: "/test", dryRun: false, yes: false, edit: false },
        rawArgs: [],
        cmd: pushCommand,
      });

      // 未解決の衝突を警告で知らせる
      expect(mockLog.warn).toHaveBeenCalledWith(expect.stringContaining("unresolved conflicts"));
      // 選択しなければ push されない
      expect(mockCreatePullRequest).not.toHaveBeenCalled();
    });

    it("コンフリクトしていないファイルは、未解決の衝突があっても push できる", async () => {
      const { effect } = mockContext({
        lock: lockWith({
          hashes: { "bad.txt": "abc123" },
        }),
      });
      mockLoadCommandContext.mockReturnValue(effect);

      vol.fromJSON({
        "/test/bad.txt": "local",
        "/tmp/template/bad.txt": "template",
      });

      // safe.txt は localOnly（push 可）、bad.txt は conflict（ベースの SHA なし → unresolved）
      mockClassifyFiles.mockReturnValueOnce({
        autoUpdate: [],
        localOnly: repoRelPaths(["safe.txt"]),
        conflicts: repoRelPaths(["bad.txt"]),
        newFiles: [],
        deletedFiles: [],
        deletedWithLocalEdits: [],
        deletedLocally: [],
        unchanged: [],
      });
      mockDetectDiff.mockResolvedValueOnce({
        files: [
          { path: repoRelPath("safe.txt"), type: "added", localContent: "safe" },
          {
            path: repoRelPath("bad.txt"),
            type: "modified",
            localContent: "local",
            templateContent: "template",
          },
        ],
      });
      // ユーザーは衝突しない safe.txt のみ選択（bad.txt は既定で未選択）
      mockSelectPushFiles.mockResolvedValueOnce([
        { path: repoRelPath("safe.txt"), type: "added", localContent: "safe" },
      ]);
      mockGetGitHubToken.mockReturnValue("ghp_token");
      mockConfirmAction.mockResolvedValueOnce(true);
      mockCreatePullRequest.mockResolvedValueOnce({
        url: "https://github.com/owner/repo/pull/1",
        branch: "update-template-123",
        number: 1,
      });

      await (pushCommand.run as any)({
        args: { dir: "/test", dryRun: false, yes: false, edit: false },
        rawArgs: [],
        cmd: pushCommand,
      });

      // safe.txt は push される
      expect(mockCreatePullRequest).toHaveBeenCalledWith(
        "ghp_token",
        expect.objectContaining({
          files: expect.arrayContaining([expect.objectContaining({ path: "safe.txt" })]),
        }),
      );
      // 未解決の bad.txt は push に含まれない
      const callArgs = mockCreatePullRequest.mock.calls[0][1];
      expect(callArgs.files.some((f: any) => f.path === "bad.txt")).toBe(false);
    });

    it("未解決の衝突を --files で明示指定すると中断し、ファイル名と ziku pull を案内する", async () => {
      const { effect, cleanup } = mockContext({
        lock: lockWith({
          hashes: {
            "file.txt": "abc123",
          },
        }),
      });
      mockLoadCommandContext.mockReturnValue(effect);

      vol.fromJSON({
        "/test/file.txt": "local content",
        "/tmp/template/file.txt": "template content",
      });

      mockClassifyFiles.mockReturnValueOnce({
        autoUpdate: [],
        localOnly: [],
        conflicts: repoRelPaths(["file.txt"]),
        newFiles: [],
        deletedFiles: [],
        deletedWithLocalEdits: [],
        deletedLocally: [],
        unchanged: [],
      });
      mockDetectDiff.mockResolvedValueOnce({
        files: [
          {
            path: repoRelPath("file.txt"),
            type: "modified",
            localContent: "local content",
            templateContent: "template content",
          },
        ],
      });

      // --files で衝突ファイルを明示指定 → 解決を促して確定的に中断する。
      // hint には対象ファイル名と解決手順（ziku pull）が両方含まれること。
      await expect(
        (pushCommand.run as any)({
          args: { dir: "/test", dryRun: false, yes: false, edit: false, files: "file.txt" },
          rawArgs: [],
          cmd: pushCommand,
        }),
      ).rejects.toMatchObject({
        reason: { kind: "PushBlockedByConflicts", files: ["file.txt"] },
        message: expect.stringContaining("couldn't be auto-merged"),
        hint: expect.stringMatching(/file\.txt[\s\S]*ziku pull/),
      });

      expect(mockCreatePullRequest).not.toHaveBeenCalled();
      // 中断してもテンプレートの一時ディレクトリは解放される
      expect(cleanup).toHaveBeenCalled();
    });

    it("対話で未解決の衝突を選択すると中断する（--files 以外の経路）", async () => {
      const { effect } = mockContext({
        lock: lockWith({
          hashes: { "file.txt": "abc123" },
        }),
      });
      mockLoadCommandContext.mockReturnValue(effect);

      vol.fromJSON({
        "/test/file.txt": "local content",
        "/tmp/template/file.txt": "template content",
      });

      mockClassifyFiles.mockReturnValueOnce({
        autoUpdate: [],
        localOnly: [],
        conflicts: repoRelPaths(["file.txt"]),
        newFiles: [],
        deletedFiles: [],
        deletedWithLocalEdits: [],
        deletedLocally: [],
        unchanged: [],
      });
      const conflictFile = {
        path: repoRelPath("file.txt"),
        type: "modified" as const,
        localContent: "local content",
        templateContent: "template content",
      };
      mockDetectDiff.mockResolvedValueOnce({
        files: [conflictFile],
      });
      // 既定では未選択だが、ユーザーが対話で衝突ファイルを明示選択したケース
      mockSelectPushFiles.mockResolvedValueOnce([conflictFile]);

      await expect(
        (pushCommand.run as any)({
          args: { dir: "/test", dryRun: false, yes: false, edit: false },
          rawArgs: [],
          cmd: pushCommand,
        }),
      ).rejects.toMatchObject({
        reason: { kind: "PushBlockedByConflicts", files: ["file.txt"] },
        message: expect.stringContaining("couldn't be auto-merged"),
        hint: expect.stringMatching(/file\.txt[\s\S]*ziku pull/),
      });

      expect(mockCreatePullRequest).not.toHaveBeenCalled();
    });

    it("ベースの SHA とハッシュがある場合に 3-way マージで自動解決", async () => {
      const { effect } = mockContext({
        lock: lockWith({
          hashes: {
            "file.txt": "abc123",
          },
          commitSha: "abc123def456",
        }),
      });
      mockLoadCommandContext.mockReturnValue(effect);

      vol.fromJSON({
        "/test/file.txt": "local content",
        "/tmp/template/file.txt": "template content",
        // base テンプレートのファイル（downloadTemplateToTemp が /tmp/base-template を返す）
        "/tmp/base-template/file.txt": "base content",
      });

      mockClassifyFiles.mockReturnValueOnce({
        autoUpdate: [],
        localOnly: [],
        conflicts: repoRelPaths(["file.txt"]),
        newFiles: [],
        deletedFiles: [],
        deletedWithLocalEdits: [],
        deletedLocally: [],
        unchanged: [],
      });

      // downloadBaseForMerge がベースを返す
      mockDownloadBaseForMerge.mockReturnValueOnce(
        Effect.succeed({ templateDir: absPath("/tmp/base-template"), cleanup: vi.fn() }),
      );

      // mergeOneFile のモック（自動マージ成功）
      mockMergeOneFile.mockReturnValueOnce(
        Effect.succeed({
          file: repoRelPath("file.txt"),
          outcome: classifyMergeOutcome("merged content"),
        }),
      );

      const pushableFile = {
        path: repoRelPath("file.txt"),
        type: "modified" as const,
        localContent: "local content",
        templateContent: "template content",
      };

      // detectDiff: コンテンツを提供
      mockDetectDiff.mockResolvedValueOnce({
        files: [pushableFile],
      });

      mockSelectPushFiles.mockResolvedValueOnce([pushableFile]);
      // 3-way マージ成功 → unresolved なし → 確認は PR 作成確認のみ
      mockConfirmAction.mockResolvedValueOnce(true);
      mockGetGitHubToken.mockReturnValue("ghp_token");
      mockCreatePullRequest.mockResolvedValueOnce({
        url: "https://github.com/owner/repo/pull/1",
        branch: "update-template-123",
        number: 1,
      });

      await (pushCommand.run as any)({
        args: { dir: "/test", dryRun: false, yes: false, edit: false },
        rawArgs: [],
        cmd: pushCommand,
      });

      expect(mockLog.success).toHaveBeenCalledWith("Auto-merged 1 file(s):");

      // mergeOneFile に正しい引数が渡されること
      expect(mockMergeOneFile).toHaveBeenCalledWith({
        file: repoRelPath("file.txt"),
        targetDir: "/test",
        templateDir: "/tmp/template",
        base: { kind: "with-base", dir: "/tmp/base-template" },
      });

      expect(mockCreatePullRequest).toHaveBeenCalledWith(
        "ghp_token",
        expect.objectContaining({
          files: expect.arrayContaining([
            expect.objectContaining({
              path: repoRelPath("file.txt"),
              content: "merged content",
            }),
          ]),
        }),
      );
    });

    it("自動マージの結果がテンプレートと同一なら PR を作らない", async () => {
      // ベース A / ローカル B / テンプレート B + C。マージはクリーンに B + C へ解決し、
      // それはテンプレートの内容そのもの。送っても差分が無いので PR 作成が拒まれる。
      const { effect } = mockContext({
        lock: lockWith({ hashes: { "file.txt": "abc123" }, commitSha: "abc123def456" }),
      });
      mockLoadCommandContext.mockReturnValue(effect);

      vol.fromJSON({
        "/test/file.txt": "B\n",
        "/tmp/template/file.txt": "B\nC\n",
        "/tmp/base-template/file.txt": "A\n",
      });

      mockClassifyFiles.mockReturnValueOnce({
        autoUpdate: [],
        localOnly: [],
        conflicts: repoRelPaths(["file.txt"]),
        newFiles: [],
        deletedFiles: [],
        deletedWithLocalEdits: [],
        deletedLocally: [],
        unchanged: [],
      });
      mockDownloadBaseForMerge.mockReturnValueOnce(
        Effect.succeed({ templateDir: absPath("/tmp/base-template"), cleanup: vi.fn() }),
      );
      mockMergeOneFile.mockReturnValueOnce(
        Effect.succeed({
          file: repoRelPath("file.txt"),
          outcome: classifyMergeOutcome("B\nC\n"),
        }),
      );

      const pushableFile = {
        path: repoRelPath("file.txt"),
        type: "modified" as const,
        localContent: "B\n",
        templateContent: "B\nC\n",
      };
      mockDetectDiff.mockResolvedValueOnce({ files: [pushableFile] });
      mockSelectPushFiles.mockResolvedValueOnce([pushableFile]);
      mockGetGitHubToken.mockReturnValue("ghp_token");

      await (pushCommand.run as any)({
        args: { dir: "/test", dryRun: false, yes: false, edit: false },
        rawArgs: [],
        cmd: pushCommand,
      });

      expect(mockCreatePullRequest).not.toHaveBeenCalled();
      expect(mockConfirmAction).not.toHaveBeenCalled();
      expect(mockLog.info).toHaveBeenCalledWith(expect.stringContaining("Nothing to push"));
    });

    it("--dry-run のプレビューも、自動マージでテンプレートと同一になったファイルを出さない", async () => {
      // プレビューが候補をそのまま並べると、実行すると何も送られないファイルを
      // 「送られる」と見せることになる。
      const { effect } = mockContext({
        lock: lockWith({ hashes: { "file.txt": "abc123" }, commitSha: "abc123def456" }),
      });
      mockLoadCommandContext.mockReturnValue(effect);

      vol.fromJSON({
        "/test/file.txt": "B\n",
        "/tmp/template/file.txt": "B\nC\n",
        "/tmp/base-template/file.txt": "A\n",
      });

      mockClassifyFiles.mockReturnValueOnce({
        autoUpdate: [],
        localOnly: [],
        conflicts: repoRelPaths(["file.txt"]),
        newFiles: [],
        deletedFiles: [],
        deletedWithLocalEdits: [],
        deletedLocally: [],
        unchanged: [],
      });
      mockDownloadBaseForMerge.mockReturnValueOnce(
        Effect.succeed({ templateDir: absPath("/tmp/base-template"), cleanup: vi.fn() }),
      );
      mockMergeOneFile.mockReturnValueOnce(
        Effect.succeed({
          file: repoRelPath("file.txt"),
          outcome: classifyMergeOutcome("B\nC\n"),
        }),
      );
      mockDetectDiff.mockResolvedValueOnce({
        files: [
          {
            path: repoRelPath("file.txt"),
            type: "modified" as const,
            localContent: "B\n",
            templateContent: "B\nC\n",
          },
        ],
      });

      await (pushCommand.run as any)({
        args: { dir: "/test", dryRun: true, yes: false, edit: false },
        rawArgs: [],
        cmd: pushCommand,
      });

      expect(mockLog.info).toHaveBeenCalledWith(expect.stringContaining("Nothing to push"));
      // 一覧そのものが出ない（送るものが 1 件も無い）
      expect(mockLogDiffSummary).not.toHaveBeenCalled();
      expect(mockCreatePullRequest).not.toHaveBeenCalled();
    });

    it("未解決の衝突があっても PR に載る内容にコンフリクトマーカーが混入しない", async () => {
      // 型では `MergedContent` からしか送信内容を作れないが、送信対象の組み立てには
      // ローカル内容を使う経路もあるため、実際の PR ペイロードでも確認する。
      const { effect } = mockContext({
        lock: lockWith({
          hashes: { "clean.txt": "abc123", "conflicted.txt": "def456" },
          commitSha: "abc123def456",
        }),
      });
      mockLoadCommandContext.mockReturnValue(effect);

      vol.fromJSON({
        "/test/clean.txt": "local clean",
        "/test/conflicted.txt": "local conflicted",
        "/tmp/template/clean.txt": "template clean",
        "/tmp/template/conflicted.txt": "template conflicted",
        "/tmp/base-template/clean.txt": "base clean",
        "/tmp/base-template/conflicted.txt": "base conflicted",
      });

      mockClassifyFiles.mockReturnValueOnce({
        autoUpdate: [],
        localOnly: [],
        conflicts: repoRelPaths(["clean.txt", "conflicted.txt"]),
        newFiles: [],
        deletedFiles: [],
        deletedWithLocalEdits: [],
        deletedLocally: [],
        unchanged: [],
      });

      mockDownloadBaseForMerge.mockReturnValueOnce(
        Effect.succeed({ templateDir: absPath("/tmp/base-template"), cleanup: vi.fn() }),
      );

      mockMergeOneFile.mockReturnValueOnce(
        Effect.succeed({
          file: repoRelPath("clean.txt"),
          outcome: classifyMergeOutcome("merged clean"),
        }),
      );
      mockMergeOneFile.mockReturnValueOnce(
        Effect.succeed({
          file: repoRelPath("conflicted.txt"),
          outcome: classifyMergeOutcome(
            "<<<<<<< LOCAL\nlocal conflicted\n=======\ntemplate conflicted\n>>>>>>> TEMPLATE",
          ),
        }),
      );

      const cleanDiff = {
        path: repoRelPath("clean.txt"),
        type: "modified" as const,
        localContent: "local clean",
        templateContent: "template clean",
      };
      const conflictedDiff = {
        path: repoRelPath("conflicted.txt"),
        type: "modified" as const,
        localContent: "local conflicted",
        templateContent: "template conflicted",
      };
      mockDetectDiff.mockResolvedValueOnce({
        files: [cleanDiff, conflictedDiff],
      });

      // 未解決の衝突は既定で未選択（selectPushFiles の既定集合と同じ）
      mockSelectPushFiles.mockResolvedValueOnce([cleanDiff]);
      mockConfirmAction.mockResolvedValueOnce(true);
      mockGetGitHubToken.mockReturnValue("ghp_token");
      mockCreatePullRequest.mockResolvedValueOnce({
        url: "https://github.com/owner/repo/pull/1",
        branch: "update-template-123",
        number: 1,
      });

      await (pushCommand.run as any)({
        args: { dir: "/test", dryRun: false, yes: false, edit: false },
        rawArgs: [],
        cmd: pushCommand,
      });

      const prArg = mockCreatePullRequest.mock.calls[0]?.[1] as {
        files: readonly { path: string; content: string }[];
      };
      expect(prArg.files.map((f) => f.path)).toEqual(["clean.txt"]);
      for (const file of prArg.files) {
        expect(file.content).not.toMatch(/^[<|=>]{7}/m);
      }
    });

    it("ziku.jsonc の conflict は中断せず要素レベルマージで PR に統合される（base なし → 和集合）", async () => {
      const { effect } = mockContext({
        lock: lockWith({
          hashes: {
            ".ziku/ziku.jsonc": "oldhash",
          },
        }),
      });
      mockLoadCommandContext.mockReturnValue(effect);

      const localConfig = JSON.stringify({ include: [".claude/**", ".eslintrc.json"] }, null, 2);
      const templateConfig = JSON.stringify({ include: [".claude/**", ".github/**"] }, null, 2);
      vol.fromJSON({
        "/test/.ziku/ziku.jsonc": localConfig,
        "/tmp/template/.ziku/ziku.jsonc": templateConfig,
      });

      // ziku.jsonc が conflict に分類される（両側がパターンを編集）
      mockClassifyFiles.mockReturnValueOnce({
        autoUpdate: [],
        localOnly: [],
        conflicts: repoRelPaths([".ziku/ziku.jsonc"]),
        newFiles: [],
        deletedFiles: [],
        deletedWithLocalEdits: [],
        deletedLocally: [],
        unchanged: [],
      });

      // base が取れない（downloadBaseForMerge→null, デフォルト）→ 2-way 和集合

      const pushableFile = {
        path: repoRelPath(".ziku/ziku.jsonc"),
        type: "modified" as const,
        localContent: localConfig,
        templateContent: templateConfig,
      };
      mockDetectDiff.mockResolvedValueOnce({
        files: [pushableFile],
      });
      mockSelectPushFiles.mockResolvedValueOnce([pushableFile]);
      mockConfirmAction.mockResolvedValueOnce(true);
      mockGetGitHubToken.mockReturnValue("ghp_token");
      mockCreatePullRequest.mockResolvedValueOnce({
        url: "https://github.com/owner/repo/pull/1",
        branch: "update-template-123",
        number: 1,
      });

      await (pushCommand.run as any)({
        args: { dir: "/test", dryRun: false, yes: false, edit: false },
        rawArgs: [],
        cmd: pushCommand,
      });

      // ziku.jsonc には diff3 の mergeOneFile を使わない
      expect(mockMergeOneFile).not.toHaveBeenCalled();
      // 中断せず PR が作られ、要素マージ（和集合）結果が含まれる
      const prArg = mockCreatePullRequest.mock.calls[0]?.[1] as {
        files: readonly { path: string; content: string }[];
      };
      const configFile = prArg.files.find((f) => f.path === ".ziku/ziku.jsonc");
      expect(configFile).toBeDefined();
      const merged = JSON.parse(configFile?.content as string);
      expect(merged.include).toEqual([".claude/**", ".eslintrc.json", ".github/**"]);
    });

    it("delete/modify conflict: 未解決でも ENOENT で落ちず、除外して継続する", async () => {
      const { effect } = mockContext({
        lock: lockWith({
          hashes: {
            "deleted-file.txt": "abc123",
          },
          commitSha: "abc123def456",
        }),
      });
      mockLoadCommandContext.mockReturnValue(effect);

      // ローカルにファイルが存在しない（削除済み）
      // テンプレートと base テンプレートにはファイルが存在する
      vol.fromJSON({
        "/tmp/template/deleted-file.txt": "template content updated",
        "/tmp/base-template/deleted-file.txt": "base content",
      });

      mockClassifyFiles.mockReturnValueOnce({
        autoUpdate: [],
        localOnly: [],
        conflicts: repoRelPaths(["deleted-file.txt"]), // delete/modify conflict
        newFiles: [],
        deletedFiles: [],
        deletedWithLocalEdits: [],
        deletedLocally: [],
        unchanged: [],
      });

      // downloadBaseForMerge がベースを返す
      mockDownloadBaseForMerge.mockReturnValueOnce(
        Effect.succeed({ templateDir: absPath("/tmp/base-template"), cleanup: vi.fn() }),
      );

      // mergeOneFile: コンフリクト（delete/modify conflict は mergeOneFile 内で
      // readFileSafe により安全にローカル=空文字列で処理される）
      mockMergeOneFile.mockReturnValueOnce(
        Effect.succeed({
          file: repoRelPath("deleted-file.txt"),
          outcome: classifyMergeOutcome(
            "<<<<<<< LOCAL\n=======\ntemplate content updated\n>>>>>>> TEMPLATE",
          ),
        }),
      );

      // ENOENT で落ちず、未解決の衝突は push 対象から除外して正常終了する。
      await (pushCommand.run as any)({
        args: { dir: "/test", dryRun: false, yes: false, edit: false },
        rawArgs: [],
        cmd: pushCommand,
      });

      // delete/modify conflict も安全に処理（mergeOneFile が呼ばれている）
      expect(mockMergeOneFile).toHaveBeenCalled();
      // 未解決なので push されない
      expect(mockCreatePullRequest).not.toHaveBeenCalled();
    });

    it("--yes でも未解決の衝突は push されない（暗黙の上書きをしない）", async () => {
      const { effect } = mockContext({
        lock: lockWith({
          hashes: {
            "file.txt": "abc123",
          },
        }),
      });
      mockLoadCommandContext.mockReturnValue(effect);

      vol.fromJSON({
        "/test/file.txt": "local content",
        "/tmp/template/file.txt": "template content",
      });

      // ベースの SHA なし → 3-way マージ不可 → unresolved
      mockClassifyFiles.mockReturnValueOnce({
        autoUpdate: [],
        localOnly: repoRelPaths(["safe.txt"]),
        conflicts: repoRelPaths(["file.txt"]),
        newFiles: [],
        deletedFiles: [],
        deletedWithLocalEdits: [],
        deletedLocally: [],
        unchanged: [],
      });
      mockDetectDiff.mockResolvedValueOnce({
        files: [
          { path: repoRelPath("safe.txt"), type: "added", localContent: "safe" },
          {
            path: repoRelPath("file.txt"),
            type: "modified",
            localContent: "local content",
            templateContent: "template content",
          },
        ],
      });
      mockGetGitHubToken.mockReturnValue("ghp_token");
      mockCreatePullRequest.mockResolvedValueOnce({
        url: "https://github.com/owner/repo/pull/1",
        branch: "update-template-123",
        number: 1,
      });

      // --yes は選択プロンプトを省くが、暗黙の上書き push はしない。既定集合が
      // 未解決の衝突を外すので、巻き添えにならない safe.txt だけが送られる。
      await (pushCommand.run as any)({
        args: { dir: "/test", dryRun: false, yes: true, edit: false },
        rawArgs: [],
        cmd: pushCommand,
      });

      expect(mockSelectPushFiles).not.toHaveBeenCalled();
      const prArg = mockCreatePullRequest.mock.calls[0]?.[1];
      expect(prArg?.files.map((f) => f.path)).toEqual(["safe.txt"]);
    });

    it("baseHashes がない場合でもコンフリクト検出を実行（空の baseHashes で分類）", async () => {
      await (pushCommand.run as any)({
        args: { dir: "/test", dryRun: false, yes: false, edit: false },
        rawArgs: [],
        cmd: pushCommand,
      });

      // baseHashes がなくても hashFiles と classifyFiles は実行される
      expect(mockHashFiles).toHaveBeenCalled();
      expect(mockClassifyFiles).toHaveBeenCalledWith(
        expect.objectContaining({
          baseHashes: {},
        }),
      );
    });

    it("autoUpdate ファイル（テンプレートのみ変更）は classification により push 対象外", async () => {
      const { effect } = mockContext({
        lock: lockWith({
          hashes: {
            "file.txt": "abc123",
            "template-only.txt": "def456",
          },
        }),
      });
      mockLoadCommandContext.mockReturnValue(effect);

      vol.fromJSON({
        "/test/file.txt": "local content",
        "/test/template-only.txt": "old template content",
        "/tmp/template/file.txt": "local content",
        "/tmp/template/template-only.txt": "new template content",
      });

      // classification が autoUpdate に分類 → pushableFilePaths に含まれない
      mockClassifyFiles.mockReturnValueOnce({
        autoUpdate: repoRelPaths(["template-only.txt"]),
        localOnly: [],
        conflicts: [],
        newFiles: [],
        deletedFiles: [],
        deletedWithLocalEdits: [],
        deletedLocally: [],
        unchanged: repoRelPaths(["file.txt"]),
      });

      // detectDiff は template-only.txt を "modified" として返すが、
      // classification の pushableFilePaths に含まれないため除外される
      mockDetectDiff.mockResolvedValueOnce({
        files: [
          {
            path: repoRelPath("template-only.txt"),
            type: "modified" as const,
            localContent: "old template content",
            templateContent: "new template content",
          },
        ],
      });

      await (pushCommand.run as any)({
        args: { dir: "/test", dryRun: false, yes: false, edit: false },
        rawArgs: [],
        cmd: pushCommand,
      });

      // autoUpdate ファイルは classification により除外 → "No changes to push"
      expect(mockLog.info).toHaveBeenCalledWith(
        expect.stringContaining("Skipping 1 file(s) only changed in template"),
      );
      expect(mockLog.info).toHaveBeenCalledWith("No changes to push");
      expect(mockCreatePullRequest).not.toHaveBeenCalled();
    });

    it("baseHashes が存在しコンフリクトがない場合は正常に続行", async () => {
      const { effect } = mockContext({
        lock: lockWith({
          hashes: {
            "file.txt": "abc123",
          },
        }),
      });
      mockLoadCommandContext.mockReturnValue(effect);

      // コンフリクトなし
      mockClassifyFiles.mockReturnValueOnce({
        autoUpdate: repoRelPaths(["file.txt"]),
        localOnly: [],
        conflicts: [],
        newFiles: [],
        deletedFiles: [],
        deletedWithLocalEdits: [],
        deletedLocally: [],
        unchanged: [],
      });

      await (pushCommand.run as any)({
        args: { dir: "/test", dryRun: false, yes: false, edit: false },
        rawArgs: [],
        cmd: pushCommand,
      });

      // コンフリクト検出は実行されたが、エラーにはならない
      expect(mockHashFiles).toHaveBeenCalled();
      expect(mockClassifyFiles).toHaveBeenCalled();
      // "No changes to push" に到達
      expect(mockLog.info).toHaveBeenCalledWith("No changes to push");
    });
  });
});

/** Octokit の RequestError を模した例外。ステータスとレスポンスヘッダを載せる。 */
function githubApiError(
  status: number,
  message: string,
  headers: Record<string, string> = {},
): Error {
  return Object.assign(new Error(message), { status, response: { status, headers } });
}

/**
 * push が失敗したとき、ユーザーが取れる行動があるものは文言で案内し、それ以外だけを
 * ziku の不具合として原因ごと見せる — その振り分けを症状の側から確かめる。
 */
describe("push の失敗の報告", () => {
  beforeEach(() => {
    vol.reset();
    resetPushMocks();
    const { effect } = mockContext();
    mockLoadCommandContext.mockReturnValue(effect);
  });

  /** GitHub へ push し、投げられた値をそのまま返す。成功した場合はテストを落とす。 */
  async function failingGitHubPush(): Promise<unknown> {
    setupPushableFiles([{ path: repoRelPath("file.txt"), type: "added", localContent: "content" }]);
    mockGetGitHubToken.mockReturnValue("ghp_token");

    return (pushCommand.run as any)({
      args: { dir: "/test", dryRun: false, yes: true, edit: false },
      rawArgs: [],
      cmd: pushCommand,
    }).then(
      () => expect.unreachable("push が成功してしまった"),
      (thrown: unknown) => thrown,
    );
  }

  it("トークンが失効していたら、バグ報告ではなくトークンの更新を促す", async () => {
    const cause = githubApiError(401, "Bad credentials");
    mockCreatePullRequest.mockRejectedValueOnce(cause);

    const failure = await failingGitHubPush();

    expect(failure).toBeInstanceOf(ZikuFailure);
    expect(failure).toMatchObject({
      reason: { kind: "GitHubAuthRejected", detail: "Bad credentials" },
      // 原因を捨てない
      cause,
    });
    expect((failure as ZikuFailure).hint).toContain("gh auth login");
  });

  it("レート制限は、待つか認証するかを案内する", async () => {
    mockCreatePullRequest.mockRejectedValueOnce(
      githubApiError(403, "API rate limit exceeded", {
        "x-ratelimit-remaining": "0",
        "x-ratelimit-reset": String(Math.floor(Date.now() / 1000) + 300),
      }),
    );

    const failure = await failingGitHubPush();

    expect(failure).toMatchObject({
      reason: { kind: "GitHubRateLimited", authenticated: true },
    });
    expect((failure as ZikuFailure).hint).toMatch(/resets in ~\d+ min/);
  });

  it("連投を弾く secondary rate limit も、待てば解ける失敗として案内する", async () => {
    // 1 時間あたりのクォータとは別の制限で、`retry-after` だけが返る。
    mockCreatePullRequest.mockRejectedValueOnce(
      githubApiError(403, "You have exceeded a secondary rate limit", { "retry-after": "60" }),
    );

    const failure = await failingGitHubPush();

    expect(failure).toMatchObject({ reason: { kind: "GitHubRateLimited" } });
    expect((failure as ZikuFailure).hint).toMatch(/resets in ~\d+ min/);
  });

  it("権限が足りない 403 は、権限と fork の設定を見直すよう案内する", async () => {
    // レート制限のヘッダを持たない 403 は、待っても解けない権限の問題。
    mockCreatePullRequest.mockRejectedValueOnce(
      githubApiError(403, "Resource not accessible by personal access token"),
    );

    const failure = await failingGitHubPush();

    expect(failure).toMatchObject({
      reason: { kind: "GitHubPermissionDenied", operation: "create a pull request" },
    });
    expect((failure as ZikuFailure).hint).toContain("forking");
  });

  it("GitHub へ届かなければ、再実行を案内する", async () => {
    // Octokit は fetch の失敗を status 500 の RequestError に包み直すので、届かなかった
    // 事実は例外チェーンの奥の errno にしか残らない。
    const wrapped = Object.assign(new Error("request to https://api.github.com/user failed"), {
      status: 500,
      cause: Object.assign(new TypeError("fetch failed"), {
        cause: Object.assign(new Error("getaddrinfo ENOTFOUND api.github.com"), {
          code: "ENOTFOUND",
        }),
      }),
    });
    mockCreatePullRequest.mockRejectedValueOnce(wrapped);

    const failure = await failingGitHubPush();

    expect(failure).toMatchObject({
      reason: { kind: "GitHubUnreachable", operation: "create a pull request" },
    });
    expect((failure as ZikuFailure).hint).toContain("network");
  });

  it("ツリーを取り切れなかった失敗は、分類済みの案内のまま届く", async () => {
    // createPullRequest が分類済みの ZikuFailure を投げる。GitHub API の例外として
    // 分類し直すと Unclassified → defect になり、ファイル数を減らす案内が消える。
    const tooLarge = zikuFailure({ kind: "RepoTreeTooLarge", repo: "me/my-template" });
    mockCreatePullRequest.mockRejectedValueOnce(tooLarge);

    const failure = await failingGitHubPush();

    expect(failure).toBe(tooLarge);
    expect(failure).toMatchObject({
      reason: { kind: "RepoTreeTooLarge", repo: "me/my-template" },
    });
    expect((failure as ZikuFailure).hint).toContain("Reduce the number of files");
  });

  it("控えたブランチが上流に無ければ、バグ報告ではなく宛先の直し方を案内する", async () => {
    // ref を明示していないテンプレートでは lock の source.defaultBranch が宛先になるので、
    // 上流で改名されると repos.getBranch が 404 を返す。分類しないと defect として
    // 「ziku のバグを報告してください」と出る。
    const cause = githubApiError(404, "Branch not found");
    mockCreatePullRequest.mockRejectedValueOnce(cause);

    const failure = await failingGitHubPush();

    expect(failure).toBeInstanceOf(ZikuFailure);
    expect(failure).toMatchObject({
      reason: { kind: "GitHubTargetNotFound", operation: "create a pull request" },
      cause,
    });
    expect((failure as ZikuFailure).hint).toContain("source.ref");
    expect((failure as ZikuFailure).hint).toContain("ziku init");
  });

  it("分類していない失敗は、文言に潰さず原因のまま投げる", async () => {
    const bug = new TypeError("Cannot read properties of undefined (reading 'sha')");
    mockCreatePullRequest.mockRejectedValueOnce(bug);

    const failure = await failingGitHubPush();

    // 文言へ潰すと、ziku の不具合が「ユーザー側の問題」として案内され、原因も消える
    expect(failure).toBe(bug);
    expect(failure).not.toBeInstanceOf(ZikuFailure);
    expect((failure as Error).stack).toBeDefined();
  });

  /** ローカルテンプレートへ push し、書き込みを `error` で失敗させる。 */
  async function failingLocalPush(error: unknown): Promise<unknown> {
    const { effect } = mockContext({
      source: localTemplateSource,
      templateDir: absPath("/local/template"),
      lock: lockWith({ source: localTemplateSource }),
    });
    mockLoadCommandContext.mockReturnValue(effect);
    setupPushableFiles([{ path: repoRelPath("file.txt"), type: "added", localContent: "content" }]);
    mockWriteFile.mockImplementationOnce(() => Promise.reject(error));

    return (pushCommand.run as any)({
      args: { dir: "/test", dryRun: false, yes: true, edit: false },
      rawArgs: [],
      cmd: pushCommand,
    }).then(
      () => expect.unreachable("push が成功してしまった"),
      (thrown: unknown) => thrown,
    );
  }

  it("ローカルテンプレートへ書き込めなければ、直す場所を示す", async () => {
    const denied = Object.assign(
      new Error("EACCES: permission denied, open '/local/template/file.txt'"),
      { code: "EACCES", path: "/local/template/file.txt" },
    );

    const failure = await failingLocalPush(denied);

    expect(failure).toBeInstanceOf(ZikuFailure);
    expect(failure).toMatchObject({
      reason: {
        kind: "FileWriteFailed",
        path: "/local/template/file.txt",
        directory: "/local/template",
      },
      cause: denied,
    });
    expect((failure as ZikuFailure).hint).toContain("/local/template");
  });

  it("書き込み先を直しても通らない失敗は、分類せず原因のまま投げる", async () => {
    // ディレクトリへファイルを書こうとした（EISDIR）のは書き込み先の問題ではなく、
    // ziku が組み立てたパスの問題。権限や空き容量を案内しても行動につながらない。
    const wrongPath = Object.assign(new Error("EISDIR: illegal operation on a directory, open"), {
      code: "EISDIR",
      path: "/local/template/file.txt",
    });

    const failure = await failingLocalPush(wrongPath);

    expect(failure).toBe(wrongPath);
    expect(failure).not.toBeInstanceOf(ZikuFailure);
  });
});

describe("未追跡ファイルの追跡フロー", () => {
  beforeEach(() => {
    vol.reset();
    resetPushMocks();
    const { effect } = mockContext();
    mockLoadCommandContext.mockReturnValue(effect);
  });

  /** /test/.ziku/ziku.jsonc を初期 include 付きで memfs に用意する */
  function seedZikuConfig(include: string[] = [".github/**"]): void {
    vol.fromJSON({
      "/test/.ziku/ziku.jsonc": `${JSON.stringify(
        { $schema: "https://example.com/schema.json", include },
        null,
        2,
      )}\n`,
    });
  }

  /** memfs 上の /test/.ziku/ziku.jsonc の include 配列を読み出す */
  function readTrackedInclude(): string[] {
    const raw = vol.toJSON()["/test/.ziku/ziku.jsonc"] as string;
    return JSON.parse(raw).include as string[];
  }

  const untrackedDocsFile = [{ folder: "docs", files: [{ path: "docs/new.md", folder: "docs" }] }];

  it("対話モードで選択した未追跡ファイルが include に追記され push 対象に乗る", async () => {
    seedZikuConfig();
    mockDetectUntrackedFiles.mockReturnValueOnce(untrackedDocsFile as never);
    mockSelectUntrackedToTrack.mockResolvedValueOnce(repoRelPaths(["docs/new.md"]));

    // 追跡したファイルが localOnly として分類され、diff にも現れる
    setupPushableFiles([
      { path: repoRelPath("docs/new.md"), type: "added", localContent: "# New doc" },
    ]);
    mockSelectPushFiles.mockResolvedValueOnce([
      { path: repoRelPath("docs/new.md"), type: "added", localContent: "# New doc" },
    ]);
    mockGetGitHubToken.mockReturnValue("ghp_token");
    mockConfirmAction.mockResolvedValueOnce(true);
    mockCreatePullRequest.mockResolvedValueOnce({
      url: "https://github.com/owner/repo/pull/1",
      branch: "update-template-123",
      number: 1,
    });

    await (pushCommand.run as any)({
      args: { dir: "/test", dryRun: false, yes: false, edit: false },
      rawArgs: [],
      cmd: pushCommand,
    });

    // 追跡ファイルが PR に含まれる
    expect(mockCreatePullRequest).toHaveBeenCalledWith(
      "ghp_token",
      expect.objectContaining({
        files: expect.arrayContaining([expect.objectContaining({ path: "docs/new.md" })]),
      }),
    );
    // include に永続化される（push 成功後）
    expect(readTrackedInclude()).toContain("docs/new.md");
    expect(mockLog.success).toHaveBeenCalledWith(expect.stringContaining("Tracked 1 new file(s)"));
  });

  it("永続化先の ziku.jsonc がスキーマ違反なら、構文エラーではなく検証失敗として報告する", async () => {
    // include を欠いた設定は JSONC としては通るので、構文エラーと混同されやすい。
    vol.fromJSON({ "/test/.ziku/ziku.jsonc": `${JSON.stringify({ exclude: [] }, null, 2)}\n` });
    mockDetectUntrackedFiles.mockReturnValueOnce(untrackedDocsFile as never);
    mockSelectUntrackedToTrack.mockResolvedValueOnce(repoRelPaths(["docs/new.md"]));

    setupPushableFiles([
      { path: repoRelPath("docs/new.md"), type: "added", localContent: "# New doc" },
    ]);
    mockSelectPushFiles.mockResolvedValueOnce([
      { path: repoRelPath("docs/new.md"), type: "added", localContent: "# New doc" },
    ]);
    mockGetGitHubToken.mockReturnValue("ghp_token");
    mockConfirmAction.mockResolvedValueOnce(true);
    mockCreatePullRequest.mockResolvedValueOnce({
      url: "https://github.com/owner/repo/pull/1",
      branch: "update-template-123",
      number: 1,
    });

    await expect(
      (pushCommand.run as any)({
        args: { dir: "/test", dryRun: false, yes: false, edit: false },
        rawArgs: [],
        cmd: pushCommand,
      }),
    ).rejects.toThrow("Failed to read .ziku/ziku.jsonc");
  });

  it("新規追跡パターンが同一 push でテンプレの ziku.jsonc にも届く", async () => {
    // ディスク上の ziku.jsonc は旧 include のまま（push 成功後に persistNewlyTracked が書く）。
    // detectDiff には ziku.jsonc が現れない（unchanged 相当で push 対象から漏れるケース）。
    // ローカル・テンプレともに .github/** を既に持つ（だから classify は差分なしと判定した）。
    // それでも新規追跡パターン docs/new.md を含む union が同じ push でテンプレに届くこと。
    seedZikuConfig([".github/**"]);
    vol.fromJSON({
      "/tmp/template/.ziku/ziku.jsonc": `${JSON.stringify({ include: [".github/**"] }, null, 2)}\n`,
    });
    mockDetectUntrackedFiles.mockReturnValueOnce(untrackedDocsFile as never);
    mockSelectUntrackedToTrack.mockResolvedValueOnce(repoRelPaths(["docs/new.md"]));

    setupPushableFiles([
      { path: repoRelPath("docs/new.md"), type: "added", localContent: "# New doc" },
    ]);
    mockSelectPushFiles.mockResolvedValueOnce([
      { path: repoRelPath("docs/new.md"), type: "added", localContent: "# New doc" },
    ]);
    mockGetGitHubToken.mockReturnValue("ghp_token");
    mockConfirmAction.mockResolvedValueOnce(true);
    mockCreatePullRequest.mockResolvedValueOnce({
      url: "https://github.com/owner/repo/pull/1",
      branch: "update-template-123",
      number: 1,
    });

    await (pushCommand.run as any)({
      args: { dir: "/test", dryRun: false, yes: false, edit: false },
      rawArgs: [],
      cmd: pushCommand,
    });

    const prArg = mockCreatePullRequest.mock.calls[0]?.[1] as {
      files: readonly { path: string; content: string }[];
    };
    // ファイル本体だけでなく ziku.jsonc も push される
    const configFile = prArg.files.find((f) => f.path === ".ziku/ziku.jsonc");
    expect(configFile).toBeDefined();
    const pushed = JSON.parse(configFile?.content as string);
    // 新規追跡パターンと既存パターンの両方が含まれる（union）
    expect(pushed.include).toContain("docs/new.md");
    expect(pushed.include).toContain(".github/**");
  });

  it("ziku track の直後の push でも、README は同じ PR に載る ziku.jsonc から組み直す", async () => {
    // テンプレートのディスク上の ziku.jsonc から組むと、この push が追加するパターンを
    // 反映しない README を配ることになる。
    seedZikuConfig([".github/**"]);
    vol.fromJSON({
      "/tmp/template/.ziku/ziku.jsonc": `${JSON.stringify({ include: [".github/**"] }, null, 2)}\n`,
    });
    mockDetectUntrackedFiles.mockReturnValueOnce(untrackedDocsFile as never);
    mockSelectUntrackedToTrack.mockResolvedValueOnce(repoRelPaths(["docs/new.md"]));

    setupPushableFiles([
      { path: repoRelPath("docs/new.md"), type: "added", localContent: "# New doc" },
    ]);
    mockSelectPushFiles.mockResolvedValueOnce([
      { path: repoRelPath("docs/new.md"), type: "added", localContent: "# New doc" },
    ]);
    mockGetGitHubToken.mockReturnValue("ghp_token");
    mockConfirmAction.mockResolvedValueOnce(true);
    mockCreatePullRequest.mockResolvedValueOnce({
      url: "https://github.com/owner/repo/pull/1",
      branch: "update-template-123",
      number: 1,
    });

    await (pushCommand.run as any)({
      args: { dir: "/test", dryRun: false, yes: false, edit: false },
      rawArgs: [],
      cmd: pushCommand,
    });

    expect(mockRenderTemplateReadme).toHaveBeenCalledWith(
      expect.objectContaining({ config: expect.stringContaining("docs/new.md") }),
    );
  });

  it("未追跡を1件も選択しなければ include は変化しない", async () => {
    seedZikuConfig();
    mockDetectUntrackedFiles.mockReturnValueOnce(untrackedDocsFile as never);
    mockSelectUntrackedToTrack.mockResolvedValueOnce([]);

    // 別の追跡済みファイルの変更だけを push する
    setupPushableFiles([{ path: repoRelPath("file.txt"), type: "added", localContent: "content" }]);
    mockSelectPushFiles.mockResolvedValueOnce([
      { path: repoRelPath("file.txt"), type: "added", localContent: "content" },
    ]);
    mockGetGitHubToken.mockReturnValue("ghp_token");
    mockConfirmAction.mockResolvedValueOnce(true);
    mockCreatePullRequest.mockResolvedValueOnce({
      url: "https://github.com/owner/repo/pull/1",
      branch: "update-template-123",
      number: 1,
    });

    await (pushCommand.run as any)({
      args: { dir: "/test", dryRun: false, yes: false, edit: false },
      rawArgs: [],
      cmd: pushCommand,
    });

    expect(readTrackedInclude()).toEqual([".github/**"]);
    expect(mockLog.success).not.toHaveBeenCalledWith(expect.stringContaining("Tracked"));
  });

  it("push 失敗時は include を書き換えない（部分適用しない）", async () => {
    seedZikuConfig();
    mockDetectUntrackedFiles.mockReturnValueOnce(untrackedDocsFile as never);
    mockSelectUntrackedToTrack.mockResolvedValueOnce(repoRelPaths(["docs/new.md"]));

    setupPushableFiles([
      { path: repoRelPath("docs/new.md"), type: "added", localContent: "# New doc" },
    ]);
    mockSelectPushFiles.mockResolvedValueOnce([
      { path: repoRelPath("docs/new.md"), type: "added", localContent: "# New doc" },
    ]);
    mockGetGitHubToken.mockReturnValue("ghp_token");
    mockConfirmAction.mockResolvedValueOnce(true);
    // PR 作成が失敗する
    mockCreatePullRequest.mockRejectedValueOnce(new Error("network error"));

    await expect(
      (pushCommand.run as any)({
        args: { dir: "/test", dryRun: false, yes: false, edit: false },
        rawArgs: [],
        cmd: pushCommand,
      }),
    ).rejects.toThrow();

    // push が失敗したので include は元のまま
    expect(readTrackedInclude()).toEqual([".github/**"]);
  });

  it("--yes では未追跡を追加せず、除外を明示通知する", async () => {
    seedZikuConfig();
    mockDetectUntrackedFiles.mockReturnValueOnce(untrackedDocsFile as never);
    // --yes では追跡対象なし → push 対象もなしで終了

    await (pushCommand.run as any)({
      args: { dir: "/test", dryRun: false, yes: true, edit: false },
      rawArgs: [],
      cmd: pushCommand,
    });

    // 選択プロンプトは出さない
    expect(mockSelectUntrackedToTrack).not.toHaveBeenCalled();
    // 何件が・なぜ push から外れたかを通知する（--yes は追跡選択も省くため）
    const [, , notice] = vi.mocked(mockLogUntrackedFilesNotice).mock.calls[0] as [
      unknown,
      unknown,
      { headline: string },
    ];
    expect(notice.headline).toContain("1 untracked file(s) left out of this push");
    expect(notice.headline).toContain("--yes skips the tracking prompt");
    // include は変化しない
    expect(readTrackedInclude()).toEqual([".github/**"]);
  });

  it("--dry-run では未追跡を追加せず、dry-run 用の通知文言を出す", async () => {
    seedZikuConfig();
    mockDetectUntrackedFiles.mockReturnValueOnce(untrackedDocsFile as never);

    await (pushCommand.run as any)({
      args: { dir: "/test", dryRun: true, yes: false, edit: false },
      rawArgs: [],
      cmd: pushCommand,
    });

    // dry-run は「除外」ではなく「追跡判断のスキップ」と伝える
    expect(mockSelectUntrackedToTrack).not.toHaveBeenCalled();
    expect(mockLogUntrackedFilesNotice).toHaveBeenCalledWith(
      untrackedDocsFile,
      1,
      expect.objectContaining({ headline: expect.stringContaining("dry-run: tracking skipped") }),
    );
    expect(readTrackedInclude()).toEqual([".github/**"]);
  });

  it("ローカルソースへの push でも、追跡したファイルが include に永続化される", async () => {
    const { effect } = mockContext({
      source: localTemplateSource,
      lock: lockWith({ source: localTemplateSource }),
    });
    mockLoadCommandContext.mockReturnValue(effect);
    seedZikuConfig();
    mockDetectUntrackedFiles.mockReturnValueOnce(untrackedDocsFile as never);
    mockSelectUntrackedToTrack.mockResolvedValueOnce(repoRelPaths(["docs/new.md"]));

    setupPushableFiles([
      { path: repoRelPath("docs/new.md"), type: "added", localContent: "# New doc" },
    ]);
    mockSelectPushFiles.mockResolvedValueOnce([
      { path: repoRelPath("docs/new.md"), type: "added", localContent: "# New doc" },
    ]);
    // ローカル push の確認プロンプト
    mockConfirmAction.mockResolvedValueOnce(true);

    await (pushCommand.run as any)({
      args: { dir: "/test", dryRun: false, yes: false, edit: false },
      rawArgs: [],
      cmd: pushCommand,
    });

    // ローカル push 経路（PR は作らない）でも include に追記される
    expect(mockCreatePullRequest).not.toHaveBeenCalled();
    expect(readTrackedInclude()).toContain("docs/new.md");
  });

  it("追跡を選んでもファイル選択で外したファイルは永続化されない", async () => {
    seedZikuConfig();
    mockDetectUntrackedFiles.mockReturnValueOnce(untrackedDocsFile as never);
    mockSelectUntrackedToTrack.mockResolvedValueOnce(repoRelPaths(["docs/new.md"]));

    // docs/new.md（追跡候補）と safe.txt の両方が push 可能
    setupPushableFiles([
      { path: repoRelPath("docs/new.md"), type: "added", localContent: "# New doc" },
      { path: repoRelPath("safe.txt"), type: "added", localContent: "safe" },
    ]);
    // ユーザーはファイル選択で safe.txt のみ選び、docs/new.md は外す
    mockSelectPushFiles.mockResolvedValueOnce([
      { path: repoRelPath("safe.txt"), type: "added", localContent: "safe" },
    ]);
    mockGetGitHubToken.mockReturnValue("ghp_token");
    mockConfirmAction.mockResolvedValueOnce(true);
    mockCreatePullRequest.mockResolvedValueOnce({
      url: "https://github.com/owner/repo/pull/1",
      branch: "update-template-123",
      number: 1,
    });

    await (pushCommand.run as any)({
      args: { dir: "/test", dryRun: false, yes: false, edit: false },
      rawArgs: [],
      cmd: pushCommand,
    });

    // 実際に push したのは safe.txt のみ。push していない docs/new.md は追跡されない。
    const callArgs = mockCreatePullRequest.mock.calls[0][1];
    expect(callArgs.files.some((f: any) => f.path === "safe.txt")).toBe(true);
    expect(readTrackedInclude()).toEqual([".github/**"]);
  });
});

describe("--files でファイル本体だけを指定した場合の ziku.jsonc 自動同梱（#90）", () => {
  beforeEach(() => {
    vol.reset();
    resetPushMocks();
    const { effect } = mockContext();
    mockLoadCommandContext.mockReturnValue(effect);
  });

  /** /test/.ziku/ziku.jsonc を指定 include 付きで memfs に用意する（`ziku track` 済み想定） */
  function seedZikuConfig(include: string[]): void {
    vol.fromJSON({
      "/test/.ziku/ziku.jsonc": `${JSON.stringify(
        { $schema: "https://example.com/schema.json", include },
        null,
        2,
      )}\n`,
    });
  }

  it("事前に `ziku track` 済みのパターンが --files で本体だけ指定しても push される", async () => {
    // .claude/skills/new-skill/SKILL.md は「ziku track」済みでローカルの
    // ziku.jsonc には既に反映されている（テンプレにはまだ無い）。
    seedZikuConfig([".github/**", ".claude/skills/new-skill/SKILL.md"]);
    vol.fromJSON({
      "/tmp/template/.ziku/ziku.jsonc": `${JSON.stringify({ include: [".github/**"] }, null, 2)}\n`,
    });

    setupPushableFiles([
      {
        path: repoRelPath(".claude/skills/new-skill/SKILL.md"),
        type: "added",
        localContent: "# skill",
      },
      {
        path: repoRelPath(".ziku/ziku.jsonc"),
        type: "modified",
        localContent: JSON.stringify(
          { include: [".github/**", ".claude/skills/new-skill/SKILL.md"] },
          null,
          2,
        ),
        templateContent: JSON.stringify({ include: [".github/**"] }, null, 2),
      },
    ]);

    mockGetGitHubToken.mockReturnValue("ghp_token");
    mockConfirmAction.mockResolvedValueOnce(true);
    mockCreatePullRequest.mockResolvedValueOnce({
      url: "https://github.com/owner/repo/pull/1",
      branch: "update-template-123",
      number: 1,
    });

    // --files はスキル本体だけを指定し、ziku.jsonc は含めない（issue #90 の再現手順）。
    await (pushCommand.run as any)({
      args: {
        dir: "/test",
        dryRun: false,
        yes: false,
        edit: false,
        files: ".claude/skills/new-skill/SKILL.md",
      },
      rawArgs: [],
      cmd: pushCommand,
    });

    const prArg = mockCreatePullRequest.mock.calls[0]?.[1] as {
      files: readonly { path: string; content: string }[];
    };
    expect(prArg.files.some((f) => f.path === ".claude/skills/new-skill/SKILL.md")).toBe(true);

    // ファイル本体だけでなく ziku.jsonc も push される（#90 の修正）
    const configFile = prArg.files.find((f) => f.path === ".ziku/ziku.jsonc");
    expect(configFile).toBeDefined();
    const pushed = JSON.parse(configFile?.content as string);
    expect(pushed.include).toContain(".claude/skills/new-skill/SKILL.md");
    expect(pushed.include).toContain(".github/**");

    // ユーザーに自動同梱したことを通知する
    expect(mockLog.info).toHaveBeenCalledWith(expect.stringContaining("Also pushing"));
  });

  it("--files で指定したファイルに無関係なローカル限定パターンは巻き込まない", async () => {
    // .claude/rules/unrelated.md は別件で ziku track 済みだが、今回の push には無関係。
    seedZikuConfig([
      ".github/**",
      ".claude/skills/new-skill/SKILL.md",
      ".claude/rules/unrelated.md",
    ]);

    setupPushableFiles([
      {
        path: repoRelPath(".claude/skills/new-skill/SKILL.md"),
        type: "added",
        localContent: "# skill",
      },
      {
        path: repoRelPath(".ziku/ziku.jsonc"),
        type: "modified",
        localContent: JSON.stringify(
          {
            include: [
              ".github/**",
              ".claude/skills/new-skill/SKILL.md",
              ".claude/rules/unrelated.md",
            ],
          },
          null,
          2,
        ),
        templateContent: JSON.stringify({ include: [".github/**"] }, null, 2),
      },
    ]);

    mockGetGitHubToken.mockReturnValue("ghp_token");
    mockConfirmAction.mockResolvedValueOnce(true);
    mockCreatePullRequest.mockResolvedValueOnce({
      url: "https://github.com/owner/repo/pull/1",
      branch: "update-template-123",
      number: 1,
    });

    await (pushCommand.run as any)({
      args: {
        dir: "/test",
        dryRun: false,
        yes: false,
        edit: false,
        files: ".claude/skills/new-skill/SKILL.md",
      },
      rawArgs: [],
      cmd: pushCommand,
    });

    const prArg = mockCreatePullRequest.mock.calls[0]?.[1] as {
      files: readonly { path: string; content: string }[];
    };
    const configFile = prArg.files.find((f) => f.path === ".ziku/ziku.jsonc");
    expect(configFile).toBeDefined();
    const pushed = JSON.parse(configFile?.content as string);
    expect(pushed.include).toContain(".claude/skills/new-skill/SKILL.md");
    // 今回の push に無関係なパターンは含まれない
    expect(pushed.include).not.toContain(".claude/rules/unrelated.md");
  });

  it("ziku.jsonc 自体を --files で明示指定した場合は全パターンが union される（挙動を変えない）", async () => {
    seedZikuConfig([
      ".github/**",
      ".claude/skills/new-skill/SKILL.md",
      ".claude/rules/unrelated.md",
    ]);

    setupPushableFiles([
      {
        path: repoRelPath(".ziku/ziku.jsonc"),
        type: "modified",
        localContent: JSON.stringify(
          {
            include: [
              ".github/**",
              ".claude/skills/new-skill/SKILL.md",
              ".claude/rules/unrelated.md",
            ],
          },
          null,
          2,
        ),
        templateContent: JSON.stringify({ include: [".github/**"] }, null, 2),
      },
    ]);

    mockGetGitHubToken.mockReturnValue("ghp_token");
    mockConfirmAction.mockResolvedValueOnce(true);
    mockCreatePullRequest.mockResolvedValueOnce({
      url: "https://github.com/owner/repo/pull/1",
      branch: "update-template-123",
      number: 1,
    });

    await (pushCommand.run as any)({
      args: { dir: "/test", dryRun: false, yes: false, edit: false, files: ".ziku/ziku.jsonc" },
      rawArgs: [],
      cmd: pushCommand,
    });

    const prArg = mockCreatePullRequest.mock.calls[0]?.[1] as {
      files: readonly { path: string; content: string }[];
    };
    const configFile = prArg.files.find((f) => f.path === ".ziku/ziku.jsonc");
    const pushed = JSON.parse(configFile?.content as string);
    expect(pushed.include).toContain(".claude/rules/unrelated.md");
  });

  it("ローカルソースへの push でも、自動同梱はテンプレのみに書かれ、ローカルの他パターンは消えない", async () => {
    // レビュー指摘: スコープ限定 union（テンプレ + 関連パターンのみ）をそのまま
    // ローカルの ziku.jsonc へ書き戻すと、今回の push と無関係な docs/a.md が
    // ローカルの追跡対象から消えてしまう（union は削除しないという原則に反する）。
    const { effect } = mockContext({
      source: localTemplateSource,
      lock: lockWith({ source: localTemplateSource }),
    });
    mockLoadCommandContext.mockReturnValue(effect);

    // docs/a.md, docs/b.md ともに事前に ziku track 済み。今回の push は docs/b.md のみ。
    seedZikuConfig([".github/**", "docs/a.md", "docs/b.md"]);
    vol.fromJSON({
      "/local/template/.ziku/ziku.jsonc": `${JSON.stringify({ include: [".github/**"] }, null, 2)}\n`,
    });

    setupPushableFiles([
      { path: repoRelPath("docs/b.md"), type: "added", localContent: "# doc b" },
      {
        path: repoRelPath(".ziku/ziku.jsonc"),
        type: "modified",
        localContent: JSON.stringify(
          { include: [".github/**", "docs/a.md", "docs/b.md"] },
          null,
          2,
        ),
        templateContent: JSON.stringify({ include: [".github/**"] }, null, 2),
      },
    ]);

    mockConfirmAction.mockResolvedValueOnce(true);

    await (pushCommand.run as any)({
      args: { dir: "/test", dryRun: false, yes: false, edit: false, files: "docs/b.md" },
      rawArgs: [],
      cmd: pushCommand,
    });

    // テンプレ側には関連パターンだけが届く（docs/a.md は含めない）
    const templateConfig = JSON.parse(vol.toJSON()["/local/template/.ziku/ziku.jsonc"] as string);
    expect(templateConfig.include).toContain("docs/b.md");
    expect(templateConfig.include).not.toContain("docs/a.md");

    // ローカルの ziku.jsonc は書き換えられず、docs/a.md の追跡が失われない
    const localConfig = JSON.parse(vol.toJSON()["/test/.ziku/ziku.jsonc"] as string);
    expect(localConfig.include).toContain("docs/a.md");
    expect(localConfig.include).toContain("docs/b.md");
  });
});

describe("pushCommand args", () => {
  it("args に yes フラグが定義されている", () => {
    const args = pushCommand.args as Record<string, { type: string; default?: unknown }>;
    expect(args.yes).toBeDefined();
    expect(args.yes.default).toBe(false);
  });

  it("args に force という名前のトップレベルフラグが存在しない", () => {
    const args = pushCommand.args as Record<string, unknown>;
    expect(args.force).toBeUndefined();
  });
});
