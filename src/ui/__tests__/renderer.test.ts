import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

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
  logUnexpectedError,
  logZikuError,
  logDiffSummary,
  logFileResults,
  outro,
  withSpinner,
} from "../renderer";

/** テスト中に process.stdout.isTTY を切り替えるヘルパー（#84 の分岐検証用） */
function setIsTTY(value: boolean): void {
  Object.defineProperty(process.stdout, "isTTY", { value, configurable: true });
}

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
    // withSpinner は process.stdout.isTTY で挙動を分岐する（#84）。
    // TTY 経路（アニメーション）を検証するため、各テストで isTTY を明示的に切り替える。
    let originalIsTTY: boolean | undefined;

    beforeEach(() => {
      originalIsTTY = process.stdout.isTTY;
    });

    afterEach(() => {
      Object.defineProperty(process.stdout, "isTTY", {
        value: originalIsTTY,
        configurable: true,
      });
    });

    it("should start and stop spinner on success (TTY)", async () => {
      setIsTTY(true);
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

    it("should stop spinner on error (TTY)", async () => {
      setIsTTY(true);
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

    it("非 TTY ではスピナーを使わず単一行で開始メッセージを出す（#84）", async () => {
      setIsTTY(false);

      const result = await withSpinner("loading...", async () => 42);

      expect(result).toBe(42);
      // アニメーションするスピナーは生成しない
      expect(p.spinner).not.toHaveBeenCalled();
      // 開始メッセージは 1 回だけ
      expect(p.log.step).toHaveBeenCalledTimes(1);
      expect(p.log.step).toHaveBeenCalledWith("loading...");
    });

    it("非 TTY でタスク失敗時は失敗行を出しエラーを伝播する（#84）", async () => {
      setIsTTY(false);

      await expect(
        withSpinner("loading...", async () => {
          throw new Error("fail");
        }),
      ).rejects.toThrow("fail");

      expect(p.spinner).not.toHaveBeenCalled();
      expect(p.log.error).toHaveBeenCalledWith("Failed: loading...");
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
      logDiffSummary([
        { path: "a.ts", type: "unchanged", localContent: "same", templateContent: "same" },
      ]);
      expect(p.log.info).toHaveBeenCalledWith("No changes detected");
    });

    it("should display changed files", () => {
      logDiffSummary([
        { path: "a.ts", type: "added", localContent: "a" },
        { path: "b.ts", type: "modified", localContent: "b", templateContent: "B" },
        { path: "c.ts", type: "deleted", templateContent: "c" },
      ]);
      expect(p.log.message).toHaveBeenCalledTimes(1);
    });

    it("件数は渡された差分から数える", () => {
      logDiffSummary([
        { path: "a.ts", type: "added", localContent: "a" },
        { path: "b.ts", type: "added", localContent: "b" },
        { path: "c.ts", type: "deleted", templateContent: "c" },
        { path: "d.ts", type: "unchanged", localContent: "d", templateContent: "d" },
      ]);
      const message = vi.mocked(p.log.message).mock.calls[0][0] as string;
      expect(message).toContain("+2 added");
      expect(message).toContain("-1 deleted");
      expect(message).not.toContain("modified");
    });
  });

  describe("logZikuError", () => {
    it("should display error with hint", () => {
      logZikuError({ message: "not found", hint: "Run init first" });
      expect(p.log.error).toHaveBeenCalledWith("not found");
      expect(p.log.message).toHaveBeenCalledTimes(1);
    });

    it("should display error without hint", () => {
      logZikuError({ message: "not found" });
      expect(p.log.error).toHaveBeenCalledWith("not found");
      expect(p.log.message).not.toHaveBeenCalled();
    });
  });

  describe("logUnexpectedError", () => {
    it("スタックトレースと cause の連鎖をそのまま見せる", () => {
      const root = new Error("socket hang up");
      const wrapper = new Error("request failed", { cause: root });

      logUnexpectedError(wrapper);

      expect(p.log.error).toHaveBeenCalledWith("Unexpected error — this is a bug in ziku.");
      const body = vi.mocked(p.log.message).mock.calls[0][0] as string;
      expect(body).toContain("request failed");
      expect(body).toContain("Caused by:");
      expect(body).toContain("socket hang up");
      expect(body).toContain("renderer.test.ts");
    });

    it("Error でない値も文字列にして見せる", () => {
      logUnexpectedError("boom");

      const body = vi.mocked(p.log.message).mock.calls[0][0] as string;
      expect(body).toBe("boom");
    });

    it("cause が循環していても打ち切る", () => {
      const a = new Error("a");
      const b = new Error("b", { cause: a });
      a.cause = b;

      logUnexpectedError(a);

      const body = vi.mocked(p.log.message).mock.calls[0][0] as string;
      expect(body).toContain("(truncated)");
    });
  });
});
