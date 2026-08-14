/**
 * push が「何を送るか」を決める計算のテスト。
 *
 * ファイルシステム・GitHub API・プロンプトを一切用意せず、入力の値だけで判断を検証する。
 * コマンド全体の配線（どの順で I/O を呼ぶか・どのログを出すか）は `push.test.ts` が見る。
 */
import { describe, expect, it } from "vitest";
import type { FileClassification } from "../../utils/merge";
import { classifyFiles } from "../../utils/merge";
import { classifyMergeOutcome } from "../../utils/merge/types";
import type { SyncPlan, ZikuConfigState } from "../../utils/merge/sync-plan";
import { partitionSyncPlan } from "../../utils/merge/sync-plan";
import type { ConfigDrift } from "../../utils/config-merge";
import type { PinnedGitHubSource } from "../../utils/template-resolve";
import type { DeletablePath, FileDiff, PushContent, RepoRelPath } from "../../modules/schemas";
import { asDeletablePath, asPushContent, mergedAsPushContent } from "../../modules/schemas";
import { classifySyncPath } from "../../utils/ziku-config";
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
  baseAfterPush,
  collectPushCandidates,
  configDiffToInject,
  defaultPushSelection,
  filterByFilesArg,
  patternsToPersist,
  planConfigPropagation,
  planPushCandidates,
  planPushDelivery,
  planUntrackedTracking,
  pushPayloadOf,
  pushSummaryRows,
  pushedDeletions,
  pushedFiles,
  resolvePrBaseBranch,
  selectedUnresolvedConflicts,
  withAutoUpdatedFile,
  withheldFromDefaultSelection,
  zikuConfigWriteBack,
} from "../push-plan";
import type { ChangedFileDiff, PushFile, PushPayload, PushSend } from "../push-plan";

/** 送った内容をローカルへ書き戻していないケース。ベース前進の例外が要らない既定の入力。 */
const NOTHING_WRITTEN_BACK: ReadonlySet<RepoRelPath> = new Set();

/** 既定選択が何も外さなかったケース。伝播の計画にゲートが効いていない状態を表す。 */
const NOTHING_WITHHELD: ReadonlySet<RepoRelPath> = new Set();

/**
 * ローカルの内容をそのまま送るファイル。ベースをテンプレート側へ進めてよい。
 */
function localFile(path: string, content: string): PushFile {
  return {
    path: repoRelPath(path),
    content: asPushContent(content),
    origin: { _tag: "LocalContent" },
  };
}

/**
 * ziku が組み立てた内容を送るファイル。ローカルへ書き戻さない限りベースを進められない。
 */
function synthesizedFile(path: string, content: string): PushFile {
  return {
    path: repoRelPath(path),
    content: asPushContent(content),
    origin: { _tag: "Synthesized" },
  };
}

/**
 * 削除として送れるパスを組み立てる。
 *
 * `asDeletablePath` は設定ファイルを弾くため `undefined` を返しうる。テストの入力は通常の
 * 同期ファイルに限るので、弾かれたらフィクスチャの誤りとして落とす。
 */
function deletablePath(path: string): DeletablePath {
  const deletable = asDeletablePath(classifySyncPath(repoRelPath(path)));
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

/** テンプレートの取得に使った参照が決まった状態のソース。 */
function pinnedSource(ref: PinnedGitHubSource["ref"]): PinnedGitHubSource {
  return { kind: "github", owner: "o", repo: "r", ref };
}

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

  it("init が生成したファイルは、ベースに載っているので送信候補に上がらない", () => {
    // `.devcontainer/devcontainer.env.example` は init が組み立てて書くファイルで、
    // テンプレートには無い。ベースに載らないと localOnly になり、`push --yes` が
    // ziku 自身の生成物をテンプレートへ送って全プロジェクトへ配ってしまう。
    const envExample = ".devcontainer/devcontainer.env.example";
    const classification = classifyFiles({
      baseHashes: hashMap({ [envExample]: "generated" }),
      localHashes: hashMap({ [envExample]: "generated" }),
      templateHashes: hashMap({}),
    });

    expect(classification.localOnly).not.toContain(envExample);
    expect([
      ...planPushCandidates(partitionSyncPlan(classification), driftBothWays).pushablePaths,
    ]).toEqual([]);
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

describe("withheldFromDefaultSelection", () => {
  it("既定選択が外した候補だけを集める", () => {
    const candidates = [
      added("a.txt"),
      deleted("gone.txt"),
      modified("conflict.txt"),
      added("restored.txt"),
    ];

    const withheld = withheldFromDefaultSelection(candidates, {
      includeDeletions: false,
      conflictedPaths: pathSet(["conflict.txt"]),
      restoresTemplateDeletion: pathSet(["restored.txt"]),
    });

    expect([...withheld].toSorted()).toEqual(["conflict.txt", "gone.txt", "restored.txt"]);
  });

  it("既定集合と補い合う（候補は必ずどちらか一方に入る）", () => {
    const candidates = [added("a.txt"), deleted("gone.txt")];
    const marks = {
      includeDeletions: false,
      conflictedPaths: pathSet(),
      restoresTemplateDeletion: pathSet(),
    };

    const selected = paths(defaultPushSelection(candidates, marks));
    const withheld = [...withheldFromDefaultSelection(candidates, marks)];

    expect([...selected, ...withheld].toSorted()).toEqual(["a.txt", "gone.txt"]);
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

/** 送るものがある前提で payload を取り出す。無ければテストの前提が崩れている。 */
function deliveryPayload(
  selected: Parameters<typeof planPushDelivery>[0]["selected"],
  mergedContents: Parameters<typeof planPushDelivery>[0]["mergedContents"],
): PushPayload {
  const delivery = planPushDelivery({
    selected,
    mergedContents,
    restoresTemplateDeletion: pathSet(),
  });
  if (delivery._tag !== "Send") throw new Error("fixture must have something to push");
  return delivery.send.payload;
}

describe("planPushDelivery", () => {
  it("削除と送信内容を分け、自動マージ済みの内容を優先する", () => {
    const merged = classifyMergeOutcome("merged content");
    if (merged._tag !== "Clean") throw new Error("fixture must merge cleanly");
    const mergedContents = new Map<RepoRelPath, PushContent>([
      [repoRelPath("b.txt"), mergedAsPushContent(merged.content)],
    ]);

    const payload = deliveryPayload(
      [added("a.txt", "local a"), modified("b.txt", "local b"), deleted("gone.txt")],
      mergedContents,
    );

    expect(pushedFiles(payload)).toEqual([
      { path: "a.txt", content: "local a", origin: { _tag: "LocalContent" } },
      { path: "b.txt", content: "merged content", origin: { _tag: "Synthesized" } },
    ]);
    expect(pushedDeletions(payload)).toEqual([{ path: "gone.txt" }]);
  });

  it("マージ結果が無いファイルはローカルの内容をそのまま送る", () => {
    const payload = deliveryPayload([added("a.txt", "local a")], new Map());

    expect(pushedFiles(payload)).toEqual([
      { path: "a.txt", content: "local a", origin: { _tag: "LocalContent" } },
    ]);
  });

  it("マージ結果と同じ内容がローカルにあっても、出所はマージ結果のままにする", () => {
    // 出所は内容の一致ではなく経路で決まる。自動同梱する ziku.jsonc の差分は組み立てた
    // 内容を localContent に載せて流れてくるため、内容比較では「ローカルにある」と誤読する。
    const mergedContents = new Map<RepoRelPath, PushContent>([
      [repoRelPath("a.txt"), asPushContent("local a")],
    ]);

    const payload = deliveryPayload([added("a.txt", "local a")], mergedContents);

    expect(pushedFiles(payload)).toEqual([
      { path: "a.txt", content: "local a", origin: { _tag: "Synthesized" } },
    ]);
  });

  it("ziku.jsonc の削除は送らない（通常ファイルの削除は送る）", () => {
    // テンプレートの ziku.jsonc が消えると、そのテンプレートを使う全プロジェクトの
    // init / pull が同期対象パターンを引けなくなる。
    const payload = deliveryPayload([deleted(".ziku/ziku.jsonc"), deleted("gone.txt")], new Map());

    expect(pushedDeletions(payload)).toEqual([{ path: "gone.txt" }]);
    expect(pushedFiles(payload)).toEqual([]);
  });

  it("送る内容がテンプレートと同一になったファイルは送らない", () => {
    // ベースが A、ローカルが B、テンプレートが B + C の衝突。自動マージはクリーンに
    // B + C へ解決し、それはテンプレートの内容そのもの。差分の無い PR を作りにいくと
    // GitHub が拒み、その状態はどの分類にも無いので ziku の不具合として表示される。
    const merged = classifyMergeOutcome("B\nC\n");
    if (merged._tag !== "Clean") throw new Error("fixture must merge cleanly");
    const mergedContents = new Map<RepoRelPath, PushContent>([
      [repoRelPath("a.txt"), mergedAsPushContent(merged.content)],
    ]);

    const delivery = planPushDelivery({
      selected: [modified("a.txt", "B\n", "B\nC\n")],
      mergedContents,
      restoresTemplateDeletion: pathSet(),
    });

    expect(delivery).toEqual({ _tag: "Nothing" });
  });

  it("送信ペイロードとサマリーの行は同じ集合になる", () => {
    // 片方だけが「テンプレートと同一」を落とすと、0 件と表示しながら中身の無い送信をする。
    const mergedContents = new Map<RepoRelPath, PushContent>([
      [repoRelPath("same.txt"), asPushContent("template")],
      [repoRelPath("differs.txt"), asPushContent("sent")],
    ]);
    const pushableFiles = [
      modified("same.txt", "local", "template"),
      modified("differs.txt", "local", "template"),
    ];

    const delivery = planPushDelivery({
      selected: pushableFiles,
      mergedContents,
      restoresTemplateDeletion: pathSet(),
    });
    if (delivery._tag !== "Send") throw new Error("fixture must have something to push");
    const { payload } = delivery.send;
    const rows = pushSummaryRows(delivery.send);

    expect(pushedFiles(payload).map((f) => f.path)).toEqual(["differs.txt"]);
    expect(rows.map((row) => (row._tag === "Change" ? row.diff.path : row.path))).toEqual([
      "differs.txt",
    ]);
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
      pushed: pushPayloadOf({ files: [localFile("sent.txt", "x")] }),
      alreadySynced: new Set(repoRelPaths(["same.txt"])),
      writtenBackToLocal: NOTHING_WRITTEN_BACK,
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
      pushed: pushPayloadOf({ deletions: [{ path: deletablePath("gone.txt") }] }),
      alreadySynced: new Set(repoRelPaths(["same.txt"])),
      writtenBackToLocal: NOTHING_WRITTEN_BACK,
    });

    expect(base).toEqual({ "same.txt": "same" });
  });

  it("元から一致していたパスは、テンプレートから消えていればエントリを落とす", () => {
    // ローカル・テンプレートの双方から消えているファイル。据え置くと毎回削除候補として
    // 報告され続け、status も同期済みにならない。
    const base = baseAfterPush({
      templateHashes: hashMap({}),
      previousBase: hashMap({ "gone-everywhere.txt": "old" }),
      pushed: pushPayloadOf({}),
      alreadySynced: new Set(repoRelPaths(["gone-everywhere.txt"])),
      writtenBackToLocal: NOTHING_WRITTEN_BACK,
    });

    expect(base).toEqual({});
  });

  it("ベースに無かったパスは、送ったときだけエントリが増える", () => {
    const base = baseAfterPush({
      templateHashes: hashMap({ "new.txt": "new-hash", "untouched.txt": "template-only" }),
      previousBase: hashMap({}),
      pushed: pushPayloadOf({ files: [localFile("new.txt", "x")] }),
      alreadySynced: new Set(),
      writtenBackToLocal: NOTHING_WRITTEN_BACK,
    });

    expect(base).toEqual({ "new.txt": "new-hash" });
  });

  it("ローカルへ書き戻さなかった ziku.jsonc のベースは前進させない", () => {
    // スコープ限定の和集合はローカルの内容ではない。テンプレート側へ揃えると次の分類が
    // ローカルを localOnly と読み、次の push がローカル全体の和集合を送る。
    const base = baseAfterPush({
      templateHashes: hashMap({ ".ziku/ziku.jsonc": "scoped", "sent.txt": "sent-new" }),
      previousBase: hashMap({ ".ziku/ziku.jsonc": "local", "sent.txt": "sent-old" }),
      pushed: pushPayloadOf({
        files: [synthesizedFile(".ziku/ziku.jsonc", "scoped"), localFile("sent.txt", "x")],
      }),
      alreadySynced: new Set(),
      writtenBackToLocal: NOTHING_WRITTEN_BACK,
    });

    expect(base).toEqual({ ".ziku/ziku.jsonc": "local", "sent.txt": "sent-new" });
  });

  it("元から一致していた ziku.jsonc も、書き戻さずに送ったならベースを据え置く", () => {
    const base = baseAfterPush({
      templateHashes: hashMap({ ".ziku/ziku.jsonc": "scoped" }),
      previousBase: hashMap({ ".ziku/ziku.jsonc": "local" }),
      pushed: pushPayloadOf({ files: [synthesizedFile(".ziku/ziku.jsonc", "scoped")] }),
      alreadySynced: new Set([CONFIG_PATH]),
      writtenBackToLocal: NOTHING_WRITTEN_BACK,
    });

    expect(base).toEqual({ ".ziku/ziku.jsonc": "local" });
  });

  it("書き戻したなら ziku.jsonc のベースもテンプレート側へ前進させる", () => {
    const base = baseAfterPush({
      templateHashes: hashMap({ ".ziku/ziku.jsonc": "merged" }),
      previousBase: hashMap({ ".ziku/ziku.jsonc": "local" }),
      pushed: pushPayloadOf({ files: [synthesizedFile(".ziku/ziku.jsonc", "merged")] }),
      alreadySynced: new Set(),
      writtenBackToLocal: new Set([CONFIG_PATH]),
    });

    expect(base).toEqual({ ".ziku/ziku.jsonc": "merged" });
  });

  it("自動マージ結果だけを送ったファイルのベースは前進させない", () => {
    // 規則は `ziku.jsonc` 固有ではなく、ziku が組み立てた内容すべてに掛かる。
    const base = baseAfterPush({
      templateHashes: hashMap({ "doc.md": "merged" }),
      previousBase: hashMap({ "doc.md": "old" }),
      pushed: pushPayloadOf({ files: [synthesizedFile("doc.md", "merged")] }),
      alreadySynced: new Set(),
      writtenBackToLocal: NOTHING_WRITTEN_BACK,
    });

    expect(base).toEqual({ "doc.md": "old" });
  });

  it("自動マージ結果を送った次の分類は、そのファイルを localOnly と読まない", () => {
    // ベースがテンプレート側へ進むと local != base == template になり、次の分類は
    // ローカルだけが変えたと読む。すると `push --yes` の既定選択に古いローカル内容が入り、
    // 送った直後のテンプレート側の変更を上書きで巻き戻す。
    const localHash = "local";
    const mergedHash = "merged";

    const base = baseAfterPush({
      templateHashes: hashMap({ "doc.md": mergedHash }),
      previousBase: hashMap({ "doc.md": "old" }),
      pushed: pushPayloadOf({ files: [synthesizedFile("doc.md", "merged content")] }),
      alreadySynced: new Set(),
      writtenBackToLocal: NOTHING_WRITTEN_BACK,
    });

    const next = classifyFiles({
      baseHashes: base,
      localHashes: hashMap({ "doc.md": localHash }),
      templateHashes: hashMap({ "doc.md": mergedHash }),
    });

    expect(next.localOnly).toEqual([]);
    expect(next.conflicts).toEqual(["doc.md"]);
  });
});

describe("planConfigPropagation", () => {
  it("伝えるパターンが無ければ ziku.jsonc を組み直さない", () => {
    const plan = planConfigPropagation({
      selectedPaths: repoRelPaths(["a.txt"]),
      newlyTrackedPaths: [],
      localOnlyPatterns: [],
      withheldFromDefault: NOTHING_WITHHELD,
    });

    expect(plan).toEqual({ _tag: "NoConfigChange" });
    expect(zikuConfigWriteBack(plan)).toEqual({ _tag: "WriteBack" });
  });

  it("ziku.jsonc が選択済みなら、新規追跡分を足したローカル全体の和集合を送る", () => {
    const plan = planConfigPropagation({
      selectedPaths: [CONFIG_PATH, repoRelPath("a.txt")],
      newlyTrackedPaths: repoRelPaths(["a.txt"]),
      localOnlyPatterns: [],
      withheldFromDefault: NOTHING_WITHHELD,
    });

    expect(plan).toEqual({ _tag: "MergeLocalConfig", extraIncludes: globPatterns(["a.txt"]) });
    expect(zikuConfigWriteBack(plan)).toEqual({ _tag: "WriteBack" });
  });

  it("ziku.jsonc が未選択なら、今回の送信対象に関係するパターンだけを和集合する", () => {
    const plan = planConfigPropagation({
      selectedPaths: repoRelPaths(["a.txt"]),
      newlyTrackedPaths: repoRelPaths(["a.txt"]),
      localOnlyPatterns: globPatterns([".claude/rules/*.md"]),
      withheldFromDefault: NOTHING_WITHHELD,
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
      withheldFromDefault: NOTHING_WITHHELD,
    });

    expect(zikuConfigWriteBack(plan)).toEqual({ _tag: "Withhold" });
  });

  it("選択から外れた追跡候補のパターンは先に送らない", () => {
    const plan = planConfigPropagation({
      selectedPaths: repoRelPaths(["a.txt"]),
      newlyTrackedPaths: repoRelPaths(["a.txt", "dropped.txt"]),
      localOnlyPatterns: [],
      withheldFromDefault: NOTHING_WITHHELD,
    });

    expect(plan).toEqual({
      _tag: "MergeScopedConfig",
      additionalIncludes: globPatterns(["a.txt"]),
    });
  });

  it("既定選択が ziku.jsonc を外していたら自動同梱しない", () => {
    // 既定から外す理由（テンプレート側の削除の取り消し・未解決の衝突）は、選択を経ずに
    // 送信対象へ足す経路でも変わらない。ここが素通しになると、既定で送らないと決めた
    // 設定ファイルが自動同梱として PR に載る。
    const plan = planConfigPropagation({
      selectedPaths: repoRelPaths(["a.txt"]),
      newlyTrackedPaths: repoRelPaths(["a.txt"]),
      localOnlyPatterns: globPatterns([".claude/rules/*.md"]),
      withheldFromDefault: new Set([CONFIG_PATH]),
    });

    expect(plan).toEqual({ _tag: "NoConfigChange" });
  });

  it("ゲートに掛かっていても、ユーザーが ziku.jsonc を選んでいれば送る", () => {
    // 一覧から明示的に選んだ場合は、削除の取り消しだと分かったうえでの操作。ローカル全体の
    // 和集合を送る経路に戻す。
    const plan = planConfigPropagation({
      selectedPaths: [CONFIG_PATH, repoRelPath("a.txt")],
      newlyTrackedPaths: repoRelPaths(["a.txt"]),
      localOnlyPatterns: [],
      withheldFromDefault: new Set([CONFIG_PATH]),
    });

    expect(plan).toEqual({ _tag: "MergeLocalConfig", extraIncludes: globPatterns(["a.txt"]) });
  });

  it("ziku.jsonc が選択済みで新規追跡が無ければ、既存の内容をそのまま送る", () => {
    const plan = planConfigPropagation({
      selectedPaths: [CONFIG_PATH],
      newlyTrackedPaths: [],
      localOnlyPatterns: [],
      withheldFromDefault: NOTHING_WITHHELD,
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
  it("取得に使ったブランチをそのまま宛先にする", () => {
    // ref 未指定のソースでは、既定ブランチとして決着した名前がここに入っている。
    expect(resolvePrBaseBranch(pinnedSource({ kind: "branch", name: "master" }))).toEqual({
      _tag: "Branch",
      name: "master",
    });
  });

  it("タグ・コミット固定は PR の宛先にできない", () => {
    expect(resolvePrBaseBranch(pinnedSource({ kind: "tag", name: "v1.0.0" }))).toEqual({
      _tag: "UnsupportedRef",
      kind: "tag",
    });
    expect(
      resolvePrBaseBranch(pinnedSource({ kind: "commit", sha: commitSha("a".repeat(40)) })),
    ).toEqual({ _tag: "UnsupportedRef", kind: "commit" });
  });
});

describe("pushSummaryRows", () => {
  const noRestores = pathSet();

  /** 送る集合を直に組んだ {@link PushSend}。行が payload から導かれることを見る。 */
  function sendOf(params: {
    pushableFiles: readonly ChangedFileDiff[];
    files?: readonly PushFile[];
    deletions?: readonly { path: DeletablePath }[];
    restoresTemplateDeletion?: ReadonlySet<RepoRelPath>;
  }): PushSend {
    return {
      payload: pushPayloadOf({ files: params.files, deletions: params.deletions }),
      pushableFiles: params.pushableFiles,
      restoresTemplateDeletion: params.restoresTemplateDeletion ?? noRestores,
    };
  }

  it("送る内容とテンプレートの内容から種別を決め直す", () => {
    const rows = pushSummaryRows(
      sendOf({
        pushableFiles: [modified("a.txt", "local", "template")],
        files: [synthesizedFile("a.txt", "merged")],
      }),
    );

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
    const rows = pushSummaryRows(
      sendOf({
        pushableFiles: [modified("a.txt", "local", "template")],
        files: [synthesizedFile("a.txt", "template")],
      }),
    );

    expect(rows).toEqual([]);
  });

  it("削除は送信内容を持たないまま行に出す", () => {
    const rows = pushSummaryRows(
      sendOf({
        pushableFiles: [deleted("gone.txt")],
        deletions: [{ path: deletablePath("gone.txt") }],
      }),
    );

    expect(rows).toEqual([
      {
        _tag: "Change",
        diff: { path: "gone.txt", type: "deleted", templateContent: "template" },
        restoresTemplateDeletion: false,
      },
    ]);
  });

  it("テンプレートの削除を取り消すファイルには印を付ける", () => {
    const rows = pushSummaryRows(
      sendOf({
        pushableFiles: [added("restored.txt", "local")],
        files: [synthesizedFile("restored.txt", "local")],
        restoresTemplateDeletion: pathSet(["restored.txt"]),
      }),
    );

    expect(rows[0]).toMatchObject({ _tag: "Change", restoresTemplateDeletion: true });
  });

  it("選択に無いのに送るファイルは自動更新として並べる", () => {
    const rows = pushSummaryRows(
      sendOf({ pushableFiles: [], files: [synthesizedFile("README.md", "generated")] }),
    );

    expect(rows).toEqual([{ _tag: "AutoUpdated", path: "README.md" }]);
  });

  it("送信内容も削除指定も無いファイルは行に出さない", () => {
    const rows = pushSummaryRows(sendOf({ pushableFiles: [added("a.txt")] }));

    expect(rows).toEqual([]);
  });

  it("付け足したファイルは送る集合にも行にも同時に載る", () => {
    // 片方だけに足せると、PR には出るのにサマリには出ないファイルができる。
    const before = sendOf({
      pushableFiles: [modified("a.txt", "local", "template")],
      files: [synthesizedFile("a.txt", "merged")],
    });

    const after = withAutoUpdatedFile(before, synthesizedFile("README.md", "generated"));

    expect(pushedFiles(after.payload).map((f) => f.path)).toEqual(["a.txt", "README.md"]);
    expect(pushSummaryRows(after)).toContainEqual({ _tag: "AutoUpdated", path: "README.md" });
  });

  it("既に送る集合にあるパスを付け足すと内容を差し替える", () => {
    // 同じパスを 2 回送ると、2 回目の書き込みが 1 回目で変わった blob SHA と食い違って弾かれる。
    const before = sendOf({
      pushableFiles: [modified("README.md", "local", "template")],
      files: [synthesizedFile("README.md", "local")],
    });

    const after = withAutoUpdatedFile(before, synthesizedFile("README.md", "rebuilt"));

    expect(pushedFiles(after.payload)).toEqual([synthesizedFile("README.md", "rebuilt")]);
  });

  it("削除として送るパスには内容を足さない", () => {
    // 内容と削除を同じパスに載せると、GitHub は内容の書き込みで変わった blob と削除に
    // 渡す SHA の食い違いで PR の作成を拒み、同期ブランチだけが残る。
    const before = sendOf({
      pushableFiles: [deleted("README.md")],
      deletions: [{ path: deletablePath("README.md") }],
    });

    const after = withAutoUpdatedFile(before, synthesizedFile("README.md", "generated"));

    expect(pushedFiles(after.payload)).toEqual([]);
    expect(pushedDeletions(after.payload)).toEqual([{ path: "README.md" }]);
    expect(pushSummaryRows(after)).toEqual([
      {
        _tag: "Change",
        diff: { path: "README.md", type: "deleted", templateContent: "template" },
        restoresTemplateDeletion: false,
      },
    ]);
  });
});
