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
import type { FileDiff, GitHubSource, RepoRelPath } from "../../modules/schemas";
import { commitSha, globPatterns, repoRelPath, repoRelPaths } from "../../__tests__/brands";
import {
  applyPushSelection,
  asPushContent,
  buildPushPayload,
  buildPushSummaryRows,
  collectPushCandidates,
  configDiffToInject,
  configWriteBackSafe,
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
} from "../push-plan";
import type { ChangedFileDiff, PushContent } from "../push-plan";

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

const untrackedConfig: ZikuConfigState = { _tag: "Untracked" };

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

describe("planPushCandidates", () => {
  it("ローカル側に伝えるものがある分類を送信候補にする", () => {
    const plan = planPushCandidates(
      syncPlan({
        localOnly: repoRelPaths(["a.txt"]),
        conflicts: repoRelPaths(["b.txt"]),
        deletedLocally: repoRelPaths(["c.txt"]),
        deletedWithLocalEdits: repoRelPaths(["d.txt"]),
      }),
    );

    expect([...plan.pushablePaths].toSorted()).toEqual(["a.txt", "b.txt", "c.txt", "d.txt"]);
  });

  it("テンプレートだけが変えたファイルは送らず、スキップとして数える", () => {
    const plan = planPushCandidates(syncPlan({ autoUpdate: repoRelPaths(["a.txt"]) }));

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
    );

    expect([...plan.restoresTemplateDeletion]).toEqual(["d.txt"]);
  });

  it("ziku.jsonc がローカル側の変更を持つなら union を送る候補にする", () => {
    const plan = planPushCandidates(syncPlan({}, { _tag: "Tracked", category: "localOnly" }));

    expect(plan.sendsConfigUnion).toBe(true);
    expect(plan.pushablePaths.has(CONFIG_PATH)).toBe(true);
    expect(plan.restoresTemplateDeletion.has(CONFIG_PATH)).toBe(false);
  });

  it("テンプレートが削除した ziku.jsonc を送る場合は削除の取り消しとして印を付ける", () => {
    const plan = planPushCandidates(
      syncPlan({}, { _tag: "Tracked", category: "deletedWithLocalEdits" }),
    );

    expect(plan.sendsConfigUnion).toBe(true);
    expect(plan.restoresTemplateDeletion.has(CONFIG_PATH)).toBe(true);
  });

  it("ziku.jsonc がテンプレート側だけ変わっているならスキップとして数える", () => {
    const plan = planPushCandidates(syncPlan({}, { _tag: "Tracked", category: "autoUpdate" }));

    expect(plan.sendsConfigUnion).toBe(false);
    expect(plan.pushablePaths.has(CONFIG_PATH)).toBe(false);
    expect(plan.skippedTemplateOnly).toEqual([CONFIG_PATH]);
  });

  it("ziku.jsonc が追跡対象外なら触らない", () => {
    const plan = planPushCandidates(syncPlan({ localOnly: repoRelPaths(["a.txt"]) }));

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
  const conflictedPaths = new Set<string>(["conflict.txt"]);

  it("未解決の衝突と削除を既定で外す", () => {
    const selected = defaultPushSelection(candidates, { includeDeletions: false, conflictedPaths });

    expect(paths(selected)).toEqual(["a.txt"]);
  });

  it("--include-deletions を指定すると削除も含める", () => {
    const selected = defaultPushSelection(candidates, { includeDeletions: true, conflictedPaths });

    expect(paths(selected)).toEqual(["a.txt", "gone.txt"]);
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
      conflictedPaths: new Set<string>(),
    });

    expect(paths(selected)).toEqual(["a.txt", "b.txt"]);
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
      new Set(["conflict.txt", "other.txt"]),
    );

    expect(paths(blocking)).toEqual(["conflict.txt"]);
  });

  it("衝突が選ばれていなければ空を返す", () => {
    expect(selectedUnresolvedConflicts([added("a.txt")], new Set(["conflict.txt"]))).toEqual([]);
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
});

describe("planConfigPropagation", () => {
  it("伝えるパターンが無ければ ziku.jsonc を組み直さない", () => {
    const plan = planConfigPropagation({
      selectedPaths: repoRelPaths(["a.txt"]),
      newlyTrackedPaths: [],
      localOnlyPatterns: [],
    });

    expect(plan).toEqual({ _tag: "NoConfigChange" });
    expect(configWriteBackSafe(plan)).toBe(true);
  });

  it("ziku.jsonc が選択済みなら、新規追跡分を足したローカル全体の和集合を送る", () => {
    const plan = planConfigPropagation({
      selectedPaths: [CONFIG_PATH, repoRelPath("a.txt")],
      newlyTrackedPaths: repoRelPaths(["a.txt"]),
      localOnlyPatterns: [],
    });

    expect(plan).toEqual({ _tag: "MergeLocalConfig", extraIncludes: globPatterns(["a.txt"]) });
    expect(configWriteBackSafe(plan)).toBe(true);
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

    expect(configWriteBackSafe(plan)).toBe(false);
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
      new Set(["a.txt", "other.txt"]),
    );

    expect(persisted).toEqual(globPatterns(["a.txt"]));
  });

  it("送ったファイルが無ければ何も永続化しない", () => {
    expect(patternsToPersist(repoRelPaths(["a.txt"]), new Set())).toEqual([]);
  });
});

describe("resolvePrBaseBranch", () => {
  it("ref を持たないソースは既定ブランチへ向ける", () => {
    expect(resolvePrBaseBranch(source())).toEqual({ _tag: "Branch", name: "main" });
  });

  it("ブランチ指定はそのブランチへ向ける", () => {
    expect(resolvePrBaseBranch(source({ kind: "branch", name: "develop" }))).toEqual({
      _tag: "Branch",
      name: "develop",
    });
  });

  it("タグ・コミット固定は PR の宛先にできない", () => {
    expect(resolvePrBaseBranch(source({ kind: "tag", name: "v1.0.0" }))).toEqual({
      _tag: "UnsupportedRef",
      kind: "tag",
    });
    expect(resolvePrBaseBranch(source({ kind: "commit", sha: commitSha("a".repeat(40)) }))).toEqual(
      { _tag: "UnsupportedRef", kind: "commit" },
    );
  });
});

describe("buildPushSummaryRows", () => {
  const noRestores = new Set<string>();

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
      restoresTemplateDeletion: new Set(["restored.txt"]),
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
