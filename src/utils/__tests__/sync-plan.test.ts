/**
 * 種別ごとの扱いが 1 箇所に集約されていることを、その 1 箇所に対して検証する。
 *
 * 「常に追跡する / 加法 union でマージする / 削除は伝播しない」という `ziku.jsonc` の規則が
 * コマンドへ散らばっていないことは、コマンドを経由せずここだけで仕様を固定できる形で表れる。
 */
import { describe, expect, it } from "vitest";
import type { FileCategory, FileClassification } from "../merge/types";
import {
  partitionSyncPlan,
  withZikuConfigAt,
  zikuConfigPullAction,
  zikuConfigPushAction,
  zikuConfigStatusCategory,
} from "../merge/sync-plan";
import { ZIKU_CONFIG_FILE } from "../ziku-config";

const ALL_CATEGORIES: readonly FileCategory[] = [
  "autoUpdate",
  "localOnly",
  "conflicts",
  "newFiles",
  "deletedFiles",
  "deletedWithLocalEdits",
  "deletedLocally",
  "unchanged",
];

function emptyClassification(): FileClassification {
  return {
    autoUpdate: [],
    localOnly: [],
    conflicts: [],
    newFiles: [],
    deletedFiles: [],
    deletedWithLocalEdits: [],
    deletedLocally: [],
    unchanged: [],
  };
}

/** 指定カテゴリに ziku.jsonc と通常ファイルが 1 つずつ入った分類結果。 */
function classificationWith(category: FileCategory): FileClassification {
  const classification = emptyClassification();
  classification[category].push(ZIKU_CONFIG_FILE, "a.txt");
  return classification;
}

/** 分類結果の全カテゴリを平坦化する。 */
function allPaths(classification: FileClassification): string[] {
  return ALL_CATEGORIES.flatMap((category) => classification[category]);
}

describe("partitionSyncPlan", () => {
  it.each(ALL_CATEGORIES)(
    "%s に入った ziku.jsonc は files から外れて config へ移る",
    (category) => {
      const plan = partitionSyncPlan(classificationWith(category));

      expect(allPaths(plan.files)).toEqual(["a.txt"]);
      expect(plan.config).toEqual({ _tag: "Tracked", category });
    },
  );

  it("ziku.jsonc が分類に現れなければ Untracked", () => {
    const plan = partitionSyncPlan({ ...emptyClassification(), localOnly: ["a.txt"] });

    expect(plan.config).toEqual({ _tag: "Untracked" });
    expect(plan.files.localOnly).toEqual(["a.txt"]);
  });

  it("通常ファイルの並びは変えない", () => {
    const plan = partitionSyncPlan({
      ...emptyClassification(),
      conflicts: ["b.txt", ZIKU_CONFIG_FILE, "a.txt"],
    });

    expect(plan.files.conflicts).toEqual(["b.txt", "a.txt"]);
  });
});

describe("zikuConfigPullAction", () => {
  it("テンプレ側に取り込む余地があるときだけ union マージする", () => {
    expect(zikuConfigPullAction({ _tag: "Tracked", category: "autoUpdate" })).toEqual({
      _tag: "UnionMerge",
    });
    expect(zikuConfigPullAction({ _tag: "Tracked", category: "conflicts" })).toEqual({
      _tag: "UnionMerge",
    });
  });

  it.each(["deletedFiles", "deletedWithLocalEdits"] as const)(
    "テンプレ側の削除（%s）は伝播しない",
    (category) => {
      // ローカルの制御ファイルを消すと、以降のコマンドがプロジェクトを未初期化として扱う。
      expect(zikuConfigPullAction({ _tag: "Tracked", category })).toEqual({ _tag: "Skip" });
    },
  );

  it.each(["localOnly", "newFiles", "deletedLocally", "unchanged"] as const)(
    "取り込むものが無い %s では何もしない",
    (category) => {
      expect(zikuConfigPullAction({ _tag: "Tracked", category })).toEqual({ _tag: "Skip" });
    },
  );

  it("分類に現れなければ何もしない", () => {
    expect(zikuConfigPullAction({ _tag: "Untracked" })).toEqual({ _tag: "Skip" });
  });
});

describe("zikuConfigPushAction", () => {
  it.each(["localOnly", "conflicts", "deletedLocally"] as const)(
    "ローカル側に伝えるものがある %s では union を送る",
    (category) => {
      expect(zikuConfigPushAction({ _tag: "Tracked", category })).toEqual({
        _tag: "SendUnion",
        restoresTemplateDeletion: false,
      });
    },
  );

  it("テンプレが削除した設定ファイルを送るときは削除の取り消しとして印を付ける", () => {
    expect(zikuConfigPushAction({ _tag: "Tracked", category: "deletedWithLocalEdits" })).toEqual({
      _tag: "SendUnion",
      restoresTemplateDeletion: true,
    });
  });

  it("テンプレ側だけが変わっているときは push 対象にせず pull を促す", () => {
    expect(zikuConfigPushAction({ _tag: "Tracked", category: "autoUpdate" })).toEqual({
      _tag: "TemplateOnly",
    });
  });

  it.each(["newFiles", "unchanged", "deletedFiles"] as const)(
    "送るものが無い %s では何もしない",
    (category) => {
      expect(zikuConfigPushAction({ _tag: "Tracked", category })).toEqual({ _tag: "Skip" });
    },
  );

  it("分類に現れなければ何もしない", () => {
    expect(zikuConfigPushAction({ _tag: "Untracked" })).toEqual({ _tag: "Skip" });
  });
});

describe("zikuConfigStatusCategory", () => {
  it("union 観点で両方向に差分があれば conflict として見せる", () => {
    expect(zikuConfigStatusCategory({ pullRelevant: true, pushRelevant: true })).toBe("conflicts");
  });

  it("取り込む側にだけ差分があれば pull 方向", () => {
    expect(zikuConfigStatusCategory({ pullRelevant: true, pushRelevant: false })).toBe(
      "autoUpdate",
    );
  });

  it("伝播する側にだけ差分があれば push 方向", () => {
    expect(zikuConfigStatusCategory({ pullRelevant: false, pushRelevant: true })).toBe("localOnly");
  });

  it("片側だけのパターン削除はアクションにならない（union == その側）", () => {
    expect(zikuConfigStatusCategory({ pullRelevant: false, pushRelevant: false })).toBe(
      "unchanged",
    );
  });
});

describe("withZikuConfigAt", () => {
  it("仕分けで外した設定ファイルを指定カテゴリへ戻す", () => {
    const plan = partitionSyncPlan(classificationWith("deletedFiles"));
    const restored = withZikuConfigAt(plan.files, "localOnly");

    expect(restored.localOnly).toEqual([ZIKU_CONFIG_FILE]);
    expect(restored.deletedFiles).toEqual(["a.txt"]);
  });

  it("元の分類結果を破壊しない", () => {
    const files = { ...emptyClassification(), localOnly: ["a.txt"] };
    withZikuConfigAt(files, "localOnly");

    expect(files.localOnly).toEqual(["a.txt"]);
  });
});
