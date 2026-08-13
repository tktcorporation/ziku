import { vol } from "memfs";
import { Effect } from "effect";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { baseHashesOf, lockSchema } from "../../modules/schemas";

// fs モジュールをモック
vi.mock("node:fs", async () => {
  const memfs = await import("memfs");
  return memfs.fs;
});

vi.mock("node:fs/promises", async () => {
  const memfs = await import("memfs");
  return memfs.fs.promises;
});

// 外部依存をモック
vi.mock("../../utils/git-remote", () => ({
  detectGitHubOwner: vi.fn(() => "test-org"),
  detectGitHubRepo: vi.fn(() => null),
  DEFAULT_TEMPLATE_REPOS: [".ziku", ".github"],
  DEFAULT_TEMPLATE_REPO: ".ziku",
}));

vi.mock("../../utils/template", () => ({
  buildTemplateSource: vi.fn(
    (source: { owner: string; repo: string }) => `gh:${source.owner}/${source.repo}`,
  ),
  downloadTemplateToTemp: vi.fn(),
  fetchTemplates: vi.fn(),
  writeFileWithStrategy: vi.fn(),
  copyFile: vi.fn(),
}));

vi.mock("../../utils/hash", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../../utils/hash")>()),
  hashFiles: vi.fn(),
}));

vi.mock("../../utils/github", async () => {
  const actual = await vi.importActual<typeof import("../../utils/github")>("../../utils/github");
  return {
    resolveLatestCommitSha: vi.fn(() => Promise.resolve("abc123def456")),
    resolveSourceCommitSha: vi.fn(() => Promise.resolve("abc123def456")),
    checkRepoExists: vi.fn(() => Promise.resolve({ _tag: "Exists" as const })),
    checkRepoSetup: vi.fn(() => Promise.resolve(true)),
    getGitHubToken: vi.fn(() => {}),
    getAuthenticatedUserLogin: vi.fn(() => Promise.resolve()),
    scaffoldTemplateRepo: vi.fn(() => Promise.resolve({ url: "https://github.com/test/repo" })),
    rateLimitedError: actual.rateLimitedError,
  };
});

vi.mock("../../ui/prompts", () => ({
  selectDirectories: vi.fn(),
  selectOverwriteStrategy: vi.fn(),
  selectMissingTemplateAction: vi.fn(),
  selectTemplateCandidate: vi.fn(() => Promise.resolve({ owner: "test-org", repo: ".github" })),
  inputTemplateSource: vi.fn(),
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
    bold: (s: string) => s,
    dim: (s: string) => s,
  },
  withSpinner: vi.fn(async (_text: string, fn: () => Promise<unknown>) => fn()),
  logFileResults: vi.fn(() => ({ added: 1, updated: 0, skipped: 0 })),
}));

vi.mock("../../utils/template-config", () => ({
  loadTemplateConfig: vi.fn(() =>
    Effect.succeed({
      include: [".mcp.json", ".mise.toml", ".devcontainer/**", ".github/**", ".claude/**"],
      exclude: [],
    }),
  ),
  templateConfigExists: vi.fn(() => true),
  extractDirectoryEntries: vi.fn((patterns: string[]) => {
    // パターンからディレクトリエントリを生成するシンプルなモック
    const dirMap = new Map<string, string[]>();
    const rootFiles: string[] = [];
    for (const p of patterns) {
      const slashIndex = p.indexOf("/");
      if (slashIndex === -1) {
        rootFiles.push(p);
      } else {
        const dir = p.slice(0, slashIndex);
        const existing = dirMap.get(dir);
        if (existing) {
          existing.push(p);
        } else {
          dirMap.set(dir, [p]);
        }
      }
    }
    const entries: Array<{ label: string; patterns: string[] }> = [];
    for (const [dir, pats] of [...dirMap.entries()].toSorted((a, b) => a[0].localeCompare(b[0]))) {
      entries.push({ label: dir, patterns: pats });
    }
    if (rootFiles.length > 0) {
      entries.push({ label: "Root files", patterns: rootFiles });
    }
    return entries;
  }),
}));

// モック後にインポート
const { initCommand, resolveConfigBaseHash } = await import("../init");
const { generateZikuJsonc } = await import("../../utils/ziku-config");
const { hashContent } = await import("../../utils/hash");
const { downloadTemplateToTemp, fetchTemplates, writeFileWithStrategy, copyFile } =
  await import("../../utils/template");
const { detectGitHubOwner, detectGitHubRepo } = await import("../../utils/git-remote");
const { selectDirectories, selectOverwriteStrategy, selectTemplateCandidate } =
  await import("../../ui/prompts");
const { log, outro } = await import("../../ui/renderer");
const { hashFiles } = await import("../../utils/hash");
const { loadTemplateConfig } = await import("../../utils/template-config");
const { checkRepoExists, checkRepoSetup } = await import("../../utils/github");

const mockDownloadTemplateToTemp = vi.mocked(downloadTemplateToTemp);
const mockFetchTemplates = vi.mocked(fetchTemplates);
const mockWriteFileWithStrategy = vi.mocked(writeFileWithStrategy);
const mockCopyFile = vi.mocked(copyFile);
const mockDetectGitHubOwner = vi.mocked(detectGitHubOwner);
const _mockDetectGitHubRepo = vi.mocked(detectGitHubRepo);
const mockSelectDirectories = vi.mocked(selectDirectories);
const mockSelectOverwriteStrategy = vi.mocked(selectOverwriteStrategy);
const mockLog = vi.mocked(log);
const mockOutro = vi.mocked(outro);
const mockHashFiles = vi.mocked(hashFiles);
const _mockLoadTemplateConfig = vi.mocked(loadTemplateConfig);
const mockCheckRepoExists = vi.mocked(checkRepoExists);
const mockCheckRepoSetup = vi.mocked(checkRepoSetup);

describe("initCommand", () => {
  beforeEach(() => {
    vol.reset();
    vi.clearAllMocks();

    // デフォルトのモック設定
    mockDownloadTemplateToTemp.mockResolvedValue({
      templateDir: "/tmp/template",
      cleanup: vi.fn(),
    });
    mockFetchTemplates.mockResolvedValue([]);
    mockWriteFileWithStrategy.mockResolvedValue({
      action: "created",
      path: ".ziku/lock.json",
    });
    mockCopyFile.mockResolvedValue({
      action: "skipped",
      path: ".ziku/ziku.jsonc",
    });
    mockHashFiles.mockResolvedValue({});
  });

  describe("meta", () => {
    it("コマンドメタデータが正しい", () => {
      expect((initCommand.meta as { name: string }).name).toBe("ziku");
      expect((initCommand.meta as { description: string }).description).toBe(
        "Apply dev environment template to your project",
      );
    });
  });

  describe("args", () => {
    it("dir 引数のデフォルト値は '.'", () => {
      const args = initCommand.args as { dir: { default: string } };
      expect(args.dir.default).toBe(".");
    });

    it("force 引数のデフォルト値は false", () => {
      const args = initCommand.args as { force: { default: boolean } };
      expect(args.force.default).toBe(false);
    });

    it("yes 引数のデフォルト値は false", () => {
      const args = initCommand.args as { yes: { default: boolean } };
      expect(args.yes.default).toBe(false);
    });

    it("dryRun 引数のデフォルト値は false", () => {
      const args = initCommand.args as { dryRun: { default: boolean } };
      expect(args.dryRun.default).toBe(false);
    });
  });

  describe("run", () => {
    it("ディレクトリが選択されない場合は警告を表示", async () => {
      vol.fromJSON({
        "/test": null,
      });

      // selectDirectories が空配列 → include が空 → "No patterns to apply"
      mockSelectDirectories.mockResolvedValueOnce([]);

      await (initCommand.run as any)({
        args: { dir: "/test", force: false, yes: false },
        rawArgs: [],
        cmd: initCommand,
      });

      expect(mockLog.warn).toHaveBeenCalledWith("No patterns to apply");
    });

    it("--yes オプションで全ディレクトリを自動選択", async () => {
      vol.fromJSON({
        "/test": null,
      });

      mockFetchTemplates.mockResolvedValue([{ action: "copied", path: ".mcp.json" }]);

      await (initCommand.run as any)({
        args: { dir: "/test", force: false, yes: true },
        rawArgs: [],
        cmd: initCommand,
      });

      // selectDirectories は呼ばれない
      expect(mockSelectDirectories).not.toHaveBeenCalled();
      // fetchTemplates は呼ばれる
      expect(mockFetchTemplates).toHaveBeenCalled();
    });

    it("ターゲットディレクトリが存在しない場合は作成", async () => {
      vol.fromJSON({});

      mockSelectDirectories.mockResolvedValueOnce([".mcp.json", ".mise.toml"]);
      mockSelectOverwriteStrategy.mockResolvedValueOnce("prompt");

      mockFetchTemplates.mockResolvedValue([{ action: "copied", path: ".mcp.json" }]);

      await (initCommand.run as any)({
        args: { dir: "/new-dir", force: false, yes: false },
        rawArgs: [],
        cmd: initCommand,
      });

      expect(vol.existsSync("/new-dir")).toBe(true);
    });

    it("devcontainer ディレクトリ選択時に env.example を作成", async () => {
      vol.fromJSON({
        "/test": null,
      });

      mockSelectDirectories.mockResolvedValueOnce([".devcontainer/**"]);
      mockSelectOverwriteStrategy.mockResolvedValueOnce("prompt");

      mockFetchTemplates.mockResolvedValue([]);

      await (initCommand.run as any)({
        args: { dir: "/test", force: false, yes: false },
        rawArgs: [],
        cmd: initCommand,
      });

      // writeFileWithStrategy が devcontainer.env.example に対して呼ばれる
      expect(mockWriteFileWithStrategy).toHaveBeenCalledWith(
        expect.objectContaining({
          relativePath: ".devcontainer/devcontainer.env.example",
        }),
      );
    });

    it("--force オプションで overwrite 戦略を使用", async () => {
      vol.fromJSON({
        "/test": null,
      });

      mockSelectDirectories.mockResolvedValueOnce([".mcp.json", ".mise.toml"]);
      mockSelectOverwriteStrategy.mockResolvedValueOnce("prompt");

      mockFetchTemplates.mockResolvedValue([]);

      await (initCommand.run as any)({
        args: { dir: "/test", force: true, yes: false }, // --force
        rawArgs: [],
        cmd: initCommand,
      });

      // fetchTemplates は overwrite 戦略で呼ばれる
      expect(mockFetchTemplates).toHaveBeenCalledWith(
        expect.objectContaining({
          overwriteStrategy: "overwrite",
        }),
      );
    });

    it("--yes だけでは既存ファイルを上書きしない（skip 戦略）", async () => {
      vol.fromJSON({
        "/test": null,
      });

      mockFetchTemplates.mockResolvedValue([]);

      await (initCommand.run as any)({
        args: { dir: "/test", force: false, yes: true },
        rawArgs: [],
        cmd: initCommand,
      });

      // --yes はプロンプトを省くだけで、既存の内容を失う承認は含まない
      expect(mockSelectOverwriteStrategy).not.toHaveBeenCalled();
      expect(mockFetchTemplates).toHaveBeenCalledWith(
        expect.objectContaining({
          overwriteStrategy: "skip",
        }),
      );
    });

    it("--yes --force なら上書きする", async () => {
      vol.fromJSON({
        "/test": null,
      });

      mockFetchTemplates.mockResolvedValue([]);

      await (initCommand.run as any)({
        args: { dir: "/test", force: true, yes: true },
        rawArgs: [],
        cmd: initCommand,
      });

      expect(mockFetchTemplates).toHaveBeenCalledWith(
        expect.objectContaining({
          overwriteStrategy: "overwrite",
        }),
      );
    });

    it("--yes でも --overwrite-strategy の明示指定が優先される", async () => {
      vol.fromJSON({
        "/test": null,
      });

      mockFetchTemplates.mockResolvedValue([]);

      await (initCommand.run as any)({
        args: { dir: "/test", force: false, yes: true, "overwrite-strategy": "overwrite" },
        rawArgs: [],
        cmd: initCommand,
      });

      expect(mockFetchTemplates).toHaveBeenCalledWith(
        expect.objectContaining({
          overwriteStrategy: "overwrite",
        }),
      );
    });

    it("cleanup が必ず呼ばれる", async () => {
      vol.fromJSON({
        "/test": null,
      });

      const mockCleanup = vi.fn();
      mockDownloadTemplateToTemp.mockResolvedValue({
        templateDir: "/tmp/template",
        cleanup: mockCleanup,
      });

      mockSelectDirectories.mockResolvedValueOnce([".mcp.json", ".mise.toml"]);
      mockSelectOverwriteStrategy.mockResolvedValueOnce("prompt");

      mockFetchTemplates.mockResolvedValue([]);

      await (initCommand.run as any)({
        args: { dir: "/test", force: false, yes: false },
        rawArgs: [],
        cmd: initCommand,
      });

      expect(mockCleanup).toHaveBeenCalled();
    });

    it("選択されたパターンで ziku.jsonc を生成する", async () => {
      vol.fromJSON({
        "/test": null,
      });

      mockSelectDirectories.mockResolvedValueOnce([".mcp.json", ".mise.toml"]);
      mockSelectOverwriteStrategy.mockResolvedValueOnce("prompt");

      mockFetchTemplates.mockResolvedValue([]);

      await (initCommand.run as any)({
        args: { dir: "/test", force: false, yes: false },
        rawArgs: [],
        cmd: initCommand,
      });

      // writeFileWithStrategy が ziku.jsonc に対して呼ばれる
      expect(mockWriteFileWithStrategy).toHaveBeenCalledWith(
        expect.objectContaining({
          relativePath: ".ziku/ziku.jsonc",
        }),
      );
    });

    it("エラー時も cleanup が呼ばれる", async () => {
      vol.fromJSON({
        "/test": null,
      });

      const mockCleanup = vi.fn();
      mockDownloadTemplateToTemp.mockResolvedValue({
        templateDir: "/tmp/template",
        cleanup: mockCleanup,
      });

      mockSelectDirectories.mockRejectedValueOnce(new Error("User cancelled"));

      await expect(
        (initCommand.run as any)({
          args: { dir: "/test", force: false, yes: false },
          rawArgs: [],
          cmd: initCommand,
        }),
      ).rejects.toThrow("User cancelled");

      expect(mockCleanup).toHaveBeenCalled();
    });

    it("--dirs オプションで指定ディレクトリのみ選択", async () => {
      vol.fromJSON({
        "/test": null,
      });

      mockFetchTemplates.mockResolvedValue([{ action: "copied", path: ".mcp.json" }]);

      await (initCommand.run as any)({
        args: {
          dir: "/test",
          force: false,
          yes: false,
          dirs: "Root files",
        },
        rawArgs: [],
        cmd: initCommand,
      });

      // selectDirectories は呼ばれない（非インタラクティブ）
      expect(mockSelectDirectories).not.toHaveBeenCalled();
      // fetchTemplates は指定ディレクトリのパターンで呼ばれる
      expect(mockFetchTemplates).toHaveBeenCalledWith(
        expect.objectContaining({
          patterns: expect.objectContaining({
            include: expect.arrayContaining([".mcp.json", ".mise.toml"]),
          }),
        }),
      );
    });

    it("--dirs で複数ディレクトリをカンマ区切りで指定", async () => {
      vol.fromJSON({
        "/test": null,
      });

      mockFetchTemplates.mockResolvedValue([]);

      await (initCommand.run as any)({
        args: {
          dir: "/test",
          force: false,
          yes: false,
          dirs: "Root files,.github",
        },
        rawArgs: [],
        cmd: initCommand,
      });

      expect(mockSelectDirectories).not.toHaveBeenCalled();
      expect(mockFetchTemplates).toHaveBeenCalledWith(
        expect.objectContaining({
          patterns: expect.objectContaining({
            include: expect.arrayContaining([".mcp.json", ".mise.toml", ".github/**"]),
          }),
        }),
      );
    });

    it("--dirs で無効なディレクトリ名を指定すると InvalidArgument", async () => {
      vol.fromJSON({
        "/test": null,
      });

      await expect(
        (initCommand.run as any)({
          args: {
            dir: "/test",
            force: false,
            yes: false,
            dirs: "invalid-dir",
          },
          rawArgs: [],
          cmd: initCommand,
        }),
      ).rejects.toMatchObject({
        _tag: "ZikuFailure",
        reason: { kind: "InvalidArgument", argument: "--dirs", value: "invalid-dir" },
      });

      expect(mockFetchTemplates).not.toHaveBeenCalled();
    });

    it("--overwrite-strategy で skip 戦略を指定", async () => {
      vol.fromJSON({
        "/test": null,
      });

      mockFetchTemplates.mockResolvedValue([]);

      await (initCommand.run as any)({
        args: {
          dir: "/test",
          force: false,
          yes: true,
          "overwrite-strategy": "skip",
        },
        rawArgs: [],
        cmd: initCommand,
      });

      expect(mockFetchTemplates).toHaveBeenCalledWith(
        expect.objectContaining({
          overwriteStrategy: "skip",
        }),
      );
    });

    it("--dirs と --overwrite-strategy の組み合わせ", async () => {
      vol.fromJSON({
        "/test": null,
      });

      mockFetchTemplates.mockResolvedValue([]);

      await (initCommand.run as any)({
        args: {
          dir: "/test",
          force: false,
          yes: false,
          dirs: "Root files",
          "overwrite-strategy": "skip",
        },
        rawArgs: [],
        cmd: initCommand,
      });

      expect(mockSelectDirectories).not.toHaveBeenCalled();
      expect(mockFetchTemplates).toHaveBeenCalledWith(
        expect.objectContaining({
          patterns: expect.objectContaining({
            include: expect.arrayContaining([".mcp.json", ".mise.toml"]),
          }),
          overwriteStrategy: "skip",
        }),
      );
    });

    it("--overwrite-strategy に無効な値を指定すると InvalidArgument", async () => {
      vol.fromJSON({
        "/test": null,
      });

      await expect(
        (initCommand.run as any)({
          args: {
            dir: "/test",
            force: false,
            yes: true,
            "overwrite-strategy": "invalid",
          },
          rawArgs: [],
          cmd: initCommand,
        }),
      ).rejects.toMatchObject({
        _tag: "ZikuFailure",
        reason: {
          kind: "InvalidArgument",
          argument: "--overwrite-strategy",
          value: "invalid",
        },
      });

      expect(mockFetchTemplates).not.toHaveBeenCalled();
    });

    it("--overwrite-strategy のみ指定時はディレクトリ選択はインタラクティブ", async () => {
      vol.fromJSON({
        "/test": null,
      });

      mockSelectDirectories.mockResolvedValueOnce([".mcp.json", ".mise.toml"]);

      mockFetchTemplates.mockResolvedValue([]);

      await (initCommand.run as any)({
        args: {
          dir: "/test",
          force: false,
          yes: false,
          "overwrite-strategy": "skip",
        },
        rawArgs: [],
        cmd: initCommand,
      });

      // ディレクトリ選択はインタラクティブ
      expect(mockSelectDirectories).toHaveBeenCalled();
      // 戦略は --overwrite-strategy で上書き
      expect(mockFetchTemplates).toHaveBeenCalledWith(
        expect.objectContaining({
          overwriteStrategy: "skip",
        }),
      );
    });

    it("'init' 引数は無視して現在のディレクトリを使用", async () => {
      vol.fromJSON({
        ".": null,
      });

      mockSelectDirectories.mockResolvedValueOnce([]);

      await (initCommand.run as any)({
        args: { dir: "init", force: false, yes: false },
        rawArgs: [],
        cmd: initCommand,
      });

      // "init" は "." として扱われる
      expect(mockLog.info).toHaveBeenCalledWith(expect.stringContaining(process.cwd()));
    });

    it("--from でカスタムソースを指定", async () => {
      vol.fromJSON({
        "/test": null,
      });

      mockSelectDirectories.mockResolvedValueOnce([".mcp.json", ".mise.toml"]);
      mockSelectOverwriteStrategy.mockResolvedValueOnce("prompt");

      mockFetchTemplates.mockResolvedValue([]);

      await (initCommand.run as any)({
        args: {
          dir: "/test",
          force: false,
          yes: false,
          from: "my-org/my-templates",
        },
        rawArgs: [],
        cmd: initCommand,
      });

      // downloadTemplateToTemp にカスタムソースが渡される
      expect(mockDownloadTemplateToTemp).toHaveBeenCalledWith(
        expect.any(String),
        "gh:my-org/my-templates",
      );
    });

    it("--from でオーナー名のみ指定すると .ziku / .github を探索し最初に見つかったものを使う", async () => {
      vol.fromJSON({
        "/test": null,
      });

      mockSelectDirectories.mockResolvedValueOnce([".mcp.json", ".mise.toml"]);
      mockSelectOverwriteStrategy.mockResolvedValueOnce("prompt");

      mockFetchTemplates.mockResolvedValue([]);

      await (initCommand.run as any)({
        args: {
          dir: "/test",
          force: false,
          yes: false,
          from: "my-org",
        },
        rawArgs: [],
        cmd: initCommand,
      });

      // checkRepoExists がデフォルトで Exists を返すため、先頭の .ziku が使われる
      expect(mockDownloadTemplateToTemp).toHaveBeenCalledWith(
        expect.any(String),
        "gh:my-org/.ziku",
      );
    });

    it("--from オーナーのみで .github だけセットアップ済みなら .github を選択", async () => {
      vol.fromJSON({
        "/test": null,
      });

      // 両方存在するが .ziku はセットアップ未完了
      mockCheckRepoExists.mockResolvedValue({ _tag: "Exists" });
      mockCheckRepoSetup
        .mockResolvedValueOnce(false) // .ziku
        .mockResolvedValueOnce(true); // .github

      mockSelectDirectories.mockResolvedValueOnce([".mcp.json", ".mise.toml"]);
      mockSelectOverwriteStrategy.mockResolvedValueOnce("prompt");
      mockFetchTemplates.mockResolvedValue([]);

      await (initCommand.run as any)({
        args: { dir: "/test", force: false, yes: false, from: "my-org" },
        rawArgs: [],
        cmd: initCommand,
      });

      // セットアップ済みの .github が選ばれる
      expect(mockDownloadTemplateToTemp).toHaveBeenCalledWith(
        expect.any(String),
        "gh:my-org/.github",
      );
    });

    it("--from オーナーのみで .ziku のみ存在する場合は .ziku を選択", async () => {
      vol.fromJSON({
        "/test": null,
      });

      // .ziku のみ存在
      mockCheckRepoExists
        .mockResolvedValueOnce({ _tag: "Exists" }) // .ziku
        .mockResolvedValueOnce({ _tag: "NotFound" }); // .github
      mockCheckRepoSetup.mockResolvedValueOnce(false); // .ziku はセットアップ未完了

      mockSelectDirectories.mockResolvedValueOnce([".mcp.json", ".mise.toml"]);
      mockSelectOverwriteStrategy.mockResolvedValueOnce("prompt");
      mockFetchTemplates.mockResolvedValue([]);

      await (initCommand.run as any)({
        args: { dir: "/test", force: false, yes: false, from: "my-org" },
        rawArgs: [],
        cmd: initCommand,
      });

      expect(mockDownloadTemplateToTemp).toHaveBeenCalledWith(
        expect.any(String),
        "gh:my-org/.ziku",
      );
    });

    it("--from 未指定時は git remote から owner を検出", async () => {
      vol.fromJSON({
        "/test": null,
      });

      mockDetectGitHubOwner.mockReturnValueOnce("detected-org");
      vi.mocked(selectTemplateCandidate).mockResolvedValueOnce({
        owner: "detected-org",
        repo: ".github",
      });

      mockSelectDirectories.mockResolvedValueOnce([".mcp.json", ".mise.toml"]);
      mockSelectOverwriteStrategy.mockResolvedValueOnce("prompt");

      mockFetchTemplates.mockResolvedValue([]);

      await (initCommand.run as any)({
        args: { dir: "/test", force: false, yes: false },
        rawArgs: [],
        cmd: initCommand,
      });

      // detected-org/.github が使われる
      expect(mockDownloadTemplateToTemp).toHaveBeenCalledWith(
        expect.any(String),
        "gh:detected-org/.github",
      );
    });

    it("git remote 検出失敗時はユーザーにソース入力を促す", async () => {
      vol.fromJSON({
        "/test": null,
      });

      mockDetectGitHubOwner.mockReturnValueOnce(null);

      const { inputTemplateSource } = await import("../../ui/prompts");
      const mockInputTemplateSource = vi.mocked(inputTemplateSource);
      // ユーザーが custom-org/templates を入力
      mockInputTemplateSource.mockResolvedValueOnce("custom-org/templates");
      mockCheckRepoExists.mockResolvedValueOnce({ _tag: "Exists" });
      mockSelectDirectories.mockResolvedValueOnce([".mcp.json", ".mise.toml"]);
      mockSelectOverwriteStrategy.mockResolvedValueOnce("prompt");

      mockFetchTemplates.mockResolvedValue([]);

      await (initCommand.run as any)({
        args: { dir: "/test", force: false, yes: false },
        rawArgs: [],
        cmd: initCommand,
      });

      expect(mockInputTemplateSource).toHaveBeenCalled();
      expect(mockDownloadTemplateToTemp).toHaveBeenCalledWith(
        expect.any(String),
        "gh:custom-org/templates",
      );
    });

    it(".ziku/lock.json に同期ベースのハッシュが含まれる", async () => {
      vol.fromJSON({
        "/test": null,
      });

      const expectedHashes = {
        ".mcp.json": "abc123hash",
        ".mise.toml": "def456hash",
      };
      mockHashFiles.mockResolvedValueOnce(expectedHashes);

      mockFetchTemplates.mockResolvedValue([{ action: "copied", path: ".mcp.json" }]);

      await (initCommand.run as any)({
        args: { dir: "/test", force: false, yes: true },
        rawArgs: [],
        cmd: initCommand,
      });

      // hashFiles がテンプレートディレクトリとパターンで呼ばれる
      expect(mockHashFiles).toHaveBeenCalledWith(
        "/tmp/template",
        expect.any(Array),
        expect.any(Array),
      );

      // saveLock により .ziku/lock.json がファイルシステムに書き出される
      expect(vol.existsSync("/test/.ziku/lock.json")).toBe(true);
      const lockContent = lockSchema.parse(
        JSON.parse(vol.readFileSync("/test/.ziku/lock.json", "utf-8") as string),
      );
      expect(baseHashesOf(lockContent)).toEqual(expectedHashes);
    });

    it("テンプレに ziku.jsonc があれば同期ベースに ziku.jsonc の base が記録される", async () => {
      vol.fromJSON({
        "/test": null,
      });

      // テンプレに ziku.jsonc が存在する状況（hashFiles が ziku.jsonc を返す）
      mockHashFiles.mockResolvedValueOnce({ ".ziku/ziku.jsonc": "template-config-hash" });

      mockFetchTemplates.mockResolvedValue([{ action: "copied", path: ".mcp.json" }]);

      await (initCommand.run as any)({
        args: { dir: "/test", force: false, yes: true },
        rawArgs: [],
        cmd: initCommand,
      });

      expect(vol.existsSync("/test/.ziku/lock.json")).toBe(true);
      const lockContent = lockSchema.parse(
        JSON.parse(vol.readFileSync("/test/.ziku/lock.json", "utf-8") as string),
      );
      // base はローカル subset 由来のハッシュで記録される（テンプレ保護のため）
      expect(baseHashesOf(lockContent)[".ziku/ziku.jsonc"]).toEqual(expect.any(String));
      // テンプレ側ハッシュではなくローカル内容のハッシュ
      expect(baseHashesOf(lockContent)[".ziku/ziku.jsonc"]).not.toBe("template-config-hash");
    });

    it("テンプレに ziku.jsonc が無ければ同期ベースに ziku.jsonc を記録しない（誤削除防止 / codex P1）", async () => {
      vol.fromJSON({
        "/test": null,
      });

      // テンプレに ziku.jsonc が無い状況（hashFiles が ziku.jsonc を返さない）
      mockHashFiles.mockResolvedValueOnce({});

      mockFetchTemplates.mockResolvedValue([{ action: "copied", path: ".mcp.json" }]);

      await (initCommand.run as any)({
        args: { dir: "/test", force: false, yes: true },
        rawArgs: [],
        cmd: initCommand,
      });

      const lockContent = lockSchema.parse(
        JSON.parse(vol.readFileSync("/test/.ziku/lock.json", "utf-8") as string),
      );
      // base を記録しない（記録すると次回 pull で deletedFiles 判定→制御ファイル削除になる）
      expect(baseHashesOf(lockContent)[".ziku/ziku.jsonc"]).toBeUndefined();
    });
  });

  describe("dry run (--dryRun)", () => {
    it("fetchTemplates / writeFileWithStrategy に dryRun: true を渡す", async () => {
      vol.fromJSON({
        "/test": null,
      });

      mockFetchTemplates.mockResolvedValue([{ action: "copied", path: ".mcp.json" }]);

      await (initCommand.run as any)({
        args: { dir: "/test", force: false, yes: true, dryRun: true },
        rawArgs: [],
        cmd: initCommand,
      });

      expect(mockFetchTemplates).toHaveBeenCalledWith(expect.objectContaining({ dryRun: true }));
      expect(mockWriteFileWithStrategy).toHaveBeenCalledWith(
        expect.objectContaining({ relativePath: ".ziku/ziku.jsonc", dryRun: true }),
      );
    });

    it("ファイル一覧を表示する前に 'Dry run mode' を表示する（pull/track と同じ挙動）", async () => {
      vol.fromJSON({
        "/test": null,
      });

      mockFetchTemplates.mockResolvedValue([{ action: "copied", path: ".mcp.json" }]);

      await (initCommand.run as any)({
        args: { dir: "/test", force: false, yes: true, dryRun: true },
        rawArgs: [],
        cmd: initCommand,
      });

      const infoCallOrder = mockLog.info.mock.invocationCallOrder;
      const fetchTemplatesCallOrder = mockFetchTemplates.mock.invocationCallOrder[0];
      expect(mockLog.info).toHaveBeenCalledWith("Dry run mode");
      const dryRunLogOrder =
        infoCallOrder[mockLog.info.mock.calls.findIndex((c) => c[0] === "Dry run mode")];
      expect(dryRunLogOrder).toBeLessThan(fetchTemplatesCallOrder);
    });

    it("存在しないターゲットディレクトリを作成しない", async () => {
      vol.fromJSON({});

      mockFetchTemplates.mockResolvedValue([{ action: "copied", path: ".mcp.json" }]);

      await (initCommand.run as any)({
        args: { dir: "/nonexistent-target", force: false, yes: true, dryRun: true },
        rawArgs: [],
        cmd: initCommand,
      });

      expect(vol.existsSync("/nonexistent-target")).toBe(false);
      expect(mockLog.message).toHaveBeenCalledWith(
        expect.stringContaining("Would create directory"),
      );
    });

    it("リモートダウンロードが targetDir を副作用的に作成しても、空なら後始末する", async () => {
      vol.fromJSON({});

      // giget は tempDir (targetDir/.ziku-temp) 作成時に targetDir 自体も
      // 再帰的に作成する。この副作用をモックで再現する。
      mockDownloadTemplateToTemp.mockImplementationOnce(async (targetDir: string) => {
        vol.mkdirSync(`${targetDir}/.ziku-temp`, { recursive: true });
        return {
          templateDir: `${targetDir}/.ziku-temp`,
          cleanup: () => {
            vol.rmSync(`${targetDir}/.ziku-temp`, { recursive: true, force: true });
          },
        };
      });
      mockFetchTemplates.mockResolvedValue([{ action: "copied", path: ".mcp.json" }]);

      await (initCommand.run as any)({
        args: { dir: "/nonexistent-remote-target", force: false, yes: true, dryRun: true },
        rawArgs: [],
        cmd: initCommand,
      });

      expect(vol.existsSync("/nonexistent-remote-target")).toBe(false);
    });

    it("targetDir の祖先ディレクトリも未作成だった場合、まとめて後始末する", async () => {
      vol.fromJSON({ "/existing-root/.gitkeep": "" });

      // targetDir (/existing-root/new-parent/project) の祖先 new-parent も
      // 未作成のケース。giget は recursive:true で両方まとめて作成する。
      mockDownloadTemplateToTemp.mockImplementationOnce(async (targetDir: string) => {
        vol.mkdirSync(`${targetDir}/.ziku-temp`, { recursive: true });
        return {
          templateDir: `${targetDir}/.ziku-temp`,
          cleanup: () => {
            vol.rmSync(`${targetDir}/.ziku-temp`, { recursive: true, force: true });
          },
        };
      });
      mockFetchTemplates.mockResolvedValue([{ action: "copied", path: ".mcp.json" }]);

      await (initCommand.run as any)({
        args: {
          dir: "/existing-root/new-parent/project",
          force: false,
          yes: true,
          dryRun: true,
        },
        rawArgs: [],
        cmd: initCommand,
      });

      // targetDir とその祖先 new-parent はどちらも削除される
      expect(vol.existsSync("/existing-root/new-parent")).toBe(false);
      // 実行前から存在していた /existing-root 自体は残る
      expect(vol.existsSync("/existing-root")).toBe(true);
      expect(vol.existsSync("/existing-root/.gitkeep")).toBe(true);
    });

    it("ダウンロードが失敗しても、副作用で作られた targetDir を後始末する", async () => {
      vol.fromJSON({});

      // giget は tempDir 作成後にダウンロード/展開に失敗することがある。
      // 失敗時も tempDir 自体は giget 側で削除されるが（downloadTemplateToTemp の
      // 実装）、targetDir は giget が作った副作用のまま残る想定を再現する。
      mockDownloadTemplateToTemp.mockImplementationOnce(async (targetDir: string) => {
        vol.mkdirSync(targetDir, { recursive: true });
        throw new Error("network error during extraction");
      });

      await expect(
        (initCommand.run as any)({
          args: { dir: "/nonexistent-failing-target", force: false, yes: true, dryRun: true },
          rawArgs: [],
          cmd: initCommand,
        }),
      ).rejects.toThrow("network error during extraction");

      expect(vol.existsSync("/nonexistent-failing-target")).toBe(false);
    });

    it("ターゲットディレクトリが元々存在していた場合は dryRun でも削除しない", async () => {
      vol.fromJSON({
        "/existing-target/.gitkeep": "",
      });

      mockDownloadTemplateToTemp.mockImplementationOnce(async (targetDir: string) => {
        vol.mkdirSync(`${targetDir}/.ziku-temp`, { recursive: true });
        return {
          templateDir: `${targetDir}/.ziku-temp`,
          cleanup: () => {
            vol.rmSync(`${targetDir}/.ziku-temp`, { recursive: true, force: true });
          },
        };
      });
      mockFetchTemplates.mockResolvedValue([{ action: "copied", path: ".mcp.json" }]);

      await (initCommand.run as any)({
        args: { dir: "/existing-target", force: false, yes: true, dryRun: true },
        rawArgs: [],
        cmd: initCommand,
      });

      expect(vol.existsSync("/existing-target")).toBe(true);
      expect(vol.existsSync("/existing-target/.gitkeep")).toBe(true);
    });

    it(".ziku/lock.json を書き出さない（実書き込みは saveLock 経由）", async () => {
      vol.fromJSON({
        "/test": null,
      });

      mockFetchTemplates.mockResolvedValue([{ action: "copied", path: ".mcp.json" }]);

      await (initCommand.run as any)({
        args: { dir: "/test", force: false, yes: true, dryRun: true },
        rawArgs: [],
        cmd: initCommand,
      });

      expect(vol.existsSync("/test/.ziku/lock.json")).toBe(false);
    });

    it("プレビュー用の outro メッセージを表示する（'Setup complete!' ではない）", async () => {
      vol.fromJSON({
        "/test": null,
      });

      mockFetchTemplates.mockResolvedValue([{ action: "copied", path: ".mcp.json" }]);

      await (initCommand.run as any)({
        args: { dir: "/test", force: false, yes: true, dryRun: true },
        rawArgs: [],
        cmd: initCommand,
      });

      expect(mockOutro).toHaveBeenCalledWith(expect.stringContaining("Dry run complete"));
      expect(mockOutro).not.toHaveBeenCalledWith(expect.stringContaining("Setup complete!"));
    });

    it("devcontainer.env.example の作成にも dryRun: true を伝える", async () => {
      vol.fromJSON({
        "/test": null,
      });

      mockSelectDirectories.mockResolvedValueOnce([".devcontainer/**"]);
      mockSelectOverwriteStrategy.mockResolvedValueOnce("prompt");
      mockFetchTemplates.mockResolvedValue([]);

      await (initCommand.run as any)({
        args: { dir: "/test", force: false, yes: false, dryRun: true },
        rawArgs: [],
        cmd: initCommand,
      });

      expect(mockWriteFileWithStrategy).toHaveBeenCalledWith(
        expect.objectContaining({
          relativePath: ".devcontainer/devcontainer.env.example",
          dryRun: true,
        }),
      );
    });
  });
});

describe("generateZikuJsonc", () => {
  it("include と $schema を含む JSON を生成する", () => {
    const content = generateZikuJsonc({ include: [".mcp.json", ".devcontainer/**"], exclude: [] });
    const parsed = JSON.parse(content);
    expect(parsed.$schema).toBeDefined();
    expect(parsed.include).toBeDefined();
    expect(Array.isArray(parsed.include)).toBe(true);
    expect(parsed.include.length).toBeGreaterThan(0);
  });

  it("デフォルト生成に include パターンがある", () => {
    const content = generateZikuJsonc({ include: [".mcp.json"], exclude: [] });
    const parsed = JSON.parse(content);
    expect(Array.isArray(parsed.include)).toBe(true);
    expect(parsed.include.length).toBeGreaterThan(0);
  });
});

describe("resolveConfigBaseHash（テンプレ保護の安全装置）", () => {
  it("ローカル(部分集合) の内容ハッシュを base にする（テンプレを削らないため）", () => {
    const localContent = generateZikuJsonc({ include: [".claude/**"], exclude: [] });
    const result = resolveConfigBaseHash({
      localConfigContent: localContent,
      templateConfigHash: hashContent("different-template-content"),
    });
    // base = ローカル内容のハッシュ（テンプレ側のハッシュではない）
    expect(result).toBe(hashContent(localContent));
  });

  it("テンプレ側ハッシュが undefined でもローカル内容から base を決められる", () => {
    const localContent = generateZikuJsonc({ include: [".mcp.json"], exclude: [] });
    const result = resolveConfigBaseHash({
      localConfigContent: localContent,
      templateConfigHash: undefined,
    });
    expect(result).toBe(hashContent(localContent));
  });

  it("ローカルが完全集合（テンプレと同一）なら base はテンプレと一致する", () => {
    const content = generateZikuJsonc({ include: [".claude/**", ".mcp.json"], exclude: [] });
    const templateHash = hashContent(content);
    const result = resolveConfigBaseHash({
      localConfigContent: content,
      templateConfigHash: templateHash,
    });
    // local == template のときは base も一致 → push/pull とも no-op
    expect(result).toBe(templateHash);
  });
});
