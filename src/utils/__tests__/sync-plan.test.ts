/**
 * 種別ごとの扱いが 1 箇所に集約されていることを、その 1 箇所に対して検証する。
 *
 * 「常に追跡する / 加法 union でマージする / 削除は伝播しない」という `ziku.jsonc` の規則が
 * コマンドへ散らばっていないことは、コマンドを経由せずここだけで仕様を固定できる形で表れる。
 */
import { describe, expect, it } from "vitest";
import { repoRelPath, repoRelPaths } from "../../__tests__/brands";
import type { RepoRelPath } from "../../modules/schemas";
import type { FileCategory, FileClassification } from "../merge/types";
import type { ZikuConfigState } from "../merge/sync-plan";
import {
  partitionSyncPlan,
  withZikuConfigAt,
  zikuConfigActions,
  zikuConfigPullAction,
  zikuConfigPushAction,
  zikuConfigPushOutcome,
  zikuConfigStatusCategory,
} from "../merge/sync-plan";
import type { ConfigDrift } from "../config-merge";
import { directionOfCategory, isEntryCategory } from "../status";
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

/** 分類に現れうる ziku.jsonc の位置づけの全パターン。 */
const ALL_STATES: readonly ZikuConfigState[] = [
  { _tag: "Untracked" },
  ...ALL_CATEGORIES.map((category): ZikuConfigState => ({ _tag: "Tracked", category })),
];

/** union 観点の実差分の全パターン。 */
const ALL_DRIFTS: readonly ConfigDrift[] = [
  { pullRelevant: false, pushRelevant: false },
  { pullRelevant: true, pushRelevant: false },
  { pullRelevant: false, pushRelevant: true },
  { pullRelevant: true, pushRelevant: true },
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
  classification[category].push(ZIKU_CONFIG_FILE, repoRelPath("a.txt"));
  return classification;
}

/** 分類結果の全カテゴリを平坦化する。 */
function allPaths(classification: FileClassification): RepoRelPath[] {
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
    const plan = partitionSyncPlan({
      ...emptyClassification(),
      localOnly: repoRelPaths(["a.txt"]),
    });

    expect(plan.config).toEqual({ _tag: "Untracked" });
    expect(plan.files.localOnly).toEqual(["a.txt"]);
  });

  it("通常ファイルの並びは変えない", () => {
    const plan = partitionSyncPlan({
      ...emptyClassification(),
      conflicts: [repoRelPath("b.txt"), ZIKU_CONFIG_FILE, repoRelPath("a.txt")],
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
  it.each(["localOnly", "conflicts"] as const)(
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

  it("ローカルで設定ファイルが消えていても、削除もパターンもテンプレートへ送らない", () => {
    // union はテンプレートの内容と一致する（ローカルに足せるパターンが無い）。テンプレートの
    // 設定ファイルが消えると、そのテンプレートを使う全プロジェクトが同期できなくなる。
    expect(zikuConfigPushAction({ _tag: "Tracked", category: "deletedLocally" })).toEqual({
      _tag: "Skip",
    });
  });

  it("分類に現れなければ何もしない", () => {
    expect(zikuConfigPushAction({ _tag: "Untracked" })).toEqual({ _tag: "Skip" });
  });
});

describe("zikuConfigPushOutcome", () => {
  it("テンプレート側の追加を pull が取り込めるときは pull を案内する", () => {
    expect(
      zikuConfigPushOutcome(
        { _tag: "Tracked", category: "autoUpdate" },
        { pullRelevant: true, pushRelevant: false },
      ),
    ).toEqual({ _tag: "PullToSync" });
  });

  it("テンプレートがパターンを削除しローカルが未変更なら pull を案内しない", () => {
    // union はローカルの内容と一致するので pull は何も書き換えない。案内すると、実行しても
    // 何も起きない操作を勧めることになる。
    expect(
      zikuConfigPushOutcome(
        { _tag: "Tracked", category: "autoUpdate" },
        { pullRelevant: false, pushRelevant: true },
      ),
    ).toEqual({ _tag: "Skip" });
  });

  it.each(ALL_DRIFTS)("送る判断は drift で変わらない（%o）", (drift) => {
    expect(zikuConfigPushOutcome({ _tag: "Tracked", category: "localOnly" }, drift)).toEqual({
      _tag: "SendUnion",
      restoresTemplateDeletion: false,
    });
    expect(
      zikuConfigPushOutcome({ _tag: "Tracked", category: "deletedWithLocalEdits" }, drift),
    ).toEqual({ _tag: "SendUnion", restoresTemplateDeletion: true });
    expect(zikuConfigPushOutcome({ _tag: "Untracked" }, drift)).toEqual({ _tag: "Skip" });
  });
});

describe("zikuConfigStatusCategory", () => {
  it("双方に取り込む余地があれば conflict として見せる", () => {
    expect(
      zikuConfigStatusCategory(
        { _tag: "Tracked", category: "conflicts" },
        { pullRelevant: true, pushRelevant: true },
      ),
    ).toBe("conflicts");
  });

  it("pull だけが内容を書き換えるなら pull 方向", () => {
    expect(
      zikuConfigStatusCategory(
        { _tag: "Tracked", category: "autoUpdate" },
        { pullRelevant: true, pushRelevant: false },
      ),
    ).toBe("autoUpdate");
  });

  it("push だけが内容を書き換えるなら push 方向", () => {
    expect(
      zikuConfigStatusCategory(
        { _tag: "Tracked", category: "localOnly" },
        { pullRelevant: false, pushRelevant: true },
      ),
    ).toBe("localOnly");
  });

  it("テンプレートがパターンを削除しローカルが未変更なら同期済みとして扱う", () => {
    // union はローカルの内容と一致するので pull は書き込まず、テンプレートが消した
    // パターンを push が復活させることもない。どちらのコマンドも何もしない終端状態。
    expect(
      zikuConfigStatusCategory(
        { _tag: "Tracked", category: "autoUpdate" },
        { pullRelevant: false, pushRelevant: true },
      ),
    ).toBe("unchanged");
  });

  it("ローカルがパターンを削除しテンプレートが未変更なら同期済みとして扱う", () => {
    expect(
      zikuConfigStatusCategory(
        { _tag: "Tracked", category: "localOnly" },
        { pullRelevant: true, pushRelevant: false },
      ),
    ).toBe("unchanged");
  });

  it("分類に現れなければ同期済みとして扱う", () => {
    expect(
      zikuConfigStatusCategory({ _tag: "Untracked" }, { pullRelevant: true, pushRelevant: true }),
    ).toBe("unchanged");
  });
});

describe("status が見せる方向と、pull / push が実際に行う操作", () => {
  // 個別のケースを並べても、どれか 1 つの組み合わせで食い違ったことに気付けない。
  // 位置づけ × drift の全組み合わせで「見せた方向 == 実際に内容が変わる方向」を突き合わせる。
  const combinations = ALL_STATES.flatMap((state) => ALL_DRIFTS.map((drift) => ({ state, drift })));

  it.each(combinations)("%o は勧めた操作だけが実際に動く", ({ state, drift }) => {
    const category = zikuConfigStatusCategory(state, drift);
    const { pull, push } = zikuConfigActions(state);

    // 加法 union は片側にしか無いパターンを足すだけなので、足すものがある（drift）ときだけ
    // 内容が変わる。アクションが Skip / TemplateOnly ならそもそも読み書きしない。
    const changes = {
      pull: pull._tag === "UnionMerge" && drift.pullRelevant,
      push: push._tag === "SendUnion" && drift.pushRelevant,
    };

    const direction = isEntryCategory(category) ? directionOfCategory(category) : undefined;
    const shown = {
      pull: direction === "pull" || direction === "conflict",
      push: direction === "push" || direction === "conflict",
    };

    expect(shown).toEqual(changes);
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
    const files = { ...emptyClassification(), localOnly: repoRelPaths(["a.txt"]) };
    withZikuConfigAt(files, "localOnly");

    expect(files.localOnly).toEqual(["a.txt"]);
  });
});
