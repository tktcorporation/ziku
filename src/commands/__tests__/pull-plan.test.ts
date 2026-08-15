/**
 * pull が「何を取り込み、次のベースに何を書くか」を決める計算のテスト。
 *
 * ファイルシステム・GitHub API・プロンプトを一切用意せず、入力の値だけで判断を検証する。
 * コマンド全体の配線（どの順で I/O を呼ぶか・どのログを出すか）は `pull.test.ts` が見る。
 */
import { describe, expect, it } from "vitest";
import type { FileClassification } from "../../utils/merge";
import type { SyncHashes } from "../../utils/sync-analysis";
import type {
  CommitSha,
  HashMap,
  MergingLockState,
  PendingConflicts,
  RepoRelPath,
  ResumableLockState,
} from "../../modules/schemas";
import { baseCommitSha, baseHashesOf, markMerging } from "../../modules/schemas";
import {
  commitSha,
  contentHash,
  hashMap,
  pendingConflict,
  repoRelPath,
  repoRelPaths,
} from "../../__tests__/brands";
import type { PullApprovalFlags, ZikuConfigMergeResult } from "../pull-plan";
import {
  baseAfterDeletions,
  configBaseHash,
  configContentToWrite,
  finalizeMergedBase,
  hasReadableText,
  isNonInteractive,
  isUnmergedConflict,
  lockNeedsRewrite,
  nextSyncBase,
  planPullChanges,
  resolveDeletionPolicy,
  splitTemplateDeletions,
} from "../pull-plan";

const CONFIG_PATH = repoRelPath(".ziku/ziku.jsonc");

const emptyClassification: FileClassification = {
  autoUpdate: [],
  localOnly: [],
  conflicts: [],
  newFiles: [],
  deletedFiles: [],
  deletedWithLocalEdits: [],
  deletedLocally: [],
  unchanged: [],
};

function classification(files: Partial<FileClassification>): FileClassification {
  return { ...emptyClassification, ...files };
}

function syncHashes(hashes: Partial<SyncHashes>): SyncHashes {
  return { baseHashes: {}, localHashes: {}, templateHashes: {}, ...hashes };
}

/**
 * パスの集合をテストの入力として組み立てる。
 *
 * 適用済みの削除は `ReadonlySet<RepoRelPath>` で渡す。リテラルの `Set<string>` は代入
 * できないので、変換をここへまとめる。
 */
function pathSet(members: readonly string[] = []): ReadonlySet<RepoRelPath> {
  return new Set(repoRelPaths(members));
}

const flags = (force: boolean, yes: boolean): PullApprovalFlags => ({ force, yes });

const syncedLock: ResumableLockState = {
  version: "0.1.0",
  installedAt: "2024-01-01T00:00:00.000Z",
  source: { kind: "github", owner: "o", repo: "r" },
  sync: "synced",
  base: { hashes: hashMap({ "a.txt": "hash-a" }), ref: commitSha("base123") },
};

const conflicts: PendingConflicts = [pendingConflict("conflict.md", "noBase")];

/** 中断中の lock を、確定後のベースになる `nextBase` 付きで組み立てる。 */
function mergingLock(nextBase: { hashes: HashMap; commitSha?: CommitSha }): MergingLockState {
  return markMerging(syncedLock, nextBase, conflicts);
}

describe("resolveDeletionPolicy", () => {
  it("--force は削除の承認なので全件削除する", () => {
    expect(resolveDeletionPolicy(flags(true, false))).toBe("deleteAll");
  });

  it("--yes はプロンプトを省くだけで削除を承認しないので全件残す", () => {
    expect(resolveDeletionPolicy(flags(false, true))).toBe("keepAll");
  });

  it("フラグが無ければユーザーに選ばせる", () => {
    expect(resolveDeletionPolicy(flags(false, false))).toBe("askUser");
  });

  it("--force --yes は承認済みなので、確認を挟まず削除する", () => {
    expect(resolveDeletionPolicy(flags(true, true))).toBe("deleteAll");
  });
});

describe("isNonInteractive", () => {
  it("--force / --yes のどちらかがあれば、入力待ちで止まらない実行として扱う", () => {
    expect(isNonInteractive(flags(true, false))).toBe(true);
    expect(isNonInteractive(flags(false, true))).toBe(true);
    expect(isNonInteractive(flags(true, true))).toBe(true);
  });

  it("フラグが無ければ対話できる実行として扱う", () => {
    expect(isNonInteractive(flags(false, false))).toBe(false);
  });
});

describe("splitTemplateDeletions", () => {
  it("ローカルに実在するファイルだけを削除候補にする", () => {
    const result = splitTemplateDeletions(
      repoRelPaths(["kept.txt", "gone.txt"]),
      hashMap({ "kept.txt": "hash-kept" }),
    );

    expect(result.deletable).toEqual(["kept.txt"]);
  });

  it("ベースにだけ残ったエントリがあることを呼び出し側へ伝える", () => {
    const result = splitTemplateDeletions(
      repoRelPaths(["kept.txt", "gone.txt"]),
      hashMap({ "kept.txt": "hash-kept" }),
    );

    expect(result.hasStaleBaseEntries).toBe(true);
  });

  it("全てローカルに実在するなら、落とすベースのエントリは無い", () => {
    const result = splitTemplateDeletions(
      repoRelPaths(["a.txt", "b.txt"]),
      hashMap({ "a.txt": "hash-a", "b.txt": "hash-b" }),
    );

    expect(result).toEqual({ deletable: ["a.txt", "b.txt"], hasStaleBaseEntries: false });
  });

  it("削除候補が無ければ、どちらも空の結果になる", () => {
    expect(splitTemplateDeletions([], hashMap({ "a.txt": "hash-a" }))).toEqual({
      deletable: [],
      hasStaleBaseEntries: false,
    });
  });
});

describe("baseAfterDeletions", () => {
  it("削除を全て適用したなら、テンプレート側へ前進したベースをそのまま使う", () => {
    const advancedBase = hashMap({ "kept.txt": "hash-t" });

    const base = baseAfterDeletions({
      advancedBase,
      previousBase: hashMap({ "kept.txt": "hash-t", "old.txt": "hash-old" }),
      localHashes: hashMap({ "kept.txt": "hash-t" }),
      deletions: { candidates: repoRelPaths(["old.txt"]), applied: pathSet(["old.txt"]) },
    });

    expect(base).toEqual({ "kept.txt": "hash-t" });
  });

  it("残したファイルは前回のベースを据え置く（次の push が削除を巻き戻さない）", () => {
    const base = baseAfterDeletions({
      advancedBase: hashMap({ "kept.txt": "hash-t" }),
      previousBase: hashMap({ "kept.txt": "hash-t", "old.txt": "hash-old" }),
      localHashes: hashMap({ "kept.txt": "hash-t", "old.txt": "hash-old" }),
      deletions: { candidates: repoRelPaths(["old.txt"]), applied: pathSet() },
    });

    expect(base).toEqual({ "kept.txt": "hash-t", "old.txt": "hash-old" });
  });

  it("ローカルに無いファイルは、削除を適用しなくてもベースから落ちる", () => {
    const base = baseAfterDeletions({
      advancedBase: hashMap({ "kept.txt": "hash-t" }),
      previousBase: hashMap({ "kept.txt": "hash-t", "gone.txt": "hash-gone" }),
      localHashes: hashMap({ "kept.txt": "hash-t" }),
      deletions: { candidates: repoRelPaths(["gone.txt"]), applied: pathSet() },
    });

    expect(base).toEqual({ "kept.txt": "hash-t" });
  });

  it("ローカル編集ありの削除候補も、残したなら同じく据え置かれる", () => {
    const base = baseAfterDeletions({
      advancedBase: {},
      previousBase: hashMap({ "edited.txt": "hash-base", "plain.txt": "hash-base2" }),
      localHashes: hashMap({ "edited.txt": "hash-local", "plain.txt": "hash-base2" }),
      deletions: {
        candidates: repoRelPaths(["plain.txt", "edited.txt"]),
        applied: pathSet(["plain.txt"]),
      },
    });

    expect(base).toEqual({ "edited.txt": "hash-base" });
  });

  it("前回のベースにエントリが無い候補は、前進させた側を尊重して据え置かない", () => {
    const base = baseAfterDeletions({
      advancedBase: hashMap({ "odd.txt": "hash-t" }),
      previousBase: {},
      localHashes: hashMap({ "odd.txt": "hash-local" }),
      deletions: { candidates: repoRelPaths(["odd.txt"]), applied: pathSet() },
    });

    expect(base).toEqual({ "odd.txt": "hash-t" });
  });

  it("渡されたベースを書き換えない", () => {
    const advancedBase = hashMap({ "kept.txt": "hash-t" });

    baseAfterDeletions({
      advancedBase,
      previousBase: hashMap({ "old.txt": "hash-old" }),
      localHashes: hashMap({ "old.txt": "hash-old" }),
      deletions: { candidates: repoRelPaths(["old.txt"]), applied: pathSet() },
    });

    expect(advancedBase).toEqual({ "kept.txt": "hash-t" });
  });
});

describe("nextSyncBase", () => {
  const common = {
    previousBase: hashMap({ "a.txt": "hash-base" }),
    localHashes: hashMap({ "a.txt": "hash-t" }),
    deletions: { candidates: [], applied: pathSet() },
  };

  it("解決できたコミット SHA をベースに載せる", () => {
    const point = nextSyncBase({
      ...common,
      advance: { hashes: hashMap({ "a.txt": "hash-t" }), commitSha: commitSha("latest123") },
    });

    expect(point).toEqual({ hashes: { "a.txt": "hash-t" }, commitSha: "latest123" });
  });

  it("SHA を解決できなければ、ハッシュだけ前進させて SHA を持たないベースになる", () => {
    const point = nextSyncBase({
      ...common,
      advance: { hashes: hashMap({ "a.txt": "hash-t" }), commitSha: undefined },
    });

    // ハッシュは取り込んだツリーへ進む。SHA は空のままで、前回記録した SHA を引き継がない。
    // 引き継ぐと共通祖先が前回のツリーになり、取り込み済みの変更が再びマージに載る。
    expect(point).toEqual({ hashes: { "a.txt": "hash-t" }, commitSha: undefined });
  });

  it("中断（削除は 1 件も適用しない）と確定は、適用した削除の分だけ違うベースになる", () => {
    const withDeletion = {
      advance: { hashes: hashMap({ "a.txt": "hash-t" }), commitSha: commitSha("latest123") },
      previousBase: hashMap({ "a.txt": "hash-base", "old.txt": "hash-old" }),
      localHashes: hashMap({ "a.txt": "hash-t", "old.txt": "hash-old" }),
    };
    const candidates = repoRelPaths(["old.txt"]);

    const paused = nextSyncBase({
      ...withDeletion,
      deletions: { candidates, applied: pathSet() },
    });
    const applied = nextSyncBase({
      ...withDeletion,
      deletions: { candidates, applied: pathSet(["old.txt"]) },
    });

    expect(paused.hashes).toEqual({ "a.txt": "hash-t", "old.txt": "hash-old" });
    expect(applied.hashes).toEqual({ "a.txt": "hash-t" });
    expect(paused.commitSha).toBe(applied.commitSha);
  });
});

describe("ZikuConfigMergeResult", () => {
  /** 「テンプレートが ziku.jsonc を削除し、ローカルには残っている」ハッシュの並び。 */
  const templateDeletedConfig = syncHashes({
    baseHashes: hashMap({ ".ziku/ziku.jsonc": "hash-base-config" }),
    localHashes: hashMap({ ".ziku/ziku.jsonc": "hash-base-config" }),
  });

  it("union マージの対象外なら、書き込まず base はテンプレート側の走査結果に従う", () => {
    const result: ZikuConfigMergeResult = { _tag: "FollowTemplate" };

    expect(
      configBaseHash(
        result,
        syncHashes({ templateHashes: hashMap({ ".ziku/ziku.jsonc": "hash-template-config" }) }),
      ),
    ).toBe("hash-template-config");
    expect(configContentToWrite(result)).toBeUndefined();
  });

  it("テンプレートが削除しローカルに残るなら、書き込まず base を据え置く", () => {
    const result: ZikuConfigMergeResult = { _tag: "RetainBase" };

    expect(configBaseHash(result, templateDeletedConfig)).toBe("hash-base-config");
    expect(configContentToWrite(result)).toBeUndefined();
  });

  it("両側から消えているなら、据え置く相手がいないので base から落とす", () => {
    const bothGone = syncHashes({
      baseHashes: hashMap({ ".ziku/ziku.jsonc": "hash-base-config" }),
    });

    expect(configBaseHash({ _tag: "RetainBase" }, bothGone)).toBeUndefined();
  });

  it("union が現在のローカルと一致するなら、書かずに base だけ揃える", () => {
    const result: ZikuConfigMergeResult = { _tag: "BaseOnly", baseHash: contentHash("hash-union") };

    expect(configBaseHash(result, templateDeletedConfig)).toBe("hash-union");
    expect(configContentToWrite(result)).toBeUndefined();
  });

  it("書き込む結果は、内容と base をどちらも運ぶ", () => {
    const result: ZikuConfigMergeResult = {
      _tag: "Write",
      baseHash: contentHash("hash-union"),
      content: "{}",
    };

    expect(configBaseHash(result, templateDeletedConfig)).toBe("hash-union");
    expect(configContentToWrite(result)).toBe("{}");
  });

  it("型: 意味を成さない組み合わせを作れない", () => {
    // union を書き込むなら base も必ずその内容へ揃える。揃えないと、テンプレが削除した
    // パターンを後続の push が localOnly として再追加する。この組み合わせが
    // 「コンパイルできない」ことが型の役目なので、@ts-expect-error が外れたら
    // （= 書けるようになったら）typecheck が失敗して気付ける。
    // @ts-expect-error 書き込む結果は base ハッシュを伴う
    const writeWithoutBase: ZikuConfigMergeResult = { _tag: "Write", content: "{}" };

    expect(writeWithoutBase._tag).toBe("Write");
  });
});

describe("lockNeedsRewrite", () => {
  it("ziku.jsonc の base が記録済みの値と違うなら書き直す", () => {
    expect(
      lockNeedsRewrite({
        configBaseHash: contentHash("hash-union"),
        recordedConfigBaseHash: contentHash("hash-old"),
        hasStaleBaseEntries: false,
      }),
    ).toBe(true);
  });

  it("ziku.jsonc の base が記録済みの値と同じなら書き直さない", () => {
    expect(
      lockNeedsRewrite({
        configBaseHash: contentHash("hash-union"),
        recordedConfigBaseHash: contentHash("hash-union"),
        hasStaleBaseEntries: false,
      }),
    ).toBe(false);
  });

  it("ziku.jsonc の base を落とすなら、記録済みのエントリを消すために書き直す", () => {
    expect(
      lockNeedsRewrite({
        configBaseHash: undefined,
        recordedConfigBaseHash: contentHash("hash-old"),
        hasStaleBaseEntries: false,
      }),
    ).toBe(true);
  });

  it("ziku.jsonc が base に載らない状態のままなら書き直さない", () => {
    expect(
      lockNeedsRewrite({
        configBaseHash: undefined,
        recordedConfigBaseHash: undefined,
        hasStaleBaseEntries: false,
      }),
    ).toBe(false);
  });

  it("ベースにだけ残ったエントリがあるなら、落とすために書き直す", () => {
    expect(
      lockNeedsRewrite({
        configBaseHash: undefined,
        recordedConfigBaseHash: undefined,
        hasStaleBaseEntries: true,
      }),
    ).toBe(true);
  });
});

describe("planPullChanges", () => {
  it("取り込む変更を全カテゴリで数える", () => {
    const plan = planPullChanges({
      files: classification({
        autoUpdate: repoRelPaths(["u.txt"]),
        newFiles: repoRelPaths(["n.txt"]),
        conflicts: repoRelPaths(["c.txt"]),
        deletedFiles: repoRelPaths(["d.txt"]),
        deletedWithLocalEdits: repoRelPaths(["e.txt"]),
      }),
      hashes: syncHashes({ localHashes: hashMap({ "d.txt": "hash-d", "e.txt": "hash-e" }) }),
      configSync: { _tag: "FollowTemplate" },
    });

    expect(plan.totalChanges).toBe(5);
  });

  it("ローカルに無い削除候補は、提示しないので変更として数えない", () => {
    const plan = planPullChanges({
      files: classification({ deletedFiles: repoRelPaths(["gone.txt"]) }),
      hashes: syncHashes({}),
      configSync: { _tag: "FollowTemplate" },
    });

    expect(plan.totalChanges).toBe(0);
    expect(plan.deletableFiles).toEqual([]);
  });

  it("ziku.jsonc への書き込みも 1 件の変更として数える", () => {
    const plan = planPullChanges({
      files: classification({}),
      hashes: syncHashes({}),
      configSync: { _tag: "Write", baseHash: contentHash("hash-union"), content: "{}" },
    });

    expect(plan.totalChanges).toBe(1);
  });

  it("書き込みの要らない union（BaseOnly）は変更として数えない", () => {
    const plan = planPullChanges({
      files: classification({}),
      hashes: syncHashes({}),
      configSync: { _tag: "BaseOnly", baseHash: contentHash("hash-union") },
    });

    expect(plan.totalChanges).toBe(0);
  });

  it("削除候補は、ローカルに無いものも含めてベースの計算へ渡す", () => {
    const plan = planPullChanges({
      files: classification({
        deletedFiles: repoRelPaths(["gone.txt", "kept.txt"]),
        deletedWithLocalEdits: repoRelPaths(["edited.txt"]),
      }),
      hashes: syncHashes({
        localHashes: hashMap({ "kept.txt": "hash-k", "edited.txt": "hash-e" }),
      }),
      configSync: { _tag: "FollowTemplate" },
    });

    expect(plan.deletionCandidates).toEqual(["gone.txt", "kept.txt", "edited.txt"]);
    expect(plan.deletableFiles).toEqual(["kept.txt"]);
  });

  it("union マージを行ったときは ziku.jsonc の base だけをローカル最終内容へ揃える", () => {
    const plan = planPullChanges({
      files: classification({}),
      hashes: syncHashes({
        templateHashes: hashMap({ "a.txt": "hash-t", ".ziku/ziku.jsonc": "hash-template-config" }),
      }),
      configSync: { _tag: "BaseOnly", baseHash: contentHash("hash-union") },
    });

    expect(plan.advancedBase).toEqual({
      "a.txt": "hash-t",
      ".ziku/ziku.jsonc": "hash-union",
    });
  });

  it("union マージを行っていないなら、テンプレート側のハッシュがそのままベースになる", () => {
    const templateHashes = hashMap({ "a.txt": "hash-t" });

    const plan = planPullChanges({
      files: classification({}),
      hashes: syncHashes({ templateHashes }),
      configSync: { _tag: "FollowTemplate" },
    });

    expect(plan.advancedBase).toEqual(templateHashes);
  });

  it("テンプレートが消した ziku.jsonc は、ローカルに残る限りベースを据え置く", () => {
    // 据え置かないと次の分類が localOnly になり、`push --yes` が確認なしにテンプレートへ
    // 設定ファイルを復活させる（テンプレートを使う全プロジェクトへ配られる）。
    const plan = planPullChanges({
      files: classification({ autoUpdate: repoRelPaths(["a.txt"]) }),
      hashes: syncHashes({
        baseHashes: hashMap({ "a.txt": "hash-a", ".ziku/ziku.jsonc": "hash-base-config" }),
        localHashes: hashMap({ "a.txt": "hash-a", ".ziku/ziku.jsonc": "hash-base-config" }),
        templateHashes: hashMap({ "a.txt": "hash-t" }),
      }),
      configSync: { _tag: "RetainBase" },
    });

    expect(plan.advancedBase).toEqual({
      "a.txt": "hash-t",
      ".ziku/ziku.jsonc": "hash-base-config",
    });
  });

  it("ローカルからも消えた ziku.jsonc は、ベースからも落とす", () => {
    const plan = planPullChanges({
      files: classification({ autoUpdate: repoRelPaths(["a.txt"]) }),
      hashes: syncHashes({
        baseHashes: hashMap({ "a.txt": "hash-a", ".ziku/ziku.jsonc": "hash-base-config" }),
        localHashes: hashMap({ "a.txt": "hash-a" }),
        templateHashes: hashMap({ "a.txt": "hash-t" }),
      }),
      configSync: { _tag: "RetainBase" },
    });

    expect(plan.advancedBase).toEqual({ "a.txt": "hash-t" });
    expect(plan.rewriteLock).toBe(true);
  });

  it("テンプレートが消した ziku.jsonc を据え置くだけなら、lock を書き直さない", () => {
    // 据え置いた結果が記録済みの base と同じなら、書き直す理由が無い。他に変更が無ければ
    // pull は lock に触れずに終わる。
    const plan = planPullChanges({
      files: classification({}),
      hashes: syncHashes({
        baseHashes: hashMap({ ".ziku/ziku.jsonc": "hash-base-config" }),
        localHashes: hashMap({ ".ziku/ziku.jsonc": "hash-base-config" }),
      }),
      configSync: { _tag: "RetainBase" },
    });

    expect(plan.totalChanges).toBe(0);
    expect(plan.rewriteLock).toBe(false);
  });

  it("見せる変更が無くても、ziku.jsonc の base が変わるなら lock を書き直す", () => {
    const plan = planPullChanges({
      files: classification({}),
      hashes: syncHashes({ baseHashes: hashMap({ ".ziku/ziku.jsonc": "hash-old" }) }),
      configSync: { _tag: "BaseOnly", baseHash: contentHash("hash-union") },
    });

    expect(plan.totalChanges).toBe(0);
    expect(plan.rewriteLock).toBe(true);
  });

  it("見せる変更が無くても、ベースにだけ残ったエントリがあるなら lock を書き直す", () => {
    const plan = planPullChanges({
      files: classification({ deletedFiles: repoRelPaths(["gone.txt"]) }),
      hashes: syncHashes({ baseHashes: hashMap({ "gone.txt": "hash-gone" }) }),
      configSync: { _tag: "FollowTemplate" },
    });

    expect(plan.totalChanges).toBe(0);
    expect(plan.rewriteLock).toBe(true);
  });

  it("取り込むものも落とすエントリも無ければ、lock を書き直さない", () => {
    const plan = planPullChanges({
      files: classification({}),
      hashes: syncHashes({ baseHashes: hashMap({ "a.txt": "hash-a" }) }),
      configSync: { _tag: "FollowTemplate" },
    });

    expect(plan.totalChanges).toBe(0);
    expect(plan.rewriteLock).toBe(false);
  });

  it("記録済みと同じ base へ揃えるだけなら、lock を書き直さない", () => {
    const plan = planPullChanges({
      files: classification({}),
      hashes: syncHashes({ baseHashes: hashMap({ ".ziku/ziku.jsonc": "hash-union" }) }),
      configSync: { _tag: "BaseOnly", baseHash: contentHash("hash-union") },
    });

    expect(plan.rewriteLock).toBe(false);
  });
});

describe("isUnmergedConflict / hasReadableText", () => {
  it("マーカーを書き出したファイルは、マーカーの消失で解決を判定できる", () => {
    const conflict = pendingConflict("a.md", "markers");

    expect(isUnmergedConflict(conflict)).toBe(false);
    expect(hasReadableText(conflict)).toBe(true);
  });

  it("ベース不在のファイルは選択が要るが、マーカーの走査対象ではある", () => {
    const conflict = pendingConflict("a.md", "noBase");

    expect(isUnmergedConflict(conflict)).toBe(true);
    expect(hasReadableText(conflict)).toBe(true);
  });

  it("バイナリは選択が要り、マーカーを探しても意味を持たない", () => {
    const conflict = pendingConflict("icon.png", "binary");

    expect(isUnmergedConflict(conflict)).toBe(true);
    expect(hasReadableText(conflict)).toBe(false);
  });
});

describe("finalizeMergedBase", () => {
  it("置き換えたファイルが無ければ、中断時に記録したベースをそのまま確定する", () => {
    const lock = mergingLock({
      hashes: hashMap({ "a.txt": "hash-t", "old.txt": "hash-old" }),
      commitSha: commitSha("paused123"),
    });

    const finalized = finalizeMergedBase(lock, {});

    expect(finalized.sync).toBe("synced");
    expect(baseHashesOf(finalized)).toEqual({ "a.txt": "hash-t", "old.txt": "hash-old" });
    expect(baseCommitSha(finalized)).toBe("paused123");
  });

  it("テンプレートの内容で置き換えたファイルは、書き込んだ内容のハッシュをベースにする", () => {
    const lock = mergingLock({
      hashes: hashMap({ "a.txt": "hash-paused", "b.txt": "hash-b" }),
      commitSha: commitSha("paused123"),
    });

    const finalized = finalizeMergedBase(lock, hashMap({ "a.txt": "hash-written" }));

    expect(baseHashesOf(finalized)).toEqual({ "a.txt": "hash-written", "b.txt": "hash-b" });
  });

  it("置き換えがあっても、中断時に記録したコミット SHA を引き継ぐ", () => {
    const lock = mergingLock({
      hashes: hashMap({ "a.txt": "hash-paused" }),
      commitSha: commitSha("paused123"),
    });

    const finalized = finalizeMergedBase(lock, hashMap({ "a.txt": "hash-written" }));

    expect(baseCommitSha(finalized)).toBe("paused123");
  });

  it("据え置かれた削除のエントリは、確定後のベースにも残る", () => {
    const lock = mergingLock({
      hashes: hashMap({ "a.txt": "hash-paused", "old.txt": "hash-old" }),
      commitSha: commitSha("paused123"),
    });

    const finalized = finalizeMergedBase(lock, hashMap({ "a.txt": "hash-written" }));

    expect(baseHashesOf(finalized)[repoRelPath("old.txt")]).toBe("hash-old");
  });

  it("解決待ちの記録は確定後に残らない", () => {
    const lock = mergingLock({ hashes: hashMap({ "a.txt": "hash-paused" }) });

    const finalized = finalizeMergedBase(lock, hashMap({ "a.txt": "hash-written" }));

    expect("merge" in finalized).toBe(false);
  });
});

describe("設定ファイルのパス", () => {
  it("ベースの補正先は、分類が使うのと同じ ziku.jsonc のパス", () => {
    const plan = planPullChanges({
      files: classification({}),
      hashes: syncHashes({}),
      configSync: { _tag: "BaseOnly", baseHash: contentHash("hash-union") },
    });

    expect(Object.keys(plan.advancedBase)).toEqual([CONFIG_PATH]);
  });
});
