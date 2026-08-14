/**
 * init が「どのテンプレートを、どこから、どう配置するか」を決める計算。
 *
 * ファイルシステム・GitHub API・プロンプトのいずれにも触れず、CLI 引数・テンプレートの
 * パターン・存在確認の結果・既に確定したユーザーの選択だけから次の行動を導く。`init.ts` は
 * I/O とユーザーへの問い合わせを担い、その結果をここへ渡して返ってきた判断を実行する。
 *
 * 分割の狙いは、init の判断（どのディレクトリを配置するか / 既存ファイルをどう扱うか /
 * lock に何を書くか / テンプレートソースが確定しないときどうするか）を、GitHub も
 * ファイルシステムも用意せずに検証できる形に保つこと。
 */
import { P, match } from "ts-pattern";
import type {
  CommitSha,
  FileAction,
  FileOperationResult,
  GlobPattern,
  HashMap,
  LockState,
  OverwriteStrategy,
  RepoRelPath,
  TemplateSource,
} from "../modules/schemas";
import { createPendingLock, markSynced } from "../modules/schemas";
import type { TemplateCandidate } from "../ui/prompts";
import type { RepoExistence } from "../utils/github";
import { hashContent } from "../utils/hash";
import { repoRelPath } from "../utils/paths";
import type { FlatPatterns } from "../utils/patterns";

// ─── 空でない候補列 ───

/**
 * 少なくとも 1 要素を持つ配列。
 *
 * 「候補が 1 つも無い」は候補選びとは別の結末（エラー）になるので、選ぶ側の関数へ空の列が
 * 流れ込まないようにする。呼び出し側は {@link asNonEmpty} で 1 度だけ分岐すればよい。
 */
export type NonEmptyArray<T> = readonly [T, ...T[]];

/** 空なら `undefined` を返し、要素があることを型に持たせる。 */
export function asNonEmpty<T>(items: readonly T[]): NonEmptyArray<T> | undefined {
  return items.length === 0 ? undefined : [items[0], ...items.slice(1)];
}

// ─── 引数の解釈 ───

/** `--from` の読み取り結果。owner だけの指定は既定リポジトリの探索へ回る。 */
export type FromArgPlan =
  | { readonly _tag: "Repo"; readonly owner: string; readonly repo: string }
  | { readonly _tag: "OwnerOnly"; readonly owner: string }
  | { readonly _tag: "Invalid"; readonly value: string };

/**
 * `--from` の値を読む。
 *
 * `owner/repo` はそのリポジトリ 1 つを指す。`owner` だけなら、どの既定リポジトリを使うかは
 * 存在確認をしないと決められないので、リポジトリ名を補わずに owner だけを返す。
 * 区切りが端にある（`owner/` / `/repo`）値は、どちらの形としても読めないので弾く。
 */
export function planFromArg(from: string): FromArgPlan {
  const slashIndex = from.indexOf("/");
  if (slashIndex === -1) {
    return from.trim() ? { _tag: "OwnerOnly", owner: from } : { _tag: "Invalid", value: from };
  }
  if (slashIndex === 0 || slashIndex === from.length - 1) {
    return { _tag: "Invalid", value: from };
  }
  return {
    _tag: "Repo",
    owner: from.slice(0, slashIndex),
    repo: from.slice(slashIndex + 1),
  };
}

/**
 * ユーザーが入力した `owner/repo` を分解する。
 *
 * 入力欄の検証は入力プロンプト側が済ませているので、ここは分解だけを行う。
 */
export function splitOwnerRepo(input: string): { owner: string; repo: string } {
  const slashIndex = input.indexOf("/");
  return { owner: input.slice(0, slashIndex), repo: input.slice(slashIndex + 1) };
}

// ─── 配置するディレクトリの決定 ───

/** テンプレートの include パターンを、選択単位（トップレベルディレクトリ）でまとめたもの。 */
export interface TemplateDirectoryEntry {
  readonly label: string;
  readonly patterns: readonly GlobPattern[];
}

/** どのディレクトリを配置するかの決め方。 */
export type DirectorySelectionPlan =
  /** 対話を省くので全ディレクトリを配置する。`directoryCount` は配置数の通知に使う。 */
  | {
      readonly _tag: "SelectAll";
      readonly patterns: GlobPattern[];
      readonly directoryCount: number;
    }
  /** `--dirs` で名指しされたディレクトリだけを配置する。 */
  | { readonly _tag: "SelectNamed"; readonly patterns: GlobPattern[] }
  /** `--dirs` にテンプレートへ存在しないラベルが混ざっている。 */
  | {
      readonly _tag: "UnknownDirs";
      readonly unknown: readonly string[];
      readonly available: readonly string[];
    }
  /** ユーザーに選ばせる。 */
  | { readonly _tag: "AskUser" };

/**
 * 引数からディレクトリ選択の進め方を決める。
 *
 * `--dirs` は `--yes` より優先する。両方付いているのは「対話は要らないが、対象は自分で
 * 決める」という指定で、全ディレクトリへ広げると指定が無視されたことになるため。
 */
export function planDirectorySelection(
  entries: readonly TemplateDirectoryEntry[],
  opts: { readonly yes: boolean; readonly dirsArg: string | undefined },
): DirectorySelectionPlan {
  const dirsArg = opts.dirsArg;
  if (dirsArg === undefined || dirsArg.length === 0) {
    return opts.yes
      ? {
          _tag: "SelectAll",
          patterns: entries.flatMap((e) => [...e.patterns]),
          directoryCount: entries.length,
        }
      : { _tag: "AskUser" };
  }

  const requestedLabels = dirsArg.split(",").map((s) => s.trim());
  const availableLabels = entries.map((e) => e.label);
  const unknown = requestedLabels.filter((l) => !availableLabels.includes(l));
  if (unknown.length > 0) {
    return { _tag: "UnknownDirs", unknown, available: availableLabels };
  }
  return {
    _tag: "SelectNamed",
    patterns: entries
      .filter((e) => requestedLabels.includes(e.label))
      .flatMap((e) => [...e.patterns]),
  };
}

/**
 * 選ばれた include と、テンプレートの exclude から、実際に適用するパターンを組み立てる。
 *
 * exclude は選択に関わらず全て適用する。除外は「配るべきでないもの」の指定なので、
 * include を絞ったからといって緩めると、選んだディレクトリの中に除外対象が復活する。
 */
export function selectedFlatPatterns(
  templateConfig: {
    readonly include: readonly GlobPattern[];
    readonly exclude?: readonly GlobPattern[];
  },
  selectedInclude: readonly GlobPattern[],
): FlatPatterns {
  return {
    include: [...selectedInclude],
    exclude: [...(templateConfig.exclude ?? [])],
  };
}

/**
 * devcontainer の環境変数サンプルを一緒に作るか。
 *
 * `.devcontainer/` を配置しないプロジェクトに `devcontainer.env.example` だけが現れると、
 * 何のためのファイルか分からないゴミになる。
 */
export function requiresDevcontainerEnvExample(include: readonly GlobPattern[]): boolean {
  return include.some((p) => p.startsWith(".devcontainer/"));
}

// ─── 既存ファイルの扱い ───

/** 既存ファイルをどう扱うかの決め方。 */
export type OverwriteStrategyPlan =
  | { readonly _tag: "Decided"; readonly strategy: OverwriteStrategy }
  | { readonly _tag: "InvalidStrategy"; readonly value: string }
  | { readonly _tag: "AskUser" };

/**
 * 上書き戦略を CLI 引数・フラグから決める。
 *
 * 優先順位: `--force` > `--overwrite-strategy` > `--yes` > 対話。
 *
 * `--yes` が `skip` を選ぶのは、`--yes` が「プロンプトを省く」だけのフラグで、既存ファイルを
 * 失う承認を含まないため。既存の内容を捨ててよいかはユーザーにしか決められないので、
 * 承認が無い非対話実行では既存ファイルを残す側に倒す。上書きしたい場合は `--force`
 * （破壊的操作の承認）か `--overwrite-strategy overwrite`（明示指定）を使う。
 */
export function planOverwriteStrategy(opts: {
  readonly force: boolean;
  readonly strategyArg: string | undefined;
  readonly yes: boolean;
}): OverwriteStrategyPlan {
  if (opts.force) return { _tag: "Decided", strategy: "overwrite" };

  const strategyArg = opts.strategyArg;
  if (strategyArg !== undefined && strategyArg.length > 0) {
    return match(strategyArg)
      .with(
        P.union("overwrite", "skip", "prompt"),
        (strategy): OverwriteStrategyPlan => ({ _tag: "Decided", strategy }),
      )
      .otherwise((value): OverwriteStrategyPlan => ({ _tag: "InvalidStrategy", value }));
  }

  if (opts.yes) return { _tag: "Decided", strategy: "skip" };
  return { _tag: "AskUser" };
}

// ─── lock の初期状態 ───

/** lock の同期ベースに載せる 1 ファイル分のハッシュを、どちらの内容から取るか。 */
export type BaseHashOrigin =
  /** init が書き込んだので、ディスクの内容は書いた内容（テンプレート / 生成物）と一致する。 */
  | { readonly _tag: "Written" }
  /** 書き込みが起きなかったので、ディスクにある実内容から取る。 */
  | { readonly _tag: "LocalFile" };

/**
 * ファイル 1 つの扱いから、ベースに載せるハッシュの出どころを決める。
 *
 * `undefined`（そのファイルについて操作結果が無い）を書き込み側へ倒さないのは、init が
 * 触っていないファイルはディスクに在るとも無いとも言えないため。ディスクを見にいけば、
 * 在れば実内容が、無ければ「ベース無し」が得られ、どちらも実態と一致する。
 */
export function baseHashOrigin(action: FileAction | undefined): BaseHashOrigin {
  return match(action)
    .with("copied", "created", "overwritten", (): BaseHashOrigin => ({ _tag: "Written" }))
    .with("skipped", "skipped_ignored", undefined, (): BaseHashOrigin => ({ _tag: "LocalFile" }))
    .exhaustive();
}

/** lock の同期ベースに載せるハッシュ表を、確定分とディスク参照分に分けたもの。 */
export interface LockBaseHashPlan {
  /** init が書いた内容から確定したハッシュ。そのままベースへ載る。 */
  readonly written: HashMap;
  /** ディスク上の実内容を読んでハッシュを取るファイル。 */
  readonly fromLocalFile: readonly RepoRelPath[];
}

/**
 * テンプレート側のハッシュ表とファイル操作の結果から、lock の同期ベースの作り方を決める。
 *
 * ## なぜ操作結果を見る必要があるか
 * lock のベースは「次回の pull / push が差分を測る基準」なので、ディスクに実在しない内容を
 * 記録すると、誰も編集していないのに次回の比較が差分を報告する。テンプレートを走査した
 * ハッシュをそのままベースにすると、上書き戦略が `skip` で残った既存ファイルについて
 * 「ローカルがテンプレートの内容から書き換えられた」という嘘のベースになり、status は
 * push を勧め、push はユーザーの無関係な既存ファイルでテンプレートを上書きし、pull は
 * ベースとテンプレートが一致するので何も降ろさない。`--yes` はプロンプトを省くだけで
 * 既存ファイルを失う承認を含まない（戦略は `skip` に解決される —
 * {@link planOverwriteStrategy}）ので、この食い違いは非対話実行のたびに起きる。
 *
 * ## 走査するのはテンプレートと生成物の両方
 * init が書くファイルはテンプレート由来のものだけではない（`.devcontainer/devcontainer.env.example`
 * のように init 自身が組み立てるものがある）。テンプレートのハッシュ表だけを走査すると、
 * そうしたファイルにベースのエントリが付かず、次回の分類は {base 無・local 有・template 無} を
 * `localOnly`（ローカルだけが作った）と読む。すると `push --yes` が ziku 自身の生成物を
 * テンプレートへ送り、そこから pull で全プロジェクトへ配られる。
 *
 * ベースへ載せると、そのファイルは次回以降 {base 有・local 有・template 無} になり、pull からは
 * テンプレート側の削除候補に見える（対話なら選択、`--force` なら削除）。載せない側の帰結が
 * 「テンプレートへ送って全プロジェクトへ配る」で取り消せないのに対し、こちらは 1 つの
 * プロジェクトの中で完結し、利用者が残す側を選べる。
 *
 * ## 判断とディスク読み取りの分離
 * ここはどのファイルをどちらの内容から取るかだけを決め、ディスクは読まない。`fromLocalFile`
 * のファイルを読んでハッシュを取るのは呼び出し側の役目。
 *
 * @param params.templateHashes    テンプレートを走査して得たハッシュ表
 * @param params.generatedContents init が自分で組み立てて書く本文（パス → 本文）。テンプレートに
 *   同じパスがあっても、書き込みが起きた後のディスクにはこちらが載る。`.ziku/ziku.jsonc` が
 *   代表例で、init はテンプレートのパターンの **部分集合** だけを選んで導入できる（ユーザーが
 *   dir を選択する）ため、ローカルの本文はテンプレートより少ないことがある。テンプレートの
 *   本文をベースにすると local(部分集合) != base(full) == template となり、push が「local が
 *   パターンを削除した」と解釈して **テンプレートからパターンを削る**（そのテンプレートを使う
 *   全プロジェクトへ波及する）。init が書いた本文をベースにすれば local == base で push
 *   対象外になり、pull では template != base == local としてテンプレートの全体設定が降りてくる。
 * @param params.results           init が行ったファイル操作の結果
 */
export function planLockBaseHashes(params: {
  readonly templateHashes: HashMap;
  readonly generatedContents: ReadonlyMap<RepoRelPath, string>;
  readonly results: readonly FileOperationResult[];
}): LockBaseHashPlan {
  const actions = new Map<string, FileAction>(params.results.map((r) => [r.path, r.action]));

  // init が書き込んだ場合にベースへ載る内容。生成物はその本文から、それ以外はテンプレートの
  // 走査結果から取る。テンプレートに無いパスもここで揃うので、以降は出所を意識せず扱える。
  const ifWritten: HashMap = { ...params.templateHashes };
  for (const [path, content] of params.generatedContents) {
    ifWritten[path] = hashContent(content);
  }

  const written: HashMap = {};
  const fromLocalFile: RepoRelPath[] = [];
  for (const [rawPath, hash] of Object.entries(ifWritten)) {
    const path = repoRelPath(rawPath);
    match(baseHashOrigin(actions.get(rawPath)))
      .with({ _tag: "Written" }, () => {
        written[path] = hash;
      })
      .with({ _tag: "LocalFile" }, () => {
        fromLocalFile.push(path);
      })
      .exhaustive();
  }
  return { written, fromLocalFile };
}

/**
 * init が書き出す lock の初期状態を組み立てる。
 *
 * ハッシュが 1 件も取れなかった場合はベース未確定（`pending`）のまま残す。空のベースを
 * 「確定したベース」として書くと、次回以降テンプレート全体が新規扱いになる事実が
 * 読み取れなくなる。
 */
export function buildInitialLock(params: {
  readonly version: string;
  readonly installedAt: string;
  readonly source: TemplateSource;
  readonly baseHashes: HashMap;
  readonly baseCommit: CommitSha | undefined;
}): LockState {
  const pending = createPendingLock({
    version: params.version,
    installedAt: params.installedAt,
    source: params.source,
  });
  return Object.keys(params.baseHashes).length > 0
    ? markSynced(pending, { hashes: params.baseHashes, commitSha: params.baseCommit })
    : pending;
}

// ─── 実行結果の伝え方 ───

/** 適用を終えた時点で、ユーザーに何を伝えるか。 */
export type InitOutcome =
  /** 追加も更新も起きなかった（全て既存のまま）。 */
  | { readonly _tag: "NoChanges" }
  /** dry-run なので、同じコマンドを本番実行する案内を出す。 */
  | { readonly _tag: "DryRunPreview" }
  /** 実際に書き込んだので、次のステップを案内する。 */
  | { readonly _tag: "Applied" };

/**
 * ファイル操作のサマリーと実行モードから、締めくくりの伝え方を決める。
 *
 * 変更が無いことを先に見るのは、dry-run でも「何も起きない」ことは伝える価値があるため。
 */
export function planInitOutcome(params: {
  readonly summary: { readonly added: number; readonly updated: number };
  readonly dryRun: boolean;
}): InitOutcome {
  if (params.summary.added === 0 && params.summary.updated === 0) return { _tag: "NoChanges" };
  return params.dryRun ? { _tag: "DryRunPreview" } : { _tag: "Applied" };
}

// ─── テンプレートソースの解決 ───

/** 存在確認そのものが成立しなかったことを表す結果。候補選びを続けられない。 */
export type BlockingExistence = Extract<
  RepoExistence,
  { readonly _tag: "RateLimited" | "Unauthorized" }
>;

/** 5xx やネットワーク断など、「無い」と断定できない結果。 */
export type UnverifiedExistence = Extract<RepoExistence, { readonly _tag: "Unknown" }>;

/** 1 つのリポジトリの存在確認から導いた次の行動。 */
export type RepoProbeDecision =
  /** 存在を確認できた。 */
  | { readonly _tag: "Verified" }
  /**
   * 確認できなかったが、無いとも言えない。候補として採用し、実際の取得時に本来のエラーを
   * 出させる。除外すると transient な障害で本来存在するリポジトリを "not found" 扱いにする。
   */
  | { readonly _tag: "Unverified"; readonly existence: UnverifiedExistence }
  /** 存在しないと確認できた。 */
  | { readonly _tag: "Absent" }
  /** 確認の可否自体が判定できない。 */
  | { readonly _tag: "Blocked"; readonly existence: BlockingExistence };

/** 存在確認の結果を、呼び出し側が分岐できる 4 つの行動へ落とす。 */
export function decideRepoProbe(existence: RepoExistence): RepoProbeDecision {
  return match(existence)
    .with({ _tag: "Exists" }, (): RepoProbeDecision => ({ _tag: "Verified" }))
    .with({ _tag: "Unknown" }, (u): RepoProbeDecision => ({ _tag: "Unverified", existence: u }))
    .with({ _tag: "NotFound" }, (): RepoProbeDecision => ({ _tag: "Absent" }))
    .with(
      { _tag: P.union("RateLimited", "Unauthorized") },
      (b): RepoProbeDecision => ({ _tag: "Blocked", existence: b }),
    )
    .exhaustive();
}

/** 並列の存在確認を、候補選びへ進めてよいかどうかで振り分けた結果。 */
export type ProbeGate =
  /** 進んでよい。`degraded` は警告に降格した確認不能の結果。 */
  | { readonly _tag: "Proceed"; readonly degraded: readonly BlockingExistence[] }
  /** 判定が全く不能なので、明確なエラーで止める。 */
  | { readonly _tag: "Blocked"; readonly existence: BlockingExistence };

/**
 * 並列存在チェックの結果から、RateLimited / Unauthorized を即失敗にすべきか判断する。
 *
 * `Promise.all` で複数候補を並列に問い合わせると、クォータ境界で `[Exists, RateLimited]` の
 * ように混在することがある。確認済みの Exists が 1 つでもあれば、RateLimited /
 * Unauthorized は警告に降格して候補選択を続行する。Exists が無ければ判定が全く不能なので、
 * RateLimited → Unauthorized の順で明確なエラーにする。
 */
export function gateProbeResults(results: readonly RepoExistence[]): ProbeGate {
  const blocking = results.filter((r): r is BlockingExistence =>
    match(r)
      .with({ _tag: P.union("RateLimited", "Unauthorized") }, () => true)
      .with({ _tag: P.union("Exists", "NotFound", "Unknown") }, () => false)
      .exhaustive(),
  );
  if (results.some((r) => r._tag === "Exists")) {
    return { _tag: "Proceed", degraded: blocking };
  }

  const rateLimited = blocking.find((r) => r._tag === "RateLimited");
  if (rateLimited) return { _tag: "Blocked", existence: rateLimited };
  const unauthorized = blocking.find((r) => r._tag === "Unauthorized");
  if (unauthorized) return { _tag: "Blocked", existence: unauthorized };
  return { _tag: "Proceed", degraded: [] };
}

/** 存在確認とその対象を組にしたもの。並列問い合わせの結果を取り違えずに渡すための形。 */
export interface ProbedItem<T> {
  readonly item: T;
  readonly existence: RepoExistence;
}

/** 候補を「ありえる順」に並べ替えた結果。 */
export interface ProbedCandidates<T> {
  /** Exists を先頭、Unknown を末尾に並べた候補。NotFound は落とす。 */
  readonly usable: T[];
  /** 確認できなかった候補。採用する前にユーザーへ警告するために返す。 */
  readonly unverified: readonly { readonly item: T; readonly existence: UnverifiedExistence }[];
}

/**
 * 存在確認の結果で候補を絞り、確認済みを優先する順に並べ替える。
 *
 * 先頭の候補は「セットアップ済みが無ければこれを使う」フォールバックとして選ばれるため、
 * 確認できていない候補が確認済みより前に来ると、transient な障害の候補を掴んでしまう。
 * 同じ確度の候補どうしでは、渡された順序（既定リポジトリの優先順）を保つ。
 */
export function orderProbedCandidates<T>(probes: readonly ProbedItem<T>[]): ProbedCandidates<T> {
  const verified: T[] = [];
  const unknown: T[] = [];
  const unverified: { item: T; existence: UnverifiedExistence }[] = [];

  for (const probe of probes) {
    match(decideRepoProbe(probe.existence))
      .with({ _tag: "Verified" }, () => {
        verified.push(probe.item);
      })
      .with({ _tag: "Unverified" }, ({ existence }) => {
        unknown.push(probe.item);
        unverified.push({ item: probe.item, existence });
      })
      .with({ _tag: P.union("Absent", "Blocked") }, () => {})
      .exhaustive();
  }

  return { usable: [...verified, ...unknown], unverified };
}

/** セットアップ状態を確かめた候補。 */
export interface CandidateSetup<T> {
  readonly item: T;
  /** `.ziku/ziku.jsonc` を持つ（テンプレートとして使える状態）か。 */
  readonly ready: boolean;
}

/**
 * セットアップ済みの候補を優先して 1 つ選ぶ。
 *
 * どれもセットアップ済みでなければ `fallback` を返す。テンプレートとして未完成でも、取得を
 * 試みて「ziku setup を実行してください」と案内できる方が、候補なしで止めるより先へ進める。
 * 呼び出し側は候補が空でないことを {@link asNonEmpty} で確かめ、その先頭を `fallback` に渡す。
 */
export function preferReadyCandidate<T>(setups: readonly CandidateSetup<T>[], fallback: T): T {
  return setups.find((s) => s.ready)?.item ?? fallback;
}

/**
 * 認証ユーザーと git remote のオーナーから、探すべきテンプレート候補を組み立てる。
 *
 * 認証ユーザーを先に置くのは、自分のアカウントのテンプレートが最も高い確度で「使ってよい
 * もの」だから。同じ owner/repo が両方から出たら先に入れた方を残す。
 */
export function buildOwnerCandidates(params: {
  readonly authenticatedUser: string | undefined;
  readonly detectedOwner: string | undefined;
  readonly repos: readonly string[];
}): TemplateCandidate[] {
  const owners: { name: string; label: string }[] = [];
  if (params.authenticatedUser !== undefined) {
    owners.push({ name: params.authenticatedUser, label: "Your account" });
  }
  if (params.detectedOwner !== undefined) {
    owners.push({ name: params.detectedOwner, label: "Git remote owner" });
  }

  const seen = new Set<string>();
  const candidates: TemplateCandidate[] = [];
  for (const owner of owners) {
    for (const repo of params.repos) {
      const key = `${owner.name}/${repo}`;
      if (seen.has(key)) continue;
      seen.add(key);
      candidates.push({ owner: owner.name, repo, label: owner.label });
    }
  }
  return candidates;
}

/** セットアップ状態を候補へ写して、選択 UI が ready を出せるようにする。 */
export function withReadyFlags(
  setups: readonly CandidateSetup<TemplateCandidate>[],
): TemplateCandidate[] {
  return setups.map((s) => ({ ...s.item, ready: s.ready }));
}

/**
 * 同一オーナーの候補を重複排除する。
 *
 * セットアップ済み（ready=true）の候補を優先し、同順なら渡された順（既定リポジトリの
 * 優先順）で選ぶ。オーナー名の大小は GitHub 上で区別されないので、比較は小文字で行う。
 */
export function deduplicateByOwner(candidates: readonly TemplateCandidate[]): TemplateCandidate[] {
  const byOwner = new Map<string, TemplateCandidate>();
  for (const c of candidates) {
    const key = c.owner.toLowerCase();
    const existing = byOwner.get(key);
    if (existing === undefined || (c.ready === true && existing.ready !== true)) {
      byOwner.set(key, c);
    }
  }
  return [...byOwner.values()];
}

/** 対話を省く実行で、テンプレートソースをどう決めるか。 */
export type NonInteractiveSourcePlan =
  | { readonly _tag: "Use"; readonly owner: string; readonly repo: string }
  /** オーナーをまたいで候補が複数ある。どれを使うかは人にしか決められない。 */
  | { readonly _tag: "Ambiguous"; readonly candidates: readonly string[] }
  /** 探す先は分かったが、そこにテンプレートが無い。 */
  | { readonly _tag: "NotFound"; readonly repos: readonly string[] }
  /** 探す先すら分からない。 */
  | { readonly _tag: "Undetectable" };

/**
 * 対話を省く実行でのテンプレートソースを決める。
 *
 * @param deduplicated オーナー単位に絞った、存在を確かめられた候補。
 * @param probedCandidates 存在確認を行った候補全体。1 件も存在しなかったときに、
 *   どこを探したのかをエラーで示すために使う。
 */
export function planNonInteractiveSource(
  deduplicated: readonly TemplateCandidate[],
  probedCandidates: readonly TemplateCandidate[],
): NonInteractiveSourcePlan {
  const single = deduplicated.length === 1 ? deduplicated[0] : undefined;
  if (single !== undefined) return { _tag: "Use", owner: single.owner, repo: single.repo };
  if (deduplicated.length > 1) {
    return {
      _tag: "Ambiguous",
      candidates: deduplicated.map((c) => `${c.owner}/${c.repo}`),
    };
  }

  const first = probedCandidates[0];
  if (first !== undefined) return { _tag: "NotFound", repos: [`${first.owner}/${first.repo}`] };
  return { _tag: "Undetectable" };
}

/** 対話ありの実行で、テンプレートソースをどう聞くか。 */
export type InteractiveSourcePlan =
  /** 見つかった候補から選ばせる。 */
  | { readonly _tag: "ChooseCandidate"; readonly candidates: readonly TemplateCandidate[] }
  /** 探す先は分かったがテンプレートが無いので、作成するか別を指定するかを聞く。 */
  | { readonly _tag: "OfferCreation"; readonly owner: string; readonly repo: string }
  /** 探す先が分からないので、直接入力してもらう。 */
  | { readonly _tag: "AskInput" };

/**
 * 対話ありの実行で、テンプレートソースの聞き方を決める。
 *
 * @param existingCandidates 存在を確かめられた候補。
 * @param probedCandidates 存在確認を行った候補全体。
 */
export function planInteractiveSource(
  existingCandidates: readonly TemplateCandidate[],
  probedCandidates: readonly TemplateCandidate[],
): InteractiveSourcePlan {
  if (existingCandidates.length > 0) {
    return { _tag: "ChooseCandidate", candidates: existingCandidates };
  }
  const first = probedCandidates[0];
  if (first !== undefined) return { _tag: "OfferCreation", owner: first.owner, repo: first.repo };
  return { _tag: "AskInput" };
}

/** テンプレートが無いときに、ユーザーが選んだ行動をどう実行するか。 */
export type MissingTemplatePlan =
  | { readonly _tag: "CreateRepo" }
  /** dry-run ではリポジトリ作成を実行できないので、操作内容を示して中断する。 */
  | { readonly _tag: "CreationBlocked"; readonly operation: string }
  | { readonly _tag: "AskInput" };

/**
 * テンプレートが見つからないときの選択を、実行できる形に落とす。
 *
 * dry-run で "create-repo" を実行しないのは、リポジトリ作成がローカルの取り消し可能な変更
 * ではなく GitHub 上への実書き込みだから。他の dry-run 分岐（ファイル書き込みの省略）と
 * 違って「実行したふり」ができず、プレビューを続けるための有効なソースも作れない。
 */
export function planMissingTemplateAction(
  action: "create-repo" | "specify-source",
  context: { readonly owner: string; readonly repo: string; readonly dryRun: boolean },
): MissingTemplatePlan {
  return match(action)
    .with(
      "create-repo",
      (): MissingTemplatePlan =>
        context.dryRun
          ? {
              _tag: "CreationBlocked",
              operation: `Would create template repository ${context.owner}/${context.repo}`,
            }
          : { _tag: "CreateRepo" },
    )
    .with("specify-source", (): MissingTemplatePlan => ({ _tag: "AskInput" }))
    .exhaustive();
}
