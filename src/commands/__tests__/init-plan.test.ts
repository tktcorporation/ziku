/**
 * init が「何を配置し、どんな lock を書くか」を決める計算のテスト。
 *
 * ファイルシステム・GitHub API・プロンプトを一切用意せず、入力の値だけで判断を検証する。
 * コマンド全体の配線（どの順で I/O を呼ぶか・どのログを出すか）は `init.test.ts` が見る。
 */
import { describe, expect, it } from "vitest";
import type { RepoExistence } from "../../utils/github";
import { hashContent } from "../../utils/hash";
import { generateZikuJsonc } from "../../utils/ziku-config";
import type { GlobPattern, HashMap, TemplateSource } from "../../modules/schemas";
import { baseCommitSha, baseHashesOf } from "../../modules/schemas";
import { absPath, commitSha, globPatterns, hashMap, repoRelPath } from "../../__tests__/brands";
import type { TemplateCandidate } from "../../ui/prompts";
import {
  asNonEmpty,
  buildInitialLock,
  buildOwnerCandidates,
  decideRepoProbe,
  deduplicateByOwner,
  gateProbeResults,
  orderProbedCandidates,
  planDirectorySelection,
  planFromArg,
  planInitOutcome,
  planInteractiveSource,
  planLockBaseHashes,
  planMissingTemplateAction,
  planNonInteractiveSource,
  planOverwriteStrategy,
  preferReadyCandidate,
  requiresDevcontainerEnvExample,
  resolveConfigBaseContent,
  resolveConfigBaseHash,
  resolveTargetDirArg,
  selectedFlatPatterns,
  splitOwnerRepo,
  withReadyFlags,
} from "../init-plan";
import type { ProbedItem } from "../init-plan";

const CONFIG_PATH = repoRelPath(".ziku/ziku.jsonc");

const exists: RepoExistence = { _tag: "Exists" };
const notFound: RepoExistence = { _tag: "NotFound" };
const unknown: RepoExistence = { _tag: "Unknown", status: 500, reason: "Server error" };
const rateLimited: RepoExistence = { _tag: "RateLimited", resetAt: undefined, authenticated: true };
const unauthorized: RepoExistence = { _tag: "Unauthorized", message: "Bad credentials" };

function entry(label: string, patterns: string[]): { label: string; patterns: GlobPattern[] } {
  return { label, patterns: globPatterns(patterns) };
}

function candidate(owner: string, repo: string, ready?: boolean): TemplateCandidate {
  return ready === undefined
    ? { owner, repo, label: "Your account" }
    : { owner, repo, label: "Your account", ready };
}

function probed<T>(item: T, existence: RepoExistence): ProbedItem<T> {
  return { item, existence };
}

describe("resolveTargetDirArg", () => {
  it("サブコマンド名としての 'init' はカレントディレクトリとして扱う", () => {
    expect(resolveTargetDirArg("init")).toBe(".");
  });

  it("それ以外の位置引数はディレクトリ名として扱う", () => {
    expect(resolveTargetDirArg("./my-project")).toBe("./my-project");
    expect(resolveTargetDirArg("initializer")).toBe("initializer");
  });
});

describe("planFromArg", () => {
  it("owner/repo はそのリポジトリを指す", () => {
    expect(planFromArg("my-org/my-templates")).toEqual({
      _tag: "Repo",
      owner: "my-org",
      repo: "my-templates",
    });
  });

  it("owner だけならリポジトリ名を補わない（既定リポジトリの探索へ回す）", () => {
    expect(planFromArg("my-org")).toEqual({ _tag: "OwnerOnly", owner: "my-org" });
  });

  it.each(["", "   ", "/repo", "owner/"])('どちらとしても読めない "%s" は Invalid', (value) => {
    expect(planFromArg(value)).toEqual({ _tag: "Invalid", value });
  });

  it("リポジトリ名にスラッシュが含まれてもオーナーだけを切り出す", () => {
    expect(planFromArg("my-org/group/repo")).toEqual({
      _tag: "Repo",
      owner: "my-org",
      repo: "group/repo",
    });
  });
});

describe("splitOwnerRepo", () => {
  it("最初のスラッシュで owner と repo に分ける", () => {
    expect(splitOwnerRepo("my-org/my-templates")).toEqual({
      owner: "my-org",
      repo: "my-templates",
    });
  });
});

describe("planDirectorySelection", () => {
  const entries = [entry(".claude", [".claude/**"]), entry("Root files", [".mcp.json"])];

  it("--yes は全ディレクトリを配置する", () => {
    expect(planDirectorySelection(entries, { yes: true, dirsArg: undefined })).toEqual({
      _tag: "SelectAll",
      patterns: [".claude/**", ".mcp.json"],
      directoryCount: 2,
    });
  });

  it("--dirs は名指しされたディレクトリのパターンだけを返す", () => {
    expect(planDirectorySelection(entries, { yes: false, dirsArg: "Root files" })).toEqual({
      _tag: "SelectNamed",
      patterns: [".mcp.json"],
    });
  });

  it("--dirs はカンマ区切りの前後の空白を無視する", () => {
    expect(
      planDirectorySelection(entries, { yes: false, dirsArg: " .claude , Root files " }),
    ).toEqual({ _tag: "SelectNamed", patterns: [".claude/**", ".mcp.json"] });
  });

  it("--dirs は --yes より優先する（指定が無視されないように）", () => {
    expect(planDirectorySelection(entries, { yes: true, dirsArg: ".claude" })).toEqual({
      _tag: "SelectNamed",
      patterns: [".claude/**"],
    });
  });

  it("テンプレートに無いラベルは、選べる一覧と一緒に返す", () => {
    expect(planDirectorySelection(entries, { yes: true, dirsArg: "nope,.claude" })).toEqual({
      _tag: "UnknownDirs",
      unknown: ["nope"],
      available: [".claude", "Root files"],
    });
  });

  it("フラグが無ければユーザーに選ばせる", () => {
    expect(planDirectorySelection(entries, { yes: false, dirsArg: undefined })).toEqual({
      _tag: "AskUser",
    });
  });

  it("--dirs が空文字なら指定なしとして扱う", () => {
    expect(planDirectorySelection(entries, { yes: false, dirsArg: "" })).toEqual({
      _tag: "AskUser",
    });
  });

  it("エントリが無い状態で --yes を指定してもパターンは空になる", () => {
    expect(planDirectorySelection([], { yes: true, dirsArg: undefined })).toEqual({
      _tag: "SelectAll",
      patterns: [],
      directoryCount: 0,
    });
  });
});

describe("selectedFlatPatterns", () => {
  it("選ばれた include と、テンプレートの exclude 全部を組み合わせる", () => {
    const templateConfig = {
      include: globPatterns([".claude/**", ".mcp.json"]),
      exclude: globPatterns([".claude/secrets/**"]),
    };
    expect(selectedFlatPatterns(templateConfig, globPatterns([".mcp.json"]))).toEqual({
      include: [".mcp.json"],
      exclude: [".claude/secrets/**"],
    });
  });

  it("exclude が無いテンプレートでは空になる", () => {
    expect(
      selectedFlatPatterns({ include: globPatterns([".mcp.json"]) }, globPatterns([".mcp.json"])),
    ).toEqual({ include: [".mcp.json"], exclude: [] });
  });
});

describe("requiresDevcontainerEnvExample", () => {
  it(".devcontainer/ 配下を配置するときだけ必要", () => {
    expect(requiresDevcontainerEnvExample(globPatterns([".devcontainer/**"]))).toBe(true);
    expect(requiresDevcontainerEnvExample(globPatterns([".mcp.json", ".claude/**"]))).toBe(false);
  });

  it("名前が .devcontainer で始まるだけのファイルは対象にしない", () => {
    expect(requiresDevcontainerEnvExample(globPatterns([".devcontainer.json"]))).toBe(false);
  });
});

describe("planOverwriteStrategy", () => {
  it("--force は破壊的上書きの承認なので overwrite になる", () => {
    expect(planOverwriteStrategy({ force: true, strategyArg: undefined, yes: false })).toEqual({
      _tag: "Decided",
      strategy: "overwrite",
    });
  });

  it("--force は --overwrite-strategy より優先する", () => {
    expect(planOverwriteStrategy({ force: true, strategyArg: "skip", yes: true })).toEqual({
      _tag: "Decided",
      strategy: "overwrite",
    });
  });

  it.each(["overwrite", "skip", "prompt"] as const)('--overwrite-strategy "%s" を採用する', (s) => {
    expect(planOverwriteStrategy({ force: false, strategyArg: s, yes: true })).toEqual({
      _tag: "Decided",
      strategy: s,
    });
  });

  it("--overwrite-strategy の未知の値は弾く", () => {
    expect(planOverwriteStrategy({ force: false, strategyArg: "merge", yes: false })).toEqual({
      _tag: "InvalidStrategy",
      value: "merge",
    });
  });

  it("--yes だけでは既存ファイルを残す（上書きの承認を含まない）", () => {
    expect(planOverwriteStrategy({ force: false, strategyArg: undefined, yes: true })).toEqual({
      _tag: "Decided",
      strategy: "skip",
    });
  });

  it("指定が無ければユーザーに聞く", () => {
    expect(planOverwriteStrategy({ force: false, strategyArg: undefined, yes: false })).toEqual({
      _tag: "AskUser",
    });
  });
});

describe("resolveConfigBaseContent（ディスクに実在する本文を選ぶ）", () => {
  const generatedContent = generateZikuJsonc({
    include: globPatterns([".claude/**", ".mcp.json"]),
    exclude: [],
  });
  const existingContent = generateZikuJsonc({
    include: globPatterns([".mcp.json"]),
    exclude: [],
  });

  it("新規作成なら生成した本文を採る", () => {
    expect(
      resolveConfigBaseContent({ action: "created", generatedContent, existingContent: undefined }),
    ).toBe(generatedContent);
  });

  it("上書きなら生成した本文を採る", () => {
    expect(
      resolveConfigBaseContent({ action: "overwritten", generatedContent, existingContent }),
    ).toBe(generatedContent);
  });

  it("スキップなら既存ファイルの本文を採る（生成した本文はディスクに無い）", () => {
    expect(resolveConfigBaseContent({ action: "skipped", generatedContent, existingContent })).toBe(
      existingContent,
    );
  });

  it("gitignore 由来のスキップでも既存ファイルの本文を採る", () => {
    expect(
      resolveConfigBaseContent({ action: "skipped_ignored", generatedContent, existingContent }),
    ).toBe(existingContent);
  });
});

describe("resolveConfigBaseHash（テンプレ保護の安全装置）", () => {
  it("ローカル(部分集合) の内容ハッシュを base にする（テンプレを削らないため）", () => {
    const localContent = generateZikuJsonc({ include: globPatterns([".claude/**"]), exclude: [] });
    const result = resolveConfigBaseHash({
      persistedConfigContent: localContent,
      templateConfigHash: hashContent("different-template-content"),
    });
    // base = ローカル内容のハッシュ（テンプレ側のハッシュではない）
    expect(result).toBe(hashContent(localContent));
  });

  it("テンプレ側ハッシュが undefined でもローカル内容から base を決められる", () => {
    const localContent = generateZikuJsonc({ include: globPatterns([".mcp.json"]), exclude: [] });
    const result = resolveConfigBaseHash({
      persistedConfigContent: localContent,
      templateConfigHash: undefined,
    });
    expect(result).toBe(hashContent(localContent));
  });

  it("ローカルが完全集合（テンプレと同一）なら base はテンプレと一致する", () => {
    const content = generateZikuJsonc({
      include: globPatterns([".claude/**", ".mcp.json"]),
      exclude: [],
    });
    const templateHash = hashContent(content);
    const result = resolveConfigBaseHash({
      persistedConfigContent: content,
      templateConfigHash: templateHash,
    });
    // local == template のときは base も一致 → push/pull とも no-op
    expect(result).toBe(templateHash);
  });
});

describe("planLockBaseHashes", () => {
  const persistedConfigContent = generateZikuJsonc({
    include: globPatterns([".mcp.json"]),
    exclude: [],
  });

  it("テンプレに ziku.jsonc があれば base をディスク上の本文のハッシュへ差し替える", () => {
    const result = planLockBaseHashes({
      templateHashes: hashMap({ ".mcp.json": "a", ".ziku/ziku.jsonc": "template-hash" }),
      persistedConfigContent,
    });
    expect(result[CONFIG_PATH]).toBe(hashContent(persistedConfigContent));
    expect(result[repoRelPath(".mcp.json")]).toBe("a");
  });

  it("テンプレに ziku.jsonc が無ければ base を記録しない（次回 pull の誤削除を防ぐ）", () => {
    const result = planLockBaseHashes({
      templateHashes: hashMap({ ".mcp.json": "a" }),
      persistedConfigContent,
    });
    expect(result[CONFIG_PATH]).toBeUndefined();
  });

  it("渡されたハッシュ表を書き換えない", () => {
    const templateHashes = hashMap({ ".ziku/ziku.jsonc": "template-hash" });
    planLockBaseHashes({ templateHashes, persistedConfigContent });
    expect(templateHashes[CONFIG_PATH]).toBe("template-hash");
  });
});

describe("buildInitialLock", () => {
  const githubSource: TemplateSource = { kind: "github", owner: "o", repo: "r" };
  const localSource: TemplateSource = { kind: "local", path: absPath("/templates") };
  const identity = { version: "1.0.0", installedAt: "2020-01-01T00:00:00.000Z" };

  it("ハッシュが取れていればベース確定済み（synced）にする", () => {
    const lock = buildInitialLock({
      ...identity,
      source: githubSource,
      baseHashes: hashMap({ ".mcp.json": "a" }),
      baseCommit: commitSha("abc123"),
    });

    expect(lock.sync).toBe("synced");
    expect(baseHashesOf(lock)).toEqual({ ".mcp.json": "a" });
    expect(baseCommitSha(lock)).toBe("abc123");
  });

  it("ハッシュが 1 件も無ければベース未確定（pending）のまま残す", () => {
    const lock = buildInitialLock({
      ...identity,
      source: githubSource,
      baseHashes: {},
      baseCommit: commitSha("abc123"),
    });

    expect(lock.sync).toBe("pending");
    expect(baseHashesOf(lock)).toEqual({});
  });

  it("ローカルソースではコミット SHA を持たない", () => {
    const lock = buildInitialLock({
      ...identity,
      source: localSource,
      baseHashes: hashMap({ ".mcp.json": "a" }),
      baseCommit: undefined,
    });

    expect(lock.source).toEqual(localSource);
    expect(baseCommitSha(lock)).toBeUndefined();
  });

  it("識別情報をそのまま載せる", () => {
    const lock = buildInitialLock({
      ...identity,
      source: githubSource,
      baseHashes: {} as HashMap,
      baseCommit: undefined,
    });

    expect(lock.version).toBe("1.0.0");
    expect(lock.installedAt).toBe("2020-01-01T00:00:00.000Z");
  });
});

describe("planInitOutcome", () => {
  it("追加も更新も無ければ、実行モードによらず変更なしとして伝える", () => {
    expect(planInitOutcome({ summary: { added: 0, updated: 0 }, dryRun: false })).toEqual({
      _tag: "NoChanges",
    });
    expect(planInitOutcome({ summary: { added: 0, updated: 0 }, dryRun: true })).toEqual({
      _tag: "NoChanges",
    });
  });

  it("dry-run で変更があればプレビューとして伝える", () => {
    expect(planInitOutcome({ summary: { added: 1, updated: 0 }, dryRun: true })).toEqual({
      _tag: "DryRunPreview",
    });
  });

  it("実行して変更があれば適用として伝える", () => {
    expect(planInitOutcome({ summary: { added: 0, updated: 3 }, dryRun: false })).toEqual({
      _tag: "Applied",
    });
  });
});

describe("decideRepoProbe", () => {
  it("存在を確認できたら採用する", () => {
    expect(decideRepoProbe(exists)).toEqual({ _tag: "Verified" });
  });

  it("確認できない結果は、無いと断定せず採用する", () => {
    expect(decideRepoProbe(unknown)).toEqual({ _tag: "Unverified", existence: unknown });
  });

  it("無いと確認できたら候補から外す", () => {
    expect(decideRepoProbe(notFound)).toEqual({ _tag: "Absent" });
  });

  it.each([rateLimited, unauthorized])("確認自体が成立しない結果は判断を止める", (existence) => {
    expect(decideRepoProbe(existence)).toEqual({ _tag: "Blocked", existence });
  });
});

describe("gateProbeResults", () => {
  it("確認済みが 1 つでもあれば、確認不能は警告に降格して続行する", () => {
    expect(gateProbeResults([exists, rateLimited])).toEqual({
      _tag: "Proceed",
      degraded: [rateLimited],
    });
  });

  it("確認済みが無ければ、レート制限を優先して中断する", () => {
    expect(gateProbeResults([unauthorized, rateLimited])).toEqual({
      _tag: "Blocked",
      existence: rateLimited,
    });
  });

  it("確認済みが無く、認証拒否だけなら認証拒否で中断する", () => {
    expect(gateProbeResults([notFound, unauthorized])).toEqual({
      _tag: "Blocked",
      existence: unauthorized,
    });
  });

  it("判定を妨げる結果が無ければ、確認済みが無くても続行する", () => {
    expect(gateProbeResults([notFound, unknown])).toEqual({ _tag: "Proceed", degraded: [] });
  });

  it("何も問い合わせていなければ続行する", () => {
    expect(gateProbeResults([])).toEqual({ _tag: "Proceed", degraded: [] });
  });
});

describe("orderProbedCandidates", () => {
  it("確認済みを先頭、確認不能を末尾に並べ、無いものは落とす", () => {
    const result = orderProbedCandidates([
      probed(".ziku", unknown),
      probed(".github", exists),
      probed(".old", notFound),
    ]);

    expect(result.usable).toEqual([".github", ".ziku"]);
    expect(result.unverified).toEqual([{ item: ".ziku", existence: unknown }]);
  });

  it("同じ確度なら渡された順序を保つ", () => {
    const result = orderProbedCandidates([probed(".ziku", exists), probed(".github", exists)]);
    expect(result.usable).toEqual([".ziku", ".github"]);
  });

  it("判定を妨げる結果の候補も採用しない", () => {
    const result = orderProbedCandidates([probed(".ziku", rateLimited)]);
    expect(result.usable).toEqual([]);
    expect(result.unverified).toEqual([]);
  });
});

describe("asNonEmpty", () => {
  it("要素があればそのまま返す", () => {
    expect(asNonEmpty([1, 2])).toEqual([1, 2]);
  });

  it("空なら undefined を返す", () => {
    expect(asNonEmpty([])).toBeUndefined();
  });
});

describe("preferReadyCandidate", () => {
  it("セットアップ済みの候補を優先する", () => {
    expect(
      preferReadyCandidate(
        [
          { item: ".ziku", ready: false },
          { item: ".github", ready: true },
        ],
        ".ziku",
      ),
    ).toBe(".github");
  });

  it("セットアップ済みが複数あれば先頭を選ぶ", () => {
    expect(
      preferReadyCandidate(
        [
          { item: ".ziku", ready: true },
          { item: ".github", ready: true },
        ],
        ".ziku",
      ),
    ).toBe(".ziku");
  });

  it("どれもセットアップ済みでなければ fallback を選ぶ", () => {
    expect(preferReadyCandidate([{ item: ".github", ready: false }], ".ziku")).toBe(".ziku");
  });
});

describe("buildOwnerCandidates", () => {
  it("認証ユーザーを git remote のオーナーより先に置く", () => {
    expect(
      buildOwnerCandidates({
        authenticatedUser: "me",
        detectedOwner: "my-org",
        repos: [".ziku", ".github"],
      }),
    ).toEqual([
      { owner: "me", repo: ".ziku", label: "Your account" },
      { owner: "me", repo: ".github", label: "Your account" },
      { owner: "my-org", repo: ".ziku", label: "Git remote owner" },
      { owner: "my-org", repo: ".github", label: "Git remote owner" },
    ]);
  });

  it("同じ owner/repo は先に入れた方だけを残す", () => {
    expect(
      buildOwnerCandidates({ authenticatedUser: "me", detectedOwner: "me", repos: [".ziku"] }),
    ).toEqual([{ owner: "me", repo: ".ziku", label: "Your account" }]);
  });

  it("オーナーが 1 つも分からなければ候補も無い", () => {
    expect(
      buildOwnerCandidates({
        authenticatedUser: undefined,
        detectedOwner: undefined,
        repos: [".ziku"],
      }),
    ).toEqual([]);
  });
});

describe("withReadyFlags", () => {
  it("セットアップ状態を候補へ写す", () => {
    expect(
      withReadyFlags([
        { item: candidate("me", ".ziku"), ready: true },
        { item: candidate("me", ".github"), ready: false },
      ]),
    ).toEqual([
      { owner: "me", repo: ".ziku", label: "Your account", ready: true },
      { owner: "me", repo: ".github", label: "Your account", ready: false },
    ]);
  });
});

describe("deduplicateByOwner", () => {
  it("同じオーナーではセットアップ済みを優先する", () => {
    expect(
      deduplicateByOwner([candidate("me", ".ziku", false), candidate("me", ".github", true)]),
    ).toEqual([candidate("me", ".github", true)]);
  });

  it("同じ確度なら渡された順の先頭を残す", () => {
    expect(
      deduplicateByOwner([candidate("me", ".ziku", true), candidate("me", ".github", true)]),
    ).toEqual([candidate("me", ".ziku", true)]);
  });

  it("オーナー名の大小は区別しない", () => {
    expect(
      deduplicateByOwner([candidate("Me", ".ziku", true), candidate("me", ".github", true)]),
    ).toHaveLength(1);
  });

  it("オーナーが違えば両方残る", () => {
    const candidates = [candidate("me", ".ziku", true), candidate("my-org", ".ziku", true)];
    expect(deduplicateByOwner(candidates)).toEqual(candidates);
  });
});

describe("planNonInteractiveSource", () => {
  it("候補が 1 つに絞れればそれを使う", () => {
    expect(
      planNonInteractiveSource([candidate("me", ".ziku", true)], [candidate("me", ".ziku")]),
    ).toEqual({ _tag: "Use", owner: "me", repo: ".ziku" });
  });

  it("オーナーをまたいで候補が残るなら、人に選ばせるため中断する", () => {
    expect(
      planNonInteractiveSource(
        [candidate("me", ".ziku", true), candidate("my-org", ".github", true)],
        [],
      ),
    ).toEqual({ _tag: "Ambiguous", candidates: ["me/.ziku", "my-org/.github"] });
  });

  it("探した先にテンプレートが無ければ、どこを探したかを示す", () => {
    expect(
      planNonInteractiveSource([], [candidate("me", ".ziku"), candidate("me", ".github")]),
    ).toEqual({ _tag: "NotFound", repos: ["me/.ziku"] });
  });

  it("探す先すら分からなければ検出不能として扱う", () => {
    expect(planNonInteractiveSource([], [])).toEqual({ _tag: "Undetectable" });
  });
});

describe("planInteractiveSource", () => {
  it("存在する候補があれば選ばせる", () => {
    const candidates = [candidate("me", ".ziku", true)];
    expect(planInteractiveSource(candidates, candidates)).toEqual({
      _tag: "ChooseCandidate",
      candidates,
    });
  });

  it("候補は挙がったが存在しなければ、作成するか聞く", () => {
    expect(
      planInteractiveSource([], [candidate("me", ".ziku"), candidate("me", ".github")]),
    ).toEqual({ _tag: "OfferCreation", owner: "me", repo: ".ziku" });
  });

  it("候補が挙がらなければ入力してもらう", () => {
    expect(planInteractiveSource([], [])).toEqual({ _tag: "AskInput" });
  });
});

describe("planMissingTemplateAction", () => {
  it("作成を選んだらリポジトリを作る", () => {
    expect(
      planMissingTemplateAction("create-repo", { owner: "me", repo: ".ziku", dryRun: false }),
    ).toEqual({ _tag: "CreateRepo" });
  });

  it("dry-run では作成せず、何をしようとしたかを示して中断する", () => {
    expect(
      planMissingTemplateAction("create-repo", { owner: "me", repo: ".ziku", dryRun: true }),
    ).toEqual({
      _tag: "CreationBlocked",
      operation: "Would create template repository me/.ziku",
    });
  });

  it("別のソース指定を選んだら入力してもらう", () => {
    expect(
      planMissingTemplateAction("specify-source", { owner: "me", repo: ".ziku", dryRun: true }),
    ).toEqual({ _tag: "AskInput" });
  });
});
