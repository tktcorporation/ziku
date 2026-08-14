import { vol } from "memfs";
import { Effect, Option } from "effect";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { FileNotFoundError, ZikuFailure } from "../../errors";
import type { FileCategory, FileClassification } from "../../utils/merge/types";
import type { SyncPlan } from "../../utils/merge/sync-plan";
import type {
  PendingConflicts,
  LockState,
  ResumableLockState,
  TemplateSource,
  CommitSha,
  GlobPattern,
} from "../../modules/schemas";
import { markMerging } from "../../modules/schemas";
import {
  absPath,
  globPatterns,
  pendingConflict,
  repoRelPath,
  repoRelPaths,
  syncScope,
} from "../../__tests__/brands";

// fs モジュールをモック
vi.mock("node:fs", async () => {
  const memfs = await import("memfs");
  return memfs.fs;
});

vi.mock("node:fs/promises", async () => {
  const memfs = await import("memfs");
  return memfs.fs.promises;
});

// loadCommandContext をモック（diff.test.ts と同じ DI パターン）
vi.mock("../../services/command-context", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../../services/command-context")>();
  return {
    ...actual,
    loadCommandContext: vi.fn(),
  };
});

// utils/sync-analysis をモック (実 I/O を避ける)
vi.mock("../../utils/sync-analysis", () => ({
  analyzeSync: vi.fn(),
}));

// 走査範囲の解決をモック (実 I/O を避ける)。範囲の解決規則そのものは
// sync-scope の単体テストと、コマンドをまたぐ回帰テストが持つ。
vi.mock("../../utils/sync-scope", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../../utils/sync-scope")>();
  return { ...actual, resolveSyncScope: vi.fn() };
});

// utils/lock をモック (fast-path で読まれる)。
// デフォルトは ENOENT 相当: status が loadLock に失敗 → fast-path をスルーして
// 通常の loadCommandContext 経路に進む (= 既存テストの挙動と互換)。
vi.mock("../../utils/lock", () => ({
  loadLock: vi.fn(),
  LOCK_FILE: ".ziku/lock.json",
}));

// utils/ziku-config をモック (fast-path の整合性チェックで呼ばれる)。
// デフォルトは false: config 未作成相当 → fast-path をスルーして既存テストと互換。
vi.mock("../../utils/ziku-config", () => ({
  zikuConfigExists: vi.fn().mockReturnValue(false),
  ZIKU_CONFIG_FILE: ".ziku/ziku.jsonc",
}));

// utils/untracked をモック
vi.mock("../../utils/untracked", () => ({
  detectUntrackedFiles: vi.fn().mockResolvedValue([]),
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
  withSpinner: vi.fn(async (_text: string, fn: () => Promise<unknown>) => fn()),
  pc: {
    cyan: vi.fn((s: string) => s),
    dim: vi.fn((s: string) => s),
    green: vi.fn((s: string) => s),
    red: vi.fn((s: string) => s),
    yellow: vi.fn((s: string) => s),
    bold: vi.fn((s: string) => s),
  },
}));

// モック後にインポート
const { statusCommand } = await import("../status");
const { loadCommandContext } = await import("../../services/command-context");
const { analyzeSync } = await import("../../utils/sync-analysis");
const { resolveSyncScope } = await import("../../utils/sync-scope");
const { detectUntrackedFiles } = await import("../../utils/untracked");
const { loadLock } = await import("../../utils/lock");
const { zikuConfigExists } = await import("../../utils/ziku-config");
const { log, outro } = await import("../../ui/renderer");

const mockLoadCommandContext = vi.mocked(loadCommandContext);
const mockAnalyzeSync = vi.mocked(analyzeSync);
const mockResolveSyncScope = vi.mocked(resolveSyncScope);
const mockDetectUntrackedFiles = vi.mocked(detectUntrackedFiles);
const mockLoadLock = vi.mocked(loadLock);
const mockZikuConfigExists = vi.mocked(zikuConfigExists);
const mockLog = vi.mocked(log);
const mockOutro = vi.mocked(outro);

/**
 * テスト用の SyncPlan。ziku.jsonc は analyzeSync の分類に現れない前提
 * （status は drift から入れるバケツを決めるため、plan.config は Untracked で足りる）。
 */
function syncPlanOf(files: FileClassification): SyncPlan {
  return { files, config: { _tag: "Untracked" } };
}

/**
 * ziku.jsonc だけが分類に現れた SyncPlan。ファイル差分はゼロなので、status の推奨は
 * ziku.jsonc の扱いだけで決まる。
 */
function trackedConfigPlan(category: FileCategory): SyncPlan {
  return { files: emptyClassification(), config: { _tag: "Tracked", category } };
}

/** drift 判定が読むローカル / テンプレートの ziku.jsonc を置く。 */
function writeConfigs(patterns: { local: string[]; template: string[] }): void {
  vol.fromJSON({
    "/test/.ziku/ziku.jsonc": JSON.stringify({ include: patterns.local }, null, 2),
    "/tmp/template/.ziku/ziku.jsonc": JSON.stringify({ include: patterns.template }, null, 2),
  });
}

/** テスト用の空 FileClassification */
function emptyClassification(): FileClassification {
  return {
    autoUpdate: [],
    localOnly: [],
    conflicts: [],
    newFiles: [],
    deletedFiles: [],
    deletedWithLocalEdits: [],
    deletedLocally: [],
    unchanged: [],
  };
}

/** テスト用 CommandContext */
const testSource: TemplateSource = { kind: "github", owner: "tktcorporation", repo: ".github" };

const pendingLock: ResumableLockState = {
  version: "0.1.0",
  installedAt: "2024-01-01T00:00:00.000Z",
  source: testSource,
  sync: "pending",
};

/**
 * status が投げた `ZikuFailure` を取り出す。
 *
 * 失敗の検証は理由 (`reason.kind`) とユーザー向けの文言で行う。例外のクラスだけを見ると、
 * 別の失敗にすり替わっても気付けない。
 */
async function captureFailure(run: () => Promise<unknown>): Promise<ZikuFailure> {
  const thrown = await run().then(
    () => undefined,
    (e: unknown) => e,
  );
  expect(thrown).toBeInstanceOf(ZikuFailure);
  return thrown as ZikuFailure;
}

/** コンフリクト解決待ちのロックを作る。 */
function mergingLock(conflicts: PendingConflicts): LockState {
  return markMerging(pendingLock, { hashes: {} }, conflicts);
}

function mockContext(
  overrides: Partial<{
    include: GlobPattern[];
    lock: LockState;
  }> = {},
) {
  const cleanup = vi.fn();
  return {
    effect: Effect.succeed({
      config: { include: overrides.include ?? globPatterns([".claude/**"]) },
      lock: overrides.lock ?? pendingLock,
      source: testSource,
      templateDir: absPath("/tmp/template"),
      cleanup,
      resolveBaseRef: Effect.succeed(Option.none<CommitSha>()),
    }),
    cleanup,
  };
}

describe("statusCommand", () => {
  beforeEach(() => {
    vol.reset();
    vi.clearAllMocks();
    // デフォルト: テンプレ側にパターン追加なし (P1 fix の no-op パス)
    mockResolveSyncScope.mockResolvedValue({
      scope: syncScope({ include: [".claude/**", ".ziku/ziku.jsonc"] }),
      newInclude: [],
    });
    // デフォルト: lock 未作成相当 (fast-path をスキップし、通常の loadCommandContext 経路に進む)
    mockLoadLock.mockReturnValue(Effect.fail(new FileNotFoundError({ path: ".ziku/lock.json" })));
    // デフォルト: config 未作成相当 (fast-path をスキップ)
    mockZikuConfigExists.mockReturnValue(false);
  });

  describe("meta", () => {
    it("コマンドメタデータが正しい", () => {
      expect((statusCommand.meta as { name: string }).name).toBe("status");
      expect((statusCommand.meta as { description: string }).description).toContain("pull/push");
    });
  });

  describe("args", () => {
    it("dir 引数のデフォルト値は '.'", () => {
      const args = statusCommand.args as { dir: { default: string } };
      expect(args.dir.default).toBe(".");
    });

    it("--short / --exit-code フラグは存在しない（YAGNI で削除済み）", () => {
      const args = statusCommand.args as Record<string, unknown>;
      expect(args.short).toBeUndefined();
      expect(args["exit-code"]).toBeUndefined();
    });
  });

  describe("run", () => {
    it("解決待ちがあれば fast-path で template fetch せずに案内する", async () => {
      // 解決待ち中はネットワーク不通でも
      // status が "pull --continue" を案内できるべき。lock を local だけで読んで
      // 早期 return することで、loadCommandContext (= template download) を回避する。
      mockZikuConfigExists.mockReturnValue(true);
      mockLoadLock.mockReturnValueOnce(
        Effect.succeed(
          mergingLock([pendingConflict(".claude/settings.json"), pendingConflict(".mcp.json")]),
        ),
      );
      // loadCommandContext は失敗するように設定 (template 取得不可をシミュレート)
      const { TemplateError } = await import("../../errors");
      mockLoadCommandContext.mockReturnValue(
        Effect.fail(new TemplateError({ message: "network unreachable" })),
      );

      // biome-ignore lint/suspicious/noExplicitAny: citty run signature
      await (statusCommand.run as any)({
        args: { dir: "/test" },
        rawArgs: [],
        cmd: statusCommand,
      });

      // テンプレ取得が呼ばれない (fast-path で先に return)
      expect(mockLoadCommandContext).not.toHaveBeenCalled();
      // outro で pull --continue を案内
      const outroArg = mockOutro.mock.calls.at(-1)?.[0] ?? "";
      expect(outroArg).toContain("ziku pull --continue");
      expect(outroArg).toContain("2");
      // conflict 一覧も表示される
      const messageCalls = mockLog.message.mock.calls.flat().join("\n");
      expect(messageCalls).toContain(".claude/settings.json");
      expect(messageCalls).toContain(".mcp.json");
    });

    it("ziku.jsonc が無い場合は fast-path をスキップして通常エラー経路に流す", async () => {
      // lock.json は残っているが ziku.jsonc が
      // 削除/破損している半壊状態で fast-path に入ると、
      // "pull --continue を実行して" と案内するが pull --continue は zikuConfigExists で
      // "Not initialized" を出して失敗する。動かない命令を出さないために、
      // fast-path 内でも config 存在を前提条件として確認する。
      mockZikuConfigExists.mockReturnValue(false);
      mockLoadLock.mockReturnValueOnce(Effect.succeed(mergingLock([pendingConflict("foo.txt")])));
      mockLoadCommandContext.mockReturnValue(
        Effect.fail(new FileNotFoundError({ path: ".ziku/ziku.jsonc" })),
      );

      const failure = await captureFailure(() =>
        // biome-ignore lint/suspicious/noExplicitAny: citty run signature
        (statusCommand.run as any)({
          args: { dir: "/test" },
          rawArgs: [],
          cmd: statusCommand,
        }),
      );
      expect(failure.reason).toEqual({ kind: "NotInitialized", path: ".ziku/ziku.jsonc" });

      // fast-path を踏まないので outro での "pull --continue" 案内は出ない
      const outroCalls = mockOutro.mock.calls.flat().join("\n");
      expect(outroCalls).not.toContain("ziku pull --continue");
      // 通常経路で loadCommandContext が呼ばれてエラーが伝播
      expect(mockLoadCommandContext).toHaveBeenCalled();
    });

    it("loadCommandContext 失敗時は理由付きの失敗をスロー", async () => {
      mockLoadCommandContext.mockReturnValue(
        Effect.fail(new FileNotFoundError({ path: ".ziku/ziku.jsonc" })),
      );

      const failure = await captureFailure(() =>
        // biome-ignore lint/suspicious/noExplicitAny: citty run signature
        (statusCommand.run as any)({
          args: { dir: "/test" },
          rawArgs: [],
          cmd: statusCommand,
        }),
      );

      expect(failure.reason).toEqual({ kind: "NotInitialized", path: ".ziku/ziku.jsonc" });
      expect(failure.hint).toContain("ziku init");
    });

    it("patterns が空の場合は警告 + outro 'Nothing to compare.'", async () => {
      const { effect, cleanup } = mockContext({ include: [] });
      mockLoadCommandContext.mockReturnValue(effect);

      // biome-ignore lint/suspicious/noExplicitAny: citty run signature
      await (statusCommand.run as any)({
        args: { dir: "/test" },
        rawArgs: [],
        cmd: statusCommand,
      });

      expect(mockLog.warn).toHaveBeenCalledWith("No patterns configured");
      expect(mockOutro).toHaveBeenCalledWith("Nothing to compare.");
      expect(cleanup).toHaveBeenCalled();
    });

    it("完全 in-sync のとき outro に 'In sync' のメッセージを渡す", async () => {
      const { effect, cleanup } = mockContext();
      mockLoadCommandContext.mockReturnValue(effect);
      mockAnalyzeSync.mockResolvedValueOnce({
        plan: syncPlanOf(emptyClassification()),
        hashes: { baseHashes: {}, localHashes: {}, templateHashes: {} },
      });

      // biome-ignore lint/suspicious/noExplicitAny: citty run signature
      await (statusCommand.run as any)({
        args: { dir: "/test" },
        rawArgs: [],
        cmd: statusCommand,
      });

      // log.message で renderStatusLong の出力（"in sync" 含む）
      expect(mockLog.message).toHaveBeenCalled();
      // outro で recommendationLine の "In sync" メッセージ
      const outroArg = mockOutro.mock.calls.at(-1)?.[0] ?? "";
      expect(outroArg).toContain("In sync");
      expect(cleanup).toHaveBeenCalled();
    });

    it("pull だけ pending のとき outro に 'ziku pull' を含むメッセージ", async () => {
      const { effect } = mockContext();
      mockLoadCommandContext.mockReturnValue(effect);
      mockAnalyzeSync.mockResolvedValueOnce({
        plan: syncPlanOf({ ...emptyClassification(), autoUpdate: repoRelPaths(["a.txt"]) }),
        hashes: { baseHashes: {}, localHashes: {}, templateHashes: {} },
      });

      // biome-ignore lint/suspicious/noExplicitAny: citty run signature
      await (statusCommand.run as any)({
        args: { dir: "/test" },
        rawArgs: [],
        cmd: statusCommand,
      });

      const outroArg = mockOutro.mock.calls.at(-1)?.[0] ?? "";
      expect(outroArg).toContain("ziku pull");
    });

    it("push だけ pending のとき outro に 'ziku push' を含むメッセージ", async () => {
      const { effect } = mockContext();
      mockLoadCommandContext.mockReturnValue(effect);
      mockAnalyzeSync.mockResolvedValueOnce({
        plan: syncPlanOf({ ...emptyClassification(), localOnly: repoRelPaths(["b.txt"]) }),
        hashes: { baseHashes: {}, localHashes: {}, templateHashes: {} },
      });

      // biome-ignore lint/suspicious/noExplicitAny: citty run signature
      await (statusCommand.run as any)({
        args: { dir: "/test" },
        rawArgs: [],
        cmd: statusCommand,
      });

      const outroArg = mockOutro.mock.calls.at(-1)?.[0] ?? "";
      expect(outroArg).toContain("ziku push");
    });

    it("コンフリクト解決待ちの場合は outro に 'pull --continue'", async () => {
      // nextBase の中身は decideRecommendation の分岐に影響しないため空で十分。
      // 解決待ちであること自体が continueMerge を発火させる。
      const { effect } = mockContext({
        lock: mergingLock([pendingConflict("c.txt")]),
      });
      mockLoadCommandContext.mockReturnValue(effect);
      mockAnalyzeSync.mockResolvedValueOnce({
        plan: syncPlanOf(emptyClassification()),
        hashes: { baseHashes: {}, localHashes: {}, templateHashes: {} },
      });

      // biome-ignore lint/suspicious/noExplicitAny: citty run signature
      await (statusCommand.run as any)({
        args: { dir: "/test" },
        rawArgs: [],
        cmd: statusCommand,
      });

      const outroArg = mockOutro.mock.calls.at(-1)?.[0] ?? "";
      expect(outroArg).toContain("ziku pull --continue");
    });

    it("pull + push 両方 pending のとき outro に 'ziku pull' と 'ziku push' を含む (pullThenPush パイプライン)", async () => {
      const { effect } = mockContext();
      mockLoadCommandContext.mockReturnValue(effect);
      mockAnalyzeSync.mockResolvedValueOnce({
        plan: syncPlanOf({
          ...emptyClassification(),
          autoUpdate: repoRelPaths(["a.txt"]),
          localOnly: repoRelPaths(["b.txt"]),
        }),
        hashes: { baseHashes: {}, localHashes: {}, templateHashes: {} },
      });

      // biome-ignore lint/suspicious/noExplicitAny: citty run signature
      await (statusCommand.run as any)({
        args: { dir: "/test" },
        rawArgs: [],
        cmd: statusCommand,
      });

      const outroArg = mockOutro.mock.calls.at(-1)?.[0] ?? "";
      expect(outroArg).toContain("ziku pull");
      expect(outroArg).toContain("ziku push");
    });

    it("conflict あり (解決待ちなし) のとき outro に merge 開始の案内", async () => {
      const { effect } = mockContext();
      mockLoadCommandContext.mockReturnValue(effect);
      mockAnalyzeSync.mockResolvedValueOnce({
        plan: syncPlanOf({ ...emptyClassification(), conflicts: repoRelPaths(["c.txt"]) }),
        hashes: { baseHashes: {}, localHashes: {}, templateHashes: {} },
      });

      // biome-ignore lint/suspicious/noExplicitAny: citty run signature
      await (statusCommand.run as any)({
        args: { dir: "/test" },
        rawArgs: [],
        cmd: statusCommand,
      });

      const outroArg = mockOutro.mock.calls.at(-1)?.[0] ?? "";
      expect(outroArg).toContain("ziku pull");
      expect(outroArg).toContain("merge");
    });

    it("テンプレートがパターンを追加したとき outro は pull（ファイル差分がゼロでも ziku.jsonc を数える）", async () => {
      const { effect } = mockContext();
      mockLoadCommandContext.mockReturnValue(effect);
      // 新パターンに該当するファイルは無く、差分は ziku.jsonc 自体だけ。
      mockResolveSyncScope.mockResolvedValueOnce({
        scope: syncScope({ include: [".claude/**", ".new-pattern/**", ".ziku/ziku.jsonc"] }),
        newInclude: globPatterns([".new-pattern/**"]),
      });
      writeConfigs({ local: [".claude/**"], template: [".claude/**", ".new-pattern/**"] });
      mockAnalyzeSync.mockResolvedValueOnce({
        plan: trackedConfigPlan("autoUpdate"),
        hashes: { baseHashes: {}, localHashes: {}, templateHashes: {} },
      });

      // biome-ignore lint/suspicious/noExplicitAny: citty run signature
      await (statusCommand.run as any)({
        args: { dir: "/test" },
        rawArgs: [],
        cmd: statusCommand,
      });

      const outroArg = mockOutro.mock.calls.at(-1)?.[0] ?? "";
      // pull を推奨する（in sync や push にならない）。pull は union をローカルへ書き込む。
      expect(outroArg).toContain("ziku pull");
      expect(outroArg).toContain("1 incoming change");
      expect(outroArg).not.toContain("In sync");
    });

    it("テンプレートがパターンを削除しローカルが未変更なら outro は in sync（push も pull も送るものが無い）", async () => {
      const { effect } = mockContext();
      mockLoadCommandContext.mockReturnValue(effect);
      // テンプレートが `.old/**` を削除。ローカルは保持したまま。
      writeConfigs({ local: [".claude/**", ".old/**"], template: [".claude/**"] });
      mockAnalyzeSync.mockResolvedValueOnce({
        plan: trackedConfigPlan("autoUpdate"),
        hashes: { baseHashes: {}, localHashes: {}, templateHashes: {} },
      });

      // biome-ignore lint/suspicious/noExplicitAny: citty run signature
      await (statusCommand.run as any)({
        args: { dir: "/test" },
        rawArgs: [],
        cmd: statusCommand,
      });

      const outroArg = mockOutro.mock.calls.at(-1)?.[0] ?? "";
      expect(outroArg).toContain("In sync");
    });

    it("ローカルがパターンを削除しテンプレートが未変更でも outro は in sync（pull は削除を巻き戻さない）", async () => {
      const { effect } = mockContext();
      mockLoadCommandContext.mockReturnValue(effect);
      // ローカルが `.old/**` を削除。テンプレートは保持したまま。
      writeConfigs({ local: [".claude/**"], template: [".claude/**", ".old/**"] });
      mockAnalyzeSync.mockResolvedValueOnce({
        plan: trackedConfigPlan("localOnly"),
        hashes: { baseHashes: {}, localHashes: {}, templateHashes: {} },
      });

      // biome-ignore lint/suspicious/noExplicitAny: citty run signature
      await (statusCommand.run as any)({
        args: { dir: "/test" },
        rawArgs: [],
        cmd: statusCommand,
      });

      const outroArg = mockOutro.mock.calls.at(-1)?.[0] ?? "";
      expect(outroArg).toContain("In sync");
    });

    it("解決した走査範囲をそのまま比較と未追跡探索へ渡し、テンプレ側の新パターンを通知する", async () => {
      const { effect } = mockContext();
      mockLoadCommandContext.mockReturnValue(effect);
      const scope = syncScope({
        include: [".claude/**", ".new-feature/**", ".ziku/ziku.jsonc"],
      });
      mockResolveSyncScope.mockResolvedValueOnce({
        scope,
        newInclude: globPatterns([".new-feature/**"]),
      });
      mockAnalyzeSync.mockResolvedValueOnce({
        plan: syncPlanOf(emptyClassification()),
        hashes: { baseHashes: {}, localHashes: {}, templateHashes: {} },
      });

      // biome-ignore lint/suspicious/noExplicitAny: citty run signature
      await (statusCommand.run as any)({
        args: { dir: "/test" },
        rawArgs: [],
        cmd: statusCommand,
      });

      // 比較の範囲と未追跡探索の範囲が食い違うと、status が数えた push 候補を push が
      // 送れない。同じ範囲から両方を導いていることを、渡した値そのもので確かめる。
      expect(mockAnalyzeSync).toHaveBeenCalledWith(expect.objectContaining({ scope }));
      expect(mockDetectUntrackedFiles).toHaveBeenCalledWith(
        expect.objectContaining({ patterns: scope.declared }),
      );
      // ユーザー向けの新パターン通知
      const infoCalls = mockLog.info.mock.calls.flat().join(" ");
      expect(infoCalls).toContain("Template added 1 new pattern");
    });

    it("untracked がある場合は detectUntrackedFiles の結果が描画される", async () => {
      const { effect } = mockContext();
      mockLoadCommandContext.mockReturnValue(effect);
      mockAnalyzeSync.mockResolvedValueOnce({
        plan: syncPlanOf(emptyClassification()),
        hashes: { baseHashes: {}, localHashes: {}, templateHashes: {} },
      });
      mockDetectUntrackedFiles.mockResolvedValueOnce([
        {
          folder: "x",
          files: [{ path: repoRelPath(".claude/rules/draft.md"), folder: "x" }],
        },
      ]);

      // biome-ignore lint/suspicious/noExplicitAny: citty run signature
      await (statusCommand.run as any)({
        args: { dir: "/test" },
        rawArgs: [],
        cmd: statusCommand,
      });

      const messageCalls = mockLog.message.mock.calls.flat().join("\n");
      expect(messageCalls).toContain(".claude/rules/draft.md");
    });

    it("analyzeSync が throw しても cleanup は呼ばれる (Effect.ensuring 経由)", async () => {
      const { effect, cleanup } = mockContext();
      mockLoadCommandContext.mockReturnValue(effect);
      mockAnalyzeSync.mockRejectedValueOnce(new Error("hash failure"));

      await expect(
        // biome-ignore lint/suspicious/noExplicitAny: citty run signature
        (statusCommand.run as any)({
          args: { dir: "/test" },
          rawArgs: [],
          cmd: statusCommand,
        }),
      ).rejects.toThrow("hash failure");

      expect(cleanup).toHaveBeenCalled();
    });
  });
});
