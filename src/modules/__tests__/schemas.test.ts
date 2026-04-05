import { describe, expect, it } from "vitest";
import {
  diffResultSchema,
  diffTypeSchema,
  fileActionSchema,
  fileDiffSchema,
  fileOperationResultSchema,
  filePathSchema,
  lockSchema,
  nonNegativeIntSchema,
  overwriteStrategySchema,
  prResultSchema,
  zikuConfigSchema,
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

describe("zikuConfigSchema", () => {
  it("有効な設定を受け入れる（include のみ）", () => {
    const config = {
      include: [".mcp.json", ".devcontainer/**"],
    };
    expect(zikuConfigSchema.parse(config)).toEqual(config);
  });

  it("$schema フィールドを受け入れる", () => {
    const config = {
      $schema: "https://example.com/schema.json",
      include: [".mcp.json"],
    };
    expect(zikuConfigSchema.parse(config)).toEqual(config);
  });

  it("exclude フィールドを受け入れる", () => {
    const config = {
      include: [".mcp.json"],
      exclude: ["*.local"],
    };
    expect(zikuConfigSchema.parse(config)).toEqual(config);
  });

  it("include が欠けている場合は拒否する", () => {
    expect(() => zikuConfigSchema.parse({ exclude: [] })).toThrow();
  });

  it("空の include 配列を受け入れる", () => {
    const config = { include: [] };
    expect(zikuConfigSchema.parse(config)).toEqual(config);
  });
});

describe("lockSchema", () => {
  it("有効な lock を受け入れる（source 付き）", () => {
    const lock = {
      version: "0.1.0",
      installedAt: "2024-01-01T00:00:00+09:00",
      source: {
        owner: "tktcorporation",
        repo: ".github",
      },
    };
    expect(lockSchema.parse(lock)).toEqual(lock);
  });

  it("ref を含む source を受け入れる", () => {
    const lock = {
      version: "0.1.0",
      installedAt: "2024-01-01T00:00:00+09:00",
      source: {
        owner: "tktcorporation",
        repo: ".github",
        ref: "main",
      },
    };
    expect(lockSchema.parse(lock)).toEqual(lock);
  });

  it("ローカルパス source を受け入れる", () => {
    const lock = {
      version: "0.1.0",
      installedAt: "2024-01-01T00:00:00+09:00",
      source: {
        path: "/path/to/template",
      },
    };
    expect(lockSchema.parse(lock)).toEqual(lock);
  });

  it("baseRef を受け入れる", () => {
    const lock = {
      version: "0.1.0",
      installedAt: "2024-01-01T00:00:00+09:00",
      source: {
        owner: "tktcorporation",
        repo: ".github",
      },
      baseRef: "abc123",
    };
    expect(lockSchema.parse(lock)).toEqual(lock);
  });

  it("baseHashes を受け入れる", () => {
    const lock = {
      version: "0.1.0",
      installedAt: "2024-01-01T00:00:00+09:00",
      source: {
        owner: "tktcorporation",
        repo: ".github",
      },
      baseHashes: { ".mcp.json": "abc123" },
    };
    expect(lockSchema.parse(lock)).toEqual(lock);
  });

  it("pendingMerge を受け入れる", () => {
    const lock = {
      version: "0.1.0",
      installedAt: "2024-01-01T00:00:00+09:00",
      source: {
        owner: "tktcorporation",
        repo: ".github",
      },
      pendingMerge: {
        conflicts: [".mcp.json"],
        templateHashes: { ".mcp.json": "abc123" },
        latestRef: "def456",
      },
    };
    expect(lockSchema.parse(lock)).toEqual(lock);
  });

  it("source が欠けている場合は拒否する", () => {
    expect(() =>
      lockSchema.parse({
        version: "0.1.0",
        installedAt: "2024-01-01T00:00:00+09:00",
      }),
    ).toThrow();
  });

  it("不正な datetime 形式を拒否する", () => {
    expect(() =>
      lockSchema.parse({
        version: "0.1.0",
        installedAt: "invalid-date",
        source: { owner: "test", repo: "test" },
      }),
    ).toThrow();
  });

  it("ISO 8601 形式の datetime を受け入れる", () => {
    const lock = {
      version: "0.1.0",
      installedAt: "2024-06-15T10:30:00Z",
      source: { owner: "test", repo: "test" },
    };
    expect(lockSchema.parse(lock)).toEqual(lock);
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
      branch: "ziku-sync-1234567890",
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
