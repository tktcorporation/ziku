/**
 * push が「何を送るか」を決める計算のテスト。
 *
 * ファイルシステム・GitHub API・プロンプトを一切用意せず、入力の値だけで判断を検証する。
 * コマンド全体の配線（どの順で I/O を呼ぶか・どのログを出すか）は `push.test.ts` が見る。
 */
import { describe, expect, it } from "vitest";
import type { FileClassification } from "../../utils/merge";
import { classifyMergeOutcome } from "../../utils/merge/types";
import type { SyncPlan, ZikuConfigState } from "../../utils/merge/sync-plan";
import type { ConfigDrift } from "../../utils/config-merge";
import type { DefaultBranchResolution } from "../../utils/github";
import type { FileDiff, GitHubSource, RepoRelPath } from "../../modules/schemas";
import {
  commitSha,
  globPatterns,
  hashMap,
  repoRelPath,
  repoRelPaths,
} from "../../__tests__/brands";
import {
  alreadySyncedPaths,
  applyPushSelection,
  asDeletablePath,
  asPushContent,
  baseAfterPush,
  buildPushPayload,
  buildPushSummaryRows,
  collectPushCandidates,
  configDiffToInject,
  defaultPushSelection,
  filterByFilesArg,
  mergedAsPushContent,
  patternsToPersist,
  planConfigPropagation,
  planPushCandidates,
  planUntrackedTracking,
  resolvePrBaseBranch,
  selectedUnresolvedConflicts,
  withNewlyTrackedPatterns,
  zikuConfigWriteBack,
} from "../push-plan";
import type {
  ChangedFileDiff,
  DeletablePath,
  PushContent,
  ZikuConfigWriteBack,
} from "../push-plan";

/** 送った内容がローカルにも残るケース。ベースの前進に例外が要らない既定の入力。 */
const WRITE_BACK: ZikuConfigWriteBack = { _tag: "WriteBack" };

/**
 * 削除として送れるパスを組み立てる。
 *
 * `asDeletablePath` は設定ファイルを弾くため `undefined` を返しうる。テストの入力は通常の
 * 同期ファイルに限るので、弾かれたらフィクスチャの誤りとして落とす。
 */
function deletablePath(path: string): DeletablePath {
  const deletable = asDeletablePath(repoRelPath(path));
  if (deletable === undefined) throw new Error(`fixture must be deletable: ${path}`);
  return deletable;
}

const CONFIG_PATH = repoRelPath(".ziku/ziku.jsonc");

/**
 * パスの集合をテストの入力として組み立てる。
 *
 * 送信対象を絞る API は `ReadonlySet<RepoRelPath>` を取る。リテラルの `Set<string>` は
 * 代入できないので、変換をここへまとめる。
 */
function pathSet(members: readonly string[] = []): ReadonlySet<RepoRelPath> {
  return new Set(repoRelPaths(members));
}

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

const untrackedConfig: ZikuConfigState = { _tag: "Untracked" };

/** 双方に取り込めるパターンがある状態。分類だけで結論が出るケースの既定値として使う。 */
const driftBothWays: ConfigDrift = { pullRelevant: true, pushRelevant: true };

function syncPlan(files: Partial<FileClassification>, config?: ZikuConfigState): SyncPlan {
  return { files: { ...emptyClassification, ...files }, config: config ?? untrackedConfig };
}

function added(path: string, localContent = "local"): ChangedFileDiff {
  return { path: repoRelPath(path), type: "added", localContent };
}

function modified(path: string, localContent = "local", templateContent = "template") {
  return {
    path: repoRelPath(path),
    type: "modified",
    localContent,
    templateContent,
  } as const satisfies ChangedFileDiff;
}

function deleted(path: string, templateContent = "template"): ChangedFileDiff {
  return { path: repoRelPath(path), type: "deleted", templateContent };
}

function paths(files: readonly { path: RepoRelPath }[]): string[] {
  return files.map((f) => f.path);
}

function source(ref?: GitHubSource["ref"]): GitHubSource {
  return { kind: "github", owner: "o", repo: "r", ref };
}

/** 既定ブランチを引けた問い合わせ結果。 */
function fetched(name: string): DefaultBranchResolution {
  return { _tag: "Resolved", name };
}

/** レート制限のように、待てば直る失敗で終わった問い合わせ結果。 */
const RATE_LIMITED: DefaultBranchResolution = {
  _tag: "Unresolved",
  reason: "API rate limit exceeded",
};

/** トークンを拒否された問い合わせ結果。 */
const AUTH_REJECTED: DefaultBranchResolution = {
  _tag: "AuthRejected",
  detail: "Bad credentials",
};

describe("planPushCandidates", () => {
  it("ローカル側に伝えるものがある分類を送信候補にする", () => {
    const plan = planPushCandidates(
      syncPlan({
        localOnly: repoRelPaths(["a.txt"]),
        conflicts: repoRelPaths(["b.txt"]),
        deletedLocally: repoRelPaths(["c.txt"]),
        deletedWithLocalEdits: repoRelPaths(["d.txt"]),
      }),
      driftBothWays,
    );

    expect([...plan.pushablePaths].toSorted()).toEqual(["a.txt", "b.txt", "c.txt", "d.txt"]);
  });

  it("テンプレートだけが変えたファイルは送らず、スキップとして数える", () => {
    const plan = planPushCandidates(
      syncPlan({ autoUpdate: repoRelPaths(["a.txt"]) }),
      driftBothWays,
    );

    expect(plan.pushablePaths.has(repoRelPath("a.txt"))).toBe(false);
    expect(plan.skippedTemplateOnly).toEqual(["a.txt"]);
  });

  it("ローカルにもテンプレートにも無い分類（unchanged / newFiles / deletedFiles）は候補に入らない", () => {
    const plan = planPushCandidates(
      syncPlan({
        unchanged: repoRelPaths(["a.txt"]),
        newFiles: repoRelPaths(["b.txt"]),
        deletedFiles: repoRelPaths(["c.txt"]),
      }),
      driftBothWays,
    );

    expect([...plan.pushablePaths]).toEqual([]);
    expect(plan.skippedTemplateOnly).toEqual([]);
  });

  it("テンプレートが削除したファイルの push は削除の取り消しとして印を付ける", () => {
    const plan = planPushCandidates(
      syncPlan({
        localOnly: repoRelPaths(["a.txt"]),
        deletedWithLocalEdits: repoRelPaths(["d.txt"]),
      }),
      driftBothWays,
    );

    expect([...plan.restoresTemplateDeletion]).toEqual(["d.txt"]);
  });

  it("ziku.jsonc がローカル側の変更を持つなら union を送る候補にする", () => {
    const plan = planPushCandidates(
      syncPlan({}, { _tag: "Tracked", category: "localOnly" }),
      driftBothWays,
    );

    expect(plan.sendsConfigUnion).toBe(true);
    expect(plan.pushablePaths.has(CONFIG_PATH)).toBe(true);
    expect(plan.restoresTemplateDeletion.has(CONFIG_PATH)).toBe(false);
  });

  it("テンプレートが削除した ziku.jsonc を送る場合は削除の取り消しとして印を付ける", () => {
    const plan = planPushCandidates(
      syncPlan({}, { _tag: "Tracked", category: "deletedWithLocalEdits" }),
      driftBothWays,
    );

    expect(plan.sendsConfigUnion).toBe(true);
    expect(plan.restoresTemplateDeletion.has(CONFIG_PATH)).toBe(true);
  });

  it("ziku.jsonc がテンプレート側だけ変わっているならスキップとして数える", () => {
    const plan = planPushCandidates(syncPlan({}, { _tag: "Tracked", category: "autoUpdate" }), {
      pullRelevant: true,
      pushRelevant: false,
    });

    expect(plan.sendsConfigUnion).toBe(false);
    expect(plan.pushablePaths.has(CONFIG_PATH)).toBe(false);
    expect(plan.skippedTemplateOnly).toEqual([CONFIG_PATH]);
  });

  it("テンプレートが ziku.jsonc のパターンを削除しただけなら pull を案内しない", () => {
    // pull は削除を伝播しないので、案内どおり実行しても何も起きない。
    const plan = planPushCandidates(syncPlan({}, { _tag: "Tracked", category: "autoUpdate" }), {
      pullRelevant: false,
      pushRelevant: true,
    });

    expect(plan.skippedTemplateOnly).toEqual([]);
    expect(plan.sendsConfigUnion).toBe(false);
    expect(plan.pushablePaths.has(CONFIG_PATH)).toBe(false);
  });

  it("ローカルで ziku.jsonc が消えていても送信候補にしない", () => {
    const plan = planPushCandidates(
      syncPlan({}, { _tag: "Tracked", category: "deletedLocally" }),
      driftBothWays,
    );

    expect(plan.sendsConfigUnion).toBe(false);
    expect(plan.pushablePaths.has(CONFIG_PATH)).toBe(false);
    expect(plan.skippedTemplateOnly).toEqual([]);
  });

  it("ziku.jsonc が追跡対象外なら触らない", () => {
    const plan = planPushCandidates(
      syncPlan({ localOnly: repoRelPaths(["a.txt"]) }),
      driftBothWays,
    );

    expect(plan.sendsConfigUnion).toBe(false);
    expect(plan.pushablePaths.has(CONFIG_PATH)).toBe(false);
  });
});

describe("collectPushCandidates", () => {
  const pushablePaths = new Set(repoRelPaths(["a.txt", "b.txt", "c.txt"]));

  it("分類が候補としたパスの差分だけを取り出す", () => {
    const files: FileDiff[] = [added("a.txt"), modified("b.txt"), added("z.txt")];

    expect(paths(collectPushCandidates(files, pushablePaths))).toEqual(["a.txt", "b.txt"]);
  });

  it("変更のないファイルは候補に入っていても取り出さない", () => {
    const files: FileDiff[] = [
      { path: repoRelPath("a.txt"), type: "unchanged", localContent: "x", templateContent: "x" },
    ];

    expect(collectPushCandidates(files, pushablePaths)).toEqual([]);
  });
});

describe("filterByFilesArg", () => {
  const candidates = [added("a.txt"), modified("b.txt")];

  it("指定されたパスだけを残す", () => {
    const { filtered, notFound } = filterByFilesArg(candidates, "b.txt");

    expect(paths(filtered)).toEqual(["b.txt"]);
    expect(notFound).toEqual([]);
  });

  it("空白と空要素を無視して複数指定を解釈する", () => {
    const { filtered } = filterByFilesArg(candidates, " a.txt , ,b.txt ");

    expect(paths(filtered)).toEqual(["a.txt", "b.txt"]);
  });

  it("候補に無いパスは notFound として返す", () => {
    const { filtered, notFound } = filterByFilesArg(candidates, "a.txt,missing.txt");

    expect(paths(filtered)).toEqual(["a.txt"]);
    expect(notFound).toEqual(["missing.txt"]);
  });
});

describe("defaultPushSelection", () => {
  const candidates = [added("a.txt"), deleted("gone.txt"), modified("conflict.txt")];
  const conflictedPaths = pathSet(["conflict.txt"]);
  const noRestores = pathSet();

  it("未解決の衝突と削除を既定で外す", () => {
    const selected = defaultPushSelection(candidates, {
      includeDeletions: false,
      conflictedPaths,
      restoresTemplateDeletion: noRestores,
    });

    expect(paths(selected)).toEqual(["a.txt"]);
  });

  it("--include-deletions を指定すると削除も含める", () => {
    const selected = defaultPushSelection(candidates, {
      includeDeletions: true,
      conflictedPaths,
      restoresTemplateDeletion: noRestores,
    });

    expect(paths(selected)).toEqual(["a.txt", "gone.txt"]);
  });

  it("テンプレートの削除を取り消すファイルは既定で外す", () => {
    const withRestore = [added("a.txt"), added("restored.txt")];

    const selected = defaultPushSelection(withRestore, {
      includeDeletions: false,
      conflictedPaths: pathSet(),
      restoresTemplateDeletion: pathSet(["restored.txt"]),
    });

    expect(paths(selected)).toEqual(["a.txt"]);
  });

  it("--include-deletions でも削除の取り消しは既定に入らない", () => {
    const withRestore = [added("a.txt"), added("restored.txt")];

    const selected = defaultPushSelection(withRestore, {
      includeDeletions: true,
      conflictedPaths: pathSet(),
      restoresTemplateDeletion: pathSet(["restored.txt"]),
    });

    expect(paths(selected)).toEqual(["a.txt"]);
  });
});

describe("applyPushSelection", () => {
  const candidates = [added("a.txt"), modified("b.txt"), deleted("gone.txt")];

  it("--files 指定は一致した候補と未発見のパスを返す", () => {
    const { selected, notFound } = applyPushSelection(candidates, {
      _tag: "Files",
      filesArg: "gone.txt,missing.txt",
    });

    expect(paths(selected)).toEqual(["gone.txt"]);
    expect(notFound).toEqual(["missing.txt"]);
  });

  it("対話を省く実行は既定集合を返す", () => {
    const { selected } = applyPushSelection(candidates, {
      _tag: "Default",
      includeDeletions: false,
      conflictedPaths: pathSet(),
      restoresTemplateDeletion: pathSet(),
    });

    expect(paths(selected)).toEqual(["a.txt", "b.txt"]);
  });

  it("削除の取り消しは対話で明示選択すれば送れる", () => {
    const restoring = [added("a.txt"), added("restored.txt")];
    const restoresTemplateDeletion = pathSet(["restored.txt"]);

    const viaDefault = applyPushSelection(restoring, {
      _tag: "Default",
      includeDeletions: false,
      conflictedPaths: pathSet(),
      restoresTemplateDeletion,
    });
    const viaChosen = applyPushSelection(restoring, {
      _tag: "Chosen",
      paths: repoRelPaths(["restored.txt"]),
    });

    expect(paths(viaDefault.selected)).toEqual(["a.txt"]);
    expect(paths(viaChosen.selected)).toEqual(["restored.txt"]);
  });

  it("対話の選択結果は候補の並び順で返す", () => {
    const { selected, notFound } = applyPushSelection(candidates, {
      _tag: "Chosen",
      paths: repoRelPaths(["b.txt", "a.txt"]),
    });

    expect(paths(selected)).toEqual(["a.txt", "b.txt"]);
    expect(notFound).toEqual([]);
  });
});

describe("selectedUnresolvedConflicts", () => {
  it("選択に混ざった未解決の衝突を返す", () => {
    const blocking = selectedUnresolvedConflicts(
      [added("a.txt"), modified("conflict.txt")],
      pathSet(["conflict.txt", "other.txt"]),
    );

    expect(paths(blocking)).toEqual(["conflict.txt"]);
  });

  it("衝突が選ばれていなければ空を返す", () => {
    expect(selectedUnresolvedConflicts([added("a.txt")], pathSet(["conflict.txt"]))).toEqual([]);
  });
});

describe("PushContent", () => {
  it("型: マーカー入りと確定した内容は送信対象へ変換できない", () => {
    const outcome = classifyMergeOutcome(
      "<<<<<<< LOCAL\nmine\n=======\ntheirs\n>>>>>>> TEMPLATE\n",
    );
    if (outcome._tag !== "Conflicted") throw new Error("fixture must conflict");

    // マーカー入りの内容がテンプレートへ配られると、そのテンプレートを使う全プロジェクトへ
    // 壊れたファイルが届く。これを「コンパイルできない」ことで防ぐのが PushContent の役目
    // なので、@ts-expect-error が外れたら（= 変換できるようになったら）typecheck が失敗する。
    // @ts-expect-error マージ由来の内容は asPushContent を通れない
    const converted: PushContent = asPushContent(outcome.content);

    expect(converted).toBe(outcome.content);
  });

  it("クリーンと判定された内容は専用の経路で送信対象になる", () => {
    const outcome = classifyMergeOutcome("merged content");
    if (outcome._tag !== "Clean") throw new Error("fixture must merge cleanly");

    expect(mergedAsPushContent(outcome.content)).toBe("merged content");
  });
});

describe("buildPushPayload", () => {
  it("削除と送信内容を分け、自動マージ済みの内容を優先する", () => {
    const merged = classifyMergeOutcome("merged content");
    if (merged._tag !== "Clean") throw new Error("fixture must merge cleanly");
    const mergedContents = new Map<RepoRelPath, PushContent>([
      [repoRelPath("b.txt"), mergedAsPushContent(merged.content)],
    ]);

    const payload = buildPushPayload(
      [added("a.txt", "local a"), modified("b.txt", "local b"), deleted("gone.txt")],
      mergedContents,
    );

    expect(payload.files).toEqual([
      { path: "a.txt", content: "local a" },
      { path: "b.txt", content: "merged content" },
    ]);
    expect(payload.deletions).toEqual([{ path: "gone.txt" }]);
  });

  it("マージ結果が無いファイルはローカルの内容をそのまま送る", () => {
    const payload = buildPushPayload([added("a.txt", "local a")], new Map());

    expect(payload.files).toEqual([{ path: "a.txt", content: "local a" }]);
  });

  it("ziku.jsonc の削除は送らない（通常ファイルの削除は送る）", () => {
    // テンプレートの ziku.jsonc が消えると、そのテンプレートを使う全プロジェクトの
    // init / pull が同期対象パターンを引けなくなる。
    const payload = buildPushPayload([deleted(".ziku/ziku.jsonc"), deleted("gone.txt")], new Map());

    expect(payload.deletions).toEqual([{ path: "gone.txt" }]);
    expect(payload.files).toEqual([]);
  });
});

describe("alreadySyncedPaths", () => {
  it("ローカルとテンプレートが一致するパスを集める", () => {
    const synced = alreadySyncedPaths({
      baseHashes: hashMap({ "same.txt": "old", "mine.txt": "old" }),
      localHashes: hashMap({ "same.txt": "h1", "mine.txt": "local" }),
      templateHashes: hashMap({ "same.txt": "h1", "mine.txt": "template" }),
    });

    expect([...synced]).toEqual(["same.txt"]);
  });

  it("ベースにだけ残ったエントリも一致扱いにする（消すものも送るものも無い）", () => {
    const synced = alreadySyncedPaths({
      baseHashes: hashMap({ "gone-everywhere.txt": "old" }),
      localHashes: hashMap({}),
      templateHashes: hashMap({}),
    });

    expect([...synced]).toEqual(["gone-everywhere.txt"]);
  });

  it("片側にだけあるパスは一致扱いにしない", () => {
    const synced = alreadySyncedPaths({
      baseHashes: hashMap({}),
      localHashes: hashMap({ "local-only.txt": "h1" }),
      templateHashes: hashMap({ "template-only.txt": "h2" }),
    });

    expect([...synced]).toEqual([]);
  });
});

describe("baseAfterPush", () => {
  const previousBase = hashMap({
    "sent.txt": "sent-old",
    "not-sent.txt": "not-sent-old",
    "same.txt": "same",
  });

  /** push 後のテンプレート。送ったファイルは新しい内容、送っていないファイルは元のまま。 */
  const templateHashes = hashMap({
    "sent.txt": "sent-new",
    "not-sent.txt": "template-new",
    "same.txt": "same",
  });

  it("送ったパスのベースだけをテンプレート側へ前進させる", () => {
    const base = baseAfterPush({
      templateHashes,
      previousBase,
      pushed: {
        files: [{ path: repoRelPath("sent.txt"), content: asPushContent("x") }],
        deletions: [],
      },
      alreadySynced: new Set(repoRelPaths(["same.txt"])),
      configWriteBack: WRITE_BACK,
    });

    expect(base).toEqual({
      "sent.txt": "sent-new",
      // 送っていないので据え置く。前進させると次の分類が localOnly と読み、テンプレートの
      // 更新が pull で取り込まれなくなる。
      "not-sent.txt": "not-sent-old",
      "same.txt": "same",
    });
  });

  it("送った削除はベースからエントリを落とす", () => {
    const base = baseAfterPush({
      templateHashes: hashMap({ "same.txt": "same" }),
      previousBase: hashMap({ "gone.txt": "old", "same.txt": "same" }),
      pushed: { files: [], deletions: [{ path: deletablePath("gone.txt") }] },
      alreadySynced: new Set(repoRelPaths(["same.txt"])),
      configWriteBack: WRITE_BACK,
    });

    expect(base).toEqual({ "same.txt": "same" });
  });

  it("元から一致していたパスは、テンプレートから消えていればエントリを落とす", () => {
    // ローカル・テンプレートの双方から消えているファイル。据え置くと毎回削除候補として
    // 報告され続け、status も同期済みにならない。
    const base = baseAfterPush({
      templateHashes: hashMap({}),
      previousBase: hashMap({ "gone-everywhere.txt": "old" }),
      pushed: { files: [], deletions: [] },
      alreadySynced: new Set(repoRelPaths(["gone-everywhere.txt"])),
      configWriteBack: WRITE_BACK,
    });

    expect(base).toEqual({});
  });

  it("ベースに無かったパスは、送ったときだけエントリが増える", () => {
    const base = baseAfterPush({
      templateHashes: hashMap({ "new.txt": "new-hash", "untouched.txt": "template-only" }),
      previousBase: hashMap({}),
      pushed: {
        files: [{ path: repoRelPath("new.txt"), content: asPushContent("x") }],
        deletions: [],
      },
      alreadySynced: new Set(),
      configWriteBack: WRITE_BACK,
    });

    expect(base).toEqual({ "new.txt": "new-hash" });
  });

  it("ローカルへ書き戻さなかった ziku.jsonc のベースは前進させない", () => {
    // スコープ限定の和集合はローカルの内容ではない。テンプレート側へ揃えると次の分類が
    // ローカルを localOnly と読み、次の push がローカル全体の和集合を送る。
    const base = baseAfterPush({
      templateHashes: hashMap({ ".ziku/ziku.jsonc": "scoped", "sent.txt": "sent-new" }),
      previousBase: hashMap({ ".ziku/ziku.jsonc": "local", "sent.txt": "sent-old" }),
      pushed: {
        files: [
          { path: CONFIG_PATH, content: asPushContent("scoped") },
          { path: repoRelPath("sent.txt"), content: asPushContent("x") },
        ],
        deletions: [],
      },
      alreadySynced: new Set(),
      configWriteBack: { _tag: "Withhold" },
    });

    expect(base).toEqual({ ".ziku/ziku.jsonc": "local", "sent.txt": "sent-new" });
  });

  it("元から一致していた ziku.jsonc も、書き戻さずに送ったならベースを据え置く", () => {
    const base = baseAfterPush({
      templateHashes: hashMap({ ".ziku/ziku.jsonc": "scoped" }),
      previousBase: hashMap({ ".ziku/ziku.jsonc": "local" }),
      pushed: { files: [{ path: CONFIG_PATH, content: asPushContent("scoped") }], deletions: [] },
      alreadySynced: new Set([CONFIG_PATH]),
      configWriteBack: { _tag: "Withhold" },
    });

    expect(base).toEqual({ ".ziku/ziku.jsonc": "local" });
  });

  it("書き戻したなら ziku.jsonc のベースもテンプレート側へ前進させる", () => {
    const base = baseAfterPush({
      templateHashes: hashMap({ ".ziku/ziku.jsonc": "merged" }),
      previousBase: hashMap({ ".ziku/ziku.jsonc": "local" }),
      pushed: { files: [{ path: CONFIG_PATH, content: asPushContent("merged") }], deletions: [] },
      alreadySynced: new Set(),
      configWriteBack: WRITE_BACK,
    });

    expect(base).toEqual({ ".ziku/ziku.jsonc": "merged" });
  });
});

describe("asDeletablePath", () => {
  it("通常の同期ファイルは削除として送れる", () => {
    expect(asDeletablePath(repoRelPath("a.txt"))).toBe("a.txt");
  });

  it("ziku 自身の設定ファイルは削除として送れない", () => {
    expect(asDeletablePath(CONFIG_PATH)).toBeUndefined();
  });
});

describe("planConfigPropagation", () => {
  it("伝えるパターンが無ければ ziku.jsonc を組み直さない", () => {
    const plan = planConfigPropagation({
      selectedPaths: repoRelPaths(["a.txt"]),
      newlyTrackedPaths: [],
      localOnlyPatterns: [],
    });

    expect(plan).toEqual({ _tag: "NoConfigChange" });
    expect(zikuConfigWriteBack(plan)).toEqual({ _tag: "WriteBack" });
  });

  it("ziku.jsonc が選択済みなら、新規追跡分を足したローカル全体の和集合を送る", () => {
    const plan = planConfigPropagation({
      selectedPaths: [CONFIG_PATH, repoRelPath("a.txt")],
      newlyTrackedPaths: repoRelPaths(["a.txt"]),
      localOnlyPatterns: [],
    });

    expect(plan).toEqual({ _tag: "MergeLocalConfig", extraIncludes: globPatterns(["a.txt"]) });
    expect(zikuConfigWriteBack(plan)).toEqual({ _tag: "WriteBack" });
  });

  it("ziku.jsonc が未選択なら、今回の送信対象に関係するパターンだけを和集合する", () => {
    const plan = planConfigPropagation({
      selectedPaths: repoRelPaths(["a.txt"]),
      newlyTrackedPaths: repoRelPaths(["a.txt"]),
      localOnlyPatterns: globPatterns([".claude/rules/*.md"]),
    });

    expect(plan).toEqual({
      _tag: "MergeScopedConfig",
      additionalIncludes: globPatterns(["a.txt", ".claude/rules/*.md"]),
    });
  });

  it("スコープ限定の和集合はローカルへ書き戻さない", () => {
    const plan = planConfigPropagation({
      selectedPaths: repoRelPaths(["a.txt"]),
      newlyTrackedPaths: [],
      localOnlyPatterns: globPatterns(["a.txt"]),
    });

    expect(zikuConfigWriteBack(plan)).toEqual({ _tag: "Withhold" });
  });

  it("選択から外れた追跡候補のパターンは先に送らない", () => {
    const plan = planConfigPropagation({
      selectedPaths: repoRelPaths(["a.txt"]),
      newlyTrackedPaths: repoRelPaths(["a.txt", "dropped.txt"]),
      localOnlyPatterns: [],
    });

    expect(plan).toEqual({
      _tag: "MergeScopedConfig",
      additionalIncludes: globPatterns(["a.txt"]),
    });
  });

  it("ziku.jsonc が選択済みで新規追跡が無ければ、既存の内容をそのまま送る", () => {
    const plan = planConfigPropagation({
      selectedPaths: [CONFIG_PATH],
      newlyTrackedPaths: [],
      localOnlyPatterns: [],
    });

    expect(plan).toEqual({ _tag: "NoConfigChange" });
  });
});

describe("configDiffToInject", () => {
  it("テンプレートと同じ内容なら伝える追加パターンが無いので注入しない", () => {
    expect(configDiffToInject({ mergedConfig: "same", templateConfig: "same" })).toBeUndefined();
  });

  it("テンプレートに ziku.jsonc が無ければ新規追加として注入する", () => {
    expect(configDiffToInject({ mergedConfig: "merged", templateConfig: undefined })).toEqual({
      path: CONFIG_PATH,
      type: "added",
      localContent: "merged",
    });
  });

  it("テンプレートにあれば、その内容からの変更として注入する", () => {
    expect(configDiffToInject({ mergedConfig: "merged", templateConfig: "old" })).toEqual({
      path: CONFIG_PATH,
      type: "modified",
      localContent: "merged",
      templateContent: "old",
    });
  });
});

describe("planUntrackedTracking", () => {
  it("未追跡ファイルが無ければ何もしない", () => {
    expect(planUntrackedTracking({ untrackedCount: 0, yes: true, dryRun: true })).toEqual({
      _tag: "NoUntracked",
    });
  });

  it("対話できるなら追跡対象を選ばせる", () => {
    expect(planUntrackedTracking({ untrackedCount: 2, yes: false, dryRun: false })).toEqual({
      _tag: "AskUser",
    });
  });

  it("--yes は追跡を増やさず、除外を通知する", () => {
    expect(planUntrackedTracking({ untrackedCount: 2, yes: true, dryRun: false })).toEqual({
      _tag: "SkipTracking",
      reason: "yes",
    });
  });

  it("dry-run は判断のスキップとして通知する", () => {
    expect(planUntrackedTracking({ untrackedCount: 2, yes: true, dryRun: true })).toEqual({
      _tag: "SkipTracking",
      reason: "dryRun",
    });
  });
});

describe("withNewlyTrackedPatterns", () => {
  const patterns = { include: globPatterns([".github/**"]), exclude: globPatterns(["**/*.log"]) };

  it("選んだファイルのパスを 1 本の include として足す", () => {
    const { effectivePatterns, newlyTrackedPaths } = withNewlyTrackedPatterns(
      patterns,
      repoRelPaths(["docs/a.md"]),
    );

    expect(effectivePatterns.include).toEqual(globPatterns([".github/**", "docs/a.md"]));
    expect(effectivePatterns.exclude).toEqual(globPatterns(["**/*.log"]));
    expect(newlyTrackedPaths).toEqual(["docs/a.md"]);
  });

  it("何も選ばなければパターンは変わらない", () => {
    const { effectivePatterns, newlyTrackedPaths } = withNewlyTrackedPatterns(patterns, []);

    expect(effectivePatterns).toEqual(patterns);
    expect(newlyTrackedPaths).toEqual([]);
  });
});

describe("patternsToPersist", () => {
  it("実際に送ったファイルのパターンだけを永続化する", () => {
    const persisted = patternsToPersist(
      repoRelPaths(["a.txt", "dropped.txt"]),
      pathSet(["a.txt", "other.txt"]),
    );

    expect(persisted).toEqual(globPatterns(["a.txt"]));
  });

  it("送ったファイルが無ければ何も永続化しない", () => {
    expect(patternsToPersist(repoRelPaths(["a.txt"]), pathSet())).toEqual([]);
  });
});

describe("resolvePrBaseBranch", () => {
  it("ref を持たないソースは引けた既定ブランチへ向ける", () => {
    expect(resolvePrBaseBranch(source(), fetched("master"))).toEqual({
      _tag: "Branch",
      name: "master",
    });
  });

  it("待てば直る失敗では、控えた既定ブランチを宛先にする", () => {
    const recorded = { ...source(), defaultBranch: "master" };

    expect(resolvePrBaseBranch(recorded, RATE_LIMITED)).toEqual({
      _tag: "Branch",
      name: "master",
    });
  });

  it("トークンを拒否されたら、控えがあっても宛先にしない", () => {
    const recorded = { ...source(), defaultBranch: "master" };

    expect(resolvePrBaseBranch(recorded, AUTH_REJECTED)).toEqual({
      _tag: "AuthRejected",
      detail: "Bad credentials",
    });
  });

  it("引けず控えも無ければ宛先を決めない（main を仮定しない）", () => {
    expect(resolvePrBaseBranch(source(), RATE_LIMITED)).toEqual({
      _tag: "DefaultBranchUnresolved",
    });
  });

  it("既定ブランチを問い合わせていなければ宛先を決めない", () => {
    expect(resolvePrBaseBranch(source(), undefined)).toEqual({ _tag: "DefaultBranchUnresolved" });
  });

  it("ブランチ指定は既定ブランチより優先される", () => {
    expect(
      resolvePrBaseBranch(source({ kind: "branch", name: "develop" }), fetched("master")),
    ).toEqual({
      _tag: "Branch",
      name: "develop",
    });
  });

  it("タグ・コミット固定は PR の宛先にできない", () => {
    expect(resolvePrBaseBranch(source({ kind: "tag", name: "v1.0.0" }), fetched("main"))).toEqual({
      _tag: "UnsupportedRef",
      kind: "tag",
    });
    expect(
      resolvePrBaseBranch(
        source({ kind: "commit", sha: commitSha("a".repeat(40)) }),
        fetched("main"),
      ),
    ).toEqual({ _tag: "UnsupportedRef", kind: "commit" });
  });
});

describe("buildPushSummaryRows", () => {
  const noRestores = pathSet();

  it("送る内容とテンプレートの内容から種別を決め直す", () => {
    const rows = buildPushSummaryRows({
      pushableFiles: [modified("a.txt", "local", "template")],
      files: [{ path: repoRelPath("a.txt"), content: asPushContent("merged") }],
      deletions: [],
      restoresTemplateDeletion: noRestores,
    });

    expect(rows).toEqual([
      {
        _tag: "Change",
        diff: {
          path: "a.txt",
          type: "modified",
          localContent: "merged",
          templateContent: "template",
        },
        restoresTemplateDeletion: false,
      },
    ]);
  });

  it("送る内容がテンプレートと同一になったファイルは行に出さない", () => {
    const rows = buildPushSummaryRows({
      pushableFiles: [modified("a.txt", "local", "template")],
      files: [{ path: repoRelPath("a.txt"), content: asPushContent("template") }],
      deletions: [],
      restoresTemplateDeletion: noRestores,
    });

    expect(rows).toEqual([]);
  });

  it("削除は送信内容を持たないまま行に出す", () => {
    const rows = buildPushSummaryRows({
      pushableFiles: [deleted("gone.txt")],
      files: [],
      deletions: [{ path: repoRelPath("gone.txt") }],
      restoresTemplateDeletion: noRestores,
    });

    expect(rows).toEqual([
      {
        _tag: "Change",
        diff: { path: "gone.txt", type: "deleted", templateContent: "template" },
        restoresTemplateDeletion: false,
      },
    ]);
  });

  it("テンプレートの削除を取り消すファイルには印を付ける", () => {
    const rows = buildPushSummaryRows({
      pushableFiles: [added("restored.txt", "local")],
      files: [{ path: repoRelPath("restored.txt"), content: asPushContent("local") }],
      deletions: [],
      restoresTemplateDeletion: pathSet(["restored.txt"]),
    });

    expect(rows[0]).toMatchObject({ _tag: "Change", restoresTemplateDeletion: true });
  });

  it("選択に無いのに送るファイルは自動更新として並べる", () => {
    const rows = buildPushSummaryRows({
      pushableFiles: [],
      files: [{ path: repoRelPath("README.md"), content: asPushContent("generated") }],
      deletions: [],
      restoresTemplateDeletion: noRestores,
    });

    expect(rows).toEqual([{ _tag: "AutoUpdated", path: "README.md" }]);
  });

  it("送信内容も削除指定も無いファイルは行に出さない", () => {
    const rows = buildPushSummaryRows({
      pushableFiles: [added("a.txt")],
      files: [],
      deletions: [],
      restoresTemplateDeletion: noRestores,
    });

    expect(rows).toEqual([]);
  });
});
