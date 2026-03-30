import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("@clack/prompts", () => ({
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
  spinner: vi.fn(() => ({
    start: vi.fn(),
    stop: vi.fn(),
  })),
}));

import * as p from "@clack/prompts";
import {
  intro,
  log,
  logBermError,
  logDiffSummary,
  logFileResults,
  outro,
  withSpinner,
} from "../renderer";

describe("renderer", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  describe("intro", () => {
    it("should call p.intro with command", () => {
      intro("push");
      expect(p.intro).toHaveBeenCalledTimes(1);
      const arg = vi.mocked(p.intro).mock.calls[0][0] as string;
      expect(arg).toContain("ziku push");
    });

    it("should call p.intro without command", () => {
      intro();
      expect(p.intro).toHaveBeenCalledTimes(1);
      const arg = vi.mocked(p.intro).mock.calls[0][0] as string;
      expect(arg).toContain("ziku");
    });
  });

  describe("outro", () => {
    it("should call p.outro", () => {
      outro("Done!");
      expect(p.outro).toHaveBeenCalledWith("Done!");
    });
  });

  describe("log", () => {
    it("should delegate to p.log methods", () => {
      log.info("info msg");
      log.success("success msg");
      log.warn("warn msg");
      log.error("error msg");
      log.step("step msg");
      log.message("message msg");

      expect(p.log.info).toHaveBeenCalledWith("info msg");
      expect(p.log.success).toHaveBeenCalledWith("success msg");
      expect(p.log.warn).toHaveBeenCalledWith("warn msg");
      expect(p.log.error).toHaveBeenCalledWith("error msg");
      expect(p.log.step).toHaveBeenCalledWith("step msg");
      expect(p.log.message).toHaveBeenCalledWith("message msg");
    });
  });

  describe("withSpinner", () => {
    it("should start and stop spinner on success", async () => {
      const mockSpinner = {
        start: vi.fn(),
        stop: vi.fn(),
        cancel: vi.fn(),
        error: vi.fn(),
        message: vi.fn(),
        clear: vi.fn(),
        isCancelled: false,
      };
      vi.mocked(p.spinner).mockReturnValue(mockSpinner);

      const result = await withSpinner("loading...", async () => 42);

      expect(result).toBe(42);
      expect(mockSpinner.start).toHaveBeenCalledWith("loading...");
      expect(mockSpinner.stop).toHaveBeenCalledWith("loading...");
    });

    it("should stop spinner on error", async () => {
      const mockSpinner = {
        start: vi.fn(),
        stop: vi.fn(),
        cancel: vi.fn(),
        error: vi.fn(),
        message: vi.fn(),
        clear: vi.fn(),
        isCancelled: false,
      };
      vi.mocked(p.spinner).mockReturnValue(mockSpinner);

      await expect(
        withSpinner("loading...", async () => {
          throw new Error("fail");
        }),
      ).rejects.toThrow("fail");

      expect(mockSpinner.start).toHaveBeenCalled();
      expect(mockSpinner.stop).toHaveBeenCalled();
    });
  });

  describe("logFileResults", () => {
    it("should count added/updated/skipped", () => {
      const results = [
        { action: "copied", path: "a.ts" },
        { action: "created", path: "b.ts" },
        { action: "overwritten", path: "c.ts" },
        { action: "skipped", path: "d.ts" },
      ];
      const summary = logFileResults(results);
      expect(summary).toEqual({ added: 2, updated: 1, skipped: 1 });
      expect(p.log.message).toHaveBeenCalledTimes(1);
    });

    it("should handle empty results", () => {
      const summary = logFileResults([]);
      expect(summary).toEqual({ added: 0, updated: 0, skipped: 0 });
    });
  });

  describe("logDiffSummary", () => {
    it("should show no changes message when all unchanged", () => {
      logDiffSummary([{ path: "a.ts", type: "unchanged" }]);
      expect(p.log.info).toHaveBeenCalledWith("No changes detected");
    });

    it("should display changed files", () => {
      logDiffSummary([
        { path: "a.ts", type: "added" },
        { path: "b.ts", type: "modified" },
        { path: "c.ts", type: "deleted" },
      ]);
      expect(p.log.message).toHaveBeenCalledTimes(1);
    });
  });

  describe("logBermError", () => {
    it("should display error with hint", () => {
      logBermError({ message: "not found", hint: "Run init first" });
      expect(p.log.error).toHaveBeenCalledWith("not found");
      expect(p.log.message).toHaveBeenCalledTimes(1);
    });

    it("should display error without hint", () => {
      logBermError({ message: "not found" });
      expect(p.log.error).toHaveBeenCalledWith("not found");
      expect(p.log.message).not.toHaveBeenCalled();
    });
  });
});
