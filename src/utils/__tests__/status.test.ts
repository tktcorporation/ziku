import { describe, expect, it } from "vitest";
import type { LockState } from "../../modules/schemas";
import type { FileClassification } from "../merge/types";
import {
  categorizeForStatus,
  decideRecommendation,
  directionOfCategory,
  isDestructiveCategory,
  isEntryCategory,
  type StatusBuckets,
} from "../status";

/** ヘルパー: 空の FileClassification を作る */
function emptyClassification(): FileClassification {
  return {
    autoUpdate: [],
    localOnly: [],
    conflicts: [],
    newFiles: [],
    deletedFiles: [],
    deletedLocally: [],
    unchanged: [],
  };
}

/** ヘルパー: 空の StatusBuckets を作る */
function emptyBuckets(): StatusBuckets {
  return { pull: [], push: [], conflict: [], inSyncCount: 0 };
}

describe("status", () => {
  describe("isEntryCategory", () => {
    it.each([
      "autoUpdate",
      "newFiles",
      "deletedFiles",
      "localOnly",
      "deletedLocally",
      "conflicts",
    ] as const)("%s は EntryCategory（status の表示対象）", (cat) => {
      expect(isEntryCategory(cat)).toBe(true);
    });

    it("unchanged は EntryCategory ではない（どのバケツにも入らない）", () => {
      expect(isEntryCategory("unchanged")).toBe(false);
    });
  });

  describe("directionOfCategory", () => {
    it.each([
      ["autoUpdate", "pull"],
      ["newFiles", "pull"],
      ["deletedFiles", "pull"],
      ["localOnly", "push"],
      ["deletedLocally", "push"],
      ["conflicts", "conflict"],
    ] as const)("%s カテゴリは %s 方向にマップされる", (cat, expected) => {
      expect(directionOfCategory(cat)).toBe(expected);
    });
    // unchanged は EntryCategory に含まれないため、directionOfCategory の入力として
    // 型レベルで除外されている（呼び出し自体がコンパイルエラー）。
  });

  describe("isDestructiveCategory", () => {
    it("deletedFiles と deletedLocally は破壊的", () => {
      expect(isDestructiveCategory("deletedFiles")).toBe(true);
      expect(isDestructiveCategory("deletedLocally")).toBe(true);
    });

    it("非削除カテゴリは非破壊的", () => {
      expect(isDestructiveCategory("autoUpdate")).toBe(false);
      expect(isDestructiveCategory("newFiles")).toBe(false);
      expect(isDestructiveCategory("localOnly")).toBe(false);
      expect(isDestructiveCategory("conflicts")).toBe(false);
    });
  });

  describe("categorizeForStatus", () => {
    it("空の classification では全バケツが空", () => {
      const result = categorizeForStatus(emptyClassification());
      expect(result.pull).toEqual([]);
      expect(result.push).toEqual([]);
      expect(result.conflict).toEqual([]);
      expect(result.inSyncCount).toBe(0);
    });

    it("autoUpdate / newFiles / deletedFiles はすべて pull バケツに入る", () => {
      const result = categorizeForStatus({
        ...emptyClassification(),
        autoUpdate: ["a.txt"],
        newFiles: ["b.txt"],
        deletedFiles: ["c.txt"],
      });

      expect(result.pull.map((e) => e.path)).toEqual(["a.txt", "b.txt", "c.txt"]);
      expect(result.push).toEqual([]);
      expect(result.conflict).toEqual([]);
    });

    it("localOnly / deletedLocally は push バケツに入る", () => {
      const result = categorizeForStatus({
        ...emptyClassification(),
        localOnly: ["x.txt"],
        deletedLocally: ["y.txt"],
      });

      expect(result.push.map((e) => e.path)).toEqual(["x.txt", "y.txt"]);
      expect(result.pull).toEqual([]);
    });

    it("conflicts は conflict バケツに入る", () => {
      const result = categorizeForStatus({
        ...emptyClassification(),
        conflicts: ["both.txt"],
      });

      expect(result.conflict.map((e) => e.path)).toEqual(["both.txt"]);
    });

    it("unchanged は inSyncCount に反映される（バケツには入らない）", () => {
      const result = categorizeForStatus({
        ...emptyClassification(),
        unchanged: ["a.txt", "b.txt", "c.txt"],
      });

      expect(result.inSyncCount).toBe(3);
      expect(result.pull).toEqual([]);
      expect(result.push).toEqual([]);
      expect(result.conflict).toEqual([]);
    });

    it("deletedFiles と deletedLocally は isDestructive: true、それ以外は false", () => {
      const result = categorizeForStatus({
        ...emptyClassification(),
        autoUpdate: ["a.txt"],
        newFiles: ["b.txt"],
        deletedFiles: ["c.txt"],
        localOnly: ["x.txt"],
        deletedLocally: ["y.txt"],
        conflicts: ["both.txt"],
      });

      const findEntry = (path: string) =>
        [...result.pull, ...result.push, ...result.conflict].find((e) => e.path === path);

      expect(findEntry("a.txt")?.isDestructive).toBe(false);
      expect(findEntry("b.txt")?.isDestructive).toBe(false);
      expect(findEntry("c.txt")?.isDestructive).toBe(true);
      expect(findEntry("x.txt")?.isDestructive).toBe(false);
      expect(findEntry("y.txt")?.isDestructive).toBe(true);
      expect(findEntry("both.txt")?.isDestructive).toBe(false);
    });

    it("各バケツ内は path 昇順でソートされる（決定論的出力）", () => {
      const result = categorizeForStatus({
        ...emptyClassification(),
        autoUpdate: ["z.txt", "a.txt", "m.txt"],
      });
      expect(result.pull.map((e) => e.path)).toEqual(["a.txt", "m.txt", "z.txt"]);
    });

    it("category フィールドが元のカテゴリを保持する（UI でラベル分けに使用）", () => {
      const result = categorizeForStatus({
        ...emptyClassification(),
        autoUpdate: ["modified.txt"],
        newFiles: ["new.txt"],
        deletedFiles: ["gone.txt"],
      });

      const byPath = Object.fromEntries(result.pull.map((e) => [e.path, e.category]));
      expect(byPath["modified.txt"]).toBe("autoUpdate");
      expect(byPath["new.txt"]).toBe("newFiles");
      expect(byPath["gone.txt"]).toBe("deletedFiles");
    });
  });

  describe("decideRecommendation", () => {
    const noLock: Pick<LockState, "pendingMerge"> = {};

    it("全バケツ空 → inSync", () => {
      const rec = decideRecommendation(emptyBuckets(), noLock);
      expect(rec).toEqual({ kind: "inSync" });
    });

    it("pull のみ → pullOnly", () => {
      const buckets: StatusBuckets = {
        ...emptyBuckets(),
        pull: [{ path: "a", direction: "pull", category: "autoUpdate", isDestructive: false }],
      };
      expect(decideRecommendation(buckets, noLock)).toEqual({ kind: "pullOnly", pullCount: 1 });
    });

    it("push のみ → pushOnly", () => {
      const buckets: StatusBuckets = {
        ...emptyBuckets(),
        push: [{ path: "a", direction: "push", category: "localOnly", isDestructive: false }],
      };
      expect(decideRecommendation(buckets, noLock)).toEqual({ kind: "pushOnly", pushCount: 1 });
    });

    it("pull + push → pullThenPush", () => {
      const buckets: StatusBuckets = {
        ...emptyBuckets(),
        pull: [{ path: "a", direction: "pull", category: "autoUpdate", isDestructive: false }],
        push: [{ path: "b", direction: "push", category: "localOnly", isDestructive: false }],
      };
      expect(decideRecommendation(buckets, noLock)).toEqual({
        kind: "pullThenPush",
        pullCount: 1,
        pushCount: 1,
      });
    });

    it("conflict があれば pull/push の有無に関係なく resolveConflict", () => {
      const buckets: StatusBuckets = {
        ...emptyBuckets(),
        pull: [{ path: "a", direction: "pull", category: "autoUpdate", isDestructive: false }],
        push: [{ path: "b", direction: "push", category: "localOnly", isDestructive: false }],
        conflict: [
          { path: "c", direction: "conflict", category: "conflicts", isDestructive: false },
        ],
      };
      expect(decideRecommendation(buckets, noLock)).toEqual({
        kind: "resolveConflict",
        conflictCount: 1,
        pullCount: 1,
        pushCount: 1,
      });
    });

    it("pendingMerge が存在し conflicts に内容があれば continueMerge（最優先）", () => {
      const lock: Pick<LockState, "pendingMerge"> = {
        pendingMerge: {
          conflicts: ["a.txt", "b.txt"],
          templateHashes: {},
        },
      };
      // 通常なら pullThenPush になる buckets でも continueMerge が優先される
      const buckets: StatusBuckets = {
        ...emptyBuckets(),
        pull: [{ path: "x", direction: "pull", category: "autoUpdate", isDestructive: false }],
        push: [{ path: "y", direction: "push", category: "localOnly", isDestructive: false }],
      };
      expect(decideRecommendation(buckets, lock)).toEqual({
        kind: "continueMerge",
        conflictCount: 2,
      });
    });

    it("patternsUpdated=true + 全バケツ空 → pullOnly (ファイル差分ゼロでもパターン取り込み必須)", () => {
      // codex review #71 P1: テンプレが新パターン追加、ファイル差分ゼロのケース。
      // inSync を返すと、ユーザーが push しても push は raw config.include しか見ないので
      // 何も起きず「次操作が no-op」という UX 事故になる。pull を必ず推奨する。
      const buckets = emptyBuckets();
      expect(decideRecommendation(buckets, noLock, true)).toEqual({
        kind: "pullOnly",
        pullCount: 0,
      });
    });

    it("patternsUpdated=true + push のみ → pullThenPush (push 単独だと patterns が反映されない)", () => {
      const buckets: StatusBuckets = {
        ...emptyBuckets(),
        push: [{ path: "x", direction: "push", category: "localOnly", isDestructive: false }],
      };
      expect(decideRecommendation(buckets, noLock, true)).toEqual({
        kind: "pullThenPush",
        pullCount: 0,
        pushCount: 1,
      });
    });

    it("patternsUpdated=false + 全バケツ空 → inSync (regression: デフォルト挙動を維持)", () => {
      // patternsUpdated 引数追加で既存呼び出しが壊れないことを保証
      const buckets = emptyBuckets();
      expect(decideRecommendation(buckets, noLock)).toEqual({ kind: "inSync" });
    });

    it("pendingMerge が空 conflicts でも continueMerge を返す（stale lock として扱う）", () => {
      // --continue 直前にプロセスが死んだ等で lock が stale な状態。
      // inSync にフォールスルーすると、その後 push が pendingMerge ガードで
      // ブロックされる際に理由が分からなくなるため、明示的に continueMerge を返す。
      const lock: Pick<LockState, "pendingMerge"> = {
        pendingMerge: {
          conflicts: [],
          templateHashes: {},
        },
      };
      const buckets = emptyBuckets();
      expect(decideRecommendation(buckets, lock)).toEqual({
        kind: "continueMerge",
        conflictCount: 0,
      });
    });
  });
});
