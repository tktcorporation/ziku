import { vol } from "memfs";
import { Effect, Option } from "effect";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { FileNotFoundError, ZikuFailure, zikuFailure } from "../../errors";
import type {
  AbsPath,
  CommitSha,
  GitHubSource,
  GlobPattern,
  LockState,
  PendingConflicts,
  ResumableLockState,
  SyncPoint,
  TemplateSource,
} from "../../modules/schemas";
import {
  baseCommitSha,
  baseHashesOf,
  createPendingLock,
  markMerging,
  markSynced,
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
// runCommandEffect / toZikuFailure は実際の実装を使い、loadCommandContext だけモックする
vi.mock("../../services/command-context", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../../services/command-context")>();
  return {
    ...actual,
    loadCommandContext: vi.fn(),
  };
});

vi.mock("../../utils/template", async () => {
  const { templateRefToString } = await import("../../modules/schemas");
  return {
    downloadTemplateToTemp: vi.fn(),
    buildTemplateSource: vi.fn((source: GitHubSource) => {
      const base = `gh:${source.owner}/${source.repo}`;
      return source.ref ? `${base}#${templateRefToString(source.ref)}` : base;
    }),
    buildCommitPinnedSource: vi.fn(
      (source: { owner: string; repo: string }, sha: string) =>
        `gh:${source.owner}/${source.repo}#${sha}`,
    ),
  };
});

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

vi.mock("../../utils/github", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../../utils/github")>();
  return {
    resolveLatestCommitSha: vi.fn(() => Promise.resolve("latest123")),
    fetchDefaultBranch: vi.fn(() => Promise.resolve({ _tag: "Resolved" as const, name: "main" })),
    // 既定ブランチの控えへ倒す規則は実装を通す（コマンドの挙動そのものなのでモックしない）
    decideDefaultBranch: actual.decideDefaultBranch,
  };
});

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
  selectUnmergedResolution: vi.fn(() => Promise.resolve("keepLocal")),
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
const { selectDeletedFiles, selectDeletedFilesWithLocalEdits, selectUnmergedResolution } =
  await import("../../ui/prompts");
const mockSelectDeletedFiles = vi.mocked(selectDeletedFiles);
const mockSelectDeletedFilesWithLocalEdits = vi.mocked(selectDeletedFilesWithLocalEdits);
const mockSelectUnmergedResolution = vi.mocked(selectUnmergedResolution);
const { downloadTemplateToTemp, buildCommitPinnedSource } = await import("../../utils/template");
const { fetchDefaultBranch } = await import("../../utils/github");
const mockFetchDefaultBranch = vi.mocked(fetchDefaultBranch);
const { zikuConfigExists } = await import("../../utils/ziku-config");
const { loadLock, saveLock } = await import("../../utils/lock");
const { loadTemplateConfig } = await import("../../utils/template-config");
const { hashContent, hashFiles } = await import("../../utils/hash");
const { classifyFiles, mergeOneFile, writeFileEnsureDir, downloadBaseForMerge } =
  await import("../../utils/merge");
// マージ結果の判定は本物を使う（"../../utils/merge" のモックは index 経由の import だけを
// 置き換えるので、実装モジュールを直接読み込めば素の関数が得られる）。
const { classifyMergeOutcome } = await import("../../utils/merge/types");
const { log } = await import("../../ui/renderer");
const {
  absPath,
  commitSha,
  globPatterns,
  hashMap,
  pendingConflict,
  repoRelPath,
  repoRelPaths,
  resolvedTemplate,
} = await import("../../__tests__/brands");

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
  include: globPatterns([".mcp.json", ".mise.toml"]),
  exclude: [],
};

const baseSource: TemplateSource = { kind: "github", owner: "tktcorporation", repo: ".github" };

const baseLock: ResumableLockState = {
  version: "0.1.0",
  installedAt: "2024-01-01T00:00:00.000Z",
  source: baseSource,
  sync: "synced",
  base: { hashes: hashMap({ ".mcp.json": "abc123" }) },
};

/** baseLock のベースだけ差し替えたロックを作る。 */
function lockWithBase(hashes: Record<string, string>, sha?: string): LockState {
  return markSynced(baseLock, {
    hashes: hashMap(hashes),
    commitSha: sha === undefined ? undefined : commitSha(sha),
  });
}

/** 直近に保存された lock。saveLock が呼ばれていなければ失敗する。 */
function lastSavedLock(): LockState {
  const saved = mockSaveLock.mock.calls.at(-1)?.[1];
  if (saved === undefined) throw new Error("saveLock was not called");
  return saved;
}

/**
 * pull が投げた `ZikuFailure` を取り出す。
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
function mergingLock(conflicts: PendingConflicts, next: SyncPoint): LockState {
  return markMerging(baseLock, next, conflicts);
}

const localTemplateSource: TemplateSource = { kind: "local", path: absPath("/tmp/local-template") };

/**
 * ローカルテンプレートを参照する同期済みロック。
 *
 * ローカルソースには過去のツリーを取り直す手段が無いため、`--continue` が読むのは常に現在の
 * テンプレートディレクトリになる。その経路を通すためのフィクスチャ。
 */
const localBaseLock: ResumableLockState = markSynced(
  createPendingLock({
    version: "0.1.0",
    installedAt: "2024-01-01T00:00:00.000Z",
    source: localTemplateSource,
  }),
  { hashes: hashMap({ ".mcp.json": "abc123" }) },
);

/**
 * テスト用の CommandContext を生成するヘルパー。
 * 通常モード（--continue 以外）で loadCommandContext の戻り値として使う。
 */
function mockContext(overrides?: {
  config?: { include: GlobPattern[]; exclude?: GlobPattern[] };
  lock?: LockState;
  source?: TemplateSource;
  templateDir?: AbsPath;
  resolveBaseRef?: Effect.Effect<Option.Option<CommitSha>, ZikuFailure>;
}) {
  const cleanup = vi.fn();
  const source = overrides?.source ?? baseSource;
  const templateDir = overrides?.templateDir ?? absPath("/tmp/template");
  return {
    effect: Effect.succeed({
      config: overrides?.config ?? baseZikuConfig,
      lock: overrides?.lock ?? baseLock,
      source,
      resolved: resolvedTemplate({ source, dir: templateDir }),
      templateDir,
      cleanup,
      resolveBaseRef: overrides?.resolveBaseRef ?? Effect.succeed(Option.none<CommitSha>()),
    }),
    cleanup,
  };
}

/**
 * hashFiles の走査結果（template → local の順）を与える。
 *
 * 既定の空マップのままだと、分類がローカルに実在するとしているファイル（`deletedFiles` や
 * `deletedWithLocalEdits`）が走査結果に現れず、実装では作れない状態になる。削除の扱いは
 * 走査結果を見て決まるので、そこを合わせないと本番と違う経路を検証してしまう。
 */
function mockScannedHashes(files: {
  template?: Record<string, string>;
  local: Record<string, string>;
}): void {
  mockHashFiles
    .mockResolvedValueOnce(hashMap(files.template ?? {}))
    .mockResolvedValueOnce(hashMap(files.local));
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
    Effect.succeed({ file: repoRelPath(file), outcome: classifyMergeOutcome(content) }),
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
  mockDownloadBaseForMerge.mockReturnValueOnce(
    Effect.succeed({ templateDir: absPath(templateDir), cleanup }),
  );
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
      templateDir: absPath("/tmp/template"),
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

      const failure = await captureFailure(() =>
        (pullCommand.run as any)({
          args: { dir: "/test", force: false, yes: false },
          rawArgs: [],
          cmd: pullCommand,
        }),
      );

      expect(failure.reason).toEqual({ kind: "NotInitialized", path: ".ziku/ziku.jsonc" });
      expect(failure.hint).toContain("ziku init");
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
        unchanged: repoRelPaths([".mcp.json"]),
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
          include: globPatterns([".root/**", ".github/**", ".new-pattern/**"]),
          exclude: undefined,
        }),
      );
      // ziku.jsonc 自体が autoUpdate に分類される（テンプレ側で内容が変わったため）
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

    it("テンプレ側だけがパターンを削除しても（autoUpdate）ローカルからは消さない", async () => {
      // テンプレが .github/** を削除。ziku.jsonc は autoUpdate に分類されるが、
      // 丸ごとコピーではなく union マージなので、削除は伝播せずローカルに残る。
      vol.fromJSON({
        "/test/.ziku/ziku.jsonc": JSON.stringify({ include: [".root/**", ".github/**"] }, null, 2),
        "/tmp/template/.ziku/ziku.jsonc": JSON.stringify({ include: [".root/**"] }, null, 2),
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

    it("テンプレ削除+追加の混在: lock の base[ziku.jsonc] は union 内容に揃う（push 再追加を防ぐ）", async () => {
      // テンプレが .b/** を削除し .c/** を追加。union=[.a,.b,.c]。base はテンプレ([.a,.c])
      // ではなく union([.a,.b,.c]) のハッシュで記録され、後続 push が .b/** を再追加しない。
      vol.fromJSON({
        "/test/.ziku/ziku.jsonc": JSON.stringify({ include: [".a/**", ".b/**"] }, null, 2),
        "/tmp/template/.ziku/ziku.jsonc": JSON.stringify({ include: [".a/**", ".c/**"] }, null, 2),
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
      const saveArg = lastSavedLock();
      expect(baseHashesOf(saveArg)[repoRelPath(".ziku/ziku.jsonc")]).toBe(hashContent(written));
    });

    it("テンプレが ziku.jsonc ファイル自体を削除しても、ローカルの制御ファイルは消さない", async () => {
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
        deletedFiles: repoRelPaths([".ziku/ziku.jsonc"]),
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

    it("ファイル書き込みが無くても config の base 更新が必要なら lock を保存する", async () => {
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
        autoUpdate: repoRelPaths([".ziku/ziku.jsonc"]),
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
      expect(baseHashesOf(saveArg)[repoRelPath(".ziku/ziku.jsonc")]).not.toBe("stale-old-hash");
    });

    it("自動更新ファイルをコピー", async () => {
      vol.fromJSON({
        "/test/.mcp.json": '{"old": true}',
        "/tmp/template/.mcp.json": '{"new": true}',
      });

      mockClassifyFiles.mockReturnValueOnce({
        autoUpdate: repoRelPaths([".mcp.json"]),
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
        newFiles: repoRelPaths([".new-file"]),
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
        conflicts: repoRelPaths([".mcp.json"]),
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
          // ベース不在は経路まで記録する。--continue はマーカーの消滅では確定できない。
          merge: expect.objectContaining({
            conflicts: [{ path: ".mcp.json", reason: "noBase" }],
          }),
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
        conflicts: repoRelPaths([".ziku/ziku.jsonc"]),
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
        deletedFiles: repoRelPaths([".old-file"]),
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
      vol.fromJSON({ "/test/old-file.txt": "old content" });

      mockScannedHashes({ local: { "old-file.txt": "hash-old" } });
      mockClassifyFiles.mockReturnValueOnce({
        autoUpdate: [],
        localOnly: [],
        conflicts: [],
        newFiles: [],
        deletedFiles: repoRelPaths(["old-file.txt"]),
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

      mockScannedHashes({ local: { "old-file.txt": "hash-old" } });
      mockClassifyFiles.mockReturnValueOnce({
        autoUpdate: [],
        localOnly: [],
        conflicts: [],
        newFiles: [],
        deletedFiles: repoRelPaths(["old-file.txt"]),
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

      mockScannedHashes({ local: { "old-file.txt": "hash-old" } });
      mockClassifyFiles.mockReturnValueOnce({
        autoUpdate: [],
        localOnly: [],
        conflicts: [],
        newFiles: [],
        deletedFiles: repoRelPaths(["old-file.txt"]),
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

      mockScannedHashes({ local: { "old-file.txt": "hash-old" } });
      mockClassifyFiles.mockReturnValueOnce({
        autoUpdate: [],
        localOnly: [],
        conflicts: [],
        newFiles: [],
        deletedFiles: repoRelPaths(["old-file.txt"]),
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

      mockScannedHashes({ local: { "edited.md": "hash-edited" } });
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

      mockScannedHashes({ local: { "edited.md": "hash-edited" } });
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

      mockScannedHashes({ local: { "chosen.md": "hash-chosen", "kept.md": "hash-kept" } });
      mockClassifyFiles.mockReturnValueOnce({
        autoUpdate: [],
        localOnly: [],
        conflicts: [],
        newFiles: [],
        deletedFiles: [],
        deletedWithLocalEdits: repoRelPaths(["chosen.md", "kept.md"]),
        deletedLocally: [],
        unchanged: [],
      });
      mockSelectDeletedFilesWithLocalEdits.mockResolvedValueOnce(repoRelPaths(["chosen.md"]));

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

      mockScannedHashes({ local: { "a.txt": "hash-a", "b.txt": "hash-b" } });
      mockClassifyFiles.mockReturnValueOnce({
        autoUpdate: [],
        localOnly: [],
        conflicts: [],
        newFiles: [],
        deletedFiles: repoRelPaths(["a.txt", "b.txt"]),
        deletedWithLocalEdits: [],
        deletedLocally: [],
        unchanged: [],
      });
      mockSelectDeletedFiles.mockResolvedValueOnce(repoRelPaths(["a.txt"]));

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
        autoUpdate: repoRelPaths([".mcp.json"]),
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
        resolveBaseRef: Effect.succeed(Option.some(commitSha("newsha456"))),
      });
      mockLoadCommandContext.mockReturnValue(effect);

      mockClassifyFiles.mockReturnValueOnce({
        autoUpdate: repoRelPaths([".mcp.json"]),
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

    it("resolveBaseRef が認証拒否で失敗したとき、古いベースへ倒さず中断する", async () => {
      vol.fromJSON({
        "/test": null,
        "/tmp/template/.mcp.json": "updated",
      });

      const { effect } = mockContext({
        lock: lockWithBase({ ".mcp.json": "abc123" }, "existing-sha"),
        resolveBaseRef: Effect.fail(
          zikuFailure({ kind: "GitHubAuthRejected", detail: "Bad credentials" }),
        ),
      });
      mockLoadCommandContext.mockReturnValue(effect);

      mockClassifyFiles.mockReturnValueOnce({
        autoUpdate: repoRelPaths([".mcp.json"]),
        localOnly: [],
        conflicts: [],
        newFiles: [],
        deletedFiles: [],
        deletedWithLocalEdits: [],
        deletedLocally: [],
        unchanged: [],
      });

      const failure = await captureFailure(() =>
        (pullCommand.run as any)({
          args: { dir: "/test", force: false, yes: false },
          rawArgs: [],
          cmd: pullCommand,
        }),
      );

      expect(failure.reason.kind).toBe("GitHubAuthRejected");
      // lock を書かないだけでなく、ファイルへも触れないまま止まる
      expect(mockSaveLock).not.toHaveBeenCalled();
      expect(mockWriteFileEnsureDir).not.toHaveBeenCalled();
    });

    it("resolveBaseRef が None のとき、ハッシュだけ前進させて古いベース SHA を落とす", async () => {
      vol.fromJSON({
        "/test": null,
        "/tmp/template/.mcp.json": "updated",
      });

      const newTemplateHashes = { ".mcp.json": "new-template-hash" };
      const { effect } = mockContext({
        lock: lockWithBase({ ".mcp.json": "abc123" }, "existing-sha"),
        resolveBaseRef: Effect.succeed(Option.none<CommitSha>()),
      });
      mockLoadCommandContext.mockReturnValue(effect);
      mockScannedHashes({ template: newTemplateHashes, local: newTemplateHashes });

      mockClassifyFiles.mockReturnValueOnce({
        autoUpdate: repoRelPaths([".mcp.json"]),
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

      // ハッシュが取り込んだツリーへ進んだのに SHA が前回のツリーを指したままだと、後の
      // コンフリクトで共通祖先が前回のツリーになり、取り込み済みの変更が再びマージに載る。
      const lockArg = lastSavedLock();
      expect(lockArg.sync).toBe("synced");
      expect(baseHashesOf(lockArg)).toEqual(newTemplateHashes);
      expect(baseCommitSha(lockArg)).toBeUndefined();
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
        unchanged: repoRelPaths([".mcp.json"]),
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
        conflicts: repoRelPaths([".mcp.json"]),
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
            conflicts: [pendingConflict(".mcp.json")],
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
        lock: mergingLock([pendingConflict(".mcp.json")], {
          hashes: hashMap({ ".mcp.json": "hash123" }),
        }),
      });
      mockLoadCommandContext.mockReturnValue(effect);

      const failure = await captureFailure(() =>
        (pullCommand.run as any)({
          args: { dir: "/test", force: false, yes: false, continue: false },
          rawArgs: [],
          cmd: pullCommand,
        }),
      );

      expect(failure.reason).toEqual({ kind: "MergePaused", conflicts: [".mcp.json"] });
      expect(failure.message).toContain("Merge already in progress");
      // 解決すべきファイルと、続きに使うコマンドの両方を hint が答える
      expect(failure.hint).toContain(".mcp.json");
      expect(failure.hint).toContain("ziku pull --continue");

      // マーカーは再マージされず、ファイルもロックも書き換わらない
      expect(mockMergeOneFile).not.toHaveBeenCalled();
      expect(mockSaveLock).not.toHaveBeenCalled();
      expect(vol.readFileSync("/test/.mcp.json", "utf8")).toContain("<<<<<<< LOCAL");
      expect(cleanup).toHaveBeenCalled();
    });

    it("--continue: 解決待ちのコンフリクトがない場合はエラー", async () => {
      mockLoadLock.mockReturnValueOnce(Effect.succeed(baseLock));

      const failure = await captureFailure(() =>
        (pullCommand.run as any)({
          args: { dir: "/test", force: false, yes: false, continue: true },
          rawArgs: [],
          cmd: pullCommand,
        }),
      );

      expect(failure.reason).toEqual({ kind: "NoMergePaused" });
      expect(failure.message).toContain("No pending merge found");
      // 解決待ちが無いので、案内は --continue ではなく通常の pull へ向く
      expect(failure.hint).toContain("Run `ziku pull` first");
    });

    it("--continue: 未初期化なら init を案内する", async () => {
      mockZikuConfigExists.mockReturnValue(false);

      const failure = await captureFailure(() =>
        (pullCommand.run as any)({
          args: { dir: "/test", force: false, yes: false, continue: true },
          rawArgs: [],
          cmd: pullCommand,
        }),
      );

      expect(failure.reason).toEqual({ kind: "NotInitialized", path: ".ziku/ziku.jsonc" });
      expect(failure.hint).toContain("ziku init");
    });

    it("--continue: コンフリクトマーカーが残っている場合はエラー", async () => {
      vol.fromJSON({
        "/test/.mcp.json": "<<<<<<< LOCAL\nlocal\n=======\ntemplate\n>>>>>>> TEMPLATE",
      });

      mockLoadLock.mockReturnValueOnce(
        Effect.succeed(
          mergingLock([pendingConflict(".mcp.json")], {
            hashes: hashMap({ ".mcp.json": "hash123" }),
            commitSha: commitSha("latest123"),
          }),
        ),
      );

      const failure = await captureFailure(() =>
        (pullCommand.run as any)({
          args: { dir: "/test", force: false, yes: false, continue: true },
          rawArgs: [],
          cmd: pullCommand,
        }),
      );

      expect(failure.reason).toEqual({
        kind: "ConflictsUnresolved",
        files: [{ path: ".mcp.json", lines: [1] }],
      });
      expect(failure.message).toContain("Unresolved conflict markers remain");
      // コマンドは合っているので、hint は編集すべき箇所を行番号まで示す
      expect(failure.hint).toContain(".mcp.json (line 1)");
      expect(failure.hint).toContain("ziku pull --continue");
    });

    it("--continue: 全解決済みならベースを確定して解決待ちの記録を消す", async () => {
      vol.fromJSON({
        "/test/.mcp.json": "resolved content (no conflict markers)",
      });

      mockLoadLock.mockReturnValueOnce(
        Effect.succeed(
          mergingLock([pendingConflict(".mcp.json")], {
            hashes: hashMap({ ".mcp.json": "newhash" }),
            commitSha: commitSha("newref123"),
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
          mergingLock([pendingConflict(".mcp.json")], {
            hashes: hashMap({ ".mcp.json": "newhash" }),
            commitSha: commitSha("newref123"),
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

    it("--continue --dryRun --yes: 選択を求められる見込みでもプレビューを出して正常終了する", async () => {
      // プレビューは「実行すると何が起きるか」を見せるためのもの。選択できない実行だから
      // といって中断すると、中断の理由を実行前に確かめる手段が無くなる。
      vol.fromJSON({ "/test/icon.png": "local bytes" });

      mockLoadLock.mockReturnValueOnce(
        Effect.succeed(
          mergingLock([pendingConflict("icon.png", "binary")], {
            hashes: hashMap({ "icon.png": "newhash" }),
          }),
        ),
      );

      await (pullCommand.run as any)({
        args: { dir: "/test", force: false, yes: true, continue: true, dryRun: true },
        rawArgs: [],
        cmd: pullCommand,
      });

      expect(mockLog.info).toHaveBeenCalledWith("Dry run mode");
      // 対象ファイルと、この実行が中断する見込みの両方が出る
      expect(mockLog.message).toHaveBeenCalledWith(expect.stringContaining("icon.png"));
      expect(mockLog.warn).toHaveBeenCalledWith(expect.stringContaining("would stop"));
      // プレビューなので確定もしないし、選択も求めない
      expect(mockSaveLock).not.toHaveBeenCalled();
      expect(mockSelectUnmergedResolution).not.toHaveBeenCalled();
    });

    it("--continue: 自動マージを試みていないファイルは、マーカーが無くても完了扱いにしない", async () => {
      // ベース不在で未解決になったファイルは ziku が何も書いていない。マーカーが無いことを
      // 解決の証拠にすると、テンプレートの変更を取り込まないままベースだけが前進する。
      vol.fromJSON({ "/test/.mcp.json": "local content (never touched by ziku)" });

      mockLoadLock.mockReturnValueOnce(
        Effect.succeed(
          mergingLock([pendingConflict(".mcp.json", "noBase")], {
            hashes: hashMap({ ".mcp.json": "newhash" }),
            commitSha: commitSha("newref123"),
          }),
        ),
      );

      await (pullCommand.run as any)({
        args: { dir: "/test", force: false, yes: false, continue: true },
        rawArgs: [],
        cmd: pullCommand,
      });

      expect(mockSelectUnmergedResolution).toHaveBeenCalledWith({
        path: ".mcp.json",
        reason: "noBase",
      });
    });

    it("--continue: バイナリで未解決になったファイルも選択を求める", async () => {
      vol.fromJSON({ "/test/icon.png": "local bytes" });

      mockLoadLock.mockReturnValueOnce(
        Effect.succeed(
          mergingLock([pendingConflict("icon.png", "binary")], {
            hashes: hashMap({ "icon.png": "newhash" }),
            commitSha: commitSha("newref123"),
          }),
        ),
      );

      await (pullCommand.run as any)({
        args: { dir: "/test", force: false, yes: false, continue: true },
        rawArgs: [],
        cmd: pullCommand,
      });

      expect(mockSelectUnmergedResolution).toHaveBeenCalledWith({
        path: "icon.png",
        reason: "binary",
      });
    });

    it("--continue: ローカルを残す選択でも、ベースはテンプレート側へ前進する", async () => {
      // 「ローカルを残す」はテンプレートの変更を意図して拒否したという意思表示なので、
      // 次回以降その差分を蒸し返さない。
      vol.fromJSON({ "/test/.mcp.json": "local content" });

      mockLoadLock.mockReturnValueOnce(
        Effect.succeed(
          mergingLock([pendingConflict(".mcp.json", "noBase")], {
            hashes: hashMap({ ".mcp.json": "newhash" }),
            commitSha: commitSha("newref123"),
          }),
        ),
      );
      mockSelectUnmergedResolution.mockResolvedValueOnce("keepLocal");

      await (pullCommand.run as any)({
        args: { dir: "/test", force: false, yes: false, continue: true },
        rawArgs: [],
        cmd: pullCommand,
      });

      expect(lastSavedLock()).toEqual({
        version: baseLock.version,
        installedAt: baseLock.installedAt,
        source: baseSource,
        sync: "synced",
        base: { hashes: { ".mcp.json": "newhash" }, ref: "newref123" },
      });
      // ローカルには触れない
      expect(mockWriteFileEnsureDir).not.toHaveBeenCalled();
    });

    it("--continue: テンプレートを取る選択は、中断時点のテンプレートの内容で上書きする", async () => {
      vol.fromJSON({
        "/test/.mcp.json": "local content",
        "/tmp/paused-template/.mcp.json": "template content",
      });

      mockLoadLock.mockReturnValueOnce(
        Effect.succeed(
          mergingLock([pendingConflict(".mcp.json", "noBase")], {
            hashes: hashMap({ ".mcp.json": "newhash" }),
            commitSha: commitSha("newref123"),
          }),
        ),
      );
      mockSelectUnmergedResolution.mockResolvedValueOnce("takeTemplate");
      const cleanup = vi.fn();
      mockDownloadTemplateToTemp.mockResolvedValueOnce({
        templateDir: absPath("/tmp/paused-template"),
        cleanup,
      });

      await (pullCommand.run as any)({
        args: { dir: "/test", force: false, yes: false, continue: true },
        rawArgs: [],
        cmd: pullCommand,
      });

      // 取り寄せるのは最新ではなく、確定するベースと同じコミット
      expect(buildCommitPinnedSource).toHaveBeenCalledWith(baseSource, "newref123");
      const written = mockWriteFileEnsureDir.mock.calls.find(([p]) => p === "/test/.mcp.json");
      expect(written?.[1]?.toString()).toBe("template content");
      expect(cleanup).toHaveBeenCalled();
      // ベースに載るのは書き込んだ内容そのもののハッシュ
      expect(lastSavedLock()).toMatchObject({
        sync: "synced",
        base: { hashes: { ".mcp.json": hashContent("template content") } },
      });
    });

    it("--continue: ローカルテンプレートが中断後に変わっていても、書き込んだ内容とベースが一致する", async () => {
      // ローカルソースには中断時点のツリーを取り直す手段が無いので、書き込まれるのは中断後の
      // 内容になる。ベースを nextBase のまま確定すると、直後から同じファイルが localOnly として
      // 現れ、次の push が新しいテンプレートの内容をローカルの変更として送り返す。
      const editedAfterPause = "template content edited after the pause";
      vol.fromJSON({
        "/test/.mcp.json": "local content",
        "/tmp/local-template/.mcp.json": editedAfterPause,
      });

      mockLoadLock.mockReturnValueOnce(
        Effect.succeed(
          markMerging(localBaseLock, { hashes: hashMap({ ".mcp.json": "paused-template-hash" }) }, [
            pendingConflict(".mcp.json", "noBase"),
          ]),
        ),
      );
      mockSelectUnmergedResolution.mockResolvedValueOnce("takeTemplate");

      await (pullCommand.run as any)({
        args: { dir: "/test", force: false, yes: false, continue: true },
        rawArgs: [],
        cmd: pullCommand,
      });

      const written = mockWriteFileEnsureDir.mock.calls.find(([p]) => p === "/test/.mcp.json");
      expect(written?.[1]?.toString()).toBe(editedAfterPause);
      expect(lastSavedLock()).toMatchObject({
        sync: "synced",
        base: { hashes: { ".mcp.json": hashContent(editedAfterPause) } },
      });
    });

    it("--continue: 中断時に SHA を確定できていなければ、既定ブランチから取り寄せる", async () => {
      // giget の既定 (main) へ倒すと、既定ブランチが master のリポジトリでは書き込む内容だけが
      // 別ブランチのツリー由来になる。
      vol.fromJSON({
        "/test/.mcp.json": "local content",
        "/tmp/paused-template/.mcp.json": "template content",
      });

      mockLoadLock.mockReturnValueOnce(
        Effect.succeed(
          mergingLock([pendingConflict(".mcp.json", "noBase")], {
            hashes: hashMap({ ".mcp.json": "newhash" }),
          }),
        ),
      );
      mockSelectUnmergedResolution.mockResolvedValueOnce("takeTemplate");
      mockFetchDefaultBranch.mockResolvedValueOnce({ _tag: "Resolved", name: "master" });
      mockDownloadTemplateToTemp.mockResolvedValueOnce({
        templateDir: absPath("/tmp/paused-template"),
        cleanup: vi.fn(),
      });

      await (pullCommand.run as any)({
        args: { dir: "/test", force: false, yes: false, continue: true },
        rawArgs: [],
        cmd: pullCommand,
      });

      expect(mockDownloadTemplateToTemp).toHaveBeenCalledWith(
        expect.any(String),
        "gh:tktcorporation/.github#master",
        "continue",
      );
      const written = mockWriteFileEnsureDir.mock.calls.find(([p]) => p === "/test/.mcp.json");
      expect(written?.[1]?.toString()).toBe("template content");
    });

    it("--continue: 既定ブランチを引けず控えも無ければ、取得せずに中断してベースを前進させない", async () => {
      vol.fromJSON({ "/test/.mcp.json": "local content" });

      mockLoadLock.mockReturnValueOnce(
        Effect.succeed(
          mergingLock([pendingConflict(".mcp.json", "noBase")], {
            hashes: hashMap({ ".mcp.json": "newhash" }),
          }),
        ),
      );
      mockSelectUnmergedResolution.mockResolvedValueOnce("takeTemplate");
      mockFetchDefaultBranch.mockResolvedValueOnce({
        _tag: "Unresolved",
        reason: "rate limit exceeded",
      });

      const failure = await captureFailure(() =>
        (pullCommand.run as any)({
          args: { dir: "/test", force: false, yes: false, continue: true },
          rawArgs: [],
          cmd: pullCommand,
        }),
      );

      expect(failure.reason).toMatchObject({
        kind: "DefaultBranchUnresolved",
        repo: "tktcorporation/.github",
      });
      expect(mockDownloadTemplateToTemp).not.toHaveBeenCalled();
      expect(mockSaveLock).not.toHaveBeenCalled();
    });

    it("--continue: レート制限でも、控えた既定ブランチから取り寄せて解決を進める", async () => {
      vol.fromJSON({
        "/test/.mcp.json": "local content",
        "/tmp/paused-template/.mcp.json": "template content",
      });

      mockLoadLock.mockReturnValueOnce(
        Effect.succeed(
          markMerging(
            { ...baseLock, source: { ...baseSource, kind: "github", defaultBranch: "master" } },
            { hashes: hashMap({ ".mcp.json": "newhash" }) },
            [pendingConflict(".mcp.json", "noBase")],
          ),
        ),
      );
      mockSelectUnmergedResolution.mockResolvedValueOnce("takeTemplate");
      mockFetchDefaultBranch.mockResolvedValueOnce({
        _tag: "Unresolved",
        reason: "rate limit exceeded",
      });
      mockDownloadTemplateToTemp.mockResolvedValueOnce({
        templateDir: absPath("/tmp/paused-template"),
        cleanup: vi.fn(),
      });

      await (pullCommand.run as any)({
        args: { dir: "/test", force: false, yes: false, continue: true },
        rawArgs: [],
        cmd: pullCommand,
      });

      expect(mockDownloadTemplateToTemp).toHaveBeenCalledWith(
        expect.any(String),
        "gh:tktcorporation/.github#master",
        "continue",
      );
      expect(mockSaveLock).toHaveBeenCalled();
    });

    it("--continue: テンプレートを取り寄せられなければベースを前進させない", async () => {
      // 取り込めていないのにベースだけ進むと、テンプレートの変更が消えたまま解決済みになる。
      vol.fromJSON({ "/test/.mcp.json": "local content" });

      mockLoadLock.mockReturnValueOnce(
        Effect.succeed(
          mergingLock([pendingConflict(".mcp.json", "noBase")], {
            hashes: hashMap({ ".mcp.json": "newhash" }),
            commitSha: commitSha("newref123"),
          }),
        ),
      );
      mockSelectUnmergedResolution.mockResolvedValueOnce("takeTemplate");
      mockDownloadTemplateToTemp.mockRejectedValueOnce(new Error("network down"));

      const failure = await captureFailure(() =>
        (pullCommand.run as any)({
          args: { dir: "/test", force: false, yes: false, continue: true },
          rawArgs: [],
          cmd: pullCommand,
        }),
      );

      expect(failure.reason).toMatchObject({ kind: "TemplateUnavailable" });
      expect(mockSaveLock).not.toHaveBeenCalled();
    });

    it("--continue --yes: 選ばせずに中断し、対話でのやり直しを案内する", async () => {
      vol.fromJSON({ "/test/.mcp.json": "local content" });

      mockLoadLock.mockReturnValueOnce(
        Effect.succeed(
          mergingLock([pendingConflict(".mcp.json", "binary")], {
            hashes: hashMap({ ".mcp.json": "newhash" }),
          }),
        ),
      );

      const failure = await captureFailure(() =>
        (pullCommand.run as any)({
          args: { dir: "/test", force: false, yes: true, continue: true },
          rawArgs: [],
          cmd: pullCommand,
        }),
      );

      expect(failure.reason).toEqual({
        kind: "UnmergedChoiceRequired",
        files: [".mcp.json"],
      });
      expect(failure.hint).toContain(".mcp.json");
      expect(mockSelectUnmergedResolution).not.toHaveBeenCalled();
      // 中断したので確定もしない
      expect(mockSaveLock).not.toHaveBeenCalled();
    });

    it("--continue: マーカーが残っていれば、選択を求める前に編集を促して中断する", async () => {
      vol.fromJSON({
        "/test/marked.txt": "<<<<<<< LOCAL\nlocal\n=======\ntemplate\n>>>>>>> TEMPLATE",
        "/test/binary.bin": "local bytes",
      });

      mockLoadLock.mockReturnValueOnce(
        Effect.succeed(
          mergingLock([pendingConflict("marked.txt"), pendingConflict("binary.bin", "binary")], {
            hashes: hashMap({ "marked.txt": "newhash" }),
          }),
        ),
      );

      const failure = await captureFailure(() =>
        (pullCommand.run as any)({
          args: { dir: "/test", force: false, yes: false, continue: true },
          rawArgs: [],
          cmd: pullCommand,
        }),
      );

      expect(failure.reason).toMatchObject({ kind: "ConflictsUnresolved" });
      expect(mockSelectUnmergedResolution).not.toHaveBeenCalled();
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
        conflicts: repoRelPaths(["settings.json"]),
        newFiles: [],
        deletedFiles: [],
        deletedWithLocalEdits: [],
        deletedLocally: [],
        unchanged: [],
      });

      // downloadBaseForMerge がベースを返す
      const baseCleanup = vi.fn();
      mockDownloadBaseForMerge.mockReturnValueOnce(
        Effect.succeed({ templateDir: absPath("/tmp/base"), cleanup: baseCleanup }),
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
        conflicts: repoRelPaths([".mcp.json"]),
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
        conflicts: repoRelPaths(["a.json", "b.txt"]),
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
            conflicts: [pendingConflict("b.txt")],
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
        conflicts: repoRelPaths(["a.json", "b.json"]),
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
        conflicts: repoRelPaths(["config.json"]),
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
        newFiles: repoRelPaths([".devcontainer/config.json"]),
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
        conflicts: repoRelPaths([".claude/rules/worktree.md"]),
        newFiles: [],
        deletedFiles: [],
        deletedWithLocalEdits: [],
        deletedLocally: [],
        unchanged: [],
      });

      const baseCleanup = vi.fn();
      mockDownloadBaseForMerge.mockReturnValueOnce(
        Effect.succeed({ templateDir: absPath("/tmp/base-template"), cleanup: baseCleanup }),
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

  describe("テンプレート削除を残したときの同期ベース", () => {
    /** 「テンプレートから消えたがローカルに残っている」状態を作る。 */
    function setupKeptDeletion(opts: {
      localHash: string;
      category: "deletedFiles" | "deletedWithLocalEdits";
    }) {
      vol.fromJSON({ "/test/old-file.txt": "old content" });

      const { effect } = mockContext({
        lock: lockWithBase({ ".mcp.json": "hash-mcp", "old-file.txt": "hash-old" }),
      });
      mockLoadCommandContext.mockReturnValue(effect);

      // template（削除済み） → local（残っている）の順で hashFiles が呼ばれる
      mockHashFiles
        .mockResolvedValueOnce(hashMap({ ".mcp.json": "hash-mcp" }))
        .mockResolvedValueOnce(
          hashMap({ ".mcp.json": "hash-mcp", "old-file.txt": opts.localHash }),
        );

      mockClassifyFiles.mockReturnValueOnce({
        autoUpdate: [],
        localOnly: [],
        conflicts: [],
        newFiles: [],
        deletedFiles: opts.category === "deletedFiles" ? repoRelPaths(["old-file.txt"]) : [],
        deletedWithLocalEdits:
          opts.category === "deletedWithLocalEdits" ? repoRelPaths(["old-file.txt"]) : [],
        deletedLocally: [],
        unchanged: repoRelPaths([".mcp.json"]),
      });
    }

    it("--yes で残したファイルは、ベースのエントリが据え置かれる", async () => {
      // ベースを進めると次回 localOnly に化け、push がテンプレートの削除を巻き戻す。
      setupKeptDeletion({ localHash: "hash-old", category: "deletedFiles" });

      await (pullCommand.run as any)({
        args: { dir: "/test", force: false, yes: true },
        rawArgs: [],
        cmd: pullCommand,
      });

      expect(vol.existsSync("/test/old-file.txt")).toBe(true);
      expect(baseHashesOf(lastSavedLock())).toEqual({
        ".mcp.json": "hash-mcp",
        "old-file.txt": "hash-old",
      });
    });

    it("ローカル編集があるまま残したファイルも、ベースは以前の値のまま", async () => {
      // ローカルの内容ではなく共通祖先を据え置く。ローカルの値を書くと、次回は
      // 「テンプレートが削除した」ではなく「ローカルが追加した」に見えてしまう。
      setupKeptDeletion({ localHash: "hash-edited", category: "deletedWithLocalEdits" });

      await (pullCommand.run as any)({
        args: { dir: "/test", force: false, yes: true },
        rawArgs: [],
        cmd: pullCommand,
      });

      expect(baseHashesOf(lastSavedLock())).toEqual({
        ".mcp.json": "hash-mcp",
        "old-file.txt": "hash-old",
      });
    });

    /**
     * 「テンプレートからもローカルからも消え、ベースにだけエントリが残っている」状態を作る。
     */
    function setupGoneLocally(): void {
      vol.fromJSON({ "/test": null });

      const { effect } = mockContext({
        lock: lockWithBase({ ".mcp.json": "hash-mcp", "gone.txt": "hash-gone" }),
      });
      mockLoadCommandContext.mockReturnValue(effect);

      mockHashFiles
        .mockResolvedValueOnce(hashMap({ ".mcp.json": "hash-mcp" }))
        .mockResolvedValueOnce(hashMap({ ".mcp.json": "hash-mcp" }));

      mockClassifyFiles.mockReturnValueOnce({
        autoUpdate: [],
        localOnly: [],
        conflicts: [],
        newFiles: [],
        deletedFiles: repoRelPaths(["gone.txt"]),
        deletedWithLocalEdits: [],
        deletedLocally: [],
        unchanged: repoRelPaths([".mcp.json"]),
      });
    }

    it("ローカルからも消えているファイルは、削除を適用しなくてもベースから落ちる", async () => {
      // 据え置きはローカルに残るファイルが localOnly へ化けるのを防ぐためのもの。ローカルに
      // 無いファイルは push の送信集合に入りようがなく、据え置くとベースのエントリだけが
      // 永久に残って毎回削除候補として報告される。
      setupGoneLocally();

      await (pullCommand.run as any)({
        args: { dir: "/test", force: false, yes: true },
        rawArgs: [],
        cmd: pullCommand,
      });

      expect(baseHashesOf(lastSavedLock())).toEqual({ ".mcp.json": "hash-mcp" });
    });

    it("ローカルに無いファイルは、削除候補としても削除ログとしても出さない", async () => {
      // 消すものが無いので、選ばせても削除したと報告しても実体を伴わない。
      setupGoneLocally();

      await (pullCommand.run as any)({
        args: { dir: "/test", force: true, yes: false },
        rawArgs: [],
        cmd: pullCommand,
      });

      expect(mockSelectDeletedFiles).not.toHaveBeenCalled();
      for (const logged of [mockLog.info, mockLog.warn, mockLog.message, mockLog.success]) {
        expect(logged).not.toHaveBeenCalledWith(expect.stringContaining("gone.txt"));
      }
      // 提示しなくてもベースのエントリは落ちる（次回も同じ状態で走らない）
      expect(baseHashesOf(lastSavedLock())).toEqual({ ".mcp.json": "hash-mcp" });
    });

    it("--force で削除したファイルは、ベースからも消える", async () => {
      setupKeptDeletion({ localHash: "hash-old", category: "deletedFiles" });

      await (pullCommand.run as any)({
        args: { dir: "/test", force: true, yes: false },
        rawArgs: [],
        cmd: pullCommand,
      });

      expect(vol.existsSync("/test/old-file.txt")).toBe(false);
      expect(baseHashesOf(lastSavedLock())).toEqual({ ".mcp.json": "hash-mcp" });
    });

    it("対話で選ばなかったファイルだけベースに残る", async () => {
      vol.fromJSON({
        "/test/deleted.txt": "aaa",
        "/test/kept.txt": "bbb",
      });

      const { effect } = mockContext({
        lock: lockWithBase({ "deleted.txt": "hash-a", "kept.txt": "hash-b" }),
      });
      mockLoadCommandContext.mockReturnValue(effect);

      mockHashFiles
        .mockResolvedValueOnce(hashMap({}))
        .mockResolvedValueOnce(hashMap({ "deleted.txt": "hash-a", "kept.txt": "hash-b" }));

      mockClassifyFiles.mockReturnValueOnce({
        autoUpdate: [],
        localOnly: [],
        conflicts: [],
        newFiles: [],
        deletedFiles: repoRelPaths(["deleted.txt", "kept.txt"]),
        deletedWithLocalEdits: [],
        deletedLocally: [],
        unchanged: [],
      });
      mockSelectDeletedFiles.mockResolvedValueOnce(repoRelPaths(["deleted.txt"]));

      await (pullCommand.run as any)({
        args: { dir: "/test", force: false, yes: false },
        rawArgs: [],
        cmd: pullCommand,
      });

      expect(baseHashesOf(lastSavedLock())).toEqual({ "kept.txt": "hash-b" });
    });

    it("コンフリクトで中断したとき、未処理の削除は nextBase に据え置かれる", async () => {
      // 中断は削除の問い合わせより手前で起きる。ここでベースを進めると、削除は一度も
      // 問われないまま --continue で確定してしまう。
      vol.fromJSON({
        "/test/conflict.md": "local",
        "/test/old-file.txt": "old content",
        "/tmp/template/conflict.md": "template",
      });

      const { effect } = mockContext({
        lock: lockWithBase({ "conflict.md": "hash-base", "old-file.txt": "hash-old" }),
      });
      mockLoadCommandContext.mockReturnValue(effect);

      mockHashFiles
        .mockResolvedValueOnce(hashMap({ "conflict.md": "hash-template" }))
        .mockResolvedValueOnce(
          hashMap({ "conflict.md": "hash-local", "old-file.txt": "hash-old" }),
        );

      mockClassifyFiles.mockReturnValueOnce({
        autoUpdate: [],
        localOnly: [],
        conflicts: repoRelPaths(["conflict.md"]),
        newFiles: [],
        deletedFiles: repoRelPaths(["old-file.txt"]),
        deletedWithLocalEdits: [],
        deletedLocally: [],
        unchanged: [],
      });
      mockBaseAvailable();
      mockMergeResult("conflict.md", "<<<<<<< LOCAL\nlocal\n=======\ntemplate\n>>>>>>> TEMPLATE\n");

      await (pullCommand.run as any)({
        args: { dir: "/test", force: false, yes: false },
        rawArgs: [],
        cmd: pullCommand,
      });

      const saved = lastSavedLock();
      expect(saved.sync).toBe("merging");
      // 削除の可否を問う前に抜けたので、ローカルにはファイルが残っている
      expect(vol.existsSync("/test/old-file.txt")).toBe(true);
      expect(saved.sync === "merging" ? saved.merge.nextBase.hashes : undefined).toEqual({
        "conflict.md": "hash-template",
        "old-file.txt": "hash-old",
      });
    });

    /**
     * コンフリクト 1 件とテンプレート側の削除 1 件を抱えた状態で pull を 1 回走らせる。
     *
     * マージ結果だけを差し替えることで、中断（マーカーが残る）と確定（クリーン）の
     * どちらの経路も同じ入力から作れる。
     */
    async function runPullWithMergeResult(mergedContent: string): Promise<LockState> {
      vi.clearAllMocks();
      vol.reset();
      vol.fromJSON({
        "/test/conflict.md": "local",
        "/test/old-file.txt": "old content",
        "/tmp/template/conflict.md": "template",
      });
      mockSaveLock.mockResolvedValue();

      const { effect } = mockContext({
        lock: lockWithBase({ "conflict.md": "hash-base", "old-file.txt": "hash-old" }),
        resolveBaseRef: Effect.succeed(Option.some(commitSha("latest123"))),
      });
      mockLoadCommandContext.mockReturnValue(effect);

      mockScannedHashes({
        template: { "conflict.md": "hash-template" },
        local: { "conflict.md": "hash-local", "old-file.txt": "hash-old" },
      });
      mockClassifyFiles.mockReturnValueOnce({
        autoUpdate: [],
        localOnly: [],
        conflicts: repoRelPaths(["conflict.md"]),
        newFiles: [],
        deletedFiles: repoRelPaths(["old-file.txt"]),
        deletedWithLocalEdits: [],
        deletedLocally: [],
        unchanged: [],
      });
      mockBaseAvailable();
      mockMergeResult("conflict.md", mergedContent);

      // --yes は削除を承認しないので、どちらの経路でも old-file.txt は残る。
      await (pullCommand.run as any)({
        args: { dir: "/test", force: false, yes: true },
        rawArgs: [],
        cmd: pullCommand,
      });

      return lastSavedLock();
    }

    it("中断経路と確定経路は同じベースを書く", async () => {
      // 到達点の計算が経路ごとに複製されていると、片方だけ直したときにベースがずれる。
      // 中断して --continue で昇格させた場合と、その場で確定した場合とで、次のベースが
      // 食い違ってはならない。
      const paused = await runPullWithMergeResult(
        "<<<<<<< LOCAL\nlocal\n=======\ntemplate\n>>>>>>> TEMPLATE\n",
      );
      const synced = await runPullWithMergeResult("merged");

      expect(paused.sync).toBe("merging");
      expect(synced.sync).toBe("synced");

      const pausedBase = paused.sync === "merging" ? paused.merge.nextBase : undefined;
      expect(pausedBase?.hashes).toEqual(baseHashesOf(synced));
      expect(pausedBase?.ref).toEqual(baseCommitSha(synced));
      // 据え置いた削除も、前進させたコンフリクトも、どちらも両経路に現れる。
      expect(baseHashesOf(synced)).toEqual({
        "conflict.md": "hash-template",
        "old-file.txt": "hash-old",
      });
      expect(baseCommitSha(synced)).toBe("latest123");
    });

    it("--continue で確定したベースにも未処理の削除が残る", async () => {
      // nextBase をそのまま昇格させるので、中断時に据え置いたエントリが確定後も残り、
      // 次回の pull で改めてユーザーに問われる。
      vol.fromJSON({ "/test/old-file.txt": "old content" });

      mockLoadLock.mockReturnValueOnce(
        Effect.succeed(
          mergingLock([pendingConflict("conflict.md", "markers")], {
            hashes: hashMap({ "conflict.md": "hash-template", "old-file.txt": "hash-old" }),
            commitSha: commitSha("newref123"),
          }),
        ),
      );

      await (pullCommand.run as any)({
        args: { dir: "/test", force: false, yes: false, continue: true },
        rawArgs: [],
        cmd: pullCommand,
      });

      expect(baseHashesOf(lastSavedLock())).toEqual({
        "conflict.md": "hash-template",
        "old-file.txt": "hash-old",
      });
      expect(vol.existsSync("/test/old-file.txt")).toBe(true);
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
        autoUpdate: repoRelPaths([".mcp.json"]),
        localOnly: [],
        conflicts: [],
        newFiles: repoRelPaths([".new-file"]),
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
        conflicts: repoRelPaths([".mcp.json"]),
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
        conflicts: repoRelPaths([".mcp.json"]),
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

      mockScannedHashes({ local: { "old-file.txt": "hash-old" } });
      mockClassifyFiles.mockReturnValueOnce({
        autoUpdate: [],
        localOnly: [],
        conflicts: [],
        newFiles: [],
        deletedFiles: repoRelPaths(["old-file.txt"]),
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

    it("コンフリクトで中断するプレビューは、削除の見込みを一切伝えない", async () => {
      // 実 pull は解決待ちで中断すると削除の処理へ進まない。この実行では起きないことを
      // 予告すると嘘になるので、2 つの削除カテゴリのどちらも黙らせる。
      vol.fromJSON({
        "/test/.mcp.json": "local content",
        "/test/old-file.txt": "old content",
        "/test/edited.txt": "edited content",
        "/tmp/template/.mcp.json": "template content",
      });

      mockScannedHashes({
        template: { ".mcp.json": "hash-template" },
        local: {
          ".mcp.json": "hash-local",
          "old-file.txt": "hash-old",
          "edited.txt": "hash-edited",
        },
      });
      mockClassifyFiles.mockReturnValueOnce({
        autoUpdate: [],
        localOnly: [],
        conflicts: repoRelPaths([".mcp.json"]),
        newFiles: [],
        deletedFiles: repoRelPaths(["old-file.txt"]),
        deletedWithLocalEdits: repoRelPaths(["edited.txt"]),
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

      expect(mockLog.warn).toHaveBeenCalledWith(expect.stringContaining("Pull would pause here"));
      expect(mockLog.info).not.toHaveBeenCalledWith(
        expect.stringContaining("would be candidates for deletion"),
      );
      expect(mockLog.warn).not.toHaveBeenCalledWith(
        expect.stringContaining("would ask you to pick which to delete"),
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
        unchanged: repoRelPaths([".mcp.json"]),
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
