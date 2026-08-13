import { vol } from "memfs";
import { Effect, Option } from "effect";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { FileNotFoundError } from "../../errors";
import type {
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

vi.mock("node:fs/promises", async () => {
  const memfs = await import("memfs");
  return memfs.fs.promises;
});

// loadCommandContext をモック（DI の恩恵: 低レベルモック不要）
// runCommandEffect / toZikuError は実際の実装を使い、loadCommandContext だけモックする
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

// utils/github をモック
vi.mock("../../utils/github", () => ({
  getGitHubToken: vi.fn(),
  createPullRequest: vi.fn(),
}));

// utils/readme をモック
vi.mock("../../utils/readme", () => ({
  detectAndUpdateReadme: vi.fn(() => null),
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
        const unresolved: string[] = [];
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
          if (outcome._tag !== "Clean") unresolved.push(file);
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
const { loadCommandContext } = await import("../../services/command-context");
const { detectDiff } = await import("../../utils/diff");
const { getGitHubToken, createPullRequest } = await import("../../utils/github");
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
const { log, logDiffSummary } = await import("../../ui/renderer");
const { hashFiles } = await import("../../utils/hash");
const { classifyFiles, mergeOneFile, downloadBaseForMerge } = await import("../../utils/merge");
// マージ結果の判定は本物を使う（"../../utils/merge" のモックは index 経由の import だけを
// 置き換えるので、実装モジュールを直接読み込めば素の関数が得られる）。
const { classifyMergeOutcome } = await import("../../utils/merge/types");
const mockLoadCommandContext = vi.mocked(loadCommandContext);
const mockDetectDiff = vi.mocked(detectDiff);
const mockGetGitHubToken = vi.mocked(getGitHubToken);
const mockCreatePullRequest = vi.mocked(createPullRequest);
const mockConfirmAction = vi.mocked(confirmAction);
const mockInputGitHubToken = vi.mocked(inputGitHubToken);
const mockInputPrTitle = vi.mocked(inputPrTitle);
const mockInputPrBody = vi.mocked(inputPrBody);
const mockSelectPushFiles = vi.mocked(selectPushFiles);
const mockSelectUntrackedToTrack = vi.mocked(selectUntrackedToTrack);
const mockLogUntrackedFilesNotice = vi.mocked(logUntrackedFilesNotice);
const mockDetectUntrackedFiles = vi.mocked(detectUntrackedFiles);
const mockLog = vi.mocked(log);
const mockLogDiffSummary = vi.mocked(logDiffSummary);
const mockHashFiles = vi.mocked(hashFiles);
const mockClassifyFiles = vi.mocked(classifyFiles);
const mockMergeOneFile = vi.mocked(mergeOneFile);
const mockDownloadBaseForMerge = vi.mocked(downloadBaseForMerge);

const validZikuConfig = {
  include: [".github/**"],
  exclude: [],
};

const githubSource: TemplateSource = { kind: "github", owner: "tktcorporation", repo: ".github" };
const localTemplateSource: TemplateSource = { kind: "local", path: "/local/template" };

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
    : markSynced(base, { hashes: opts.hashes ?? {}, commitSha: opts.commitSha });
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
  templateDir?: string;
}) {
  const cleanup = vi.fn();
  const source = overrides?.source ?? githubSource;
  return {
    effect: Effect.succeed({
      config: overrides?.config ?? validZikuConfig,
      lock: overrides?.lock ?? validLock,
      source,
      templateDir: overrides?.templateDir ?? "/tmp/template",
      cleanup,
      resolveBaseRef: Effect.succeed(Option.none<string>()),
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
      // ParseError は toZikuError で対象ファイル名付きのメッセージに変換される
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
      setupPushableFiles([{ path: "file.txt", type: "added", localContent: "content" }]);

      await (pushCommand.run as any)({
        args: { dir: "/test", dryRun: true, yes: false, edit: false },
        rawArgs: [],
        cmd: pushCommand,
      });

      expect(mockLog.info).toHaveBeenCalledWith("Dry run mode");
      // dry-run ではファイルリストを表示して終了
      expect(mockCreatePullRequest).not.toHaveBeenCalled();
    });

    it("--dry-run + --files はプレビューを指定ファイルだけに絞る（#81）", async () => {
      // push 候補を複数用意し、--files で 1 つだけ指定する
      mockClassifyFiles.mockReturnValueOnce({
        autoUpdate: [],
        localOnly: ["a.txt", "b.txt"],
        conflicts: [],
        newFiles: [],
        deletedFiles: [],
        deletedWithLocalEdits: [],
        deletedLocally: [],
        unchanged: [],
      });
      mockDetectDiff.mockResolvedValueOnce({
        files: [
          { path: "a.txt", type: "added", localContent: "a" },
          { path: "b.txt", type: "added", localContent: "b" },
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
      setupPushableFiles([{ path: "a.txt", type: "added", localContent: "a" }]);

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
        localOnly: ["normal.txt"],
        conflicts: ["conflict.txt"],
        newFiles: [],
        deletedFiles: [],
        deletedWithLocalEdits: [],
        deletedLocally: [],
        unchanged: [],
      });
      mockDetectDiff.mockResolvedValueOnce({
        files: [
          { path: "normal.txt", type: "modified", localContent: "n", templateContent: "nt" },
          { path: "conflict.txt", type: "modified", localContent: "c", templateContent: "ct" },
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
        conflicts: ["conflict.txt"],
        newFiles: [],
        deletedFiles: [],
        deletedWithLocalEdits: [],
        deletedLocally: [],
        unchanged: [],
      });
      mockDetectDiff.mockResolvedValueOnce({
        files: [
          { path: "conflict.txt", type: "modified", localContent: "c", templateContent: "ct" },
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

    it("--dry-run は --include-deletions なしでは削除ファイルをプレビューから除外する（#81）", async () => {
      mockClassifyFiles.mockReturnValueOnce({
        autoUpdate: [],
        localOnly: ["keep.txt"],
        conflicts: [],
        newFiles: [],
        deletedFiles: [],
        deletedWithLocalEdits: [],
        deletedLocally: ["gone.txt"],
        unchanged: [],
      });
      mockDetectDiff.mockResolvedValueOnce({
        files: [
          { path: "keep.txt", type: "added", localContent: "k" },
          { path: "gone.txt", type: "deleted", templateContent: "g" },
        ],
      });

      await (pushCommand.run as any)({
        args: { dir: "/test", dryRun: true, yes: false, edit: false },
        rawArgs: [],
        cmd: pushCommand,
      });

      // 削除ファイルは既定で除外（実 push の既定選択と一致）
      const previewArg = mockLogDiffSummary.mock.calls.at(-1)?.[0] ?? [];
      expect(previewArg.map((f) => f.path)).toEqual(["keep.txt"]);
    });

    it("--dry-run --include-deletions は削除ファイルもプレビューに含める（#81）", async () => {
      mockClassifyFiles.mockReturnValueOnce({
        autoUpdate: [],
        localOnly: ["keep.txt"],
        conflicts: [],
        newFiles: [],
        deletedFiles: [],
        deletedWithLocalEdits: [],
        deletedLocally: ["gone.txt"],
        unchanged: [],
      });
      mockDetectDiff.mockResolvedValueOnce({
        files: [
          { path: "keep.txt", type: "added", localContent: "k" },
          { path: "gone.txt", type: "deleted", templateContent: "g" },
        ],
      });

      await (pushCommand.run as any)({
        args: { dir: "/test", dryRun: true, yes: false, edit: false, includeDeletions: true },
        rawArgs: [],
        cmd: pushCommand,
      });

      const previewArg = mockLogDiffSummary.mock.calls.at(-1)?.[0] ?? [];
      expect(previewArg.map((f) => f.path).toSorted()).toEqual(["gone.txt", "keep.txt"]);
    });

    it("deletedWithLocalEdits を push 候補に含める", async () => {
      mockClassifyFiles.mockReturnValueOnce({
        autoUpdate: [],
        localOnly: [],
        conflicts: [],
        newFiles: [],
        deletedFiles: [],
        deletedWithLocalEdits: ["edited.md"],
        deletedLocally: [],
        unchanged: [],
      });
      mockDetectDiff.mockResolvedValueOnce({
        files: [{ path: "edited.md", type: "added", localContent: "local edits" }],
      });

      await (pushCommand.run as any)({
        args: { dir: "/test", dryRun: true, yes: false, edit: false },
        rawArgs: [],
        cmd: pushCommand,
      });

      const previewArg = mockLogDiffSummary.mock.calls.at(-1)?.[0] ?? [];
      expect(previewArg.map((f) => f.path)).toEqual(["edited.md"]);
    });

    it("deletedWithLocalEdits の push はテンプレの削除を取り消すとサマリで示す", async () => {
      mockClassifyFiles.mockReturnValueOnce({
        autoUpdate: [],
        localOnly: ["plain.txt"],
        conflicts: [],
        newFiles: [],
        deletedFiles: [],
        deletedWithLocalEdits: ["edited.md"],
        deletedLocally: [],
        unchanged: [],
      });
      mockDetectDiff.mockResolvedValueOnce({
        files: [
          { path: "edited.md", type: "added", localContent: "local edits" },
          { path: "plain.txt", type: "added", localContent: "plain" },
        ],
      });
      // --yes なので既定集合（追加された 2 ファイル）がそのまま push 対象になる
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

      const summary = mockLog.message.mock.calls
        .map((call) => call[0])
        .find((text) => text.includes("edited.md"));
      expect(summary).toContain("restores file deleted in template");
      // 注記は該当ファイルの行だけに付く
      expect(summary?.split("\n").find((line) => line.includes("plain.txt"))).not.toContain(
        "restores file deleted in template",
      );
    });

    it("ファイル選択をキャンセルすると PR を作成しない", async () => {
      setupPushableFiles([{ path: "file.txt", type: "added", localContent: "content" }]);

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
        { path: "file.txt", type: "added", localContent: "content" },
        { path: "other.txt", type: "modified", localContent: "new", templateContent: "old" },
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

    it("--yes の既定集合は削除ファイルを外す", async () => {
      mockClassifyFiles.mockReturnValueOnce({
        autoUpdate: [],
        localOnly: ["keep.txt"],
        conflicts: [],
        newFiles: [],
        deletedFiles: [],
        deletedWithLocalEdits: [],
        deletedLocally: ["gone.txt"],
        unchanged: [],
      });
      mockDetectDiff.mockResolvedValueOnce({
        files: [
          { path: "keep.txt", type: "added", localContent: "k" },
          { path: "gone.txt", type: "deleted", templateContent: "g" },
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

      const prArg = mockCreatePullRequest.mock.calls[0]?.[1];
      expect(prArg?.files.map((f) => f.path)).toEqual(["keep.txt"]);
      expect(prArg?.deletions).toEqual([]);
    });

    it("--yes --include-deletions の既定集合は削除ファイルも含む", async () => {
      mockClassifyFiles.mockReturnValueOnce({
        autoUpdate: [],
        localOnly: ["keep.txt"],
        conflicts: [],
        newFiles: [],
        deletedFiles: [],
        deletedWithLocalEdits: [],
        deletedLocally: ["gone.txt"],
        unchanged: [],
      });
      mockDetectDiff.mockResolvedValueOnce({
        files: [
          { path: "keep.txt", type: "added", localContent: "k" },
          { path: "gone.txt", type: "deleted", templateContent: "g" },
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
        deletedLocally: ["gone.txt"],
        unchanged: [],
      });
      mockDetectDiff.mockResolvedValueOnce({
        files: [{ path: "gone.txt", type: "deleted", templateContent: "g" }],
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
        path: "file.txt",
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
        path: "file.txt",
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
        path: "file.txt",
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
        path: "file.txt",
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
        path: ".claude/statusline.sh",
        type: "added" as const,
        localContent: "#!/bin/bash\necho hello",
      };
      const file2 = {
        path: ".claude/settings.json",
        type: "modified" as const,
        localContent: '{"statusLine": "script"}',
        templateContent: '{"statusLine": "default"}',
      };
      const file3 = {
        path: ".devcontainer/devcontainer.json",
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
        path: "file.txt",
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
      setupPushableFiles([{ path: "file.txt", type: "added", localContent: "content" }]);

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
        path: "file.txt",
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

    it("コンフリクト解決待ちの場合はエラー", async () => {
      const { effect } = mockContext({
        lock: markMerging(validLock, { hashes: {} }, [".mcp.json"]),
      });
      mockLoadCommandContext.mockReturnValue(effect);

      await expect(
        (pushCommand.run as any)({
          args: { dir: "/test", dryRun: false, yes: false, edit: false },
          rawArgs: [],
          cmd: pushCommand,
        }),
      ).rejects.toThrow("Unresolved merge conflicts");
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

    it("localOnly で ziku.jsonc がローカル削除されていてもテンプレのパターンは消さない（codex P2）", async () => {
      // ローカルが .github/** を削除しただけ（localOnly）。push は生のローカルではなく
      // union を送るので、テンプレ側の .github/** は保持される（削除は自動伝播しない）。
      const { effect } = mockContext({
        lock: lockWith({
          hashes: { ".ziku/ziku.jsonc": "oldhash" },
        }),
      });
      mockLoadCommandContext.mockReturnValue(effect);

      const localConfig = JSON.stringify({ include: [".claude/**"] }, null, 2);
      const templateConfig = JSON.stringify({ include: [".claude/**", ".github/**"] }, null, 2);
      vol.fromJSON({
        "/test/.ziku/ziku.jsonc": localConfig,
        "/tmp/template/.ziku/ziku.jsonc": templateConfig,
      });

      mockClassifyFiles.mockReturnValueOnce({
        autoUpdate: [],
        localOnly: [".ziku/ziku.jsonc"],
        conflicts: [],
        newFiles: [],
        deletedFiles: [],
        deletedWithLocalEdits: [],
        deletedLocally: [],
        unchanged: [],
      });

      const pushableFile = {
        path: ".ziku/ziku.jsonc",
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
        branch: "b",
        number: 1,
      });

      await (pushCommand.run as any)({
        args: { dir: "/test", dryRun: false, yes: false, edit: false },
        rawArgs: [],
        cmd: pushCommand,
      });

      const prArg = mockCreatePullRequest.mock.calls[0]?.[1] as {
        files: { path: string; content: string }[];
      };
      const configFile = prArg.files.find((f) => f.path === ".ziku/ziku.jsonc");
      expect(configFile).toBeDefined();
      const pushed = JSON.parse(configFile?.content as string);
      // 生のローカル（.github/** 削除済み）ではなく union が送られ、.github/** は残る
      expect(pushed.include).toContain(".github/**");
      expect(pushed.include).toContain(".claude/**");
    });

    it("ローカルテンプレへの push: ziku.jsonc の union 結果をローカルにも書き戻す（codex P2）", async () => {
      const { effect } = mockContext({
        source: localTemplateSource,
        // ローカルソースでは templateDir は localSource.path に解決される
        templateDir: "/local/template",
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
        conflicts: [".ziku/ziku.jsonc"],
        newFiles: [],
        deletedFiles: [],
        deletedWithLocalEdits: [],
        deletedLocally: [],
        unchanged: [],
      });

      const pushableFile = {
        path: ".ziku/ziku.jsonc",
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
        conflicts: ["file.txt"],
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
            path: "file.txt",
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
        localOnly: ["safe.txt"],
        conflicts: ["bad.txt"],
        newFiles: [],
        deletedFiles: [],
        deletedWithLocalEdits: [],
        deletedLocally: [],
        unchanged: [],
      });
      mockDetectDiff.mockResolvedValueOnce({
        files: [
          { path: "safe.txt", type: "added", localContent: "safe" },
          { path: "bad.txt", type: "modified", localContent: "local", templateContent: "template" },
        ],
      });
      // ユーザーは衝突しない safe.txt のみ選択（bad.txt は既定で未選択）
      mockSelectPushFiles.mockResolvedValueOnce([
        { path: "safe.txt", type: "added", localContent: "safe" },
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

      mockClassifyFiles.mockReturnValueOnce({
        autoUpdate: [],
        localOnly: [],
        conflicts: ["file.txt"],
        newFiles: [],
        deletedFiles: [],
        deletedWithLocalEdits: [],
        deletedLocally: [],
        unchanged: [],
      });
      mockDetectDiff.mockResolvedValueOnce({
        files: [
          {
            path: "file.txt",
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
        name: "ZikuError",
        message: expect.stringContaining("couldn't be auto-merged"),
        hint: expect.stringMatching(/file\.txt[\s\S]*ziku pull/),
      });

      expect(mockCreatePullRequest).not.toHaveBeenCalled();
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
        conflicts: ["file.txt"],
        newFiles: [],
        deletedFiles: [],
        deletedWithLocalEdits: [],
        deletedLocally: [],
        unchanged: [],
      });
      const conflictFile = {
        path: "file.txt",
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
        name: "ZikuError",
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
        conflicts: ["file.txt"],
        newFiles: [],
        deletedFiles: [],
        deletedWithLocalEdits: [],
        deletedLocally: [],
        unchanged: [],
      });

      // downloadBaseForMerge がベースを返す
      mockDownloadBaseForMerge.mockReturnValueOnce(
        Effect.succeed({ templateDir: "/tmp/base-template", cleanup: vi.fn() }),
      );

      // mergeOneFile のモック（自動マージ成功）
      mockMergeOneFile.mockReturnValueOnce(
        Effect.succeed({ file: "file.txt", outcome: classifyMergeOutcome("merged content") }),
      );

      const pushableFile = {
        path: "file.txt",
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
        file: "file.txt",
        targetDir: "/test",
        templateDir: "/tmp/template",
        base: { kind: "with-base", dir: "/tmp/base-template" },
      });

      expect(mockCreatePullRequest).toHaveBeenCalledWith(
        "ghp_token",
        expect.objectContaining({
          files: expect.arrayContaining([
            expect.objectContaining({
              path: "file.txt",
              content: "merged content",
            }),
          ]),
        }),
      );
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
        conflicts: ["clean.txt", "conflicted.txt"],
        newFiles: [],
        deletedFiles: [],
        deletedWithLocalEdits: [],
        deletedLocally: [],
        unchanged: [],
      });

      mockDownloadBaseForMerge.mockReturnValueOnce(
        Effect.succeed({ templateDir: "/tmp/base-template", cleanup: vi.fn() }),
      );

      mockMergeOneFile.mockReturnValueOnce(
        Effect.succeed({ file: "clean.txt", outcome: classifyMergeOutcome("merged clean") }),
      );
      mockMergeOneFile.mockReturnValueOnce(
        Effect.succeed({
          file: "conflicted.txt",
          outcome: classifyMergeOutcome(
            "<<<<<<< LOCAL\nlocal conflicted\n=======\ntemplate conflicted\n>>>>>>> TEMPLATE",
          ),
        }),
      );

      const cleanDiff = {
        path: "clean.txt",
        type: "modified" as const,
        localContent: "local clean",
        templateContent: "template clean",
      };
      const conflictedDiff = {
        path: "conflicted.txt",
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
        files: { path: string; content: string }[];
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
        conflicts: [".ziku/ziku.jsonc"],
        newFiles: [],
        deletedFiles: [],
        deletedWithLocalEdits: [],
        deletedLocally: [],
        unchanged: [],
      });

      // base が取れない（downloadBaseForMerge→null, デフォルト）→ 2-way 和集合

      const pushableFile = {
        path: ".ziku/ziku.jsonc",
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
        files: { path: string; content: string }[];
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
        conflicts: ["deleted-file.txt"], // delete/modify conflict
        newFiles: [],
        deletedFiles: [],
        deletedWithLocalEdits: [],
        deletedLocally: [],
        unchanged: [],
      });

      // downloadBaseForMerge がベースを返す
      mockDownloadBaseForMerge.mockReturnValueOnce(
        Effect.succeed({ templateDir: "/tmp/base-template", cleanup: vi.fn() }),
      );

      // mergeOneFile: コンフリクト（delete/modify conflict は mergeOneFile 内で
      // readFileSafe により安全にローカル=空文字列で処理される）
      mockMergeOneFile.mockReturnValueOnce(
        Effect.succeed({
          file: "deleted-file.txt",
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
        localOnly: ["safe.txt"],
        conflicts: ["file.txt"],
        newFiles: [],
        deletedFiles: [],
        deletedWithLocalEdits: [],
        deletedLocally: [],
        unchanged: [],
      });
      mockDetectDiff.mockResolvedValueOnce({
        files: [
          { path: "safe.txt", type: "added", localContent: "safe" },
          {
            path: "file.txt",
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
        autoUpdate: ["template-only.txt"],
        localOnly: [],
        conflicts: [],
        newFiles: [],
        deletedFiles: [],
        deletedWithLocalEdits: [],
        deletedLocally: [],
        unchanged: ["file.txt"],
      });

      // detectDiff は template-only.txt を "modified" として返すが、
      // classification の pushableFilePaths に含まれないため除外される
      mockDetectDiff.mockResolvedValueOnce({
        files: [
          {
            path: "template-only.txt",
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
        autoUpdate: ["file.txt"],
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
    mockSelectUntrackedToTrack.mockResolvedValueOnce(["docs/new.md"]);

    // 追跡したファイルが localOnly として分類され、diff にも現れる
    setupPushableFiles([{ path: "docs/new.md", type: "added", localContent: "# New doc" }]);
    mockSelectPushFiles.mockResolvedValueOnce([
      { path: "docs/new.md", type: "added", localContent: "# New doc" },
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
    mockSelectUntrackedToTrack.mockResolvedValueOnce(["docs/new.md"]);

    setupPushableFiles([{ path: "docs/new.md", type: "added", localContent: "# New doc" }]);
    mockSelectPushFiles.mockResolvedValueOnce([
      { path: "docs/new.md", type: "added", localContent: "# New doc" },
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

  it("新規追跡パターンが同一 push でテンプレの ziku.jsonc にも届く（codex P2）", async () => {
    // ディスク上の ziku.jsonc は旧 include のまま（push 成功後に persistNewlyTracked が書く）。
    // detectDiff には ziku.jsonc が現れない（unchanged 相当で push 対象から漏れるケース）。
    // ローカル・テンプレともに .github/** を既に持つ（だから classify は差分なしと判定した）。
    // それでも新規追跡パターン docs/new.md を含む union が同じ push でテンプレに届くこと。
    seedZikuConfig([".github/**"]);
    vol.fromJSON({
      "/tmp/template/.ziku/ziku.jsonc": `${JSON.stringify({ include: [".github/**"] }, null, 2)}\n`,
    });
    mockDetectUntrackedFiles.mockReturnValueOnce(untrackedDocsFile as never);
    mockSelectUntrackedToTrack.mockResolvedValueOnce(["docs/new.md"]);

    setupPushableFiles([{ path: "docs/new.md", type: "added", localContent: "# New doc" }]);
    mockSelectPushFiles.mockResolvedValueOnce([
      { path: "docs/new.md", type: "added", localContent: "# New doc" },
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
      files: { path: string; content: string }[];
    };
    // ファイル本体だけでなく ziku.jsonc も push される
    const configFile = prArg.files.find((f) => f.path === ".ziku/ziku.jsonc");
    expect(configFile).toBeDefined();
    const pushed = JSON.parse(configFile?.content as string);
    // 新規追跡パターンと既存パターンの両方が含まれる（union）
    expect(pushed.include).toContain("docs/new.md");
    expect(pushed.include).toContain(".github/**");
  });

  it("未追跡を1件も選択しなければ include は変化しない", async () => {
    seedZikuConfig();
    mockDetectUntrackedFiles.mockReturnValueOnce(untrackedDocsFile as never);
    mockSelectUntrackedToTrack.mockResolvedValueOnce([]);

    // 別の追跡済みファイルの変更だけを push する
    setupPushableFiles([{ path: "file.txt", type: "added", localContent: "content" }]);
    mockSelectPushFiles.mockResolvedValueOnce([
      { path: "file.txt", type: "added", localContent: "content" },
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
    mockSelectUntrackedToTrack.mockResolvedValueOnce(["docs/new.md"]);

    setupPushableFiles([{ path: "docs/new.md", type: "added", localContent: "# New doc" }]);
    mockSelectPushFiles.mockResolvedValueOnce([
      { path: "docs/new.md", type: "added", localContent: "# New doc" },
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
    mockSelectUntrackedToTrack.mockResolvedValueOnce(["docs/new.md"]);

    setupPushableFiles([{ path: "docs/new.md", type: "added", localContent: "# New doc" }]);
    mockSelectPushFiles.mockResolvedValueOnce([
      { path: "docs/new.md", type: "added", localContent: "# New doc" },
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
    mockSelectUntrackedToTrack.mockResolvedValueOnce(["docs/new.md"]);

    // docs/new.md（追跡候補）と safe.txt の両方が push 可能
    setupPushableFiles([
      { path: "docs/new.md", type: "added", localContent: "# New doc" },
      { path: "safe.txt", type: "added", localContent: "safe" },
    ]);
    // ユーザーはファイル選択で safe.txt のみ選び、docs/new.md は外す
    mockSelectPushFiles.mockResolvedValueOnce([
      { path: "safe.txt", type: "added", localContent: "safe" },
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
      { path: ".claude/skills/new-skill/SKILL.md", type: "added", localContent: "# skill" },
      {
        path: ".ziku/ziku.jsonc",
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
      files: { path: string; content: string }[];
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
      { path: ".claude/skills/new-skill/SKILL.md", type: "added", localContent: "# skill" },
      {
        path: ".ziku/ziku.jsonc",
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
      files: { path: string; content: string }[];
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
        path: ".ziku/ziku.jsonc",
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
      files: { path: string; content: string }[];
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
      { path: "docs/b.md", type: "added", localContent: "# doc b" },
      {
        path: ".ziku/ziku.jsonc",
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
