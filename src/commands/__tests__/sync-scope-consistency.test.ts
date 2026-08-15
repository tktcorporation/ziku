/**
 * 全コマンドが同じ走査範囲を使うことを、コマンドの帰結の側から確かめる。
 *
 * 範囲がコマンドごとにずれると、症状は「pull がローカル固有の内容を上書きする」
 * 「status が勧めた push を push が実行できない」「pull が同期しているファイルを push が
 * 未追跡として報告する」という形で現れる。どれも 1 コマンド内では正しく見えるので、
 * 分類・差分検出・未追跡探索はすべて実装を通し、2 コマンドをまたいだ結果を突き合わせる。
 *
 * memfs を使わず実ディレクトリで動かすのは、`tinyglobby` が実 fs を直接読むため。
 * 走査範囲の検証にパターン解決と gitignore の解釈が要るので、走査そのものを差し替えると
 * 検証対象が消える。
 */
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "pathe";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { AbsPath, TemplateSource } from "../../modules/schemas";
import { createPendingLock, markSynced } from "../../modules/schemas";

vi.mock("../../ui/renderer", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../../ui/renderer")>();
  return {
    ...actual,
    intro: vi.fn(),
    outro: vi.fn(),
    log: {
      info: vi.fn(),
      warn: vi.fn(),
      error: vi.fn(),
      success: vi.fn(),
      step: vi.fn(),
      message: vi.fn(),
    },
    withSpinner: vi.fn((_text: string, task: () => Promise<unknown>) => task()),
    logDiffSummary: vi.fn(),
    logFileResults: vi.fn(),
  };
});

// 対話は主題ではないので、削除の承認・追跡の選択が起きない既定へ固定する。実行は
// すべて `--yes` なので、ここが呼ばれること自体が想定外。
vi.mock("../../ui/prompts", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../../ui/prompts")>();
  return {
    ...actual,
    selectDeletedFiles: vi.fn(() => Promise.resolve([])),
    selectDeletedFilesWithLocalEdits: vi.fn(() => Promise.resolve([])),
    selectUntrackedToTrack: vi.fn(() => Promise.resolve([])),
    logUntrackedFilesNotice: vi.fn(),
    confirmAction: vi.fn(() => Promise.resolve(true)),
  };
});

const { pullCommand } = await import("../pull");
const { pushCommand } = await import("../push");
const { statusCommand } = await import("../status");
const { fetchTemplates } = await import("../../utils/template");
const { hashContent } = await import("../../utils/hash");
const { absPath, globPatterns, hashMap } = await import("../../__tests__/brands");
const { log, outro } = await import("../../ui/renderer");
const { logUntrackedFilesNotice } = await import("../../ui/prompts");

const mockLog = vi.mocked(log);
const mockOutro = vi.mocked(outro);
const mockUntrackedNotice = vi.mocked(logUntrackedFilesNotice);

const RULES = "rule\n";
const LOCAL_ENV = "TOKEN=local\n";
const TEMPLATE_ENV = "TOKEN=template\n";

let root: AbsPath;
let templateDir: AbsPath;
let projectDir: AbsPath;

async function writeFiles(baseDir: AbsPath, files: Record<string, string>): Promise<void> {
  for (const [relativePath, content] of Object.entries(files)) {
    const fullPath = join(baseDir, relativePath);
    await mkdir(dirname(fullPath), { recursive: true });
    await writeFile(fullPath, content, "utf-8");
  }
}

function configText(include: readonly string[]): string {
  return `${JSON.stringify({ include }, null, 2)}\n`;
}

/** `.ziku/ziku.jsonc` と追跡済みファイルだけをベースに持つ、同期済みの lock を書き出す。 */
function syncedLock(base: Record<string, string>): string {
  const source: TemplateSource = { kind: "local", path: templateDir };
  return JSON.stringify(
    markSynced(
      createPendingLock({
        version: "1.0.0",
        installedAt: "2024-01-01T00:00:00.000Z",
        source,
      }),
      { hashes: hashMap(base) },
    ),
    null,
    2,
  );
}

function runPull(): Promise<unknown> {
  return (pullCommand.run as (input: unknown) => Promise<unknown>)({
    args: { dir: projectDir, continue: false, dryRun: false, force: false, yes: true },
    rawArgs: [],
    cmd: pullCommand,
  });
}

function runPush(): Promise<unknown> {
  return (pushCommand.run as (input: unknown) => Promise<unknown>)({
    args: { dir: projectDir, dryRun: false, yes: true, edit: false, includeDeletions: false },
    rawArgs: [],
    cmd: pushCommand,
  });
}

function runStatus(): Promise<unknown> {
  return (statusCommand.run as (input: unknown) => Promise<unknown>)({
    args: { dir: projectDir },
    rawArgs: [],
    cmd: statusCommand,
  });
}

/** コマンドが画面に出した全文。バケツの中身も推奨も、利用者はこれしか見ない。 */
function screenOutput(): string {
  const lines = [
    ...mockLog.message.mock.calls,
    ...mockLog.info.mock.calls,
    ...mockLog.warn.mock.calls,
    ...mockOutro.mock.calls,
  ];
  return lines.map((args) => args[0]).join("\n");
}

/** push が未追跡として報告した全パス。 */
function untrackedReported(): string[] {
  return mockUntrackedNotice.mock.calls.flatMap(([byFolder]) =>
    byFolder.flatMap((group) => group.files.map((file) => file.path)),
  );
}

beforeEach(async () => {
  vi.clearAllMocks();
  root = absPath(await mkdtemp(join(tmpdir(), "ziku-test-sync-scope-")));
  templateDir = absPath(join(root, "template"));
  projectDir = absPath(join(root, "project"));
  await mkdir(templateDir, { recursive: true });
  await mkdir(projectDir, { recursive: true });
});

afterEach(async () => {
  await rm(root, { recursive: true, force: true });
});

describe("gitignore されたファイルは同期の対象にならない", () => {
  const INCLUDE = [".claude/**", ".env"];
  const CONFIG = configText(INCLUDE);

  /** ローカルとテンプレートの双方に、内容の違う gitignore 済みファイルがある状態。 */
  async function setupIgnoredOnBothSides(): Promise<void> {
    await writeFiles(templateDir, {
      ".gitignore": ".env\n",
      ".ziku/ziku.jsonc": CONFIG,
      ".claude/rules.md": RULES,
      ".env": TEMPLATE_ENV,
    });
    await writeFiles(projectDir, {
      ".gitignore": ".env\n",
      ".ziku/ziku.jsonc": CONFIG,
      ".ziku/lock.json": syncedLock({
        ".ziku/ziku.jsonc": hashContent(CONFIG),
        ".claude/rules.md": hashContent(RULES),
      }),
      ".claude/rules.md": RULES,
      ".env": LOCAL_ENV,
    });
  }

  it("init も pull も、ローカルにある gitignore 済みファイルの内容を残す", async () => {
    await setupIgnoredOnBothSides();

    // init が配置を決める経路。ローカルに既にあるなら、テンプレート側の内容で置き換えない。
    const results = await fetchTemplates({
      targetDir: projectDir,
      templateDir,
      overwriteStrategy: "overwrite",
      patterns: { include: globPatterns(INCLUDE), exclude: [] },
    });
    expect(results).toContainEqual({ action: "skipped_ignored", path: ".env" });
    expect(await readFile(join(projectDir, ".env"), "utf-8")).toBe(LOCAL_ENV);

    await runPull();

    // pull が同じ結論に至らないと、マシン固有の設定や資格情報が黙って消える。
    expect(await readFile(join(projectDir, ".env"), "utf-8")).toBe(LOCAL_ENV);
    // 範囲の外にあるので、解決待ちのコンフリクトにもならない。ここで止まると利用者は
    // 解決しようのない衝突を渡され、pull が完了しなくなる。
    expect(screenOutput()).not.toContain("Merge paused");
    expect(screenOutput()).not.toContain(".env");
  });

  it("status の push 候補にも push の送信先にも、gitignore 済みファイルは現れない", async () => {
    await writeFiles(templateDir, {
      ".gitignore": ".env\n",
      ".ziku/ziku.jsonc": CONFIG,
      ".claude/rules.md": RULES,
    });
    await writeFiles(projectDir, {
      ".gitignore": ".env\n",
      ".ziku/ziku.jsonc": CONFIG,
      ".ziku/lock.json": syncedLock({
        ".ziku/ziku.jsonc": hashContent(CONFIG),
        ".claude/rules.md": hashContent(RULES),
      }),
      ".claude/rules.md": RULES,
      ".env": LOCAL_ENV,
    });

    await runStatus();

    // status が数えて push が送れないと、「push しろ」という案内だけが出続けて収束しない。
    expect(screenOutput()).not.toContain(".env");

    await runPush();

    expect(existsSync(join(templateDir, ".env"))).toBe(false);
  });
});

describe("走査範囲は include の和集合で決まる", () => {
  it("テンプレート側にしかない include パターン配下のファイルを、push は未追跡として報告しない", async () => {
    const templateConfig = configText([".claude/**"]);
    const localConfig = configText([".claude/rules/**"]);

    await writeFiles(templateDir, {
      ".ziku/ziku.jsonc": templateConfig,
      ".claude/rules/a.md": RULES,
    });
    await writeFiles(projectDir, {
      ".ziku/ziku.jsonc": localConfig,
      ".ziku/lock.json": syncedLock({ ".claude/rules/a.md": hashContent(RULES) }),
      ".claude/rules/a.md": RULES,
      // テンプレートの `.claude/**` には入るが、ローカルの `.claude/rules/**` には入らない
      ".claude/settings.json": "{}\n",
    });

    await runPush();

    // pull は和集合で走査するので、このファイルは既に同期の対象。push が別の範囲を使うと
    // 同じファイルを「まだ追跡していない」と報告する。
    expect(untrackedReported()).not.toContain(".claude/settings.json");
    expect(existsSync(join(templateDir, ".claude/settings.json"))).toBe(true);
  });
});
