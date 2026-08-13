import { vol } from "memfs";
import { Effect, Option } from "effect";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { ZikuError, FileNotFoundError } from "../../errors";
import type {
  ConflictPaths,
  LockState,
  ResumableLockState,
  SyncPoint,
  TemplateSource,
} from "../../modules/schemas";
import { baseCommitSha, baseHashesOf, markMerging, markSynced } from "../../modules/schemas";
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

vi.mock("../../utils/template", () => ({
  downloadTemplateToTemp: vi.fn(),
  buildTemplateSource: vi.fn(
    (source: { owner: string; repo: string }) => `gh:${source.owner}/${source.repo}`,
  ),
}));

// --continue モードで直接使われるため、モックが引き続き必要。
// パス種別の判定（classifySyncPath 等）は分類の仕分けが実際に使うので実装をそのまま通す。
vi.mock("../../utils/ziku-config", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../../utils/ziku-config")>()),
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

vi.mock("../../utils/hash", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../../utils/hash")>()),
  hashFiles: vi.fn(),
}));

vi.mock("../../utils/merge", async () => {
  const effectMod = await import("effect");
  const fsMod = await import("node:fs/promises");
  const errorsMod = await import("../../errors");

  const mergeOneFile = vi.fn();
  type BaseDownload = { templateDir: string; cleanup: () => void } | null;
  const downloadBaseForMerge = vi.fn(
    (_opts: {
      lock: import("../../modules/schemas").LockState;
      targetDir: string;
    }): import("effect").Effect.Effect<BaseDownload> => effectMod.Effect.succeed(null),
  );

  return {
    classifyFiles: vi.fn(),
    findConflictRegions: vi.fn((content: string) =>
      content.includes("<<<<<<<") ? [{ startLine: 1 }] : [],
    ),
    // conflict-io の共通ユーティリティ（pull.ts はこれらを経由して merge する）
    readFileSafe: vi.fn((path: string) =>
      effectMod.Effect.tryPromise(() => fsMod.readFile(path, "utf-8")).pipe(
        effectMod.Effect.catchAll(() =>
          effectMod.Effect.fail(new errorsMod.FileNotFoundError({ path })),
        ),
      ),
    ),
    mergeOneFile,
    writeFileEnsureDir: vi.fn(() => effectMod.Effect.succeed(undefined)),
    downloadBaseForMerge,
    // ベース取得と 1 ファイル単位のマージは上の 2 つのモックへ委ね、ループだけを再現する。
    // 「ベースを取得できなければ内容を読まず全て未解決」という本体の規則は、pull 側の
    // 後処理（書き込むか / 何もしないか）を検証するために代替側でも同じにしておく。
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
  selectDeletedFilesWithLocalEdits: vi.fn(() => Promise.resolve([])),
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
const { selectDeletedFiles, selectDeletedFilesWithLocalEdits } = await import("../../ui/prompts");
const mockSelectDeletedFiles = vi.mocked(selectDeletedFiles);
const mockSelectDeletedFilesWithLocalEdits = vi.mocked(selectDeletedFilesWithLocalEdits);
const { downloadTemplateToTemp } = await import("../../utils/template");
const { zikuConfigExists } = await import("../../utils/ziku-config");
const { loadLock, saveLock } = await import("../../utils/lock");
const { loadTemplateConfig } = await import("../../utils/template-config");
const { hashFiles } = await import("../../utils/hash");
const { classifyFiles, mergeOneFile, writeFileEnsureDir, downloadBaseForMerge } =
  await import("../../utils/merge");
// マージ結果の判定は本物を使う（"../../utils/merge" のモックは index 経由の import だけを
// 置き換えるので、実装モジュールを直接読み込めば素の関数が得られる）。
const { classifyMergeOutcome } = await import("../../utils/merge/types");
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
const mockLoadTemplateConfig = vi.mocked(loadTemplateConfig);

const baseZikuConfig = {
  include: [".mcp.json", ".mise.toml"],
  exclude: [],
};

const baseSource: TemplateSource = { kind: "github", owner: "tktcorporation", repo: ".github" };

const baseLock: ResumableLockState = {
  version: "0.1.0",
  installedAt: "2024-01-01T00:00:00.000Z",
  source: baseSource,
  sync: "synced",
  base: { hashes: { ".mcp.json": "abc123" } },
};

/** baseLock のベースだけ差し替えたロックを作る。 */
function lockWithBase(hashes: Record<string, string>, commitSha?: string): LockState {
  return markSynced(baseLock, { hashes, commitSha });
}

/** 直近に保存された lock。saveLock が呼ばれていなければ失敗する。 */
function lastSavedLock(): LockState {
  const saved = mockSaveLock.mock.calls.at(-1)?.[1];
  if (saved === undefined) throw new Error("saveLock was not called");
  return saved;
}

/** コンフリクト解決待ちのロックを作る。 */
function mergingLock(conflicts: ConflictPaths, next: SyncPoint): LockState {
  return markMerging(baseLock, next, conflicts);
}

/**
 * テスト用の CommandContext を生成するヘルパー。
 * 通常モード（--continue 以外）で loadCommandContext の戻り値として使う。
 */
function mockContext(overrides?: {
  config?: { include: string[]; exclude?: string[] };
  lock?: LockState;
  source?: TemplateSource;
  templateDir?: string;
  resolveBaseRef?: Effect.Effect<Option.Option<string>>;
}) {
  const cleanup = vi.fn();
  const source = overrides?.source ?? baseSource;
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
 *
 * マージ結果の内容から `MergeOutcome` を組み立てる。判定を本物の
 * `classifyMergeOutcome` に任せることで、「マーカー入りなのに Clean」という
 * 実装では作れない値をテストが作ってしまうのを防ぐ。
 */
function mockMergeResult(file: string, content: string) {
  mockMergeOneFile.mockReturnValueOnce(
    Effect.succeed({ file, outcome: classifyMergeOutcome(content) }),
  );
}

/**
 * ベーステンプレートを取得できた状態にする。
 *
 * ベースを取得できないと pull は自動マージ自体を行わないため、マージ結果に対する
 * 振る舞い（書き込み・ログ・lock 更新）を見るテストは、まずこの状態を作る。
 */
function mockBaseAvailable(templateDir = "/tmp/base"): { cleanup: ReturnType<typeof vi.fn> } {
  const cleanup = vi.fn();
  mockDownloadBaseForMerge.mockReturnValueOnce(Effect.succeed({ templateDir, cleanup }));
  return { cleanup };
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
    mockLoadLock.mockReturnValue(Effect.succeed(baseLock));

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
          args: { dir: "/test", force: false, yes: false },
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
        deletedWithLocalEdits: [],
        deletedLocally: [],
        unchanged: [".mcp.json"],
      });

      await (pullCommand.run as any)({
        args: { dir: "/test", force: false, yes: false },
        rawArgs: [],
        cmd: pullCommand,
      });

      expect(mockLog.success).toHaveBeenCalledWith("Already up to date");
    });

    it("テンプレが新パターンを追加 → ziku.jsonc が union マージで同期され lock が更新される", async () => {
      // テンプレ側 ziku.jsonc が新パターンを含む状態を memfs に用意し、classifyFiles が
      // .ziku/ziku.jsonc を autoUpdate に分類するケースを再現する。
      // ziku.jsonc は丸ごとコピーではなく加法 union で同期される（テンプレ追加は取り込み）。
      vol.fromJSON({
        "/test/.ziku/ziku.jsonc": JSON.stringify({ include: [".root/**", ".github/**"] }, null, 2),
        "/tmp/template/.ziku/ziku.jsonc": JSON.stringify(
          { include: [".root/**", ".github/**", ".new-pattern/**"] },
          null,
          2,
        ),
      });

      const effectMod = await import("effect");
      mockLoadTemplateConfig.mockReturnValueOnce(
        effectMod.Effect.succeed({
          $schema: undefined,
          include: [".root/**", ".github/**", ".new-pattern/**"],
          exclude: undefined,
        }),
      );
      // ziku.jsonc 自体が autoUpdate に分類される（テンプレ側で内容が変わったため）
      mockClassifyFiles.mockReturnValueOnce({
        autoUpdate: [".ziku/ziku.jsonc"],
        localOnly: [],
        conflicts: [],
        newFiles: [],
        deletedFiles: [],
        deletedWithLocalEdits: [],
        deletedLocally: [],
        unchanged: [],
      });

      await (pullCommand.run as any)({
        args: { dir: "/test", force: false, yes: false },
        rawArgs: [],
        cmd: pullCommand,
      });

      // 早期 return しない (Already up to date は出ない)
      expect(mockLog.success).not.toHaveBeenCalledWith("Already up to date");
      // ziku.jsonc が union マージ結果で書き込まれる（テンプレの新パターンを取り込む）
      const writeCall = mockWriteFileEnsureDir.mock.calls.find(
        ([p]) => p === "/test/.ziku/ziku.jsonc",
      );
      expect(writeCall).toBeDefined();
      const written = JSON.parse(writeCall?.[1] as string);
      expect(written.include).toEqual([".root/**", ".github/**", ".new-pattern/**"]);
      // lock も更新される (新しい同期ベース)
      expect(mockSaveLock).toHaveBeenCalled();
    });

    it("テンプレ側だけがパターンを削除しても（autoUpdate）ローカルからは消さない（codex P2）", async () => {
      // テンプレが .github/** を削除。ziku.jsonc は autoUpdate に分類されるが、
      // 丸ごとコピーではなく union マージなので、削除は伝播せずローカルに残る。
      vol.fromJSON({
        "/test/.ziku/ziku.jsonc": JSON.stringify({ include: [".root/**", ".github/**"] }, null, 2),
        "/tmp/template/.ziku/ziku.jsonc": JSON.stringify({ include: [".root/**"] }, null, 2),
      });

      mockClassifyFiles.mockReturnValueOnce({
        autoUpdate: [".ziku/ziku.jsonc"],
        localOnly: [],
        conflicts: [],
        newFiles: [],
        deletedFiles: [],
        deletedWithLocalEdits: [],
        deletedLocally: [],
        unchanged: [],
      });

      await (pullCommand.run as any)({
        args: { dir: "/test", force: false, yes: false },
        rawArgs: [],
        cmd: pullCommand,
      });

      // union == local（テンプレ削除のみ）なので no-op: ローカルは書き換えられない。
      // テンプレの縮小版（[.root/**] のみ）で上書きされないことを確認（削除は伝播しない）。
      expect(mockWriteFileEnsureDir).not.toHaveBeenCalledWith(
        "/test/.ziku/ziku.jsonc",
        JSON.stringify({ include: [".root/**"] }, null, 2),
      );
      // ローカル ziku.jsonc は .github/** を保持したまま（縮小されない）
      const local = JSON.parse(vol.readFileSync("/test/.ziku/ziku.jsonc", "utf8") as string);
      expect(local.include).toContain(".github/**");
      expect(local.include).toContain(".root/**");
    });

    it("テンプレ削除+追加の混在: lock の base[ziku.jsonc] は union 内容に揃う（push 再追加を防ぐ / codex P2）", async () => {
      // テンプレが .b/** を削除し .c/** を追加。union=[.a,.b,.c]。base はテンプレ([.a,.c])
      // ではなく union([.a,.b,.c]) のハッシュで記録され、後続 push が .b/** を再追加しない。
      vol.fromJSON({
        "/test/.ziku/ziku.jsonc": JSON.stringify({ include: [".a/**", ".b/**"] }, null, 2),
        "/tmp/template/.ziku/ziku.jsonc": JSON.stringify({ include: [".a/**", ".c/**"] }, null, 2),
      });
      mockClassifyFiles.mockReturnValueOnce({
        autoUpdate: [".ziku/ziku.jsonc"],
        localOnly: [],
        conflicts: [],
        newFiles: [],
        deletedFiles: [],
        deletedWithLocalEdits: [],
        deletedLocally: [],
        unchanged: [],
      });

      await (pullCommand.run as any)({
        args: { dir: "/test", force: false, yes: false },
        rawArgs: [],
        cmd: pullCommand,
      });

      const writeCall = mockWriteFileEnsureDir.mock.calls.find(
        ([p]) => p === "/test/.ziku/ziku.jsonc",
      );
      const written = writeCall?.[1] as string;
      expect(JSON.parse(written).include).toEqual([".a/**", ".b/**", ".c/**"]);

      // lock の base[ziku.jsonc] は書き込んだ union のハッシュと一致する（テンプレ縮小版ではない）
      const { hashContent } = await import("../../utils/hash");
      const saveArg = lastSavedLock();
      expect(baseHashesOf(saveArg)[".ziku/ziku.jsonc"]).toBe(hashContent(written));
    });

    it("テンプレが ziku.jsonc ファイル自体を削除しても、ローカルの制御ファイルは消さない（codex P2）", async () => {
      vol.fromJSON({
        "/test/.ziku/ziku.jsonc": JSON.stringify({ include: [".root/**"] }, null, 2),
        "/test/.mcp.json": "x",
        "/tmp/template/.mcp.json": "x",
      });

      // classify が ziku.jsonc を deletedFiles に入れる（テンプレからファイルが消えた）
      mockClassifyFiles.mockReturnValueOnce({
        autoUpdate: [],
        localOnly: [],
        conflicts: [],
        newFiles: [],
        deletedFiles: [".ziku/ziku.jsonc"],
        deletedWithLocalEdits: [],
        deletedLocally: [],
        unchanged: [],
      });

      await (pullCommand.run as any)({
        args: { dir: "/test", force: true, yes: false },
        rawArgs: [],
        cmd: pullCommand,
      });

      // 制御ファイルは削除されない（deletedFiles から除外されている）
      expect(mockSelectDeletedFiles).not.toHaveBeenCalled();
      expect(vol.existsSync("/test/.ziku/ziku.jsonc")).toBe(true);
    });

    it("ファイル書き込みが無くても config の base 更新が必要なら lock を保存する（codex P2）", async () => {
      // union==local で write 不要だが、lock の base が古い場合は base を揃えるため
      // early-return せず saveLock を通す必要がある（さもないと status/push が誤判定）。
      const localConfig = JSON.stringify({ include: ["A"], exclude: [] });
      vol.fromJSON({
        "/test/.ziku/ziku.jsonc": localConfig,
        "/tmp/template/.ziku/ziku.jsonc": localConfig,
      });
      const { effect } = mockContext({
        lock: lockWithBase({ ".ziku/ziku.jsonc": "stale-old-hash" }),
      });
      mockLoadCommandContext.mockReturnValue(effect);

      mockClassifyFiles.mockReturnValueOnce({
        autoUpdate: [".ziku/ziku.jsonc"],
        localOnly: [],
        conflicts: [],
        newFiles: [],
        deletedFiles: [],
        deletedWithLocalEdits: [],
        deletedLocally: [],
        unchanged: [],
      });

      await (pullCommand.run as any)({
        args: { dir: "/test", force: false, yes: false },
        rawArgs: [],
        cmd: pullCommand,
      });

      // early-return せず lock を保存する（base を union に揃える）
      expect(mockLog.success).not.toHaveBeenCalledWith("Already up to date");
      expect(mockSaveLock).toHaveBeenCalled();
      const saveArg = lastSavedLock();
      expect(baseHashesOf(saveArg)[".ziku/ziku.jsonc"]).not.toBe("stale-old-hash");
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
        deletedWithLocalEdits: [],
        deletedLocally: [],
        unchanged: [],
      });

      await (pullCommand.run as any)({
        args: { dir: "/test", force: false, yes: false },
        rawArgs: [],
        cmd: pullCommand,
      });

      // writeFileEnsureDir が呼ばれることを確認
      // テンプレートからのコピーはバイト列のまま運ぶ（バイナリを壊さないため）
      expect(mockWriteFileEnsureDir).toHaveBeenCalledWith(
        "/test/.mcp.json",
        Buffer.from('{"new": true}'),
      );
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
        deletedWithLocalEdits: [],
        deletedLocally: [],
        unchanged: [],
      });

      await (pullCommand.run as any)({
        args: { dir: "/test", force: false, yes: false },
        rawArgs: [],
        cmd: pullCommand,
      });

      expect(mockWriteFileEnsureDir).toHaveBeenCalledWith(
        "/test/.new-file",
        Buffer.from("new content"),
      );
      expect(mockLog.success).toHaveBeenCalledWith("Added 1 new file(s)");
    });

    it("base を取得できないコンフリクトはマーカーを書き込まず、未解決として残す", async () => {
      vol.fromJSON({
        "/test/.mcp.json": "local content",
        "/tmp/template/.mcp.json": "template content",
      });

      // ベースのハッシュにエントリがないケース
      const { effect } = mockContext({
        lock: lockWithBase({}),
      });
      mockLoadCommandContext.mockReturnValue(effect);

      mockClassifyFiles.mockReturnValueOnce({
        autoUpdate: [],
        localOnly: [],
        conflicts: [".mcp.json"],
        newFiles: [],
        deletedFiles: [],
        deletedWithLocalEdits: [],
        deletedLocally: [],
        unchanged: [],
      });

      await (pullCommand.run as any)({
        args: { dir: "/test", force: false, yes: false },
        rawArgs: [],
        cmd: pullCommand,
      });

      // 空ベースでの自動マージを行わないので、マーカー入りの内容は生成も書き込みもされない
      expect(mockMergeOneFile).not.toHaveBeenCalled();
      expect(mockWriteFileEnsureDir).not.toHaveBeenCalledWith(
        "/test/.mcp.json",
        expect.stringContaining("<<<<<<< LOCAL"),
      );
      expect(mockLog.warn).toHaveBeenCalledWith(
        expect.stringContaining("Cannot auto-merge .mcp.json"),
      );
      // 未解決として解決待ちに記録される（push はここでブロックされる）
      expect(mockSaveLock).toHaveBeenCalledWith(
        expect.any(String),
        expect.objectContaining({
          sync: "merging",
          merge: expect.objectContaining({ conflicts: [".mcp.json"] }),
        }),
      );
    });

    it("ziku.jsonc の conflict は diff3 ではなく要素レベルマージで解決する", async () => {
      // ローカルとテンプレ双方が ziku.jsonc を編集 → conflict。
      // base が取れない（downloadBaseForMerge→null）ので 2-way 和集合になる。
      vol.fromJSON({
        "/test/.ziku/ziku.jsonc": JSON.stringify(
          { include: [".claude/**", ".eslintrc.json"] },
          null,
          2,
        ),
        "/tmp/template/.ziku/ziku.jsonc": JSON.stringify(
          { include: [".claude/**", ".github/**"] },
          null,
          2,
        ),
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

      await (pullCommand.run as any)({
        args: { dir: "/test", force: false, yes: false },
        rawArgs: [],
        cmd: pullCommand,
      });

      // ziku.jsonc には diff3 の mergeOneFile を使わない
      expect(mockMergeOneFile).not.toHaveBeenCalled();
      // 要素レベルマージ結果（和集合）が書き込まれる
      const writeCall = mockWriteFileEnsureDir.mock.calls.find(
        ([p]) => p === "/test/.ziku/ziku.jsonc",
      );
      expect(writeCall).toBeDefined();
      const writtenConfig = JSON.parse(writeCall?.[1] as string);
      expect(writtenConfig.include).toEqual([".claude/**", ".eslintrc.json", ".github/**"]);
      expect(mockLog.success).toHaveBeenCalledWith(expect.stringContaining("Merged"));
    });

    it("--force で selectDeletedFiles プロンプトをスキップ", async () => {
      vol.fromJSON({ "/test": null });

      mockClassifyFiles.mockReturnValueOnce({
        autoUpdate: [],
        localOnly: [],
        conflicts: [],
        newFiles: [],
        deletedFiles: [".old-file"],
        deletedWithLocalEdits: [],
        deletedLocally: [],
        unchanged: [],
      });

      await (pullCommand.run as any)({
        args: { dir: "/test", force: true, yes: false },
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
        deletedWithLocalEdits: [],
        deletedLocally: [],
        unchanged: [],
      });
      mockSelectDeletedFiles.mockResolvedValueOnce([]);

      await (pullCommand.run as any)({
        args: { dir: "/test", force: false, yes: false },
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
        deletedWithLocalEdits: [],
        deletedLocally: [],
        unchanged: [],
      });

      await (pullCommand.run as any)({
        args: { dir: "/test", force: true, yes: false },
        rawArgs: [],
        cmd: pullCommand,
      });

      expect(mockSelectDeletedFiles).not.toHaveBeenCalled();
      expect(vol.existsSync("/test/old-file.txt")).toBe(false);
    });

    it("--yes は削除を承認しないので、テンプレから消えたファイルを残す", async () => {
      vol.fromJSON({
        "/test/old-file.txt": "old content",
      });

      mockClassifyFiles.mockReturnValueOnce({
        autoUpdate: [],
        localOnly: [],
        conflicts: [],
        newFiles: [],
        deletedFiles: ["old-file.txt"],
        deletedWithLocalEdits: [],
        deletedLocally: [],
        unchanged: [],
      });

      await (pullCommand.run as any)({
        args: { dir: "/test", force: false, yes: true },
        rawArgs: [],
        cmd: pullCommand,
      });

      // プロンプトは省くが、承認が無いので削除はしない
      expect(mockSelectDeletedFiles).not.toHaveBeenCalled();
      expect(vol.existsSync("/test/old-file.txt")).toBe(true);
      expect(mockLog.warn).toHaveBeenCalledWith(expect.stringContaining("Re-run with --force"));
    });

    it("--force --yes でも削除は行われる（承認済みなので確認は不要）", async () => {
      vol.fromJSON({
        "/test/old-file.txt": "old content",
      });

      mockClassifyFiles.mockReturnValueOnce({
        autoUpdate: [],
        localOnly: [],
        conflicts: [],
        newFiles: [],
        deletedFiles: ["old-file.txt"],
        deletedWithLocalEdits: [],
        deletedLocally: [],
        unchanged: [],
      });

      await (pullCommand.run as any)({
        args: { dir: "/test", force: true, yes: true },
        rawArgs: [],
        cmd: pullCommand,
      });

      expect(mockSelectDeletedFiles).not.toHaveBeenCalled();
      expect(vol.existsSync("/test/old-file.txt")).toBe(false);
    });

    it("--yes では deletedWithLocalEdits を削除せず、選択も求めない", async () => {
      vol.fromJSON({
        "/test/edited.md": "local edits",
      });

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

      await (pullCommand.run as any)({
        args: { dir: "/test", force: false, yes: true },
        rawArgs: [],
        cmd: pullCommand,
      });

      expect(mockSelectDeletedFilesWithLocalEdits).not.toHaveBeenCalled();
      expect(vol.existsSync("/test/edited.md")).toBe(true);
    });

    it("--force では deletedWithLocalEdits を削除せず、選択も求めない", async () => {
      vol.fromJSON({
        "/test/edited.md": "local edits",
      });

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

      await (pullCommand.run as any)({
        args: { dir: "/test", force: true, yes: false },
        rawArgs: [],
        cmd: pullCommand,
      });

      // --force はテンプレート由来の削除の承認であって、ローカルの編集を捨てる承認ではない。
      // 非対話を意図する実行でプロンプトを出すと CI が入力待ちで止まるため、
      // 選択を求めず全て残す側に倒す。
      expect(mockSelectDeletedFilesWithLocalEdits).not.toHaveBeenCalled();
      expect(mockSelectDeletedFiles).not.toHaveBeenCalled();
      expect(vol.existsSync("/test/edited.md")).toBe(true);
    });

    it("deletedWithLocalEdits は選択したファイルだけ削除する", async () => {
      vol.fromJSON({
        "/test/chosen.md": "local edits",
        "/test/kept.md": "local edits",
      });

      mockClassifyFiles.mockReturnValueOnce({
        autoUpdate: [],
        localOnly: [],
        conflicts: [],
        newFiles: [],
        deletedFiles: [],
        deletedWithLocalEdits: ["chosen.md", "kept.md"],
        deletedLocally: [],
        unchanged: [],
      });
      mockSelectDeletedFilesWithLocalEdits.mockResolvedValueOnce(["chosen.md"]);

      await (pullCommand.run as any)({
        args: { dir: "/test", force: false, yes: false },
        rawArgs: [],
        cmd: pullCommand,
      });

      expect(vol.existsSync("/test/chosen.md")).toBe(false);
      expect(vol.existsSync("/test/kept.md")).toBe(true);
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
        deletedWithLocalEdits: [],
        deletedLocally: [],
        unchanged: [],
      });
      mockSelectDeletedFiles.mockResolvedValueOnce(["a.txt"]);

      await (pullCommand.run as any)({
        args: { dir: "/test", force: false, yes: false },
        rawArgs: [],
        cmd: pullCommand,
      });

      expect(vol.existsSync("/test/a.txt")).toBe(false);
      expect(vol.existsSync("/test/b.txt")).toBe(true);
    });

    it("同期ベースのハッシュが更新される", async () => {
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
        deletedWithLocalEdits: [],
        deletedLocally: [],
        unchanged: [],
      });

      // autoUpdate 用のテンプレートファイルを用意
      vol.fromJSON({
        "/test": null,
        "/tmp/template/.mcp.json": "updated",
      });

      await (pullCommand.run as any)({
        args: { dir: "/test", force: false, yes: false },
        rawArgs: [],
        cmd: pullCommand,
      });

      expect(mockSaveLock).toHaveBeenCalledWith(
        expect.any(String),
        expect.objectContaining({
          sync: "synced",
          base: { hashes: newTemplateHashes },
        }),
      );
    });

    it("resolveBaseRef が Some のときベースのコミット SHA が更新される", async () => {
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
        deletedWithLocalEdits: [],
        deletedLocally: [],
        unchanged: [],
      });

      await (pullCommand.run as any)({
        args: { dir: "/test", force: false, yes: false },
        rawArgs: [],
        cmd: pullCommand,
      });

      expect(mockSaveLock).toHaveBeenCalledWith(
        expect.any(String),
        expect.objectContaining({
          base: expect.objectContaining({ ref: "newsha456" }),
        }),
      );
    });

    it("resolveBaseRef が None のとき既存のベース SHA を引き継ぐ", async () => {
      vol.fromJSON({
        "/test": null,
        "/tmp/template/.mcp.json": "updated",
      });

      const { effect } = mockContext({
        lock: lockWithBase({ ".mcp.json": "abc123" }, "existing-sha"),
        resolveBaseRef: Effect.succeed(Option.none<string>()),
      });
      mockLoadCommandContext.mockReturnValue(effect);

      mockClassifyFiles.mockReturnValueOnce({
        autoUpdate: [".mcp.json"],
        localOnly: [],
        conflicts: [],
        newFiles: [],
        deletedFiles: [],
        deletedWithLocalEdits: [],
        deletedLocally: [],
        unchanged: [],
      });

      await (pullCommand.run as any)({
        args: { dir: "/test", force: false, yes: false },
        rawArgs: [],
        cmd: pullCommand,
      });

      const lockArg = mockSaveLock.mock.calls[0][1];
      expect(lockArg.sync).toBe("synced");
      expect(baseCommitSha(lockArg)).toBe("existing-sha");
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
        deletedWithLocalEdits: [],
        deletedLocally: [],
        unchanged: [".mcp.json"],
      });

      await (pullCommand.run as any)({
        args: { dir: "/test", force: false, yes: false },
        rawArgs: [],
        cmd: pullCommand,
      });

      expect(mockCleanup).toHaveBeenCalled();
    });

    it("コンフリクト時に解決待ちを保存して中断", async () => {
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
        deletedWithLocalEdits: [],
        deletedLocally: [],
        unchanged: [],
      });

      mockBaseAvailable();
      mockMergeResult(".mcp.json", "<<<<<<< LOCAL\nlocal\n=======\ntemplate\n>>>>>>> TEMPLATE");

      await (pullCommand.run as any)({
        args: { dir: "/test", force: false, yes: false, continue: false },
        rawArgs: [],
        cmd: pullCommand,
      });

      expect(mockSaveLock).toHaveBeenCalledWith(
        expect.any(String),
        expect.objectContaining({
          sync: "merging",
          merge: expect.objectContaining({
            conflicts: [".mcp.json"],
          }),
        }),
      );
      // ベースは前進しない（解決待ちに保留される）
      expect(mockSaveLock).not.toHaveBeenCalledWith(
        expect.any(String),
        expect.objectContaining({ sync: "synced" }),
      );
    });

    it("解決待ちの lock で --continue なしの pull を実行すると、再マージせず --continue を案内して中断する", async () => {
      vol.fromJSON({
        "/test/.mcp.json": "<<<<<<< LOCAL\nlocal\n=======\ntemplate\n>>>>>>> TEMPLATE",
      });

      const { effect, cleanup } = mockContext({
        lock: mergingLock([".mcp.json"], { hashes: { ".mcp.json": "hash123" } }),
      });
      mockLoadCommandContext.mockReturnValue(effect);

      await expect(
        (pullCommand.run as any)({
          args: { dir: "/test", force: false, yes: false, continue: false },
          rawArgs: [],
          cmd: pullCommand,
        }),
      ).rejects.toThrow("Merge already in progress");

      // マーカーは再マージされず、ファイルもロックも書き換わらない
      expect(mockMergeOneFile).not.toHaveBeenCalled();
      expect(mockSaveLock).not.toHaveBeenCalled();
      expect(vol.readFileSync("/test/.mcp.json", "utf8")).toContain("<<<<<<< LOCAL");
      expect(cleanup).toHaveBeenCalled();
    });

    it("--continue: 解決待ちのコンフリクトがない場合はエラー", async () => {
      mockLoadLock.mockReturnValueOnce(Effect.succeed(baseLock));

      await expect(
        (pullCommand.run as any)({
          args: { dir: "/test", force: false, yes: false, continue: true },
          rawArgs: [],
          cmd: pullCommand,
        }),
      ).rejects.toThrow(ZikuError);
    });

    it("--continue: コンフリクトマーカーが残っている場合はエラー", async () => {
      vol.fromJSON({
        "/test/.mcp.json": "<<<<<<< LOCAL\nlocal\n=======\ntemplate\n>>>>>>> TEMPLATE",
      });

      mockLoadLock.mockReturnValueOnce(
        Effect.succeed(
          mergingLock([".mcp.json"], {
            hashes: { ".mcp.json": "hash123" },
            commitSha: "latest123",
          }),
        ),
      );

      await expect(
        (pullCommand.run as any)({
          args: { dir: "/test", force: false, yes: false, continue: true },
          rawArgs: [],
          cmd: pullCommand,
        }),
      ).rejects.toThrow(ZikuError);
    });

    it("--continue: 全解決済みならベースを確定して解決待ちの記録を消す", async () => {
      vol.fromJSON({
        "/test/.mcp.json": "resolved content (no conflict markers)",
      });

      mockLoadLock.mockReturnValueOnce(
        Effect.succeed(
          mergingLock([".mcp.json"], {
            hashes: { ".mcp.json": "newhash" },
            commitSha: "newref123",
          }),
        ),
      );

      await (pullCommand.run as any)({
        args: { dir: "/test", force: false, yes: false, continue: true },
        rawArgs: [],
        cmd: pullCommand,
      });

      expect(mockSaveLock).toHaveBeenCalledWith(expect.any(String), {
        version: baseLock.version,
        installedAt: baseLock.installedAt,
        source: baseSource,
        sync: "synced",
        base: { hashes: { ".mcp.json": "newhash" }, ref: "newref123" },
      });
      // 確定後の lock に解決待ちの記録は残らない
      const savedLock = mockSaveLock.mock.calls.at(-1)?.[1];
      expect(savedLock).not.toHaveProperty("merge");
      expect(mockLog.success).toHaveBeenCalledWith("All conflicts resolved");
    });

    it("--continue --dryRun: 全解決済みでも saveLock を呼ばずベースを確定しない", async () => {
      vol.fromJSON({
        "/test/.mcp.json": "resolved content (no conflict markers)",
      });

      mockLoadLock.mockReturnValueOnce(
        Effect.succeed(
          mergingLock([".mcp.json"], {
            hashes: { ".mcp.json": "newhash" },
            commitSha: "newref123",
          }),
        ),
      );

      await (pullCommand.run as any)({
        args: { dir: "/test", force: false, yes: false, continue: true, dryRun: true },
        rawArgs: [],
        cmd: pullCommand,
      });

      expect(mockSaveLock).not.toHaveBeenCalled();
      expect(mockLog.info).toHaveBeenCalledWith("Dry run mode");
    });

    it("downloadBaseForMerge がベースのコミット SHA 付きで呼ばれる", async () => {
      vol.fromJSON({
        "/test/settings.json": '{"local": true}',
        "/tmp/template/settings.json": '{"template": true}',
      });

      const { effect } = mockContext({
        lock: lockWithBase({ "settings.json": "old-hash" }, "abc123"),
      });
      mockLoadCommandContext.mockReturnValue(effect);

      mockClassifyFiles.mockReturnValueOnce({
        autoUpdate: [],
        localOnly: [],
        conflicts: ["settings.json"],
        newFiles: [],
        deletedFiles: [],
        deletedWithLocalEdits: [],
        deletedLocally: [],
        unchanged: [],
      });

      // downloadBaseForMerge がベースを返す
      const baseCleanup = vi.fn();
      mockDownloadBaseForMerge.mockReturnValueOnce(
        Effect.succeed({ templateDir: "/tmp/base", cleanup: baseCleanup }),
      );

      mockMergeResult("settings.json", '{"merged": true}');

      await (pullCommand.run as any)({
        args: { dir: "/test", force: false, yes: false },
        rawArgs: [],
        cmd: pullCommand,
      });

      // downloadBaseForMerge に正しい引数が渡される
      expect(mockDownloadBaseForMerge).toHaveBeenCalledWith({
        lock: lockWithBase({ "settings.json": "old-hash" }, "abc123"),
        targetDir: "/test",
      });
      // mergeOneFile にベースツリーの所在が渡される
      expect(mockMergeOneFile).toHaveBeenCalledWith({
        file: "settings.json",
        targetDir: "/test",
        templateDir: "/tmp/template",
        base: { kind: "with-base", dir: "/tmp/base" },
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
          args: { dir: "/test", force: false, yes: false },
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
        deletedWithLocalEdits: [],
        deletedLocally: [],
        unchanged: [],
      });

      // 自動マージ成功
      mockBaseAvailable();
      mockMergeResult(".mcp.json", "auto-merged content");

      await (pullCommand.run as any)({
        args: { dir: "/test", force: false, yes: false },
        rawArgs: [],
        cmd: pullCommand,
      });

      // 自動マージ成功のメッセージが出力される
      expect(mockLog.success).toHaveBeenCalledWith(expect.stringContaining("Auto-merged"));
      expect(mockLog.success).toHaveBeenCalledWith(expect.stringContaining(".mcp.json"));
      // 解決待ちは保存されない（正常完了パス）
      expect(mockSaveLock).not.toHaveBeenCalledWith(
        expect.any(String),
        expect.objectContaining({ sync: "merging" }),
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
        deletedWithLocalEdits: [],
        deletedLocally: [],
        unchanged: [],
      });

      // a.json: 自動マージ成功
      mockBaseAvailable();
      mockMergeResult("a.json", "merged a");
      // b.txt: コンフリクト（テキストマーカー）
      mockMergeResult("b.txt", "<<<<<<< LOCAL\nlocal b\n=======\ntemplate b\n>>>>>>> TEMPLATE");

      await (pullCommand.run as any)({
        args: { dir: "/test", force: false, yes: false },
        rawArgs: [],
        cmd: pullCommand,
      });

      // a.json は自動マージ成功
      expect(mockLog.success).toHaveBeenCalledWith(expect.stringContaining("Auto-merged"));
      expect(mockLog.success).toHaveBeenCalledWith(expect.stringContaining("a.json"));
      // b.txt はコンフリクト
      expect(mockLog.warn).toHaveBeenCalledWith(expect.stringContaining("b.txt"));
      // 未解決コンフリクトがあるので解決待ちとして保存される
      expect(mockSaveLock).toHaveBeenCalledWith(
        expect.any(String),
        expect.objectContaining({
          sync: "merging",
          merge: expect.objectContaining({
            conflicts: ["b.txt"],
          }),
        }),
      );
    });

    it("全コンフリクトが自動マージ成功した場合は解決待ちを残さず正常完了", async () => {
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
        deletedWithLocalEdits: [],
        deletedLocally: [],
        unchanged: [],
      });

      mockBaseAvailable();
      mockMergeResult("a.json", "merged a");
      mockMergeResult("b.json", "merged b");

      await (pullCommand.run as any)({
        args: { dir: "/test", force: false, yes: false },
        rawArgs: [],
        cmd: pullCommand,
      });

      // 両方自動マージ成功
      expect(mockLog.success).toHaveBeenCalledWith(expect.stringContaining("a.json"));
      expect(mockLog.success).toHaveBeenCalledWith(expect.stringContaining("b.json"));
      // 解決待ちを残さず正常完了
      expect(mockSaveLock).toHaveBeenCalledWith(
        expect.any(String),
        expect.objectContaining({
          sync: "synced",
          base: expect.objectContaining({ hashes: expect.any(Object) }),
        }),
      );
      expect(mockSaveLock).not.toHaveBeenCalledWith(
        expect.any(String),
        expect.objectContaining({ sync: "merging" }),
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
        deletedWithLocalEdits: [],
        deletedLocally: [],
        unchanged: [],
      });

      mockBaseAvailable();
      mockMergeResult(
        "config.json",
        '<<<<<<< LOCAL\n{"version": "2.0"}\n=======\n{"version": "3.0"}\n>>>>>>> TEMPLATE',
      );

      await (pullCommand.run as any)({
        args: { dir: "/test", force: false, yes: false },
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
        deletedWithLocalEdits: [],
        deletedLocally: [],
        unchanged: [],
      });

      await (pullCommand.run as any)({
        args: { dir: "/test", force: false, yes: false },
        rawArgs: [],
        cmd: pullCommand,
      });

      // writeFileEnsureDir がディレクトリ作成含めて呼ばれる
      expect(mockWriteFileEnsureDir).toHaveBeenCalledWith(
        "/test/.devcontainer/config.json",
        Buffer.from('{"key": "value"}'),
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
        lock: lockWithBase({ ".claude/rules/worktree.md": "abc123" }, "abc123def456"),
      });
      mockLoadCommandContext.mockReturnValue(effect);

      mockClassifyFiles.mockReturnValueOnce({
        autoUpdate: [],
        localOnly: [],
        conflicts: [".claude/rules/worktree.md"],
        newFiles: [],
        deletedFiles: [],
        deletedWithLocalEdits: [],
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
      );

      // ENOENT で落ちずに正常終了することを検証
      await (pullCommand.run as any)({
        args: { dir: "/test", force: false, yes: false },
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
        base: { kind: "with-base", dir: "/tmp/base-template" },
      });

      // writeFileEnsureDir でファイルが書き込まれること（ディレクトリ作成含む）
      expect(mockWriteFileEnsureDir).toHaveBeenCalledWith(
        "/test/.claude/rules/worktree.md",
        expect.stringContaining("<<<<<<< LOCAL"),
      );
    });
  });

  describe("dry run (--dryRun)", () => {
    it("dryRun 引数のデフォルト値は false", () => {
      const args = pullCommand.args as { dryRun: { default: boolean } };
      expect(args.dryRun.default).toBe(false);
    });

    it("autoUpdate/newFiles があってもファイルを書き込まず lock も更新しない", async () => {
      vol.fromJSON({
        "/test": null,
        "/tmp/template/.mcp.json": "template content",
        "/tmp/template/.new-file": "new content",
      });

      mockClassifyFiles.mockReturnValueOnce({
        autoUpdate: [".mcp.json"],
        localOnly: [],
        conflicts: [],
        newFiles: [".new-file"],
        deletedFiles: [],
        deletedWithLocalEdits: [],
        deletedLocally: [],
        unchanged: [],
      });

      await (pullCommand.run as any)({
        args: { dir: "/test", force: false, yes: false, dryRun: true },
        rawArgs: [],
        cmd: pullCommand,
      });

      expect(mockWriteFileEnsureDir).not.toHaveBeenCalled();
      expect(vol.existsSync("/test/.mcp.json")).toBe(false);
      expect(vol.existsSync("/test/.new-file")).toBe(false);
      expect(mockSaveLock).not.toHaveBeenCalled();
      expect(mockLog.info).toHaveBeenCalledWith("Dry run mode");
    });

    it("コンフリクトは auto-merge を試すが結果をディスクへ書き込まない", async () => {
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
        deletedWithLocalEdits: [],
        deletedLocally: [],
        unchanged: [],
      });

      mockBaseAvailable();
      mockMergeResult(".mcp.json", "merged content");

      await (pullCommand.run as any)({
        args: { dir: "/test", force: false, yes: false, dryRun: true },
        rawArgs: [],
        cmd: pullCommand,
      });

      // auto-merge 自体は試す（結果のプレビューのため）
      expect(mockMergeOneFile).toHaveBeenCalled();
      // しかしディスクには書き込まない
      expect(mockWriteFileEnsureDir).not.toHaveBeenCalled();
      expect(mockLog.success).toHaveBeenCalledWith(expect.stringContaining("Would auto-merge"));
      expect(mockSaveLock).not.toHaveBeenCalled();
    });

    it("未解決コンフリクトは「manual resolution」ではなく「would need manual resolution」と表示する", async () => {
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
        deletedWithLocalEdits: [],
        deletedLocally: [],
        unchanged: [],
      });

      mockBaseAvailable();
      mockMergeResult(
        ".mcp.json",
        "<<<<<<< LOCAL\nlocal content\n=======\ntemplate content\n>>>>>>> TEMPLATE",
      );

      await (pullCommand.run as any)({
        args: { dir: "/test", force: false, yes: false, dryRun: true },
        rawArgs: [],
        cmd: pullCommand,
      });

      expect(mockWriteFileEnsureDir).not.toHaveBeenCalled();
      expect(mockLog.warn).toHaveBeenCalledWith(
        expect.stringContaining("would need manual resolution"),
      );
      expect(mockLog.warn).toHaveBeenCalledWith(expect.stringContaining("Pull would pause here"));
    });

    it("削除対象ファイルがあっても selectDeletedFiles を呼ばず、実際には削除しない", async () => {
      vol.fromJSON({
        "/test/old-file.txt": "old content",
      });

      mockClassifyFiles.mockReturnValueOnce({
        autoUpdate: [],
        localOnly: [],
        conflicts: [],
        newFiles: [],
        deletedFiles: ["old-file.txt"],
        deletedWithLocalEdits: [],
        deletedLocally: [],
        unchanged: [],
      });

      await (pullCommand.run as any)({
        args: { dir: "/test", force: false, yes: false, dryRun: true },
        rawArgs: [],
        cmd: pullCommand,
      });

      expect(mockSelectDeletedFiles).not.toHaveBeenCalled();
      expect(vol.existsSync("/test/old-file.txt")).toBe(true);
      expect(mockLog.info).toHaveBeenCalledWith(
        expect.stringContaining("would be candidates for deletion"),
      );
    });

    it("変更が無い場合は dryRun でも通常どおり 'Already up to date'", async () => {
      vol.fromJSON({ "/test": null });

      mockClassifyFiles.mockReturnValueOnce({
        autoUpdate: [],
        localOnly: [],
        conflicts: [],
        newFiles: [],
        deletedFiles: [],
        deletedWithLocalEdits: [],
        deletedLocally: [],
        unchanged: [".mcp.json"],
      });

      await (pullCommand.run as any)({
        args: { dir: "/test", force: false, yes: false, dryRun: true },
        rawArgs: [],
        cmd: pullCommand,
      });

      expect(mockLog.success).toHaveBeenCalledWith("Already up to date");
      expect(mockSaveLock).not.toHaveBeenCalled();
    });
  });
});
