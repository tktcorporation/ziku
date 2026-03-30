import { describe, expect, it } from "vitest";
import {
  answersSchema,
  configSchema,
  diffResultSchema,
  diffTypeSchema,
  fileActionSchema,
  fileDiffSchema,
  fileOperationResultSchema,
  filePathSchema,
  moduleSchema,
  nonNegativeIntSchema,
  overwriteStrategySchema,
  prResultSchema,
} from "../schemas";

describe("nonNegativeIntSchema", () => {
  it("0 を受け入れる", () => {
    expect(nonNegativeIntSchema.parse(0)).toBe(0);
  });

  it("正の整数を受け入れる", () => {
    expect(nonNegativeIntSchema.parse(42)).toBe(42);
  });

  it("負の数を拒否する", () => {
    expect(() => nonNegativeIntSchema.parse(-1)).toThrow();
  });

  it("小数を拒否する", () => {
    expect(() => nonNegativeIntSchema.parse(1.5)).toThrow();
  });
});

describe("filePathSchema", () => {
  it("有効なファイルパスを受け入れる", () => {
    expect(filePathSchema.parse("file.txt")).toBe("file.txt");
    expect(filePathSchema.parse("/path/to/file.txt")).toBe("/path/to/file.txt");
  });

  it("空文字列を拒否する", () => {
    expect(() => filePathSchema.parse("")).toThrow();
  });
});

describe("overwriteStrategySchema", () => {
  it("overwrite を受け入れる", () => {
    expect(overwriteStrategySchema.parse("overwrite")).toBe("overwrite");
  });

  it("skip を受け入れる", () => {
    expect(overwriteStrategySchema.parse("skip")).toBe("skip");
  });

  it("prompt を受け入れる", () => {
    expect(overwriteStrategySchema.parse("prompt")).toBe("prompt");
  });

  it("無効な値を拒否する", () => {
    expect(() => overwriteStrategySchema.parse("invalid")).toThrow();
  });
});

describe("fileActionSchema", () => {
  it("全てのアクションタイプを受け入れる", () => {
    expect(fileActionSchema.parse("copied")).toBe("copied");
    expect(fileActionSchema.parse("created")).toBe("created");
    expect(fileActionSchema.parse("overwritten")).toBe("overwritten");
    expect(fileActionSchema.parse("skipped")).toBe("skipped");
  });

  it("無効な値を拒否する", () => {
    expect(() => fileActionSchema.parse("deleted")).toThrow();
  });
});

describe("fileOperationResultSchema", () => {
  it("有効な操作結果を受け入れる", () => {
    const result = { action: "copied", path: "file.txt" };
    expect(fileOperationResultSchema.parse(result)).toEqual(result);
  });

  it("action が欠けている場合は拒否する", () => {
    expect(() => fileOperationResultSchema.parse({ path: "file.txt" })).toThrow();
  });

  it("path が欠けている場合は拒否する", () => {
    expect(() => fileOperationResultSchema.parse({ action: "copied" })).toThrow();
  });
});

describe("moduleSchema", () => {
  it("有効なモジュールを受け入れる", () => {
    const module = {
      id: ".devcontainer",
      name: "DevContainer",
      description: "VS Code DevContainer 設定",
      patterns: [".devcontainer/**"],
    };
    expect(moduleSchema.parse(module)).toEqual(module);
  });

  it("setupDescription を含むモジュールを受け入れる", () => {
    const module = {
      id: ".devcontainer",
      name: "DevContainer",
      description: "VS Code DevContainer 設定",
      setupDescription: "VS Code で開くとセットアップされます",
      patterns: [".devcontainer/**"],
    };
    expect(moduleSchema.parse(module)).toEqual(module);
  });

  it("必須フィールドが欠けている場合は拒否する", () => {
    expect(() =>
      moduleSchema.parse({
        id: ".devcontainer",
        name: "DevContainer",
        // description が欠けている
        patterns: [],
      }),
    ).toThrow();
  });

  it("空のパターン配列を受け入れる", () => {
    const module = {
      id: "test",
      name: "Test",
      description: "Test module",
      patterns: [],
    };
    expect(moduleSchema.parse(module)).toEqual(module);
  });
});

describe("configSchema", () => {
  it("有効な設定を受け入れる", () => {
    const config = {
      version: "1.0.0",
      installedAt: "2024-01-01T00:00:00+09:00",
      modules: [".devcontainer", ".github"],
      source: {
        owner: "tktcorporation",
        repo: ".github",
      },
    };
    expect(configSchema.parse(config)).toEqual(config);
  });

  it("ref を含む source を受け入れる", () => {
    const config = {
      version: "1.0.0",
      installedAt: "2024-01-01T00:00:00+09:00",
      modules: [],
      source: {
        owner: "tktcorporation",
        repo: ".github",
        ref: "main",
      },
    };
    expect(configSchema.parse(config)).toEqual(config);
  });

  it("excludePatterns を受け入れる", () => {
    const config = {
      version: "1.0.0",
      installedAt: "2024-01-01T00:00:00+09:00",
      modules: [],
      source: {
        owner: "tktcorporation",
        repo: ".github",
      },
      excludePatterns: ["*.local", ".env"],
    };
    expect(configSchema.parse(config)).toEqual(config);
  });

  it("不正な datetime 形式を拒否する", () => {
    expect(() =>
      configSchema.parse({
        version: "1.0.0",
        installedAt: "invalid-date",
        modules: [],
        source: { owner: "test", repo: "test" },
      }),
    ).toThrow();
  });

  it("ISO 8601 形式の datetime を受け入れる", () => {
    const config = {
      version: "1.0.0",
      installedAt: "2024-06-15T10:30:00Z",
      modules: [],
      source: { owner: "test", repo: "test" },
    };
    expect(configSchema.parse(config)).toEqual(config);
  });
});

describe("answersSchema", () => {
  it("有効な回答を受け入れる", () => {
    const answers = {
      modules: [".devcontainer"],
      overwriteStrategy: "overwrite",
    };
    expect(answersSchema.parse(answers)).toEqual(answers);
  });

  it("空のモジュール配列を拒否する", () => {
    expect(() =>
      answersSchema.parse({
        modules: [],
        overwriteStrategy: "skip",
      }),
    ).toThrow();
  });

  it("複数のモジュールを受け入れる", () => {
    const answers = {
      modules: [".devcontainer", ".github", ".claude"],
      overwriteStrategy: "prompt",
    };
    expect(answersSchema.parse(answers)).toEqual(answers);
  });
});

describe("diffTypeSchema", () => {
  it("全ての差分タイプを受け入れる", () => {
    expect(diffTypeSchema.parse("added")).toBe("added");
    expect(diffTypeSchema.parse("modified")).toBe("modified");
    expect(diffTypeSchema.parse("deleted")).toBe("deleted");
    expect(diffTypeSchema.parse("unchanged")).toBe("unchanged");
  });

  it("無効な値を拒否する", () => {
    expect(() => diffTypeSchema.parse("changed")).toThrow();
  });
});

describe("fileDiffSchema", () => {
  it("有効なファイル差分を受け入れる", () => {
    const diff = {
      path: "file.txt",
      type: "modified",
      localContent: "local",
      templateContent: "template",
    };
    expect(fileDiffSchema.parse(diff)).toEqual(diff);
  });

  it("コンテンツなしの差分を受け入れる（deleted の場合）", () => {
    const diff = {
      path: "file.txt",
      type: "deleted",
      templateContent: "template",
    };
    expect(fileDiffSchema.parse(diff)).toEqual(diff);
  });

  it("コンテンツなしの差分を受け入れる（added の場合）", () => {
    const diff = {
      path: "file.txt",
      type: "added",
      localContent: "local",
    };
    expect(fileDiffSchema.parse(diff)).toEqual(diff);
  });
});

describe("diffResultSchema", () => {
  it("有効な差分結果を受け入れる", () => {
    const result = {
      files: [{ path: "file.txt", type: "modified" }],
      summary: {
        added: 1,
        modified: 2,
        deleted: 0,
        unchanged: 5,
      },
    };
    expect(diffResultSchema.parse(result)).toEqual(result);
  });

  it("空のファイル配列を受け入れる", () => {
    const result = {
      files: [],
      summary: {
        added: 0,
        modified: 0,
        deleted: 0,
        unchanged: 0,
      },
    };
    expect(diffResultSchema.parse(result)).toEqual(result);
  });
});

describe("prResultSchema", () => {
  it("有効な PR 結果を受け入れる", () => {
    const result = {
      url: "https://github.com/owner/repo/pull/123",
      number: 123,
      branch: "devenv-sync-1234567890",
    };
    expect(prResultSchema.parse(result)).toEqual(result);
  });

  it("必須フィールドが欠けている場合は拒否する", () => {
    expect(() =>
      prResultSchema.parse({
        url: "https://github.com/owner/repo/pull/123",
        // number が欠けている
        branch: "main",
      }),
    ).toThrow();
  });
});
