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
import { mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "pathe";
import { afterEach, describe, expect, it } from "vitest";
import { absPath, globPatterns, repoRelPath, syncScope } from "../../__tests__/brands";
import type { AbsPath } from "../../modules/schemas";
import type { ScopedZikuConfig } from "../config-merge";
import {
  analyzeConfigDrift,
  computeMergedZikuConfig,
  computeScopedZikuConfig,
} from "../config-merge";
import { hashContent, hashFiles } from "../hash";
import { classifyFiles } from "../merge";
import type { ZikuConfigStatus } from "../merge/sync-plan";
import { partitionSyncPlan, zikuConfigActions, zikuConfigStatus } from "../merge/sync-plan";
import { detectDiff } from "../diff";
import { resolveSyncScope } from "../sync-scope";
import { detectUntrackedFiles, getTotalUntrackedCount } from "../untracked";
import { ZIKU_CONFIG_FILE, generateZikuJsonc, withConfigTracked } from "../ziku-config";

/**
 * テンプレートに `ziku.jsonc` がある前提のケースで、組み立てた内容を取り出す。
 * 足す先が無いケース（`NoTemplateConfig`）は別のテストが扱う。
 */
function scopedContent(result: ScopedZikuConfig): string {
  if (result._tag !== "Scoped") throw new Error(`expected Scoped, got ${result._tag}`);
  return result.content;
}

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
    const scope = syncScope({ include: effectiveInclude });
    const templateHashes = await hashFiles(templateDir, scope);
    const localHashes = await hashFiles(projectDir, scope);

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

  it("pull と push を往復しても、両側の ziku.jsonc の注釈が残る", async () => {
    const templateDir = await createTempDir("comments-tpl");
    const projectDir = await createTempDir("comments-prj");
    tempDirs.push(templateDir, projectDir);

    await writeFiles(templateDir, {
      ".ziku/ziku.jsonc": ["{", "  // 共通ルール", '  "include": [".claude/**"]', "}", ""].join(
        "\n",
      ),
    });
    await writeFiles(projectDir, {
      ".ziku/ziku.jsonc": [
        "{",
        "  // このプロジェクトは mcp だけ足している",
        '  "include": [".mcp.json"]',
        "}",
        "",
      ].join("\n"),
    });

    // pull: union をローカルへ書き戻す
    const pulled = await computeMergedZikuConfig({ targetDir: projectDir, templateDir });
    await writeFiles(projectDir, { ".ziku/ziku.jsonc": pulled });
    expect(pulled).toContain("// このプロジェクトは mcp だけ足している");

    // push: 今回の push に関係するパターンだけをテンプレートの内容へ足して送る
    const pushed = scopedContent(
      await computeScopedZikuConfig({
        templateDir,
        additionalIncludes: globPatterns([".mcp.json"]),
      }),
    );
    await writeFiles(templateDir, { ".ziku/ziku.jsonc": pushed });
    expect(pushed).toContain("// 共通ルール");

    // 往復後もパターンは両側に揃い、注釈はそれぞれの側に残っている
    const localAfter = await readFile(join(projectDir, ZIKU_CONFIG_FILE), "utf-8");
    const templateAfter = await readFile(join(templateDir, ZIKU_CONFIG_FILE), "utf-8");
    expect(localAfter).toContain("// このプロジェクトは mcp だけ足している");
    expect(templateAfter).toContain("// 共通ルール");
    expect(await analyzeConfigDrift(projectDir, templateDir)).toEqual({
      pullRelevant: false,
      pushRelevant: false,
    });
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
    const scope = syncScope({ include: effectiveInclude });
    const templateHashes = await hashFiles(templateDir, scope);
    const localHashes = await hashFiles(projectDir, scope);

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

    // 範囲の解決も本番と同じ経路を通す。gitignore の読み込みと「常に追跡するパス」の
    // 決定はここで行われるので、差し替えると検証対象が消える。
    const { scope } = await resolveSyncScope({
      targetDir: projectDir,
      templateDir,
      include: globPatterns([".claude/**"]),
      exclude: [],
    });

    const diff = await detectDiff({ targetDir: projectDir, templateDir, scope });

    const configDiff = diff.files.find((f) => f.path === ZIKU_CONFIG_FILE);
    expect(configDiff).toBeDefined();
    expect(configDiff?.type).toBe("modified");
  });

  it("hashFiles: `.ziku/` を gitignore していても ziku.jsonc は分類の対象に残る", async () => {
    const templateDir = await createTempDir("gi-hash-tpl");
    const projectDir = await createTempDir("gi-hash-prj");
    tempDirs.push(templateDir, projectDir);

    await writeFiles(templateDir, {
      ".gitignore": ".ziku/\n",
      ".ziku/ziku.jsonc": JSON.stringify({ include: [".claude/**"] }, null, 2),
    });
    await writeFiles(projectDir, {
      ".gitignore": ".ziku/\n",
      ".ziku/ziku.jsonc": JSON.stringify({ include: [".claude/**", ".eslintrc.json"] }, null, 2),
    });

    const { scope } = await resolveSyncScope({
      targetDir: projectDir,
      templateDir,
      include: globPatterns([".claude/**"]),
      exclude: [],
    });

    // 分類はハッシュだけから導かれるので、ここで落ちるとパターンの追加が双方向に伝わらない。
    expect(await hashFiles(projectDir, scope)).toHaveProperty([ZIKU_CONFIG_FILE]);
    expect(await hashFiles(templateDir, scope)).toHaveProperty([ZIKU_CONFIG_FILE]);
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
      syncScope({
        include: withConfigTracked(globPatterns([".claude/**"])),
        exclude: [".ziku/**", "**/*.jsonc"],
      }),
    );

    // include の明示指定が exclude より優先され、ziku.jsonc はハッシュされる
    expect(hashes[ZIKU_CONFIG_FILE]).toEqual(expect.any(String));
  });

  it("走査用の include にだけ合成エントリが入り、宣言側には入らない", async () => {
    const dir = await createTempDir("scope-split");
    tempDirs.push(dir);
    await writeFiles(dir, {
      ".ziku/ziku.jsonc": JSON.stringify({ include: [".claude/**"] }, null, 2),
      ".claude/rules.md": "rule",
    });

    const { scope } = await resolveSyncScope({
      targetDir: dir,
      templateDir: dir,
      include: globPatterns([".claude/**"]),
      exclude: [],
    });

    expect(scope.scan.include).toContain(ZIKU_CONFIG_FILE);
    expect(scope.declared.include).not.toContain(ZIKU_CONFIG_FILE);
  });

  it("未追跡探索: 初期化済みプロジェクトでも `.ziku/lock.json` は追跡候補に出ない", async () => {
    const dir = await createTempDir("untracked-lock");
    tempDirs.push(dir);
    await writeFiles(dir, {
      ".ziku/ziku.jsonc": JSON.stringify({ include: [".claude/**"] }, null, 2),
      ".ziku/lock.json": JSON.stringify({ source: { owner: "o", repo: "r" } }, null, 2),
      ".claude/rules.md": "rule",
    });

    const { scope } = await resolveSyncScope({
      targetDir: dir,
      templateDir: dir,
      include: globPatterns([".claude/**"]),
      exclude: [],
    });
    const untracked = await detectUntrackedFiles({ targetDir: dir, scope });

    // 走査用のパターンで探索すると `.ziku` が探索の基点になり lock.json が候補に出る。
    // 追跡すると、マシン固有の取得元とベースがテンプレートへ送られる。
    const paths = untracked.flatMap((g) => g.files.map((f) => f.path));
    expect(paths).not.toContain(".ziku/lock.json");
    expect(paths).not.toContain(ZIKU_CONFIG_FILE);
    expect(getTotalUntrackedCount(untracked)).toBe(0);
  });

  it("先頭が glob のパターンでも、走査範囲の外にならない", async () => {
    // `**` をディレクトリ名として読むと、その名前のディレクトリは実在しないので
    // 候補が 1 件も出ず、追跡すべきファイルを一切勧められなくなる。
    const dir = await createTempDir("untracked-glob-first-segment");
    await writeFiles(dir, {
      ".ziku/ziku.jsonc": JSON.stringify({ include: ["**/*.md"] }, null, 2),
      "docs/guide.md": "guide",
      "docs/notes.txt": "not a match",
    });

    const { scope } = await resolveSyncScope({
      targetDir: dir,
      templateDir: dir,
      include: globPatterns(["**/*.md"]),
      exclude: [],
    });
    const untracked = await detectUntrackedFiles({ targetDir: dir, scope });

    const paths = untracked.flatMap((g) => g.files.map((f) => f.path));
    // include に一致する `docs/guide.md` は追跡済みなので候補ではない。
    expect(paths).not.toContain("docs/guide.md");
    // 一致しない `docs/notes.txt` は追跡候補として出る。
    expect(paths).toContain("docs/notes.txt");
  });
});

/** パターン集合から、init / pull が書くのと同じ `ziku.jsonc` の本文を作る。 */
function configText(include: readonly string[]): string {
  return generateZikuJsonc({ include: globPatterns([...include]), exclude: [] });
}

interface DriftScenario {
  readonly name: string;
  /** 前回同期時点の include（lock の base に相当）。 */
  readonly base: readonly string[];
  readonly local: readonly string[];
  /** テンプレートの include。undefined はテンプレートから `ziku.jsonc` が消えた状態。 */
  readonly template: readonly string[] | undefined;
  readonly expected: ZikuConfigStatus;
}

/**
 * base / local / template のパターン集合が作りうる形の一覧。
 *
 * 加法 union で意味を持つ操作は「追加」だけなので、各側について「変えていない / 足した /
 * 消した」の組み合わせと、テンプレートからファイルごと消えた場合を並べる。
 */
const DRIFT_SCENARIOS: readonly DriftScenario[] = [
  {
    name: "双方とも変えていない",
    base: ["a/**"],
    local: ["a/**"],
    template: ["a/**"],
    expected: { _tag: "Categorized", category: "unchanged" },
  },
  {
    name: "テンプレートがパターンを追加した",
    base: ["a/**"],
    local: ["a/**"],
    template: ["a/**", "b/**"],
    expected: { _tag: "Categorized", category: "autoUpdate" },
  },
  {
    // 加法 union では、この状態と「ローカルが独自のパターンを持つ」状態を base から区別できない。
    // どちらも送らない（テンプレートが消したパターンを復活させない）が、ローカルにしか無い
    // パターンが残る事実は見せる。
    name: "テンプレートがパターンを削除し、ローカルは変えていない",
    base: ["a/**", "b/**"],
    local: ["a/**", "b/**"],
    template: ["a/**"],
    expected: { _tag: "LocalOnlyPatterns" },
  },
  {
    name: "ローカルがパターンを追加した",
    base: ["a/**"],
    local: ["a/**", "c/**"],
    template: ["a/**"],
    expected: { _tag: "Categorized", category: "localOnly" },
  },
  {
    name: "ローカルがパターンを削除し、テンプレートは変えていない",
    base: ["a/**", "b/**"],
    local: ["a/**"],
    template: ["a/**", "b/**"],
    expected: { _tag: "Categorized", category: "unchanged" },
  },
  {
    name: "双方が別のパターンを追加した",
    base: ["a/**"],
    local: ["a/**", "c/**"],
    template: ["a/**", "b/**"],
    expected: { _tag: "Categorized", category: "conflicts" },
  },
  {
    name: "ローカルが追加し、テンプレートは削除した",
    base: ["a/**"],
    local: ["a/**", "c/**"],
    template: [],
    expected: { _tag: "Categorized", category: "localOnly" },
  },
  {
    name: "ローカルが削除し、テンプレートは追加した",
    base: ["a/**"],
    local: [],
    template: ["a/**", "b/**"],
    expected: { _tag: "Categorized", category: "autoUpdate" },
  },
  {
    name: "双方が同じパターンを削除した",
    base: ["a/**", "b/**"],
    local: ["a/**"],
    template: ["a/**"],
    expected: { _tag: "Categorized", category: "unchanged" },
  },
  {
    name: "テンプレートから ziku.jsonc が消え、ローカルは変えていない",
    base: ["a/**"],
    local: ["a/**"],
    template: undefined,
    expected: { _tag: "LocalOnlyPatterns" },
  },
  {
    name: "テンプレートから ziku.jsonc が消え、ローカルはパターンを追加した",
    base: ["a/**"],
    local: ["a/**", "c/**"],
    template: undefined,
    expected: { _tag: "Categorized", category: "localOnly" },
  },
];

/**
 * status が見せる方向と、pull / push が `ziku.jsonc` に対して実際に行う書き換えを突き合わせる。
 *
 * 加法 union では「片側だけのパターン削除」が相手側への操作にならないため、ハッシュ差分の
 * カテゴリだけを見ると status が勧めた操作が何もしないことがある。個別のケースを 1 つずつ
 * 確かめても組み合わせの取りこぼしに気付けないので、drift を作る形を並べて一括で検査する。
 *
 * ローカルに `ziku.jsonc` がある状態だけを扱う。status はローカルの設定を読めることを前提に
 * 動く（`loadCommandContext`）ため、ローカルに設定が無い状態は status の観測対象にならない。
 */
describe("status の推奨と pull / push の実動作の一致（実ファイル I/O）", () => {
  const tempDirs: AbsPath[] = [];

  afterEach(async () => {
    for (const dir of tempDirs) {
      await rm(dir, { recursive: true, force: true });
    }
    tempDirs.length = 0;
  });

  it.each(DRIFT_SCENARIOS)("$name", async ({ base, local, template, expected }) => {
    const templateDir = await createTempDir("drift-tpl");
    const projectDir = await createTempDir("drift-prj");
    tempDirs.push(templateDir, projectDir);

    await writeFiles(projectDir, { [ZIKU_CONFIG_FILE]: configText(local) });
    if (template !== undefined) {
      await writeFiles(templateDir, { [ZIKU_CONFIG_FILE]: configText(template) });
    }

    const tracked = syncScope({ include: withConfigTracked(globPatterns([])) });
    const localHashes = await hashFiles(projectDir, tracked);
    const templateHashes = await hashFiles(templateDir, tracked);
    const baseHashes = { [ZIKU_CONFIG_FILE]: hashContent(configText(base)) };

    const plan = partitionSyncPlan(classifyFiles({ baseHashes, localHashes, templateHashes }));
    const drift = await analyzeConfigDrift(projectDir, templateDir);
    const status = zikuConfigStatus(plan.config, drift);

    expect(status).toEqual(expected);

    // 実際に書き換えが起きるか。union の計算と、書き込む / 送る前の比較は pull の
    // resolveConfigMerge・push の送信内容の組み立てと同じ手順を踏む。
    const union = await computeMergedZikuConfig({ targetDir: projectDir, templateDir });
    const localContent = await readFile(join(projectDir, ZIKU_CONFIG_FILE), "utf-8");
    const templateContent = template === undefined ? undefined : configText(template);
    const { pull, push } = zikuConfigActions(plan.config);
    const changes = {
      pull: pull._tag === "UnionMerge" && union !== localContent,
      push: push._tag === "SendUnion" && union !== templateContent,
    };

    // どのコマンドも書き換えない状態（LocalOnlyPatterns）は、どちらの方向にも見せない。
    const category = status._tag === "Categorized" ? status.category : undefined;
    const shown = {
      pull: category === "autoUpdate" || category === "conflicts",
      push: category === "localOnly" || category === "conflicts",
    };

    expect(shown).toEqual(changes);
  });
});
