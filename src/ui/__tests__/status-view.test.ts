import { describe, expect, it } from "vitest";
import { recommendationLine, renderStatusLong, type StatusViewModel } from "../status-view";
import type { Recommendation, StatusBuckets, StatusEntry } from "../../utils/status";

function entry(
  path: string,
  direction: StatusEntry["direction"],
  category: StatusEntry["category"],
  isDestructive = false,
): StatusEntry {
  return { path, direction, category, isDestructive };
}

function buckets(partial: Partial<StatusBuckets> = {}): StatusBuckets {
  return {
    pull: partial.pull ?? [],
    push: partial.push ?? [],
    conflict: partial.conflict ?? [],
    inSyncCount: partial.inSyncCount ?? 0,
  };
}

const DEFAULT_REC: Recommendation = { kind: "inSync" };

function model(
  partial: Partial<StatusViewModel> = {},
  recommendation: Recommendation = DEFAULT_REC,
): StatusViewModel {
  return {
    buckets: partial.buckets ?? buckets(),
    untracked: partial.untracked ?? [],
    recommendation: partial.recommendation ?? recommendation,
  };
}

/**
 * ANSI SGR エスケープシーケンス（ESC + `[` + 数値 + `m`）を取り除き、素のテキストで比較する。
 * RegExp コンストラクタに ESC を動的に流し込むことで、正規表現リテラル内に制御文字を
 * 直書きするのを避けている（lint の no-control-regex 回避 + ソース可読性向上）。
 */
const ESC = String.fromCodePoint(0x1b);
const ANSI_SGR_PATTERN = new RegExp(`${ESC}\\[[0-9;]*m`, "g");
function strip(s: string): string {
  return s.replaceAll(ANSI_SGR_PATTERN, "");
}

describe("status-view", () => {
  describe("recommendationLine", () => {
    it("inSync は in sync のメッセージを返す", () => {
      expect(strip(recommendationLine({ kind: "inSync" }))).toContain("In sync");
    });

    it("pullOnly は ziku pull を促す", () => {
      const line = strip(recommendationLine({ kind: "pullOnly", pullCount: 3 }));
      expect(line).toContain("ziku pull");
      expect(line).toContain("3");
    });

    it("pushOnly は ziku push を促す", () => {
      const line = strip(recommendationLine({ kind: "pushOnly", pushCount: 2 }));
      expect(line).toContain("ziku push");
      expect(line).toContain("2");
    });

    it("pullThenPush は両方のコマンドと順序を含む", () => {
      const line = strip(recommendationLine({ kind: "pullThenPush", pullCount: 3, pushCount: 2 }));
      expect(line).toContain("ziku pull");
      expect(line).toContain("ziku push");
      expect(line.indexOf("ziku pull")).toBeLessThan(line.indexOf("ziku push"));
    });

    it("resolveConflict は ziku pull で merge を始めるよう促す", () => {
      const line = strip(
        recommendationLine({
          kind: "resolveConflict",
          conflictCount: 1,
          pullCount: 0,
          pushCount: 0,
        }),
      );
      expect(line).toContain("ziku pull");
      expect(line).toContain("merge");
    });

    it("continueMerge は ziku pull --continue を促す", () => {
      const line = strip(recommendationLine({ kind: "continueMerge", conflictCount: 2 }));
      expect(line).toContain("ziku pull --continue");
      expect(line).toContain("2");
    });

    it("continueMerge with conflictCount=0 は stale lock のクリアを案内する", () => {
      const line = strip(recommendationLine({ kind: "continueMerge", conflictCount: 0 }));
      expect(line).toContain("Stale merge state");
      expect(line).toContain("ziku pull --continue");
      // 0 件と表示しないことを保証（混乱回避）
      expect(line).not.toMatch(/\b0 conflict/);
    });
  });

  describe("renderStatusLong", () => {
    it("recommendation 行は含めない（outro 側で別途表示するため SSOT を outro に集約）", () => {
      const out = strip(
        renderStatusLong(model({ buckets: buckets({ inSyncCount: 5 }) }, { kind: "inSync" })),
      );
      expect(out).not.toContain("In sync — nothing to do");
    });

    it("全部空のときは in sync メッセージを出す", () => {
      const out = strip(renderStatusLong(model({ buckets: buckets({ inSyncCount: 5 }) })));
      expect(out).toContain("Tracked files are in sync");
    });

    it("pull バケツは modified / new file / deleted ラベルを描き分ける", () => {
      const out = strip(
        renderStatusLong(
          model({
            buckets: buckets({
              pull: [
                entry("a.txt", "pull", "autoUpdate"),
                entry("b.txt", "pull", "newFiles"),
                entry("c.txt", "pull", "deletedFiles", true),
              ],
            }),
          }),
        ),
      );
      expect(out).toContain("Pull pending");
      expect(out).toContain("modified:");
      expect(out).toContain("new file:");
      expect(out).toContain("deleted:");
    });

    it("untracked セクションは ziku track のヒントを出す", () => {
      const out = strip(
        renderStatusLong(
          model({
            untracked: [{ files: [{ path: ".claude/rules/draft.md" }] }],
          }),
        ),
      );
      expect(out).toContain("Untracked");
      expect(out).toContain("ziku track");
      expect(out).toContain(".claude/rules/draft.md");
    });

    it("pendingMerge 中（continueMerge）はバケツが空でも in sync バナーを出さない", () => {
      // バグ再現: bucket/untracked が全部空でも pendingMerge があれば
      // outro で `pull --continue` を案内するため、"Tracked files are in sync"
      // と矛盾するメッセージを同時に出してはいけない (codex review #71 より)
      const out = strip(
        renderStatusLong(
          model(
            { buckets: buckets({ inSyncCount: 5 }) },
            { kind: "continueMerge", conflictCount: 0 },
          ),
        ),
      );
      expect(out).not.toContain("Tracked files are in sync");
    });

    it("conflict セクションのヒントは pendingMerge 中だと 'pull --continue' に切り替わる (codex P2)", () => {
      const conflictEntry = entry("c.txt", "conflict", "conflicts");
      const out = strip(
        renderStatusLong(
          model(
            { buckets: buckets({ conflict: [conflictEntry] }) },
            { kind: "continueMerge", conflictCount: 1 },
          ),
        ),
      );
      expect(out).toContain("ziku pull --continue");
      expect(out).not.toContain("start a 3-way merge");
    });

    it("conflict セクションのヒントは pendingMerge 無しなら従来の '3-way merge を始める' のまま", () => {
      const conflictEntry = entry("c.txt", "conflict", "conflicts");
      const out = strip(
        renderStatusLong(
          model(
            { buckets: buckets({ conflict: [conflictEntry] }) },
            { kind: "resolveConflict", conflictCount: 1, pullCount: 0, pushCount: 0 },
          ),
        ),
      );
      expect(out).toContain("start a 3-way merge");
      expect(out).not.toContain("--continue");
    });

    it("空でないバケツがある場合は in sync メッセージを出さない", () => {
      const out = strip(
        renderStatusLong(
          model({
            buckets: buckets({ pull: [entry("a.txt", "pull", "autoUpdate")] }),
          }),
        ),
      );
      expect(out).not.toContain("Tracked files are in sync");
    });
  });
});
