import { vol } from "memfs";
import { Effect } from "effect";
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

vi.mock("../../utils/merge", () => ({
  classifyFiles: vi.fn(),
  threeWayMerge: vi.fn(),
  hasConflictMarkers: vi.fn((content: string) => ({
    found: content.includes("<<<<<<<"),
    lines: [],
  })),
  asBaseContent: vi.fn((s: string) => s),
  asLocalContent: vi.fn((s: string) => s),
  asTemplateContent: vi.fn((s: string) => s),
}));

vi.mock("../../utils/github", () => ({
  resolveLatestCommitSha: vi.fn(() => Promise.resolve("latest123")),
}));

vi.mock("../../utils/template-config", async () => {
  const effectMod = await import("effect");
  return {
    loadTemplateConfig: vi.fn(() => effectMod.Effect.succeed(null)),
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
const { classifyFiles, threeWayMerge } = await import("../../utils/merge");
const { log } = await import("../../ui/renderer");

const mockLoadCommandContext = vi.mocked(loadCommandContext);
const mockDownloadTemplateToTemp = vi.mocked(downloadTemplateToTemp);
const mockZikuConfigExists = vi.mocked(zikuConfigExists);
const mockLoadLock = vi.mocked(loadLock);
const mockSaveLock = vi.mocked(saveLock);
const mockHashFiles = vi.mocked(hashFiles);
const mockClassifyFiles = vi.mocked(classifyFiles);
const mockThreeWayMerge = vi.mocked(threeWayMerge);
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
      /** テスト用: GitHub API 呼び出しをスキップし undefined を返す */
      resolveBaseRef: Effect.succeed(undefined as string | undefined),
    }),
    cleanup,
  };
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
        unchanged: [],
      });

      await (pullCommand.run as any)({
        args: { dir: "/test", force: false },
        rawArgs: [],
        cmd: pullCommand,
      });

      // ファイルが更新されていることを確認
      const content = vol.readFileSync("/test/.mcp.json", "utf-8");
      expect(content).toBe('{"new": true}');
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
        unchanged: [],
      });

      await (pullCommand.run as any)({
        args: { dir: "/test", force: false },
        rawArgs: [],
        cmd: pullCommand,
      });

      const content = vol.readFileSync("/test/.new-file", "utf-8");
      expect(content).toBe("new content");
      expect(mockLog.success).toHaveBeenCalledWith("Added 1 new file(s)");
    });

    it("コンフリクトファイルにマーカーを挿入（base なし）", async () => {
      vol.fromJSON({
        "/test/.mcp.json": "local content",
        "/tmp/template/.mcp.json": "template content",
      });

      // baseHashes にエントリがないケース（readBaseContent が undefined を返す）
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
        unchanged: [],
      });

      // base がない場合も threeWayMerge が呼ばれる（空文字列が base として渡される）
      mockThreeWayMerge.mockReturnValueOnce({
        content: "<<<<<<< LOCAL\nlocal content\n=======\ntemplate content\n>>>>>>> TEMPLATE",
        hasConflicts: true,
        conflictDetails: [],
      });

      await (pullCommand.run as any)({
        args: { dir: "/test", force: false },
        rawArgs: [],
        cmd: pullCommand,
      });

      const content = vol.readFileSync("/test/.mcp.json", "utf-8");
      expect(content).toContain("<<<<<<< LOCAL");
      expect(content).toContain("local content");
      expect(content).toContain("=======");
      expect(content).toContain("template content");
      expect(content).toContain(">>>>>>> TEMPLATE");
      expect(mockLog.warn).toHaveBeenCalledWith(
        expect.stringContaining("manual resolution needed"),
      );
      // threeWayMerge にファイルパスが渡される（named params）
      expect(mockThreeWayMerge).toHaveBeenCalledWith({
        base: "",
        local: "local content",
        template: "template content",
        filePath: ".mcp.json",
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
        unchanged: [],
      });

      mockThreeWayMerge.mockReturnValueOnce({
        content: "<<<<<<< LOCAL\nlocal\n=======\ntemplate\n>>>>>>> TEMPLATE",
        hasConflicts: true,
        conflictDetails: [],
      });

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

    it("base ダウンロードが template ディレクトリを上書きしない（一時ディレクトリ分離）", async () => {
      // 背景: downloadTemplateToTemp が常に同じ .ziku-temp を使うため、
      // base ダウンロード時に template を上書きし、base === template となって
      // マージが空振り（ローカル内容そのまま）するバグがあった。
      // ラベル引数で一時ディレクトリを分離することで解決。
      vol.fromJSON({
        "/test/settings.json": '{"local": true}',
        "/tmp/template/settings.json": '{"template": true}',
        "/tmp/base/settings.json": '{"base": true}',
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
        unchanged: [],
      });

      // base ダウンロード用（loadCommandContext が template を解決済みなので、
      // downloadTemplateToTemp は base 用の1回のみ呼ばれる）
      mockDownloadTemplateToTemp.mockResolvedValueOnce({
        templateDir: "/tmp/base",
        cleanup: vi.fn(),
      });

      mockThreeWayMerge.mockReturnValueOnce({
        content: '{"merged": true}',
        hasConflicts: false,
        conflictDetails: [],
      });

      await (pullCommand.run as any)({
        args: { dir: "/test", force: false },
        rawArgs: [],
        cmd: pullCommand,
      });

      // threeWayMerge に正しい引数が渡される:
      // base は base ディレクトリから、template は template ディレクトリから読まれる
      expect(mockThreeWayMerge).toHaveBeenCalledWith({
        base: '{"base": true}',
        local: '{"local": true}',
        template: '{"template": true}',
        filePath: "settings.json",
      });

      // base ダウンロード時に "base" ラベルが使用されることを確認
      // loadCommandContext が template を解決するため、downloadTemplateToTemp は base 用の1回のみ
      expect(mockDownloadTemplateToTemp).toHaveBeenCalledTimes(1);
      expect(mockDownloadTemplateToTemp).toHaveBeenCalledWith(
        "/test",
        expect.stringContaining("#abc123"),
        "base",
      );
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
        unchanged: [],
      });

      // 自動マージ成功（hasConflicts: false）
      mockThreeWayMerge.mockReturnValueOnce({
        content: "auto-merged content",
        hasConflicts: false,
        conflictDetails: [],
      });

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
        unchanged: [],
      });

      // a.json: 自動マージ成功
      mockThreeWayMerge.mockReturnValueOnce({
        content: "merged a",
        hasConflicts: false,
        conflictDetails: [],
      });
      // b.txt: コンフリクト（テキストマーカー）
      mockThreeWayMerge.mockReturnValueOnce({
        content: "<<<<<<< LOCAL\nlocal b\n=======\ntemplate b\n>>>>>>> TEMPLATE",
        hasConflicts: true,
        conflictDetails: [],
      });

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
        unchanged: [],
      });

      mockThreeWayMerge.mockReturnValueOnce({
        content: "merged a",
        hasConflicts: false,
        conflictDetails: [],
      });
      mockThreeWayMerge.mockReturnValueOnce({
        content: "merged b",
        hasConflicts: false,
        conflictDetails: [],
      });

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
        unchanged: [],
      });

      // threeWayMerge は構造マージでコンフリクトがある場合、テキストマージにフォールバックし
      // コンフリクトマーカーを挿入する
      mockThreeWayMerge.mockReturnValueOnce({
        content: '<<<<<<< LOCAL\n{"version": "2.0"}\n=======\n{"version": "3.0"}\n>>>>>>> TEMPLATE',
        hasConflicts: true,
        conflictDetails: [],
      });

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
        unchanged: [],
      });

      await (pullCommand.run as any)({
        args: { dir: "/test", force: false },
        rawArgs: [],
        cmd: pullCommand,
      });

      expect(vol.existsSync("/test/.devcontainer")).toBe(true);
      const content = vol.readFileSync("/test/.devcontainer/config.json", "utf-8");
      expect(content).toBe('{"key": "value"}');
    });
  });
});
