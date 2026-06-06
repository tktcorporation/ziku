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
import { hashFiles } from "../hash";
import { classifyFiles } from "../merge";
import { detectDiff } from "../diff";
import { ZIKU_CONFIG_FILE, withConfigTracked } from "../ziku-config";

async function createTempDir(label: string): Promise<string> {
  const dir = join(
    tmpdir(),
    `ziku-test-config-sync-${label}-${Date.now()}-${Math.random().toString(36).slice(2)}`,
  );
  await mkdir(dir, { recursive: true });
  return dir;
}

async function writeFiles(baseDir: string, files: Record<string, string>): Promise<void> {
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
  const tempDirs: string[] = [];

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
    const effectiveInclude = withConfigTracked([".claude/**", ".eslintrc.json"]);
    const templateHashes = await hashFiles(templateDir, effectiveInclude);
    const localHashes = await hashFiles(projectDir, effectiveInclude);

    // base = 前回 sync 時点（テンプレと一致していた）。ziku.jsonc はテンプレ版のハッシュ。
    const baseHashes = {
      ".claude/rules.md": templateHashes[".claude/rules.md"],
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
    const effectiveInclude = withConfigTracked([".claude/**", ".eslintrc.json"]);
    const templateHashes = await hashFiles(templateDir, effectiveInclude);
    const localHashes = await hashFiles(projectDir, effectiveInclude);

    // base = 前回 sync 時点（ローカル = テンプレ旧版）。ziku.jsonc はローカル版のハッシュ。
    const baseHashes = {
      ".claude/rules.md": localHashes[".claude/rules.md"],
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
      patterns: { include: withConfigTracked([".claude/**"]), exclude: [] },
    });

    const configDiff = diff.files.find((f) => f.path === ZIKU_CONFIG_FILE);
    expect(configDiff).toBeDefined();
    expect(configDiff?.type).toBe("modified");
  });
});
