import { Effect } from "effect";
import { vol } from "memfs";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { absPath, commitSha, repoRelPath } from "../../__tests__/brands";
import type { CopyResult } from "../template";
import { buildCommitPinnedSource, buildTemplateSource } from "../template";

// fs モジュールをモック
vi.mock("node:fs", async () => {
  const memfs = await import("memfs");
  return memfs.fs;
});

// @clack/prompts をモック
vi.mock("@clack/prompts", () => ({
  confirm: vi.fn(),
  isCancel: vi.fn(() => false),
}));

// ui/renderer をモック
vi.mock("../../ui/renderer", () => ({
  log: {
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    success: vi.fn(),
    step: vi.fn(),
    message: vi.fn(),
  },
}));

// giget をモック: tempDir にダミーファイルを作って成功扱いにする。
// downloadTemplate に渡された options（auth を含む）をテストから検証できるよう、
// vi.fn() でラップして呼び出し引数を記録する。
vi.mock("giget", () => ({
  downloadTemplate: vi.fn(async (_source: string, opts: { dir: string }) => {
    const { mkdirSync, writeFileSync } = await import("node:fs");
    mkdirSync(opts.dir, { recursive: true });
    writeFileSync(`${opts.dir}/dummy.txt`, "hi");
    return { dir: opts.dir };
  }),
}));

// getGitHubToken をモック: トークン取得の有無を各テストで切り替える
vi.mock("../github", () => ({
  getGitHubToken: vi.fn(),
}));

// モック後にインポート
const {
  copyFile,
  writeFileWithStrategy,
  acquireTempTemplate,
  downloadTemplateToTemp,
  fetchTemplates,
  TEMPLATE_SOURCE,
} = await import("../template");
const clack = await import("@clack/prompts");
const mockConfirm = vi.mocked(clack.confirm);
const giget = await import("giget");
const mockDownloadTemplate = vi.mocked(giget.downloadTemplate);
const github = await import("../github");
const mockGetGitHubToken = vi.mocked(github.getGitHubToken);

describe("buildTemplateSource", () => {
  it("owner/repo から giget 形式の文字列を構築", () => {
    expect(buildTemplateSource({ kind: "github", owner: "my-org", repo: "my-templates" })).toBe(
      "gh:my-org/my-templates",
    );
  });

  it("ブランチ ref は #<ブランチ名> になる", () => {
    expect(
      buildTemplateSource({
        kind: "github",
        owner: "my-org",
        repo: "repo",
        ref: { kind: "branch", name: "develop" },
      }),
    ).toBe("gh:my-org/repo#develop");
  });

  it("タグ ref は #<タグ名> になる", () => {
    expect(
      buildTemplateSource({
        kind: "github",
        owner: "my-org",
        repo: "repo",
        ref: { kind: "tag", name: "v1.2.3" },
      }),
    ).toBe("gh:my-org/repo#v1.2.3");
  });

  it("コミット ref は #<SHA> になる", () => {
    expect(
      buildTemplateSource({
        kind: "github",
        owner: "my-org",
        repo: "repo",
        ref: { kind: "commit", sha: commitSha("abc123def") },
      }),
    ).toBe("gh:my-org/repo#abc123def");
  });

  it("ref が undefined の場合は付与しない", () => {
    expect(buildTemplateSource({ kind: "github", owner: "x", repo: "y", ref: undefined })).toBe(
      "gh:x/y",
    );
  });
});

describe("buildCommitPinnedSource", () => {
  it("source の ref を無視してコミット SHA へ固定する", () => {
    expect(
      buildCommitPinnedSource(
        {
          kind: "github",
          owner: "my-org",
          repo: "repo",
          ref: { kind: "branch", name: "develop" },
        },
        commitSha("deadbeef"),
      ),
    ).toBe("gh:my-org/repo#deadbeef");
  });
});

// 型をインポート
import type { FileOperationResult } from "../../modules/schemas";

describe("copyFile", () => {
  beforeEach(() => {
    vol.reset();
    vi.clearAllMocks();
  });

  describe("新規ファイル", () => {
    it("常にコピーする", async () => {
      vol.fromJSON({
        "/src/file.txt": "source content",
      });

      const result = await copyFile(
        absPath("/src/file.txt"),
        absPath("/dest/file.txt"),
        "skip",
        repoRelPath("file.txt"),
      );

      expect(result).toEqual<CopyResult>({
        action: "copied",
        path: repoRelPath("file.txt"),
      });
      expect(vol.readFileSync("/dest/file.txt", "utf8")).toBe("source content");
    });

    it("親ディレクトリが存在しない場合は作成する", async () => {
      vol.fromJSON({
        "/src/file.txt": "source content",
      });

      await copyFile(
        absPath("/src/file.txt"),
        absPath("/dest/nested/dir/file.txt"),
        "skip",
        repoRelPath("nested/dir/file.txt"),
      );

      expect(vol.existsSync("/dest/nested/dir")).toBe(true);
      expect(vol.readFileSync("/dest/nested/dir/file.txt", "utf8")).toBe("source content");
    });
  });

  describe("既存ファイル - overwrite 戦略", () => {
    it("上書きする", async () => {
      vol.fromJSON({
        "/src/file.txt": "new content",
        "/dest/file.txt": "old content",
      });

      const result = await copyFile(
        absPath("/src/file.txt"),
        absPath("/dest/file.txt"),
        "overwrite",
        repoRelPath("file.txt"),
      );

      expect(result).toEqual<CopyResult>({
        action: "overwritten",
        path: repoRelPath("file.txt"),
      });
      expect(vol.readFileSync("/dest/file.txt", "utf8")).toBe("new content");
    });
  });

  describe("既存ファイル - skip 戦略", () => {
    it("スキップする（コピーしない）", async () => {
      vol.fromJSON({
        "/src/file.txt": "new content",
        "/dest/file.txt": "old content",
      });

      const result = await copyFile(
        absPath("/src/file.txt"),
        absPath("/dest/file.txt"),
        "skip",
        repoRelPath("file.txt"),
      );

      expect(result).toEqual<CopyResult>({
        action: "skipped",
        path: repoRelPath("file.txt"),
      });
      expect(vol.readFileSync("/dest/file.txt", "utf8")).toBe("old content");
    });
  });

  describe("既存ファイル - prompt 戦略", () => {
    it("ユーザーが Yes の場合は上書きする", async () => {
      vol.fromJSON({
        "/src/file.txt": "new content",
        "/dest/file.txt": "old content",
      });

      mockConfirm.mockResolvedValueOnce(true);

      const result = await copyFile(
        absPath("/src/file.txt"),
        absPath("/dest/file.txt"),
        "prompt",
        repoRelPath("file.txt"),
      );

      expect(result).toEqual<CopyResult>({
        action: "overwritten",
        path: repoRelPath("file.txt"),
      });
      expect(vol.readFileSync("/dest/file.txt", "utf8")).toBe("new content");
      expect(mockConfirm).toHaveBeenCalledWith({
        message: "file.txt already exists. Overwrite?",
        initialValue: false,
      });
    });

    it("ユーザーが No の場合はスキップする", async () => {
      vol.fromJSON({
        "/src/file.txt": "new content",
        "/dest/file.txt": "old content",
      });

      mockConfirm.mockResolvedValueOnce(false);

      const result = await copyFile(
        absPath("/src/file.txt"),
        absPath("/dest/file.txt"),
        "prompt",
        repoRelPath("file.txt"),
      );

      expect(result).toEqual<CopyResult>({
        action: "skipped",
        path: repoRelPath("file.txt"),
      });
      expect(vol.readFileSync("/dest/file.txt", "utf8")).toBe("old content");
    });
  });

  describe("dryRun: true", () => {
    it("新規ファイルでも実際にはコピーしない（action は copied のまま）", async () => {
      vol.fromJSON({
        "/src/file.txt": "source content",
      });

      const result = await copyFile(
        absPath("/src/file.txt"),
        absPath("/dest/file.txt"),
        "skip",
        repoRelPath("file.txt"),
        true,
      );

      expect(result).toEqual<CopyResult>({ action: "copied", path: repoRelPath("file.txt") });
      expect(vol.existsSync("/dest/file.txt")).toBe(false);
    });

    it("overwrite 戦略でも既存ファイルを書き換えない", async () => {
      vol.fromJSON({
        "/src/file.txt": "new content",
        "/dest/file.txt": "old content",
      });

      const result = await copyFile(
        absPath("/src/file.txt"),
        absPath("/dest/file.txt"),
        "overwrite",
        repoRelPath("file.txt"),
        true,
      );

      expect(result).toEqual<CopyResult>({ action: "overwritten", path: repoRelPath("file.txt") });
      expect(vol.readFileSync("/dest/file.txt", "utf8")).toBe("old content");
    });

    it("prompt 戦略は confirm() を呼ばず、initialValue と同じ「上書きしない」を既定値にする", async () => {
      vol.fromJSON({
        "/src/file.txt": "new content",
        "/dest/file.txt": "old content",
      });

      const result = await copyFile(
        absPath("/src/file.txt"),
        absPath("/dest/file.txt"),
        "prompt",
        repoRelPath("file.txt"),
        true,
      );

      expect(result).toEqual<CopyResult>({ action: "skipped", path: repoRelPath("file.txt") });
      expect(mockConfirm).not.toHaveBeenCalled();
      expect(vol.readFileSync("/dest/file.txt", "utf8")).toBe("old content");
    });
  });
});

describe("writeFileWithStrategy", () => {
  beforeEach(() => {
    vol.reset();
    vi.clearAllMocks();
  });

  describe("新規ファイル", () => {
    it("常に作成する（skip戦略でも）", async () => {
      vol.fromJSON({});

      const result = await writeFileWithStrategy({
        destPath: absPath("/dest/file.txt"),
        content: "new content",
        strategy: "skip",
        relativePath: repoRelPath("file.txt"),
      });

      expect(result).toEqual<FileOperationResult>({
        action: "created",
        path: repoRelPath("file.txt"),
      });
      expect(vol.readFileSync("/dest/file.txt", "utf8")).toBe("new content");
    });

    it("親ディレクトリが存在しない場合は作成する", async () => {
      vol.fromJSON({});

      await writeFileWithStrategy({
        destPath: absPath("/dest/nested/dir/file.txt"),
        content: "new content",
        strategy: "skip",
        relativePath: repoRelPath("nested/dir/file.txt"),
      });

      expect(vol.existsSync("/dest/nested/dir")).toBe(true);
      expect(vol.readFileSync("/dest/nested/dir/file.txt", "utf8")).toBe("new content");
    });
  });

  describe("既存ファイル - overwrite 戦略", () => {
    it("上書きする", async () => {
      vol.fromJSON({
        "/dest/file.txt": "old content",
      });

      const result = await writeFileWithStrategy({
        destPath: absPath("/dest/file.txt"),
        content: "new content",
        strategy: "overwrite",
        relativePath: repoRelPath("file.txt"),
      });

      expect(result).toEqual<FileOperationResult>({
        action: "overwritten",
        path: repoRelPath("file.txt"),
      });
      expect(vol.readFileSync("/dest/file.txt", "utf8")).toBe("new content");
    });
  });

  describe("既存ファイル - skip 戦略", () => {
    it("スキップする（書き込まない）", async () => {
      vol.fromJSON({
        "/dest/file.txt": "old content",
      });

      const result = await writeFileWithStrategy({
        destPath: absPath("/dest/file.txt"),
        content: "new content",
        strategy: "skip",
        relativePath: repoRelPath("file.txt"),
      });

      expect(result).toEqual<FileOperationResult>({
        action: "skipped",
        path: repoRelPath("file.txt"),
      });
      expect(vol.readFileSync("/dest/file.txt", "utf8")).toBe("old content");
    });
  });

  describe("既存ファイル - prompt 戦略", () => {
    it("ユーザーが Yes の場合は上書きする", async () => {
      vol.fromJSON({
        "/dest/file.txt": "old content",
      });

      mockConfirm.mockResolvedValueOnce(true);

      const result = await writeFileWithStrategy({
        destPath: absPath("/dest/file.txt"),
        content: "new content",
        strategy: "prompt",
        relativePath: repoRelPath("file.txt"),
      });

      expect(result).toEqual<FileOperationResult>({
        action: "overwritten",
        path: repoRelPath("file.txt"),
      });
      expect(vol.readFileSync("/dest/file.txt", "utf8")).toBe("new content");
      expect(mockConfirm).toHaveBeenCalledWith({
        message: "file.txt already exists. Overwrite?",
        initialValue: false,
      });
    });

    it("ユーザーが No の場合はスキップする", async () => {
      vol.fromJSON({
        "/dest/file.txt": "old content",
      });

      mockConfirm.mockResolvedValueOnce(false);

      const result = await writeFileWithStrategy({
        destPath: absPath("/dest/file.txt"),
        content: "new content",
        strategy: "prompt",
        relativePath: repoRelPath("file.txt"),
      });

      expect(result).toEqual<FileOperationResult>({
        action: "skipped",
        path: repoRelPath("file.txt"),
      });
      expect(vol.readFileSync("/dest/file.txt", "utf8")).toBe("old content");
    });
  });

  describe("dryRun: true", () => {
    it("新規ファイルでも実際には作成しない（action は created のまま）", async () => {
      vol.fromJSON({});

      const result = await writeFileWithStrategy({
        destPath: absPath("/dest/file.txt"),
        content: "new content",
        strategy: "skip",
        relativePath: repoRelPath("file.txt"),
        dryRun: true,
      });

      expect(result).toEqual<FileOperationResult>({
        action: "created",
        path: repoRelPath("file.txt"),
      });
      expect(vol.existsSync("/dest/file.txt")).toBe(false);
    });

    it("overwrite 戦略でも既存ファイルを書き換えない", async () => {
      vol.fromJSON({
        "/dest/file.txt": "old content",
      });

      const result = await writeFileWithStrategy({
        destPath: absPath("/dest/file.txt"),
        content: "new content",
        strategy: "overwrite",
        relativePath: repoRelPath("file.txt"),
        dryRun: true,
      });

      expect(result).toEqual<FileOperationResult>({
        action: "overwritten",
        path: repoRelPath("file.txt"),
      });
      expect(vol.readFileSync("/dest/file.txt", "utf8")).toBe("old content");
    });

    it("prompt 戦略は confirm() を呼ばず、initialValue と同じ「上書きしない」を既定値にする", async () => {
      vol.fromJSON({
        "/dest/file.txt": "old content",
      });

      const result = await writeFileWithStrategy({
        destPath: absPath("/dest/file.txt"),
        content: "new content",
        strategy: "prompt",
        relativePath: repoRelPath("file.txt"),
        dryRun: true,
      });

      expect(result).toEqual<FileOperationResult>({
        action: "skipped",
        path: repoRelPath("file.txt"),
      });
      expect(mockConfirm).not.toHaveBeenCalled();
      expect(vol.readFileSync("/dest/file.txt", "utf8")).toBe("old content");
    });
  });
});

describe("downloadTemplate へのトークン受け渡し", () => {
  beforeEach(() => {
    vol.reset();
    vi.clearAllMocks();
    // 既定は未認証環境（GITHUB_TOKEN 等が無い）を模す
    mockGetGitHubToken.mockReturnValue(undefined);
  });

  it("acquireTempTemplate: トークンが取得できるとき downloadTemplate に auth として渡す", async () => {
    mockGetGitHubToken.mockReturnValue("ghp_dummy_token");

    const program = acquireTempTemplate("/work", "gh:foo/bar");
    await Effect.runPromise(Effect.scoped(program));

    expect(mockDownloadTemplate).toHaveBeenCalledWith(
      "gh:foo/bar",
      expect.objectContaining({ auth: "ghp_dummy_token" }),
    );
  });

  it("acquireTempTemplate: トークンが取得できなくても downloadTemplate は呼ばれる（public リポジトリ対応）", async () => {
    const program = acquireTempTemplate("/work", "gh:foo/bar");
    await Effect.runPromise(Effect.scoped(program));

    expect(mockDownloadTemplate).toHaveBeenCalledWith(
      "gh:foo/bar",
      expect.objectContaining({ auth: undefined }),
    );
  });

  it("downloadTemplateToTemp: トークンが取得できるとき downloadTemplate に auth として渡す", async () => {
    mockGetGitHubToken.mockReturnValue("ghp_dummy_token");

    const { cleanup } = await downloadTemplateToTemp("/work", "gh:foo/bar");
    cleanup();

    expect(mockDownloadTemplate).toHaveBeenCalledWith(
      "gh:foo/bar",
      expect.objectContaining({ auth: "ghp_dummy_token" }),
    );
  });

  it("downloadTemplateToTemp: トークンが取得できなくても downloadTemplate は呼ばれる（public リポジトリ対応）", async () => {
    const { cleanup } = await downloadTemplateToTemp("/work", "gh:foo/bar");
    cleanup();

    expect(mockDownloadTemplate).toHaveBeenCalledWith(
      "gh:foo/bar",
      expect.objectContaining({ auth: undefined }),
    );
  });

  it("fetchTemplates: トークンが取得できるとき downloadTemplate に auth として渡す", async () => {
    mockGetGitHubToken.mockReturnValue("ghp_dummy_token");

    await fetchTemplates({
      targetDir: "/work",
      overwriteStrategy: "skip",
      patterns: { include: [], exclude: [] },
    });

    expect(mockDownloadTemplate).toHaveBeenCalledWith(
      TEMPLATE_SOURCE,
      expect.objectContaining({ auth: "ghp_dummy_token" }),
    );
  });

  it("fetchTemplates: トークンが取得できなくても downloadTemplate は呼ばれる（public リポジトリ対応）", async () => {
    await fetchTemplates({
      targetDir: "/work",
      overwriteStrategy: "skip",
      patterns: { include: [], exclude: [] },
    });

    expect(mockDownloadTemplate).toHaveBeenCalledWith(
      TEMPLATE_SOURCE,
      expect.objectContaining({ auth: undefined }),
    );
  });
});
