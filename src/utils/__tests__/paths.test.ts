/**
 * パターンとパスの照合を、実ファイルの走査つきで検証する。
 *
 * tinyglobby はネイティブ FS を直接参照するため memfs では動かない。glob の解決結果に
 * 依存する挙動はモックで代用できないので、実際の一時ディレクトリを使う。
 */
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "pathe";
import { afterEach, describe, expect, it } from "vitest";
import type { AbsPath } from "../../modules/schemas";
import { absPath, globPatterns, repoRelPaths } from "../../__tests__/brands";
import { joinAbs, selectPatternsMatchingPaths } from "../paths";

const tempDirs: AbsPath[] = [];

afterEach(async () => {
  for (const dir of tempDirs) await rm(dir, { recursive: true, force: true });
  tempDirs.length = 0;
});

async function projectWith(files: readonly string[]): Promise<AbsPath> {
  const dir = absPath(await mkdtemp(join(tmpdir(), "ziku-test-paths-")));
  tempDirs.push(dir);
  for (const file of files) {
    const path = joinAbs(dir, file);
    await mkdir(dirname(path), { recursive: true });
    await writeFile(path, "x", "utf-8");
  }
  return dir;
}

describe("selectPatternsMatchingPaths", () => {
  it("glob パターンは、そのパターンに一致するファイルが push 対象なら選ばれる", async () => {
    const dir = await projectWith([".claude/rules/a.md", ".claude/rules/b.md"]);

    const matched = selectPatternsMatchingPaths({
      baseDir: dir,
      patterns: globPatterns([".claude/rules/*.md"]),
      paths: repoRelPaths([".claude/rules/a.md"]),
    });

    expect(matched).toEqual([".claude/rules/*.md"]);
  });

  it("glob パターンに一致しないファイルだけの push では選ばれない", async () => {
    const dir = await projectWith([".claude/rules/a.md", "docs/guide.md"]);

    const matched = selectPatternsMatchingPaths({
      baseDir: dir,
      patterns: globPatterns([".claude/rules/*.md"]),
      paths: repoRelPaths(["docs/guide.md"]),
    });

    expect(matched).toEqual([]);
  });

  it("リテラルパスのパターンは走査を挟まず一致する（ディスクに無くても判定できる）", async () => {
    const dir = await projectWith([]);

    const matched = selectPatternsMatchingPaths({
      baseDir: dir,
      patterns: globPatterns(["docs/removed.md"]),
      paths: repoRelPaths(["docs/removed.md"]),
    });

    expect(matched).toEqual(["docs/removed.md"]);
  });

  it("glob とリテラルパスが混在していても、それぞれの規則で判定する", async () => {
    const dir = await projectWith([".claude/rules/a.md", ".mcp.json", "docs/guide.md"]);

    const matched = selectPatternsMatchingPaths({
      baseDir: dir,
      patterns: globPatterns([".claude/rules/*.md", ".mcp.json", "docs/**"]),
      paths: repoRelPaths([".claude/rules/a.md", ".mcp.json"]),
    });

    expect(matched).toEqual([".claude/rules/*.md", ".mcp.json"]);
  });

  it("`**` を含むパターンは配下のファイルにも一致する", async () => {
    const dir = await projectWith([".claude/skills/x/SKILL.md"]);

    const matched = selectPatternsMatchingPaths({
      baseDir: dir,
      patterns: globPatterns([".claude/**"]),
      paths: repoRelPaths([".claude/skills/x/SKILL.md"]),
    });

    expect(matched).toEqual([".claude/**"]);
  });

  it("パターンまたはパスが空なら何も選ばない", async () => {
    const dir = await projectWith([".claude/rules/a.md"]);

    expect(
      selectPatternsMatchingPaths({ baseDir: dir, patterns: [], paths: repoRelPaths(["a.md"]) }),
    ).toEqual([]);
    expect(
      selectPatternsMatchingPaths({
        baseDir: dir,
        patterns: globPatterns([".claude/**"]),
        paths: [],
      }),
    ).toEqual([]);
  });
});
