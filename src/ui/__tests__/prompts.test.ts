import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("@clack/prompts", () => ({
  multiselect: vi.fn(),
  select: vi.fn(),
  text: vi.fn(),
  password: vi.fn(),
  confirm: vi.fn(),
  isCancel: vi.fn(() => false),
  cancel: vi.fn(),
  log: {
    warn: vi.fn(),
    message: vi.fn(),
  },
}));

vi.mock("node:child_process", () => ({
  execFileSync: vi.fn(),
}));

import { execFileSync } from "node:child_process";
import * as p from "@clack/prompts";
import type { FileDiff } from "../../modules/schemas";
import type { FileSelectionMarks } from "../file-select-with-diff";
import { NO_FILE_SELECTION_MARKS } from "../file-select-with-diff";
import {
  confirmAction,
  confirmRetryConflictResolution,
  generatePrBody,
  generatePrTitle,
  inputGitHubToken,
  inputPrBody,
  inputPrTitle,
  openEditorForConflicts,
  selectDeletedFiles,
  selectDirectories,
  selectOverwriteStrategy,
  selectPushFiles,
} from "../prompts";
import { globPatterns, repoRelPath, repoRelPaths } from "../../__tests__/brands";

/** 検証したい印だけを指定して {@link FileSelectionMarks} を組む。 */
function marksWith(overrides: Partial<FileSelectionMarks>): FileSelectionMarks {
  return { ...NO_FILE_SELECTION_MARKS, ...overrides };
}

/** バイナリの内容を差分の string チャネルへ載せた形（バイト保存の latin1）。 */
function asBinaryContent(bytes: number[]): string {
  return Buffer.from(bytes).toString("latin1");
}

const testEntries = [
  {
    label: ".devcontainer",
    patterns: globPatterns([".devcontainer/**"]),
  },
  {
    label: ".github",
    patterns: globPatterns([".github/**"]),
  },
];

describe("prompts", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  describe("selectDirectories", () => {
    it("should return selected patterns", async () => {
      vi.mocked(p.multiselect).mockResolvedValue([".devcontainer"]);
      const result = await selectDirectories(testEntries);
      expect(result).toEqual([".devcontainer/**"]);
    });

    it("should pass all directory labels as initial values", async () => {
      vi.mocked(p.multiselect).mockResolvedValue([".devcontainer", ".github"]);
      await selectDirectories(testEntries);
      expect(p.multiselect).toHaveBeenCalledWith(
        expect.objectContaining({
          initialValues: [".devcontainer", ".github"],
        }),
      );
    });
  });

  describe("selectOverwriteStrategy", () => {
    it("should return selected strategy", async () => {
      vi.mocked(p.select).mockResolvedValue("overwrite");
      const result = await selectOverwriteStrategy();
      expect(result).toBe("overwrite");
    });

    it("should default to overwrite for new projects", async () => {
      vi.mocked(p.select).mockResolvedValue("overwrite");
      await selectOverwriteStrategy();
      expect(p.select).toHaveBeenCalledWith(
        expect.objectContaining({
          initialValue: "overwrite",
        }),
      );
    });

    it("should default to skip for re-init projects", async () => {
      vi.mocked(p.select).mockResolvedValue("skip");
      await selectOverwriteStrategy({ isReinit: true });
      expect(p.select).toHaveBeenCalledWith(
        expect.objectContaining({
          initialValue: "skip",
          message: expect.stringContaining("re-init"),
        }),
      );
    });
  });

  describe("selectPushFiles", () => {
    it("should filter files by selection", async () => {
      const files = [
        { path: repoRelPath("a.ts"), type: "added" as const, localContent: "local" },
        {
          path: repoRelPath("b.ts"),
          type: "modified" as const,
          localContent: "local",
          templateContent: "template",
        },
      ];
      vi.mocked(p.multiselect).mockResolvedValue(["a.ts"]);
      const result = await selectPushFiles(files, NO_FILE_SELECTION_MARKS);
      expect(result).toHaveLength(1);
      expect(result[0].path).toBe("a.ts");
    });

    it("should return empty array when nothing selected", async () => {
      const files = [{ path: repoRelPath("a.ts"), type: "added" as const, localContent: "local" }];
      vi.mocked(p.multiselect).mockResolvedValue([]);
      const result = await selectPushFiles(files, NO_FILE_SELECTION_MARKS);
      expect(result).toHaveLength(0);
    });

    it("conflictedPaths のファイルは初期選択から除外され conflict と表示される", async () => {
      const files = [
        {
          path: repoRelPath("a.ts"),
          type: "modified" as const,
          localContent: "local",
          templateContent: "template",
        },
        {
          path: repoRelPath("bad.ts"),
          type: "modified" as const,
          localContent: "local",
          templateContent: "template",
        },
      ];
      vi.mocked(p.multiselect).mockResolvedValue([]);
      await selectPushFiles(
        files,
        marksWith({ conflictedPaths: new Set(repoRelPaths(["bad.ts"])) }),
      );

      const callArg = vi.mocked(p.multiselect).mock.calls[0][0] as {
        initialValues: string[];
        options: Array<{ value: string; hint?: string }>;
      };
      // 衝突ファイルは既定で未選択（選ぶと push が中断するため）
      expect(callArg.initialValues).toContain("a.ts");
      expect(callArg.initialValues).not.toContain("bad.ts");
      // 衝突ファイルは hint で明示される
      const badOption = callArg.options.find((o) => o.value === "bad.ts");
      expect(badOption?.hint).toContain("conflict");
    });

    it("テンプレートの削除を取り消すファイルは初期選択から除外され、その旨が表示される", async () => {
      // 見た目は新規追加と同じ `+` なので、注記が無いと「テンプレートが消したファイルを
      // 復活させる」操作だと一覧から分からない。
      const files = [
        { path: repoRelPath("a.ts"), type: "added" as const, localContent: "local" },
        { path: repoRelPath("restored.ts"), type: "added" as const, localContent: "local" },
      ];
      vi.mocked(p.multiselect).mockResolvedValue([]);
      await selectPushFiles(
        files,
        marksWith({ restoresTemplateDeletion: new Set(repoRelPaths(["restored.ts"])) }),
      );

      const callArg = vi.mocked(p.multiselect).mock.calls[0][0] as {
        initialValues: string[];
        options: Array<{ value: string; hint?: string }>;
      };
      expect(callArg.initialValues).toContain("a.ts");
      expect(callArg.initialValues).not.toContain("restored.ts");
      const restoredOption = callArg.options.find((o) => o.value === "restored.ts");
      expect(restoredOption?.hint).toContain("restores file deleted in template");
    });

    it("バイナリの hint は行数ではなく (binary) を出す", async () => {
      const files: FileDiff[] = [
        {
          path: repoRelPath("assets/icon.png"),
          type: "modified",
          templateContent: asBinaryContent([0x89, 0x50, 0x4e, 0x47, 0x00, 0x01]),
          localContent: asBinaryContent([0x89, 0x50, 0x4e, 0x47, 0x00, 0x02]),
        },
      ];
      vi.mocked(p.multiselect).mockResolvedValue([]);
      await selectPushFiles(files, NO_FILE_SELECTION_MARKS);

      const callArg = vi.mocked(p.multiselect).mock.calls[0][0] as {
        options: Array<{ value: string; hint?: string }>;
      };
      // バイナリは増減行数を持たないので、0 行を根拠に hint ごと落とすと種別が伝わらない
      expect(callArg.options[0].hint).toContain("binary");
    });
  });

  describe("inputPrTitle", () => {
    it("should return entered title", async () => {
      vi.mocked(p.text).mockResolvedValue("feat: add config");
      const result = await inputPrTitle();
      expect(result).toBe("feat: add config");
    });

    it("should use default title as defaultValue", async () => {
      vi.mocked(p.text).mockResolvedValue("default title");
      await inputPrTitle("default title");
      expect(p.text).toHaveBeenCalledWith(
        expect.objectContaining({ defaultValue: "default title" }),
      );
    });

    it("should use placeholder when no default title provided", async () => {
      vi.mocked(p.text).mockResolvedValue("custom title");
      await inputPrTitle();
      expect(p.text).toHaveBeenCalledWith(
        expect.objectContaining({
          placeholder: "feat: update template config",
          defaultValue: undefined,
        }),
      );
    });
  });

  describe("generatePrTitle", () => {
    it("should generate feat prefix for added-only files", () => {
      const files: FileDiff[] = [
        {
          path: repoRelPath(".devcontainer/devcontainer.json"),
          type: "added",
          localContent: "local",
        },
      ];
      expect(generatePrTitle(files)).toBe("feat: add .devcontainer config");
    });

    it("should generate chore prefix for modified files", () => {
      const files: FileDiff[] = [
        {
          path: repoRelPath(".github/workflows/ci.yml"),
          type: "modified",
          localContent: "local",
          templateContent: "template",
        },
      ];
      expect(generatePrTitle(files)).toBe("chore: update .github config");
    });

    it("should generate chore prefix for mixed changes", () => {
      const files: FileDiff[] = [
        {
          path: repoRelPath(".devcontainer/devcontainer.json"),
          type: "added",
          localContent: "local",
        },
        {
          path: repoRelPath(".github/workflows/ci.yml"),
          type: "modified",
          localContent: "local",
          templateContent: "template",
        },
      ];
      expect(generatePrTitle(files)).toBe("chore: update .devcontainer, .github config");
    });

    it("should use generic title for many modules", () => {
      const files: FileDiff[] = [
        { path: repoRelPath(".devcontainer/a.json"), type: "added", localContent: "local" },
        { path: repoRelPath(".github/b.yml"), type: "added", localContent: "local" },
        { path: repoRelPath(".claude/c.md"), type: "added", localContent: "local" },
        { path: repoRelPath(".mcp/d.json"), type: "added", localContent: "local" },
      ];
      expect(generatePrTitle(files)).toBe("feat: update template configuration");
    });

    it("should handle root-level files", () => {
      const files: FileDiff[] = [
        {
          path: repoRelPath(".mcp.json"),
          type: "modified",
          localContent: "local",
          templateContent: "template",
        },
      ];
      expect(generatePrTitle(files)).toBe("chore: update .mcp.json config");
    });
  });

  describe("inputPrBody", () => {
    it("should return undefined for empty input", async () => {
      vi.mocked(p.text).mockResolvedValue("");
      const result = await inputPrBody();
      expect(result).toBeUndefined();
    });

    it("should return body text", async () => {
      vi.mocked(p.text).mockResolvedValue("description");
      const result = await inputPrBody();
      expect(result).toBe("description");
    });

    it("should pass defaultBody as defaultValue", async () => {
      vi.mocked(p.text).mockResolvedValue("auto body");
      await inputPrBody("auto body");
      expect(p.text).toHaveBeenCalledWith(expect.objectContaining({ defaultValue: "auto body" }));
    });
  });

  describe("generatePrBody", () => {
    it("should list added files", () => {
      const files: FileDiff[] = [
        {
          path: repoRelPath(".devcontainer/devcontainer.json"),
          type: "added",
          localContent: "local",
        },
      ];
      const body = generatePrBody(files);
      expect(body).toContain("**Added:**");
      expect(body).toContain("`.devcontainer/devcontainer.json`");
    });

    it("should list modified files", () => {
      const files: FileDiff[] = [
        {
          path: repoRelPath(".github/workflows/ci.yml"),
          type: "modified",
          localContent: "local",
          templateContent: "template",
        },
      ];
      const body = generatePrBody(files);
      expect(body).toContain("**Modified:**");
      expect(body).toContain("`.github/workflows/ci.yml`");
    });

    it("should list both added and modified", () => {
      const files: FileDiff[] = [
        { path: repoRelPath("a.json"), type: "added", localContent: "local" },
        {
          path: repoRelPath("b.yml"),
          type: "modified",
          localContent: "local",
          templateContent: "template",
        },
      ];
      const body = generatePrBody(files);
      expect(body).toContain("**Added:**");
      expect(body).toContain("**Modified:**");
    });

    it("should include ziku attribution", () => {
      const files: FileDiff[] = [
        { path: repoRelPath("a.json"), type: "added", localContent: "local" },
      ];
      const body = generatePrBody(files);
      expect(body).toContain("ziku");
    });
  });

  describe("inputGitHubToken", () => {
    it("should return entered token", async () => {
      vi.mocked(p.password).mockResolvedValue("ghp_test123");
      const result = await inputGitHubToken();
      expect(result).toBe("ghp_test123");
    });

    it("should show warning about missing token", async () => {
      vi.mocked(p.password).mockResolvedValue("ghp_test123");
      await inputGitHubToken();
      expect(p.log.warn).toHaveBeenCalled();
    });
  });

  describe("confirmAction", () => {
    it("should return true when confirmed", async () => {
      vi.mocked(p.confirm).mockResolvedValue(true);
      const result = await confirmAction("Proceed?");
      expect(result).toBe(true);
    });

    it("should return false when denied", async () => {
      vi.mocked(p.confirm).mockResolvedValue(false);
      const result = await confirmAction("Proceed?");
      expect(result).toBe(false);
    });

    it("should default to false without options", async () => {
      vi.mocked(p.confirm).mockResolvedValue(false);
      await confirmAction("Proceed?");
      expect(p.confirm).toHaveBeenCalledWith(expect.objectContaining({ initialValue: false }));
    });

    it("should use custom initialValue when provided", async () => {
      vi.mocked(p.confirm).mockResolvedValue(true);
      await confirmAction("Proceed?", { initialValue: true });
      expect(p.confirm).toHaveBeenCalledWith(expect.objectContaining({ initialValue: true }));
    });
  });

  describe("confirmRetryConflictResolution", () => {
    it("should call clack.confirm with initialValue true", async () => {
      vi.mocked(p.confirm).mockResolvedValue(true);
      const result = await confirmRetryConflictResolution();
      expect(result).toBe(true);
      expect(p.confirm).toHaveBeenCalledWith(
        expect.objectContaining({
          message: "Conflict markers remain. Open editor again?",
          initialValue: true,
        }),
      );
    });

    it("should return false when user declines", async () => {
      vi.mocked(p.confirm).mockResolvedValue(false);
      const result = await confirmRetryConflictResolution();
      expect(result).toBe(false);
    });
  });

  describe("selectDeletedFiles", () => {
    it("should call clack.multiselect with file options", async () => {
      const files = repoRelPaths(["a.ts", "b.ts"]);
      vi.mocked(p.multiselect).mockResolvedValue(["a.ts"]);
      const result = await selectDeletedFiles(files);
      expect(result).toEqual(["a.ts"]);
      expect(p.multiselect).toHaveBeenCalledWith(
        expect.objectContaining({
          options: [
            { value: "a.ts", label: "a.ts" },
            { value: "b.ts", label: "b.ts" },
          ],
          required: false,
        }),
      );
    });

    it("should return empty array when nothing selected", async () => {
      vi.mocked(p.multiselect).mockResolvedValue([]);
      const result = await selectDeletedFiles(repoRelPaths(["a.ts"]));
      expect(result).toEqual([]);
    });
  });

  describe("openEditorForConflicts", () => {
    it("should use $EDITOR env var", () => {
      const originalEditor = process.env.EDITOR;
      const originalVisual = process.env.VISUAL;
      process.env.EDITOR = "nano";
      delete process.env.VISUAL;

      openEditorForConflicts(["file1.ts", "file2.ts"]);

      expect(execFileSync).toHaveBeenCalledWith("nano", ["file1.ts"], { stdio: "inherit" });
      expect(execFileSync).toHaveBeenCalledWith("nano", ["file2.ts"], { stdio: "inherit" });

      process.env.EDITOR = originalEditor;
      if (originalVisual !== undefined) {
        process.env.VISUAL = originalVisual;
      }
    });

    it("should prefer $VISUAL over $EDITOR", () => {
      const originalEditor = process.env.EDITOR;
      const originalVisual = process.env.VISUAL;
      process.env.VISUAL = "code";
      process.env.EDITOR = "nano";

      openEditorForConflicts(["file1.ts"]);

      expect(execFileSync).toHaveBeenCalledWith("code", ["file1.ts"], { stdio: "inherit" });

      process.env.EDITOR = originalEditor;
      if (originalVisual === undefined) {
        delete process.env.VISUAL;
      } else {
        process.env.VISUAL = originalVisual;
      }
    });

    it("should skip when editor throws", () => {
      const originalEditor = process.env.EDITOR;
      const originalVisual = process.env.VISUAL;
      delete process.env.VISUAL;
      process.env.EDITOR = "nonexistent";
      vi.mocked(execFileSync).mockImplementation(() => {
        throw new Error("not found");
      });

      expect(() => openEditorForConflicts(["file1.ts"])).not.toThrow();

      process.env.EDITOR = originalEditor;
      if (originalVisual !== undefined) {
        process.env.VISUAL = originalVisual;
      }
    });
  });
});
