/**
 * ziku.jsonc 同期メカニズムの統合テスト — 実ファイル I/O で検証。
 *
 * 背景: `ziku track` でローカル ziku.jsonc にパターンを追加して push しても、
 * 旧実装では ziku.jsonc 自体が同期対象に含まれず、テンプレートへパターンが
 * 伝播しなかった（新規ファイルが他プロジェクトの init/pull に降りてこない孤児化バグ）。
 * withConfigTracked で ziku.jsonc を追跡対象に含めることで、classify が ziku.jsonc を
 * push/pull の候補として検出できることを、モックなしの実 hashFiles + classifyFiles で示す。
 *
 * hashFiles は内部で tinyglobby を使うが、tinyglobby はネイティブ FS を参照するため
 * memfs では動かない。よってここでは実際の一時ディレクトリを使う。
 */
import { existsSync } from "node:fs";
import { mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "pathe";
import { afterEach, describe, expect, it } from "vitest";
import { absPath, globPatterns, repoRelPath } from "../../__tests__/brands";
import type { AbsPath } from "../../modules/schemas";
import { hashFiles } from "../hash";
import { classifyFiles } from "../merge";
import { detectDiff } from "../diff";
import { detectUntrackedFiles, getTotalUntrackedCount } from "../untracked";
import { ZIKU_CONFIG_FILE, withConfigTracked, withoutConfigTracked } from "../ziku-config";

async function createTempDir(label: string): Promise<AbsPath> {
  const dir = absPath(
    join(
      tmpdir(),
      `ziku-test-config-sync-${label}-${Date.now()}-${Math.random().toString(36).slice(2)}`,
    ),
  );
  await mkdir(dir, { recursive: true });
  return dir;
}

async function writeFiles(baseDir: AbsPath, files: Record<string, string>): Promise<void> {
  for (const [relativePath, content] of Object.entries(files)) {
    const fullPath = join(baseDir, relativePath);
    const dir = join(fullPath, "..");
    if (!existsSync(dir)) {
      await mkdir(dir, { recursive: true });
    }
    await writeFile(fullPath, content, "utf-8");
  }
}

describe("ziku.jsonc 同期メカニズム（実 hashFiles + classifyFiles）", () => {
  const tempDirs: AbsPath[] = [];

  afterEach(async () => {
    for (const dir of tempDirs) {
      await rm(dir, { recursive: true, force: true });
    }
    tempDirs.length = 0;
  });

  it("track でローカルに追加したパターンは ziku.jsonc を localOnly（push 候補）にする", async () => {
    const templateDir = await createTempDir("push-tpl");
    const projectDir = await createTempDir("push-prj");
    tempDirs.push(templateDir, projectDir);

    await writeFiles(templateDir, {
      ".ziku/ziku.jsonc": JSON.stringify({ include: [".claude/**"] }, null, 2),
      ".claude/rules.md": "rule",
    });
    // ローカルは track により .eslintrc.json を追加済み
    await writeFiles(projectDir, {
      ".ziku/ziku.jsonc": JSON.stringify({ include: [".claude/**", ".eslintrc.json"] }, null, 2),
      ".claude/rules.md": "rule",
      ".eslintrc.json": "{}",
    });

    // push は「ローカルの config.include」を withConfigTracked で展開して両側をハッシュする
    const effectiveInclude = withConfigTracked(globPatterns([".claude/**", ".eslintrc.json"]));
    const templateHashes = await hashFiles(templateDir, effectiveInclude);
    const localHashes = await hashFiles(projectDir, effectiveInclude);

    // base = 前回 sync 時点（テンプレと一致していた）。ziku.jsonc はテンプレ版のハッシュ。
    const baseHashes = {
      [repoRelPath(".claude/rules.md")]: templateHashes[repoRelPath(".claude/rules.md")],
      [ZIKU_CONFIG_FILE]: templateHashes[ZIKU_CONFIG_FILE],
    };

    const classification = classifyFiles({ baseHashes, localHashes, templateHashes });

    // ziku.jsonc は「ローカルだけが変更」= localOnly → push 候補になる（旧実装ではここに来なかった）
    expect(classification.localOnly).toContain(ZIKU_CONFIG_FILE);
    // 新規追跡ファイルもローカルのみに存在 → localOnly
    expect(classification.localOnly).toContain(".eslintrc.json");
  });

  it("テンプレ側でパターンが追加された場合は ziku.jsonc を autoUpdate（pull 候補）にする", async () => {
    const templateDir = await createTempDir("pull-tpl");
    const projectDir = await createTempDir("pull-prj");
    tempDirs.push(templateDir, projectDir);

    await writeFiles(templateDir, {
      ".ziku/ziku.jsonc": JSON.stringify({ include: [".claude/**", ".eslintrc.json"] }, null, 2),
      ".claude/rules.md": "rule",
      ".eslintrc.json": "{}",
    });
    // ローカルは旧パターンのまま
    await writeFiles(projectDir, {
      ".ziku/ziku.jsonc": JSON.stringify({ include: [".claude/**"] }, null, 2),
      ".claude/rules.md": "rule",
    });

    // pull は local+template のパターン和集合を discovery に使う
    const effectiveInclude = withConfigTracked(globPatterns([".claude/**", ".eslintrc.json"]));
    const templateHashes = await hashFiles(templateDir, effectiveInclude);
    const localHashes = await hashFiles(projectDir, effectiveInclude);

    // base = 前回 sync 時点（ローカル = テンプレ旧版）。ziku.jsonc はローカル版のハッシュ。
    const baseHashes = {
      [repoRelPath(".claude/rules.md")]: localHashes[repoRelPath(".claude/rules.md")],
      [ZIKU_CONFIG_FILE]: localHashes[ZIKU_CONFIG_FILE],
    };

    const classification = classifyFiles({ baseHashes, localHashes, templateHashes });

    // ziku.jsonc は「テンプレだけが変更」= autoUpdate → pull で取り込まれる
    expect(classification.autoUpdate).toContain(ZIKU_CONFIG_FILE);
  });

  it("detectDiff: `.ziku/` を gitignore していても ziku.jsonc は差分対象に含まれる", async () => {
    const templateDir = await createTempDir("gi-tpl");
    const projectDir = await createTempDir("gi-prj");
    tempDirs.push(templateDir, projectDir);

    // 双方が `.ziku/` を gitignore していても、ziku.jsonc は push 候補から落ちてはいけない
    await writeFiles(templateDir, {
      ".gitignore": ".ziku/\n",
      ".ziku/ziku.jsonc": JSON.stringify({ include: [".claude/**"] }, null, 2),
    });
    await writeFiles(projectDir, {
      ".gitignore": ".ziku/\n",
      ".ziku/ziku.jsonc": JSON.stringify({ include: [".claude/**", ".eslintrc.json"] }, null, 2),
    });

    const diff = await detectDiff({
      targetDir: projectDir,
      templateDir,
      patterns: { include: withConfigTracked(globPatterns([".claude/**"])), exclude: [] },
    });

    const configDiff = diff.files.find((f) => f.path === ZIKU_CONFIG_FILE);
    expect(configDiff).toBeDefined();
    expect(configDiff?.type).toBe("modified");
  });

  it("hashFiles: exclude が ziku.jsonc にマッチしても include 明示なら必ずハッシュされる", async () => {
    const dir = await createTempDir("excl");
    tempDirs.push(dir);
    await writeFiles(dir, {
      ".ziku/ziku.jsonc": JSON.stringify({ include: [".claude/**"] }, null, 2),
      ".claude/rules.md": "rule",
    });

    // exclude が `.ziku/**` と `**/*.jsonc` で ziku.jsonc を消そうとするケース
    const hashes = await hashFiles(
      dir,
      withConfigTracked(globPatterns([".claude/**"])),
      globPatterns([".ziku/**", "**/*.jsonc"]),
    );

    // include の明示指定が exclude より優先され、ziku.jsonc はハッシュされる
    expect(hashes[ZIKU_CONFIG_FILE]).toEqual(expect.any(String));
  });

  it("未追跡探索: ziku.jsonc を含めると `.ziku/lock.json` を追跡候補として拾ってしまう（バグの再現）", async () => {
    const dir = await createTempDir("untracked-bug");
    tempDirs.push(dir);
    await writeFiles(dir, {
      ".ziku/ziku.jsonc": JSON.stringify({ include: [".claude/**"] }, null, 2),
      ".ziku/lock.json": JSON.stringify({ source: { owner: "o", repo: "r" } }, null, 2),
      ".claude/rules.md": "rule",
    });

    // withConfigTracked をそのまま渡すと `.ziku` がスコープ基点になり lock.json が拾われる
    const untracked = await detectUntrackedFiles({
      targetDir: dir,
      patterns: { include: withConfigTracked(globPatterns([".claude/**"])), exclude: [] },
    });
    const paths = untracked.flatMap((g) => g.files.map((f) => f.path));
    expect(paths).toContain(".ziku/lock.json");
  });

  it("未追跡探索: 合成エントリ ziku.jsonc を除けば `.ziku/lock.json` は追跡候補に出ない（修正）", async () => {
    const dir = await createTempDir("untracked-fix");
    tempDirs.push(dir);
    await writeFiles(dir, {
      ".ziku/ziku.jsonc": JSON.stringify({ include: [".claude/**"] }, null, 2),
      ".ziku/lock.json": JSON.stringify({ source: { owner: "o", repo: "r" } }, null, 2),
      ".claude/rules.md": "rule",
    });

    // push の resolveUntrackedTracking と同じ関数で探索 include から合成エントリを除く
    const discoveryInclude = withoutConfigTracked(withConfigTracked(globPatterns([".claude/**"])));
    const untracked = await detectUntrackedFiles({
      targetDir: dir,
      patterns: { include: discoveryInclude, exclude: [] },
    });
    const paths = untracked.flatMap((g) => g.files.map((f) => f.path));
    // lock.json も ziku.jsonc も追跡候補に出ない（`.ziku` がスコープ基点にならない）
    expect(paths).not.toContain(".ziku/lock.json");
    expect(paths).not.toContain(ZIKU_CONFIG_FILE);
    expect(getTotalUntrackedCount(untracked)).toBe(0);
  });
});
