/**
 * ベースツリーの取得に失敗したときの案内を検証する。
 *
 * ダウンロードとログ出力だけをモックし、`downloadBaseForMerge` が失敗経路で何を伝えるかに
 * 絞る。実 I/O を使う統合テストは conflict-io.test.ts にある。
 */
import { Effect } from "effect";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { absPath, commitSha, hashMap } from "../../__tests__/brands";
import type { LockState } from "../../modules/schemas";
import { createPendingLock, markSynced } from "../../modules/schemas";

vi.mock("../template", () => ({
  downloadTemplateToTemp: vi.fn(() => Promise.reject(new Error("network unreachable"))),
  buildCommitPinnedSource: vi.fn(() => "gh:owner/repo#abc1234"),
}));

vi.mock("../../ui/renderer", () => ({
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
    green: (s: string) => s,
    yellow: (s: string) => s,
    red: (s: string) => s,
  },
}));

const { downloadBaseForMerge } = await import("../merge/conflict-io");
const { log } = await import("../../ui/renderer");
const mockLog = vi.mocked(log);

/** ベースツリーを取り直せる lock（GitHub ソース + ベース SHA 記録済み）。 */
function githubLockWithBaseSha(): LockState {
  const pending = createPendingLock({
    version: "0.1.0",
    installedAt: "2024-01-01T00:00:00.000Z",
    source: { kind: "github", owner: "owner", repo: "repo" },
  });
  return markSynced(pending, { hashes: hashMap({}), commitSha: commitSha("abc1234") });
}

describe("downloadBaseForMerge", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("ダウンロードに失敗したら null を返し、マーカーを書いたと読めない案内を出す", async () => {
    const result = await Effect.runPromise(
      downloadBaseForMerge({ lock: githubLockWithBaseSha(), targetDir: absPath("/project") }),
    );

    expect(result).toBeNull();

    const warning = mockLog.warn.mock.calls.map((call) => call[0]).at(-1) ?? "";
    // 実挙動は「自動マージを試みず、ローカルへ一切書かない」。マーカーを探しに行かせない。
    expect(warning).not.toMatch(/marker/i);
    expect(warning).toContain("Auto-merge is skipped");
    expect(warning).toContain("left untouched");
    expect(warning).toContain("unresolved");
  });
});
