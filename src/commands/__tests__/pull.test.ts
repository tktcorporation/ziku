import { vol } from "memfs";
import { Effect, Option } from "effect";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { ZikuError, FileNotFoundError } from "../../errors";

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

vi.mock("../../utils/template", () => ({
  downloadTemplateToTemp: vi.fn(),
  buildTemplateSource: vi.fn(
    (source: { owner: string; repo: string }) => `gh:${source.owner}/${source.repo}`,
  ),
}));

// --continue モードで直接使われるため、モックが引き続き必要
vi.mock("../../utils/ziku-config", () => ({
  ZIKU_CONFIG_FILE: ".ziku/ziku.jsonc",
  loadZikuConfig: vi.fn(),
  zikuConfigExists: vi.fn(),
  saveZikuConfig: vi.fn(),
  generateZikuJsonc: vi.fn((c: any) => JSON.stringify(c)),
}));

vi.mock("../../utils/lock", () => ({
  LOCK_FILE: ".ziku/lock.json",
  loadLock: vi.fn(),
  saveLock: vi.fn(),
}));

vi.mock("../../utils/hash", () => ({
  hashFiles: vi.fn(),
}));

vi.mock("../../utils/merge", async () => {
  const effectMod = await import("effect");
  const fsMod = await import("node:fs/promises");
  const errorsMod = await import("../../errors");
  return {
    classifyFiles: vi.fn(),
    hasConflictMarkers: vi.fn((content: string) => ({
      found: content.includes("<<<<<<<"),
      lines: [],
    })),
    // conflict-io の共通ユーティリティ（pull.ts はこれらを経由して merge する）
    readFileSafe: vi.fn((path: string) =>
      effectMod.Effect.tryPromise(() => fsMod.readFile(path, "utf-8")).pipe(
        effectMod.Effect.catchAll(() =>
          effectMod.Effect.fail(new errorsMod.FileNotFoundError({ path })),
        ),
      ),
    ),
    mergeOneFile: vi.fn(),
    writeFileEnsureDir: vi.fn(() => effectMod.Effect.succeed(undefined)),
    downloadBaseForMerge: vi.fn(() => effectMod.Effect.succeed(null)),
  };
});

vi.mock("../../utils/github", () => ({
  resolveLatestCommitSha: vi.fn(() => Promise.resolve("latest123")),
}));

vi.mock("../../utils/template-config", async () => {
  const effectMod = await import("effect");
  const errorsMod = await import("../../errors");
  return {
    // デフォルト: テンプレートに ziku.jsonc がない → Effect.option で None になる
    loadTemplateConfig: vi.fn(() =>
      effectMod.Effect.fail(
        new errorsMod.TemplateNotConfiguredError({ templateDir: "/tmp/template" }),
      ),
    ),
  };
});

vi.mock("../../ui/prompts", () => ({
  selectDeletedFiles: vi.fn(),
}));

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
  pc: {
    cyan: (s: string) => s,
    green: (s: string) => s,
    yellow: (s: string) => s,
    red: (s: string) => s,
    bold: (s: string) => s,
    dim: (s: string) => s,
  },
  withSpinner: vi.fn(async (_text: string, fn: () => Promise<unknown>) => fn()),
}));

// モック後にインポート
const { pullCommand } = await import("../pull");
const { loadCommandContext } = await import("../../services/command-context");
const { selectDeletedFiles } = await import("../../ui/prompts");
const mockSelectDeletedFiles = vi.mocked(selectDeletedFiles);
const { downloadTemplateToTemp } = await import("../../utils/template");
const { zikuConfigExists } = await import("../../utils/ziku-config");
const { loadLock, saveLock } = await import("../../utils/lock");
const { hashFiles } = await import("../../utils/hash");
const { classifyFiles, mergeOneFile, writeFileEnsureDir, downloadBaseForMerge } =
  await import("../../utils/merge");
const { log } = await import("../../ui/renderer");

const mockLoadCommandContext = vi.mocked(loadCommandContext);
const mockDownloadTemplateToTemp = vi.mocked(downloadTemplateToTemp);
const mockZikuConfigExists = vi.mocked(zikuConfigExists);
const mockLoadLock = vi.mocked(loadLock);
const mockSaveLock = vi.mocked(saveLock);
const mockHashFiles = vi.mocked(hashFiles);
const mockClassifyFiles = vi.mocked(classifyFiles);
const mockMergeOneFile = vi.mocked(mergeOneFile);
const mockWriteFileEnsureDir = vi.mocked(writeFileEnsureDir);
const mockDownloadBaseForMerge = vi.mocked(downloadBaseForMerge);
const mockLog = vi.mocked(log);

const baseZikuConfig = {
  include: [".mcp.json", ".mise.toml"],
  exclude: [],
};

const baseLock = {
  version: "0.1.0",
  installedAt: "2024-01-01T00:00:00.000Z",
  source: { owner: "tktcorporation", repo: ".github" },
  baseHashes: { ".mcp.json": "abc123" },
};

/**
 * テスト用の CommandContext を生成するヘルパー。
 * 通常モード（--continue 以外）で loadCommandContext の戻り値として使う。
 */
function mockContext(overrides?: {
  config?: { include: string[]; exclude?: string[] };
  lock?: typeof baseLock & Record<string, unknown>;
  source?: { owner: string; repo: string };
  templateDir?: string;
  resolveBaseRef?: Effect.Effect<Option.Option<string>>;
}) {
  const cleanup = vi.fn();
  const source = overrides?.source ?? { owner: "tktcorporation", repo: ".github" };
  return {
    effect: Effect.succeed({
      config: overrides?.config ?? baseZikuConfig,
      lock: overrides?.lock ?? baseLock,
      source,
      templateDir: overrides?.templateDir ?? "/tmp/template",
      cleanup,
      resolveBaseRef: overrides?.resolveBaseRef ?? Effect.succeed(Option.none<string>()),
    }),
    cleanup,
  };
}

/**
 * mergeOneFile の mock を設定するヘルパー。
 * file 名と MergeResult を受け取り、Effect.succeed を返す。
 */
function mockMergeResult(file: string, content: string, hasConflicts: boolean) {
  mockMergeOneFile.mockReturnValueOnce(Effect.succeed({ file, content, hasConflicts }));
}

describe("pullCommand", () => {
  beforeEach(() => {
    vol.reset();
    vi.clearAllMocks();

    // 通常モードのデフォルト: 正常な CommandContext を返す
    const { effect } = mockContext();
    mockLoadCommandContext.mockReturnValue(effect);

    // --continue モード用のデフォルト
    mockZikuConfigExists.mockReturnValue(true);
    mockLoadLock.mockResolvedValue(baseLock as any);

    mockDownloadTemplateToTemp.mockResolvedValue({
      templateDir: "/tmp/template",
      cleanup: vi.fn(),
    });
    mockHashFiles.mockResolvedValue({});
    mockSaveLock.mockResolvedValue();
  });

  describe("meta", () => {
    it("コマンドメタデータが正しい", () => {
      expect((pullCommand.meta as { name: string }).name).toBe("pull");
      expect((pullCommand.meta as { description: string }).description).toBe(
        "Pull latest template updates",
      );
    });
  });

  describe("run", () => {
    it("初期化されていない場合はエラー", async () => {
      mockLoadCommandContext.mockReturnValue(
        Effect.fail(new FileNotFoundError({ path: ".ziku/ziku.jsonc" })),
      );

      await expect(
        (pullCommand.run as any)({
          args: { dir: "/test", force: false },
          rawArgs: [],
          cmd: pullCommand,
        }),
      ).rejects.toThrow(ZikuError);
    });

    it("変更がない場合は 'Already up to date' を表示", async () => {
      vol.fromJSON({ "/test": null });

      mockClassifyFiles.mockReturnValueOnce({
        autoUpdate: [],
        localOnly: [],
        conflicts: [],
        newFiles: [],
        deletedFiles: [],
        deletedLocally: [],
        unchanged: [".mcp.json"],
      });

      await (pullCommand.run as any)({
        args: { dir: "/test", force: false },
        rawArgs: [],
        cmd: pullCommand,
      });

      expect(mockLog.success).toHaveBeenCalledWith("Already up to date");
    });

    it("自動更新ファイルをコピー", async () => {
      vol.fromJSON({
        "/test/.mcp.json": '{"old": true}',
        "/tmp/template/.mcp.json": '{"new": true}',
      });

      mockClassifyFiles.mockReturnValueOnce({
        autoUpdate: [".mcp.json"],
        localOnly: [],
        conflicts: [],
        newFiles: [],
        deletedFiles: [],
        deletedLocally: [],
        unchanged: [],
      });

      await (pullCommand.run as any)({
        args: { dir: "/test", force: false },
        rawArgs: [],
        cmd: pullCommand,
      });

      // writeFileEnsureDir が呼ばれることを確認
      expect(mockWriteFileEnsureDir).toHaveBeenCalledWith("/test/.mcp.json", '{"new": true}');
      expect(mockLog.success).toHaveBeenCalledWith("Updated 1 file(s)");
    });

    it("新規ファイルを追加", async () => {
      vol.fromJSON({
        "/test": null,
        "/tmp/template/.new-file": "new content",
      });

      mockClassifyFiles.mockReturnValueOnce({
        autoUpdate: [],
        localOnly: [],
        conflicts: [],
        newFiles: [".new-file"],
        deletedFiles: [],
        deletedLocally: [],
        unchanged: [],
      });

      await (pullCommand.run as any)({
        args: { dir: "/test", force: false },
        rawArgs: [],
        cmd: pullCommand,
      });

      expect(mockWriteFileEnsureDir).toHaveBeenCalledWith("/test/.new-file", "new content");
      expect(mockLog.success).toHaveBeenCalledWith("Added 1 new file(s)");
    });

    it("コンフリクトファイルにマーカーを挿入（base なし）", async () => {
      vol.fromJSON({
        "/test/.mcp.json": "local content",
        "/tmp/template/.mcp.json": "template content",
      });

      // baseHashes にエントリがないケース
      const { effect } = mockContext({
        lock: {
          ...baseLock,
          baseHashes: {} as any,
        },
      });
      mockLoadCommandContext.mockReturnValue(effect);

      mockClassifyFiles.mockReturnValueOnce({
        autoUpdate: [],
        localOnly: [],
        conflicts: [".mcp.json"],
        newFiles: [],
        deletedFiles: [],
        deletedLocally: [],
        unchanged: [],
      });

      // mergeOneFile: base なし → コンフリクトマーカー
      mockMergeResult(
        ".mcp.json",
        "<<<<<<< LOCAL\nlocal content\n=======\ntemplate content\n>>>>>>> TEMPLATE",
        true,
      );

      await (pullCommand.run as any)({
        args: { dir: "/test", force: false },
        rawArgs: [],
        cmd: pullCommand,
      });

      // writeFileEnsureDir にコンフリクトマーカー付き内容が渡される
      expect(mockWriteFileEnsureDir).toHaveBeenCalledWith(
        "/test/.mcp.json",
        expect.stringContaining("<<<<<<< LOCAL"),
      );
      expect(mockLog.warn).toHaveBeenCalledWith(
        expect.stringContaining("manual resolution needed"),
      );
      // mergeOneFile に正しい引数が渡される
      expect(mockMergeOneFile).toHaveBeenCalledWith({
        file: ".mcp.json",
        targetDir: "/test",
        templateDir: "/tmp/template",
        baseTemplateDir: undefined,
      });
    });

    it("--force で selectDeletedFiles プロンプトをスキップ", async () => {
      vol.fromJSON({ "/test": null });

      mockClassifyFiles.mockReturnValueOnce({
        autoUpdate: [],
        localOnly: [],
        conflicts: [],
        newFiles: [],
        deletedFiles: [".old-file"],
        deletedLocally: [],
        unchanged: [],
      });

      await (pullCommand.run as any)({
        args: { dir: "/test", force: true },
        rawArgs: [],
        cmd: pullCommand,
      });

      // --force パスではプロンプトを表示しない
      expect(mockSelectDeletedFiles).not.toHaveBeenCalled();
    });

    it("削除ファイルがある場合に selectDeletedFiles を呼ぶ", async () => {
      vol.fromJSON({ "/test": null });

      mockClassifyFiles.mockReturnValueOnce({
        autoUpdate: [],
        localOnly: [],
        conflicts: [],
        newFiles: [],
        deletedFiles: ["old-file.txt"],
        deletedLocally: [],
        unchanged: [],
      });
      mockSelectDeletedFiles.mockResolvedValueOnce([]);

      await (pullCommand.run as any)({
        args: { dir: "/test", force: false },
        rawArgs: [],
        cmd: pullCommand,
      });

      expect(mockSelectDeletedFiles).toHaveBeenCalledWith(["old-file.txt"]);
    });

    it("--force のとき selectDeletedFiles を呼ばずに全削除する", async () => {
      vol.fromJSON({
        "/test/old-file.txt": "old content",
      });

      mockClassifyFiles.mockReturnValueOnce({
        autoUpdate: [],
        localOnly: [],
        conflicts: [],
        newFiles: [],
        deletedFiles: ["old-file.txt"],
        deletedLocally: [],
        unchanged: [],
      });

      await (pullCommand.run as any)({
        args: { dir: "/test", force: true },
        rawArgs: [],
        cmd: pullCommand,
      });

      expect(mockSelectDeletedFiles).not.toHaveBeenCalled();
      expect(vol.existsSync("/test/old-file.txt")).toBe(false);
    });

    it("selectDeletedFiles で選択したファイルのみ削除する", async () => {
      vol.fromJSON({
        "/test/a.txt": "aaa",
        "/test/b.txt": "bbb",
      });

      mockClassifyFiles.mockReturnValueOnce({
        autoUpdate: [],
        localOnly: [],
        conflicts: [],
        newFiles: [],
        deletedFiles: ["a.txt", "b.txt"],
        deletedLocally: [],
        unchanged: [],
      });
      mockSelectDeletedFiles.mockResolvedValueOnce(["a.txt"]);

      await (pullCommand.run as any)({
        args: { dir: "/test", force: false },
        rawArgs: [],
        cmd: pullCommand,
      });

      expect(vol.existsSync("/test/a.txt")).toBe(false);
      expect(vol.existsSync("/test/b.txt")).toBe(true);
    });

    it("設定の baseHashes が更新される", async () => {
      vol.fromJSON({ "/test": null });

      const newTemplateHashes = { ".mcp.json": "newhash123" };
      // hashFiles は2回呼ばれる（template, local）
      mockHashFiles.mockResolvedValueOnce(newTemplateHashes);
      mockHashFiles.mockResolvedValueOnce({});

      mockClassifyFiles.mockReturnValueOnce({
        autoUpdate: [".mcp.json"],
        localOnly: [],
        conflicts: [],
        newFiles: [],
        deletedFiles: [],
        deletedLocally: [],
        unchanged: [],
      });

      // autoUpdate 用のテンプレートファイルを用意
      vol.fromJSON({
        "/test": null,
        "/tmp/template/.mcp.json": "updated",
      });

      await (pullCommand.run as any)({
        args: { dir: "/test", force: false },
        rawArgs: [],
        cmd: pullCommand,
      });

      expect(mockSaveLock).toHaveBeenCalledWith(
        expect.any(String),
        expect.objectContaining({
          baseHashes: newTemplateHashes,
        }),
      );
    });

    it("resolveBaseRef が Some のとき baseRef が更新される", async () => {
      vol.fromJSON({
        "/test": null,
        "/tmp/template/.mcp.json": "updated",
      });

      const { effect } = mockContext({
        resolveBaseRef: Effect.succeed(Option.some("newsha456")),
      });
      mockLoadCommandContext.mockReturnValue(effect);

      mockClassifyFiles.mockReturnValueOnce({
        autoUpdate: [".mcp.json"],
        localOnly: [],
        conflicts: [],
        newFiles: [],
        deletedFiles: [],
        deletedLocally: [],
        unchanged: [],
      });

      await (pullCommand.run as any)({
        args: { dir: "/test", force: false },
        rawArgs: [],
        cmd: pullCommand,
      });

      expect(mockSaveLock).toHaveBeenCalledWith(
        expect.any(String),
        expect.objectContaining({ baseRef: "newsha456" }),
      );
    });

    it("resolveBaseRef が None のとき既存の baseRef を上書きしない", async () => {
      vol.fromJSON({
        "/test": null,
        "/tmp/template/.mcp.json": "updated",
      });

      const { effect } = mockContext({
        lock: { ...baseLock, baseRef: "existing-sha" },
        resolveBaseRef: Effect.succeed(Option.none<string>()),
      });
      mockLoadCommandContext.mockReturnValue(effect);

      mockClassifyFiles.mockReturnValueOnce({
        autoUpdate: [".mcp.json"],
        localOnly: [],
        conflicts: [],
        newFiles: [],
        deletedFiles: [],
        deletedLocally: [],
        unchanged: [],
      });

      await (pullCommand.run as any)({
        args: { dir: "/test", force: false },
        rawArgs: [],
        cmd: pullCommand,
      });

      // baseRef: undefined でロックを上書きしないことを確認
      const lockArg = mockSaveLock.mock.calls[0][1];
      expect(lockArg).not.toHaveProperty("baseRef", undefined);
      // 既存の baseRef がスプレッドで保持される
      expect(lockArg.baseRef).toBe("existing-sha");
    });

    it("cleanup が必ず呼ばれる", async () => {
      vol.fromJSON({ "/test": null });

      const { effect, cleanup: mockCleanup } = mockContext();
      mockLoadCommandContext.mockReturnValue(effect);

      mockClassifyFiles.mockReturnValueOnce({
        autoUpdate: [],
        localOnly: [],
        conflicts: [],
        newFiles: [],
        deletedFiles: [],
        deletedLocally: [],
        unchanged: [".mcp.json"],
      });

      await (pullCommand.run as any)({
        args: { dir: "/test", force: false },
        rawArgs: [],
        cmd: pullCommand,
      });

      expect(mockCleanup).toHaveBeenCalled();
    });

    it("コンフリクト時に pendingMerge を保存して中断", async () => {
      vol.fromJSON({
        "/test/.mcp.json": "local content",
        "/tmp/template/.mcp.json": "template content",
      });

      mockClassifyFiles.mockReturnValueOnce({
        autoUpdate: [],
        localOnly: [],
        conflicts: [".mcp.json"],
        newFiles: [],
        deletedFiles: [],
        deletedLocally: [],
        unchanged: [],
      });

      mockMergeResult(
        ".mcp.json",
        "<<<<<<< LOCAL\nlocal\n=======\ntemplate\n>>>>>>> TEMPLATE",
        true,
      );

      await (pullCommand.run as any)({
        args: { dir: "/test", force: false, continue: false },
        rawArgs: [],
        cmd: pullCommand,
      });

      expect(mockSaveLock).toHaveBeenCalledWith(
        expect.any(String),
        expect.objectContaining({
          pendingMerge: expect.objectContaining({
            conflicts: [".mcp.json"],
          }),
        }),
      );
      // baseHashes/baseRef は更新されない（pendingMerge に保留）
      expect(mockSaveLock).not.toHaveBeenCalledWith(
        expect.any(String),
        expect.objectContaining({
          baseHashes: expect.any(Object),
          pendingMerge: undefined,
        }),
      );
    });

    it("--continue: pendingMerge がない場合はエラー", async () => {
      mockLoadLock.mockResolvedValueOnce({
        ...baseLock,
        pendingMerge: undefined,
      });

      await expect(
        (pullCommand.run as any)({
          args: { dir: "/test", force: false, continue: true },
          rawArgs: [],
          cmd: pullCommand,
        }),
      ).rejects.toThrow(ZikuError);
    });

    it("--continue: コンフリクトマーカーが残っている場合はエラー", async () => {
      vol.fromJSON({
        "/test/.mcp.json": "<<<<<<< LOCAL\nlocal\n=======\ntemplate\n>>>>>>> TEMPLATE",
      });

      mockLoadLock.mockResolvedValueOnce({
        ...baseLock,
        pendingMerge: {
          conflicts: [".mcp.json"],
          templateHashes: { ".mcp.json": "hash123" },
          latestRef: "latest123",
        },
      });

      await expect(
        (pullCommand.run as any)({
          args: { dir: "/test", force: false, continue: true },
          rawArgs: [],
          cmd: pullCommand,
        }),
      ).rejects.toThrow(ZikuError);
    });

    it("--continue: 全解決済みなら baseHashes/baseRef を更新して pendingMerge を削除", async () => {
      vol.fromJSON({
        "/test/.mcp.json": "resolved content (no conflict markers)",
      });

      mockLoadLock.mockResolvedValueOnce({
        ...baseLock,
        pendingMerge: {
          conflicts: [".mcp.json"],
          templateHashes: { ".mcp.json": "newhash" },
          latestRef: "newref123",
        },
      });

      await (pullCommand.run as any)({
        args: { dir: "/test", force: false, continue: true },
        rawArgs: [],
        cmd: pullCommand,
      });

      expect(mockSaveLock).toHaveBeenCalledWith(
        expect.any(String),
        expect.objectContaining({
          baseHashes: { ".mcp.json": "newhash" },
          baseRef: "newref123",
          pendingMerge: undefined,
        }),
      );
      expect(mockLog.success).toHaveBeenCalledWith("All conflicts resolved");
    });

    it("downloadBaseForMerge が baseRef 付きで呼ばれる", async () => {
      vol.fromJSON({
        "/test/settings.json": '{"local": true}',
        "/tmp/template/settings.json": '{"template": true}',
      });

      const { effect } = mockContext({
        lock: {
          ...baseLock,
          baseRef: "abc123",
          baseHashes: { "settings.json": "old-hash" } as any,
        },
      });
      mockLoadCommandContext.mockReturnValue(effect);

      mockClassifyFiles.mockReturnValueOnce({
        autoUpdate: [],
        localOnly: [],
        conflicts: ["settings.json"],
        newFiles: [],
        deletedFiles: [],
        deletedLocally: [],
        unchanged: [],
      });

      // downloadBaseForMerge がベースを返す
      const baseCleanup = vi.fn();
      mockDownloadBaseForMerge.mockReturnValueOnce(
        Effect.succeed({ templateDir: "/tmp/base", cleanup: baseCleanup }),
      );

      mockMergeResult("settings.json", '{"merged": true}', false);

      await (pullCommand.run as any)({
        args: { dir: "/test", force: false },
        rawArgs: [],
        cmd: pullCommand,
      });

      // downloadBaseForMerge に正しい引数が渡される
      expect(mockDownloadBaseForMerge).toHaveBeenCalledWith({
        source: { owner: "tktcorporation", repo: ".github" },
        baseRef: "abc123",
        targetDir: "/test",
      });
      // mergeOneFile に baseTemplateDir が渡される
      expect(mockMergeOneFile).toHaveBeenCalledWith({
        file: "settings.json",
        targetDir: "/test",
        templateDir: "/tmp/template",
        baseTemplateDir: "/tmp/base",
      });
      // cleanup が呼ばれる
      expect(baseCleanup).toHaveBeenCalled();
    });

    it("エラー時も cleanup が呼ばれる", async () => {
      const { effect, cleanup: mockCleanup } = mockContext();
      mockLoadCommandContext.mockReturnValue(effect);

      // hashFiles でエラーを起こす
      mockHashFiles.mockRejectedValueOnce(new Error("Hash error"));

      await expect(
        (pullCommand.run as any)({
          args: { dir: "/test", force: false },
          rawArgs: [],
          cmd: pullCommand,
        }),
      ).rejects.toThrow("Hash error");

      expect(mockCleanup).toHaveBeenCalled();
    });

    it("コンフリクトファイルが自動マージ成功した場合に success ログを出す", async () => {
      vol.fromJSON({
        "/test/.mcp.json": "local content",
        "/tmp/template/.mcp.json": "template content",
      });

      mockClassifyFiles.mockReturnValueOnce({
        autoUpdate: [],
        localOnly: [],
        conflicts: [".mcp.json"],
        newFiles: [],
        deletedFiles: [],
        deletedLocally: [],
        unchanged: [],
      });

      // 自動マージ成功（hasConflicts: false）
      mockMergeResult(".mcp.json", "auto-merged content", false);

      await (pullCommand.run as any)({
        args: { dir: "/test", force: false },
        rawArgs: [],
        cmd: pullCommand,
      });

      // 自動マージ成功のメッセージが出力される
      expect(mockLog.success).toHaveBeenCalledWith(expect.stringContaining("Auto-merged"));
      expect(mockLog.success).toHaveBeenCalledWith(expect.stringContaining(".mcp.json"));
      // pendingMerge は保存されない（正常完了パス）
      expect(mockSaveLock).not.toHaveBeenCalledWith(
        expect.any(String),
        expect.objectContaining({ pendingMerge: expect.anything() }),
      );
    });

    it("複数コンフリクトで一部自動マージ・一部未解決の場合に各ログが出る", async () => {
      vol.fromJSON({
        "/test/a.json": "local a",
        "/test/b.txt": "local b",
        "/tmp/template/a.json": "template a",
        "/tmp/template/b.txt": "template b",
      });

      mockClassifyFiles.mockReturnValueOnce({
        autoUpdate: [],
        localOnly: [],
        conflicts: ["a.json", "b.txt"],
        newFiles: [],
        deletedFiles: [],
        deletedLocally: [],
        unchanged: [],
      });

      // a.json: 自動マージ成功
      mockMergeResult("a.json", "merged a", false);
      // b.txt: コンフリクト（テキストマーカー）
      mockMergeResult(
        "b.txt",
        "<<<<<<< LOCAL\nlocal b\n=======\ntemplate b\n>>>>>>> TEMPLATE",
        true,
      );

      await (pullCommand.run as any)({
        args: { dir: "/test", force: false },
        rawArgs: [],
        cmd: pullCommand,
      });

      // a.json は自動マージ成功
      expect(mockLog.success).toHaveBeenCalledWith(expect.stringContaining("Auto-merged"));
      expect(mockLog.success).toHaveBeenCalledWith(expect.stringContaining("a.json"));
      // b.txt はコンフリクト
      expect(mockLog.warn).toHaveBeenCalledWith(expect.stringContaining("b.txt"));
      // 未解決コンフリクトがあるので pendingMerge が保存される
      expect(mockSaveLock).toHaveBeenCalledWith(
        expect.any(String),
        expect.objectContaining({
          pendingMerge: expect.objectContaining({
            conflicts: ["b.txt"],
          }),
        }),
      );
    });

    it("全コンフリクトが自動マージ成功した場合は pendingMerge なしで正常完了", async () => {
      vol.fromJSON({
        "/test/a.json": "local a",
        "/test/b.json": "local b",
        "/tmp/template/a.json": "template a",
        "/tmp/template/b.json": "template b",
      });

      mockClassifyFiles.mockReturnValueOnce({
        autoUpdate: [],
        localOnly: [],
        conflicts: ["a.json", "b.json"],
        newFiles: [],
        deletedFiles: [],
        deletedLocally: [],
        unchanged: [],
      });

      mockMergeResult("a.json", "merged a", false);
      mockMergeResult("b.json", "merged b", false);

      await (pullCommand.run as any)({
        args: { dir: "/test", force: false },
        rawArgs: [],
        cmd: pullCommand,
      });

      // 両方自動マージ成功
      expect(mockLog.success).toHaveBeenCalledWith(expect.stringContaining("a.json"));
      expect(mockLog.success).toHaveBeenCalledWith(expect.stringContaining("b.json"));
      // pendingMerge なしで正常完了
      expect(mockSaveLock).toHaveBeenCalledWith(
        expect.any(String),
        expect.objectContaining({
          baseHashes: expect.any(Object),
        }),
      );
      expect(mockSaveLock).not.toHaveBeenCalledWith(
        expect.any(String),
        expect.objectContaining({
          pendingMerge: expect.anything(),
        }),
      );
    });

    it("コンフリクト時はマーカー付きで warn を出す", async () => {
      vol.fromJSON({
        "/test/config.json": '{"version": "2.0"}',
        "/tmp/template/config.json": '{"version": "3.0"}',
      });

      mockClassifyFiles.mockReturnValueOnce({
        autoUpdate: [],
        localOnly: [],
        conflicts: ["config.json"],
        newFiles: [],
        deletedFiles: [],
        deletedLocally: [],
        unchanged: [],
      });

      mockMergeResult(
        "config.json",
        '<<<<<<< LOCAL\n{"version": "2.0"}\n=======\n{"version": "3.0"}\n>>>>>>> TEMPLATE',
        true,
      );

      await (pullCommand.run as any)({
        args: { dir: "/test", force: false },
        rawArgs: [],
        cmd: pullCommand,
      });

      // コンフリクトの warn（manual resolution needed）
      expect(mockLog.warn).toHaveBeenCalledWith(expect.stringContaining("config.json"));
      expect(mockLog.warn).toHaveBeenCalledWith(
        expect.stringContaining("manual resolution needed"),
      );
    });

    it("新規ファイル追加時にディレクトリを自動作成", async () => {
      vol.fromJSON({
        "/test": null,
        "/tmp/template/.devcontainer/config.json": '{"key": "value"}',
      });

      mockClassifyFiles.mockReturnValueOnce({
        autoUpdate: [],
        localOnly: [],
        conflicts: [],
        newFiles: [".devcontainer/config.json"],
        deletedFiles: [],
        deletedLocally: [],
        unchanged: [],
      });

      await (pullCommand.run as any)({
        args: { dir: "/test", force: false },
        rawArgs: [],
        cmd: pullCommand,
      });

      // writeFileEnsureDir がディレクトリ作成含めて呼ばれる
      expect(mockWriteFileEnsureDir).toHaveBeenCalledWith(
        "/test/.devcontainer/config.json",
        '{"key": "value"}',
      );
    });

    it("delete/modify conflict: ローカルで削除されたファイルが conflicts にあっても ENOENT にならない", async () => {
      // ローカルにはファイルが存在しない（削除済み）
      // テンプレートにはファイルが存在する
      vol.fromJSON({
        "/test": null,
        "/tmp/template/.claude/rules/worktree.md": "template content updated",
      });

      const { effect } = mockContext({
        lock: {
          ...baseLock,
          baseRef: "abc123def456",
          baseHashes: {
            ".claude/rules/worktree.md": "abc123",
          } as any,
        },
      });
      mockLoadCommandContext.mockReturnValue(effect);

      mockClassifyFiles.mockReturnValueOnce({
        autoUpdate: [],
        localOnly: [],
        conflicts: [".claude/rules/worktree.md"],
        newFiles: [],
        deletedFiles: [],
        deletedLocally: [],
        unchanged: [],
      });

      const baseCleanup = vi.fn();
      mockDownloadBaseForMerge.mockReturnValueOnce(
        Effect.succeed({ templateDir: "/tmp/base-template", cleanup: baseCleanup }),
      );

      // mergeOneFile が delete/modify conflict を処理する
      // （内部で readFileSafe が空文字列を返す）
      mockMergeResult(
        ".claude/rules/worktree.md",
        "<<<<<<< LOCAL\n=======\ntemplate content updated\n>>>>>>> TEMPLATE",
        true,
      );

      // ENOENT で落ちずに正常終了することを検証
      await (pullCommand.run as any)({
        args: { dir: "/test", force: false },
        rawArgs: [],
        cmd: pullCommand,
      });

      // コンフリクトとして報告されること
      expect(mockLog.warn).toHaveBeenCalledWith(
        expect.stringContaining("manual resolution needed"),
      );

      // mergeOneFile に正しい引数が渡されること
      expect(mockMergeOneFile).toHaveBeenCalledWith({
        file: ".claude/rules/worktree.md",
        targetDir: "/test",
        templateDir: "/tmp/template",
        baseTemplateDir: "/tmp/base-template",
      });

      // writeFileEnsureDir でファイルが書き込まれること（ディレクトリ作成含む）
      expect(mockWriteFileEnsureDir).toHaveBeenCalledWith(
        "/test/.claude/rules/worktree.md",
        expect.stringContaining("<<<<<<< LOCAL"),
      );
    });
  });
});
