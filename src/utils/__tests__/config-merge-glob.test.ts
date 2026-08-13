/**
 * `ziku track` に glob を渡した利用者のパターンが、push でテンプレートへ伝播することを検証する。
 *
 * push は `--files` でファイル本体だけを指定されたとき、そのファイルに関係する
 * ローカル限定パターンを `findLocalOnlyPatternsForPaths` で拾い、`ziku.jsonc` を
 * 同じ push に同梱する（`src/commands/push.ts` の `applyNewlyTrackedConfigToPush`）。
 * ここが glob を拾えないと、テンプレートにはファイル本体だけが届き、他プロジェクトの
 * `init` / `pull` はパターンを知らないままそのファイルを取りこぼす。
 *
 * glob の解決には実ファイルの走査が要る（tinyglobby は memfs を見ない）ため、
 * 一時ディレクトリを使う。
 */
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "pathe";
import { afterEach, describe, expect, it } from "vitest";
import type { AbsPath, GlobPattern } from "../../modules/schemas";
import { absPath, globPatterns, repoRelPaths } from "../../__tests__/brands";
import { computeScopedZikuConfig, findLocalOnlyPatternsForPaths } from "../config-merge";
import { joinAbs } from "../paths";
import { ZIKU_CONFIG_FILE } from "../ziku-config";

const tempDirs: AbsPath[] = [];

afterEach(async () => {
  for (const dir of tempDirs) await rm(dir, { recursive: true, force: true });
  tempDirs.length = 0;
});

async function makeDir(label: string): Promise<AbsPath> {
  const dir = absPath(await mkdtemp(join(tmpdir(), `ziku-test-glob-${label}-`)));
  tempDirs.push(dir);
  return dir;
}

async function write(dir: AbsPath, file: string, content: string): Promise<void> {
  const path = joinAbs(dir, file);
  await mkdir(dirname(path), { recursive: true });
  await writeFile(path, content, "utf-8");
}

async function writeConfig(dir: AbsPath, include: readonly GlobPattern[]): Promise<void> {
  await write(dir, ZIKU_CONFIG_FILE, JSON.stringify({ include }, null, 2));
}

/** `ziku track <pattern>` 済みのローカルと、そのパターンを知らないテンプレートを用意する。 */
async function setup(opts: {
  localInclude: readonly GlobPattern[];
  templateInclude: readonly GlobPattern[];
  localFiles: readonly string[];
}): Promise<{ targetDir: AbsPath; templateDir: AbsPath }> {
  const targetDir = await makeDir("local");
  const templateDir = await makeDir("template");
  await writeConfig(targetDir, opts.localInclude);
  await writeConfig(templateDir, opts.templateInclude);
  for (const file of opts.localFiles) await write(targetDir, file, "content");
  return { targetDir, templateDir };
}

describe("glob で追跡したパターンの push 伝播", () => {
  it("`ziku track '.claude/rules/*.md'` の後に本体だけを push しても、パターンが関連付く", async () => {
    const { targetDir, templateDir } = await setup({
      localInclude: globPatterns([".github/**", ".claude/rules/*.md"]),
      templateInclude: globPatterns([".github/**"]),
      localFiles: [".claude/rules/a.md"],
    });

    const relevant = await findLocalOnlyPatternsForPaths({
      targetDir,
      templateDir,
      paths: repoRelPaths([".claude/rules/a.md"]),
    });

    expect(relevant).toEqual([".claude/rules/*.md"]);
  });

  it("関連付いたパターンはテンプレートの ziku.jsonc へ加わる", async () => {
    const { targetDir, templateDir } = await setup({
      localInclude: globPatterns([".github/**", ".claude/rules/*.md"]),
      templateInclude: globPatterns([".github/**"]),
      localFiles: [".claude/rules/a.md"],
    });

    const relevant = await findLocalOnlyPatternsForPaths({
      targetDir,
      templateDir,
      paths: repoRelPaths([".claude/rules/a.md"]),
    });
    const merged = await computeScopedZikuConfig({
      templateDir,
      additionalIncludes: relevant,
    });

    expect(JSON.parse(merged).include).toEqual([".claude/rules/*.md", ".github/**"]);
  });

  it("push するファイルに一致しない glob は巻き込まない", async () => {
    const { targetDir, templateDir } = await setup({
      localInclude: globPatterns([".claude/rules/*.md", "docs/*.md"]),
      templateInclude: [],
      localFiles: [".claude/rules/a.md", "docs/guide.md"],
    });

    const relevant = await findLocalOnlyPatternsForPaths({
      targetDir,
      templateDir,
      paths: repoRelPaths([".claude/rules/a.md"]),
    });

    expect(relevant).toEqual([".claude/rules/*.md"]);
  });

  it("glob とリテラルパスが混在する include でも、両方を正しく扱う", async () => {
    const { targetDir, templateDir } = await setup({
      localInclude: globPatterns([".claude/rules/*.md", ".mcp.json", "docs/*.md"]),
      templateInclude: [],
      localFiles: [".claude/rules/a.md", ".mcp.json", "docs/guide.md"],
    });

    const relevant = await findLocalOnlyPatternsForPaths({
      targetDir,
      templateDir,
      paths: repoRelPaths([".claude/rules/a.md", ".mcp.json"]),
    });

    expect(relevant).toEqual([".claude/rules/*.md", ".mcp.json"]);
  });

  it("テンプレートが既に持つ glob は伝播対象にならない", async () => {
    const { targetDir, templateDir } = await setup({
      localInclude: globPatterns([".claude/rules/*.md"]),
      templateInclude: globPatterns([".claude/rules/*.md"]),
      localFiles: [".claude/rules/a.md"],
    });

    const relevant = await findLocalOnlyPatternsForPaths({
      targetDir,
      templateDir,
      paths: repoRelPaths([".claude/rules/a.md"]),
    });

    expect(relevant).toEqual([]);
  });
});
