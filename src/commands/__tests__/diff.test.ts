import { vol } from "memfs";
import { Effect, Option } from "effect";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { FileNotFoundError } from "../../errors";
import type { AbsPath, CommitSha, GlobPattern, TemplateSource } from "../../modules/schemas";
import { createPendingLock, markSynced } from "../../modules/schemas";
import { absPath, globPatterns, repoRelPath, resolvedTemplate } from "../../__tests__/brands";

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
  hasDiff: vi.fn(),
}));

// utils/untracked をモック
vi.mock("../../utils/untracked", () => ({
  detectUntrackedFiles: vi.fn().mockResolvedValue([]),
  getTotalUntrackedCount: vi.fn().mockReturnValue(0),
}));

// ui/diff-view をモック
vi.mock("../../ui/diff-view", () => ({
  renderFileDiff: vi.fn(),
}));

// ui/renderer をモック
vi.mock("../../ui/renderer", () => ({
  intro: vi.fn(),
  outro: vi.fn(),
  log: {
    info: vi.fn(),
    success: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    step: vi.fn(),
    message: vi.fn(),
  },
  logDiffSummary: vi.fn(),
  withSpinner: vi.fn(async (_text: string, fn: () => Promise<unknown>) => fn()),
  pc: {
    cyan: vi.fn((s: string) => s),
    dim: vi.fn((s: string) => s),
  },
}));

// モック後にインポート
const { diffCommand } = await import("../diff");
const { loadCommandContext } = await import("../../services/command-context");
const { detectDiff, hasDiff } = await import("../../utils/diff");
const { detectUntrackedFiles } = await import("../../utils/untracked");
const { ZIKU_CONFIG_FILE } = await import("../../utils/ziku-config");
const { log, outro, logDiffSummary } = await import("../../ui/renderer");
const { renderFileDiff } = await import("../../ui/diff-view");

const mockLoadCommandContext = vi.mocked(loadCommandContext);
const mockDetectDiff = vi.mocked(detectDiff);
const mockDetectUntrackedFiles = vi.mocked(detectUntrackedFiles);
const mockHasDiff = vi.mocked(hasDiff);
const mockLog = vi.mocked(log);
const mockOutro = vi.mocked(outro);
const mockLogDiffSummary = vi.mocked(logDiffSummary);
const mockRenderFileDiff = vi.mocked(renderFileDiff);

/**
 * テスト用の CommandContext を生成するヘルパー。
 * DI のおかげでテンプレートダウンロードや設定読み込みのモックが不要。
 */
function mockContext(
  overrides?: Partial<{
    include: GlobPattern[];
    source: TemplateSource;
    templateDir: AbsPath;
    /** 前回の同期時点でテンプレートが宣言していたパターン。省略するとベース未確定の lock になる。 */
    basePatterns: readonly string[];
  }>,
) {
  const cleanup = vi.fn();
  const source: TemplateSource = overrides?.source ?? {
    kind: "github",
    owner: "tktcorporation",
    repo: ".github",
  };
  const pending = createPendingLock({
    version: "0.1.0",
    installedAt: "2024-01-01T00:00:00.000Z",
    source,
  });
  const lock =
    overrides?.basePatterns === undefined
      ? pending
      : markSynced(pending, {
          hashes: {},
          templatePatterns: { include: globPatterns(overrides.basePatterns), exclude: [] },
        });
  const templateDir = overrides?.templateDir ?? absPath("/tmp/template");
  return {
    effect: Effect.succeed({
      config: { include: overrides?.include ?? globPatterns([".root/**", ".github/**"]) },
      lock,
      source,
      resolved: resolvedTemplate({ source, dir: templateDir }),
      templateDir,
      cleanup,
      resolveBaseRef: Effect.succeed(Option.none<CommitSha>()),
    }),
    cleanup,
  };
}

const emptyDiff = {
  files: [],
};

describe("diffCommand", () => {
  beforeEach(() => {
    vol.reset();
    vi.clearAllMocks();
  });

  describe("meta", () => {
    it("コマンドメタデータが正しい", () => {
      expect((diffCommand.meta as { name: string }).name).toBe("diff");
      expect((diffCommand.meta as { description: string }).description).toBe(
        "Show differences between local and template",
      );
    });
  });

  describe("args", () => {
    it("dir 引数のデフォルト値は '.'", () => {
      const args = diffCommand.args as { dir: { default: string } };
      expect(args.dir.default).toBe(".");
    });

    it("verbose 引数のデフォルト値は false", () => {
      const args = diffCommand.args as { verbose: { default: boolean } };
      expect(args.verbose.default).toBe(false);
    });
  });

  describe("run", () => {
    it(".ziku/ziku.jsonc が存在しない場合は NotInitialized をスロー", async () => {
      mockLoadCommandContext.mockReturnValue(
        Effect.fail(new FileNotFoundError({ path: ".ziku/ziku.jsonc" })),
      );

      await expect(
        (diffCommand.run as any)({
          args: { dir: "/test", verbose: false },
          rawArgs: [],
          cmd: diffCommand,
        }),
      ).rejects.toMatchObject({
        _tag: "ZikuFailure",
        message: ".ziku/ziku.jsonc not found.",
        hint: "Run 'ziku init' first.",
        reason: { kind: "NotInitialized", path: ".ziku/ziku.jsonc" },
      });
    });

    it("patterns が空の場合は警告", async () => {
      const { effect } = mockContext({ include: [] });
      mockLoadCommandContext.mockReturnValue(effect);

      await (diffCommand.run as any)({
        args: { dir: "/test", verbose: false },
        rawArgs: [],
        cmd: diffCommand,
      });

      expect(mockLog.warn).toHaveBeenCalledWith("No patterns configured");
    });

    it("lock を書き変えない方針で読み込む", async () => {
      // diff は読むだけなので、既定ブランチの控えもディスクへ残さない（書き出すかの判断は
      // loadCommandContext が方針から決める）。
      const { effect } = mockContext();
      mockLoadCommandContext.mockReturnValue(effect);
      mockDetectDiff.mockResolvedValueOnce(emptyDiff);
      mockHasDiff.mockReturnValueOnce(false);

      await (diffCommand.run as any)({
        args: { dir: "/test", verbose: false },
        rawArgs: [],
        cmd: diffCommand,
      });

      expect(mockLoadCommandContext).toHaveBeenCalledWith(absPath("/test"), "readOnly");
    });

    it("差分がない場合は outro で完了メッセージ", async () => {
      const { effect } = mockContext();
      mockLoadCommandContext.mockReturnValue(effect);
      mockDetectDiff.mockResolvedValueOnce(emptyDiff);
      mockHasDiff.mockReturnValueOnce(false);

      await (diffCommand.run as any)({
        args: { dir: "/test", verbose: false },
        rawArgs: [],
        cmd: diffCommand,
      });

      expect(mockOutro).toHaveBeenCalledWith("No changes — in sync with template.");
    });

    it("未追跡探索は宣言されたパターンで走り、比較は制御ファイルを含む走査パターンで走る", async () => {
      const { effect } = mockContext();
      mockLoadCommandContext.mockReturnValue(effect);
      mockDetectDiff.mockResolvedValueOnce(emptyDiff);
      mockHasDiff.mockReturnValueOnce(false);

      await (diffCommand.run as any)({
        args: { dir: "/test", verbose: false },
        rawArgs: [],
        cmd: diffCommand,
      });

      // 未追跡探索も範囲全体を受け取る。探索の基点になるのはその中の宣言側で、走査パターンを
      // 基点にすると `.ziku` が基点になり、同期対象ではない `.ziku/lock.json` が追跡候補として
      // 提示される。
      expect(mockDetectUntrackedFiles).toHaveBeenCalledWith({
        targetDir: "/test",
        scope: expect.objectContaining({
          declared: expect.objectContaining({
            purpose: "declared",
            include: expect.not.arrayContaining([ZIKU_CONFIG_FILE]),
          }),
        }),
      });
      // 比較の側は制御ファイルを含む（落とすとパターンの追加が双方向に伝わらない）。
      expect(mockDetectDiff).toHaveBeenCalledWith(
        expect.objectContaining({
          scope: expect.objectContaining({
            scan: expect.objectContaining({
              include: expect.arrayContaining([ZIKU_CONFIG_FILE]),
            }),
          }),
        }),
      );
    });

    it("ローカルが外したパターンだけが理由の ziku.jsonc は、差分として見せない", async () => {
      // テキストは食い違うが、pull も push もこのファイルを書き換えない。見せると、実行しても
      // 何も起きない `ziku push` を勧めることになる。
      vol.fromJSON({
        "/test/.ziku/ziku.jsonc": JSON.stringify({ include: ["docs/*.md"] }),
        "/tmp/template/.ziku/ziku.jsonc": JSON.stringify({
          include: ["docs/*.md", "hooks/*.sh"],
        }),
      });
      const { effect } = mockContext({ basePatterns: ["docs/*.md", "hooks/*.sh"] });
      mockLoadCommandContext.mockReturnValue(effect);
      mockDetectDiff.mockResolvedValueOnce({
        files: [
          {
            path: repoRelPath(ZIKU_CONFIG_FILE),
            type: "modified",
            localContent: "local",
            templateContent: "template",
          },
        ],
      });
      mockHasDiff.mockImplementation((diff: { files: unknown[] }) => diff.files.length > 0);

      await (diffCommand.run as any)({
        args: { dir: "/test", verbose: false },
        rawArgs: [],
        cmd: diffCommand,
      });

      expect(mockOutro).toHaveBeenCalledWith("No changes — in sync with template.");
    });

    it("差分がある場合は logDiffSummary を呼ぶ", async () => {
      const { effect } = mockContext();
      mockLoadCommandContext.mockReturnValue(effect);

      const diffWithChanges = {
        files: [
          { path: repoRelPath("new-file.txt"), type: "added" as const, localContent: "content" },
        ],
      };
      mockDetectDiff.mockResolvedValueOnce(diffWithChanges);
      mockHasDiff.mockReturnValueOnce(true);

      await (diffCommand.run as any)({
        args: { dir: "/test", verbose: false },
        rawArgs: [],
        cmd: diffCommand,
      });

      expect(mockLogDiffSummary).toHaveBeenCalledWith(diffWithChanges.files);
      expect(mockOutro).toHaveBeenCalledWith("Run 'ziku push' to push changes.");
    });

    it("cleanup が成功時にも失敗時にも呼ばれる", async () => {
      const { effect, cleanup } = mockContext();
      mockLoadCommandContext.mockReturnValue(effect);
      mockDetectDiff.mockResolvedValueOnce(emptyDiff);
      mockHasDiff.mockReturnValueOnce(false);

      await (diffCommand.run as any)({
        args: { dir: "/test", verbose: false },
        rawArgs: [],
        cmd: diffCommand,
      });

      expect(cleanup).toHaveBeenCalled();
    });

    it("lock.source からテンプレートソースを構築", async () => {
      const { effect } = mockContext({
        source: { kind: "github", owner: "custom-org", repo: "custom-templates" },
        templateDir: absPath("/tmp/custom-template"),
      });
      mockLoadCommandContext.mockReturnValue(effect);
      mockDetectDiff.mockResolvedValueOnce(emptyDiff);
      mockHasDiff.mockReturnValueOnce(false);

      await (diffCommand.run as any)({
        args: { dir: "/test", verbose: false },
        rawArgs: [],
        cmd: diffCommand,
      });

      // loadCommandContext が呼ばれる（テンプレート解決は内部で完了）
      expect(mockLoadCommandContext).toHaveBeenCalledWith(expect.any(String), "readOnly");
    });

    it("エラー時も cleanup が呼ばれる", async () => {
      const { effect, cleanup } = mockContext();
      mockLoadCommandContext.mockReturnValue(effect);
      mockDetectDiff.mockRejectedValueOnce(new Error("Diff error"));

      await expect(
        (diffCommand.run as any)({
          args: { dir: "/test", verbose: false },
          rawArgs: [],
          cmd: diffCommand,
        }),
      ).rejects.toThrow("Diff error");

      expect(cleanup).toHaveBeenCalled();
    });

    it("--verbose のとき renderFileDiff を各変更ファイルに対して呼ぶ", async () => {
      const { effect } = mockContext();
      mockLoadCommandContext.mockReturnValue(effect);

      const diffWithChanges = {
        files: [
          { path: repoRelPath("new-file.txt"), type: "added" as const, localContent: "content" },
        ],
      };
      mockDetectDiff.mockResolvedValueOnce(diffWithChanges);
      mockHasDiff.mockReturnValueOnce(true);

      await (diffCommand.run as any)({
        args: { dir: "/test", verbose: true },
        rawArgs: [],
        cmd: diffCommand,
      });

      expect(mockRenderFileDiff).toHaveBeenCalledWith(diffWithChanges.files[0]);
    });

    it("--verbose なしのとき renderFileDiff を呼ばない", async () => {
      const { effect } = mockContext();
      mockLoadCommandContext.mockReturnValue(effect);

      const diffWithChanges = {
        files: [
          { path: repoRelPath("new-file.txt"), type: "added" as const, localContent: "content" },
        ],
      };
      mockDetectDiff.mockResolvedValueOnce(diffWithChanges);
      mockHasDiff.mockReturnValueOnce(true);

      await (diffCommand.run as any)({
        args: { dir: "/test", verbose: false },
        rawArgs: [],
        cmd: diffCommand,
      });

      expect(mockRenderFileDiff).not.toHaveBeenCalled();
    });

    it("--verbose のとき変更ファイルのみ renderFileDiff を呼び、unchanged はスキップ", async () => {
      const { effect } = mockContext();
      mockLoadCommandContext.mockReturnValue(effect);

      const unchangedFile = {
        path: repoRelPath("unchanged.txt"),
        type: "unchanged" as const,
        localContent: "same",
        templateContent: "same",
      };
      const addedFile = {
        path: repoRelPath("added.txt"),
        type: "added" as const,
        localContent: "new",
      };
      const modifiedFile = {
        path: repoRelPath("modified.txt"),
        type: "modified" as const,
        localContent: "changed",
        templateContent: "original",
      };

      const diffWithMixed = {
        files: [addedFile, unchangedFile, modifiedFile],
      };
      mockDetectDiff.mockResolvedValueOnce(diffWithMixed);
      mockHasDiff.mockReturnValueOnce(true);

      await (diffCommand.run as any)({
        args: { dir: "/test", verbose: true },
        rawArgs: [],
        cmd: diffCommand,
      });

      expect(mockRenderFileDiff).toHaveBeenCalledTimes(2);
      expect(mockRenderFileDiff).toHaveBeenCalledWith(addedFile);
      expect(mockRenderFileDiff).toHaveBeenCalledWith(modifiedFile);
      expect(mockRenderFileDiff).not.toHaveBeenCalledWith(unchangedFile);
    });
  });
});
