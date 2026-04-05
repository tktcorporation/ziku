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

const testEntries = [
  {
    label: ".devcontainer",
    patterns: [".devcontainer/**"],
  },
  {
    label: ".github",
    patterns: [".github/**"],
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
        { path: "a.ts", type: "added" as const },
        { path: "b.ts", type: "modified" as const },
      ];
      vi.mocked(p.multiselect).mockResolvedValue(["a.ts"]);
      const result = await selectPushFiles(files);
      expect(result).toHaveLength(1);
      expect(result[0].path).toBe("a.ts");
    });

    it("should return empty array when nothing selected", async () => {
      const files = [{ path: "a.ts", type: "added" as const }];
      vi.mocked(p.multiselect).mockResolvedValue([]);
      const result = await selectPushFiles(files);
      expect(result).toHaveLength(0);
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
      const files: FileDiff[] = [{ path: ".devcontainer/devcontainer.json", type: "added" }];
      expect(generatePrTitle(files)).toBe("feat: add .devcontainer config");
    });

    it("should generate chore prefix for modified files", () => {
      const files: FileDiff[] = [{ path: ".github/workflows/ci.yml", type: "modified" }];
      expect(generatePrTitle(files)).toBe("chore: update .github config");
    });

    it("should generate chore prefix for mixed changes", () => {
      const files: FileDiff[] = [
        { path: ".devcontainer/devcontainer.json", type: "added" },
        { path: ".github/workflows/ci.yml", type: "modified" },
      ];
      expect(generatePrTitle(files)).toBe("chore: update .devcontainer, .github config");
    });

    it("should use generic title for many modules", () => {
      const files: FileDiff[] = [
        { path: ".devcontainer/a.json", type: "added" },
        { path: ".github/b.yml", type: "added" },
        { path: ".claude/c.md", type: "added" },
        { path: ".mcp/d.json", type: "added" },
      ];
      expect(generatePrTitle(files)).toBe("feat: update template configuration");
    });

    it("should handle root-level files", () => {
      const files: FileDiff[] = [{ path: ".mcp.json", type: "modified" }];
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
      const files: FileDiff[] = [{ path: ".devcontainer/devcontainer.json", type: "added" }];
      const body = generatePrBody(files);
      expect(body).toContain("**Added:**");
      expect(body).toContain("`.devcontainer/devcontainer.json`");
    });

    it("should list modified files", () => {
      const files: FileDiff[] = [{ path: ".github/workflows/ci.yml", type: "modified" }];
      const body = generatePrBody(files);
      expect(body).toContain("**Modified:**");
      expect(body).toContain("`.github/workflows/ci.yml`");
    });

    it("should list both added and modified", () => {
      const files: FileDiff[] = [
        { path: "a.json", type: "added" },
        { path: "b.yml", type: "modified" },
      ];
      const body = generatePrBody(files);
      expect(body).toContain("**Added:**");
      expect(body).toContain("**Modified:**");
    });

    it("should include ziku attribution", () => {
      const files: FileDiff[] = [{ path: "a.json", type: "added" }];
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
      const files = ["a.ts", "b.ts"];
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
      const result = await selectDeletedFiles(["a.ts"]);
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
