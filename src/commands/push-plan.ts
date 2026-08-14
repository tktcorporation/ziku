/**
 * push が「何をテンプレートへ送るか」を決める計算。
 *
 * ファイルシステム・GitHub API・プロンプトのいずれにも触れず、渡された分類結果・差分・
 * 既に確定したユーザーの選択だけから送信対象を導く。`push.ts` は I/O とユーザーへの
 * 問い合わせを担い、その結果をここへ渡して返ってきた計画を実行する。
 *
 * 分割の狙いは、送信対象の判断（どのファイルを送るか / 何を送らないか / テンプレートの
 * 削除を取り消すのはどれか / `ziku.jsonc` に何を載せるか）を、外部環境を用意せずに
 * 検証できる形に保つこと。
 */
import { P, match } from "ts-pattern";
import { z } from "zod/v4";
import type { FileDiff, GitHubSource, GlobPattern, RepoRelPath } from "../modules/schemas";
import type { MergedContent } from "../utils/merge";
import type { SyncPlan } from "../utils/merge/sync-plan";
import { zikuConfigPushAction } from "../utils/merge/sync-plan";
import { pathAsPattern, repoRelPath } from "../utils/paths";
import { ZIKU_CONFIG_FILE, isZikuConfigPath } from "../utils/ziku-config";

// ─── テンプレートへ送る内容 ───

/**
 * テンプレートへ送るファイル内容。PR の本文にも、ローカルテンプレートへの書き込みにも
 * この型しか渡らない。
 *
 * 送るものは 2 系統ある。ユーザーがローカルに書いた内容（および ziku が組み立てた
 * `ziku.jsonc` の和集合）と、3-way マージの結果。前者はユーザー自身のテキストなので
 * ziku が中身を選り分ける立場にない。後者は ziku が生成したものなので、コンフリクト
 * マーカーを含んだままテンプレートへ配ってしまう事故が起こりうる。
 *
 * そこでマージ結果の入口を {@link mergedAsPushContent} だけに絞り、その引数を
 * `MergedContent`（マーカー非混入が検証済み）に限定する。マーカー入りと確定した
 * `ConflictedContent` は、この型へ変換する手段が無いので送信対象へ入れられない。
 */
const PushContentSchema = z.string().brand("PushContent");
export type PushContent = z.infer<typeof PushContentSchema>;

/** ローカルに実在する内容（ユーザーが書いたファイル・ziku が組み立てた設定）を送る。 */
export function asPushContent(content: string): PushContent {
  return PushContentSchema.parse(content);
}

/** 3-way マージの結果を送る。クリーンと判定された内容だけがこの経路を通れる。 */
export function mergedAsPushContent(content: MergedContent): PushContent {
  return PushContentSchema.parse(content);
}

/**
 * テンプレートへ送りうる差分。`unchanged` を除いた 3 種別だけを持つ。
 *
 * 送信対象は「ローカルとテンプレートで内容が違うもの」に限られる。種別を絞った型で
 * 持ち回ると、サマリ表示や送信ペイロードの構築が `unchanged` を考慮せずに書ける。
 */
export type ChangedFileDiff = Extract<FileDiff, { type: "added" | "modified" | "deleted" }>;

// ─── 送信候補の決定 ───

/** 分類結果から導いた、送信候補とその扱い。 */
export interface PushCandidatePlan {
  /** テンプレートへ送る候補のパス。ここに無いパスは選択肢にも上がらない。 */
  readonly pushablePaths: ReadonlySet<RepoRelPath>;
  /**
   * 送るとテンプレート側の削除を取り消すことになるパス。
   *
   * 同じ「追加」の見た目でも意味が違うので、サマリで区別して見せる。
   * {@link defaultPushSelection} はこの集合を既定から外す。
   */
  readonly restoresTemplateDeletion: ReadonlySet<RepoRelPath>;
  /** テンプレート側だけが変えたので送らないパス。pull を促す対象として見せる。 */
  readonly skippedTemplateOnly: readonly RepoRelPath[];
  /**
   * `ziku.jsonc` を加法 union の内容で送るか。true なら呼び出し側が union を計算して
   * 送信内容へ載せる（`pushablePaths` には既に含まれている）。
   */
  readonly sendsConfigUnion: boolean;
}

/**
 * 分類結果から、テンプレートへ送る候補と送らないものを決める。
 *
 * 呼び出し側が前提にしてよいこと:
 * - `pushablePaths` は分類とその設定ファイル規則だけから決まる。ユーザーの選択・
 *   `--files`・未解決の衝突はここでは考慮しない（後段の選択で絞る）。
 * - `sendsConfigUnion` が true のとき、`pushablePaths` は `ziku.jsonc` を含む。
 *   送る内容はローカルの生の内容ではなく加法 union で、その計算は呼び出し側が行う。
 *   生の内容を送ると、ローカルがパターンを削除していた場合にテンプレート側のパターンまで
 *   消えてしまう。
 */
export function planPushCandidates(plan: SyncPlan): PushCandidatePlan {
  const classification = plan.files;
  const pushablePaths = new Set<RepoRelPath>([
    ...classification.localOnly,
    ...classification.conflicts,
    ...classification.deletedLocally,
    // テンプレートに無く、ローカルにだけ編集済みの内容がある状態。候補には入るが、送ると
    // テンプレート側の削除が取り消されるため既定では選ばない（{@link defaultPushSelection}）。
    ...classification.deletedWithLocalEdits,
  ]);
  const restoresTemplateDeletion = new Set<RepoRelPath>(classification.deletedWithLocalEdits);
  const skippedTemplateOnly: RepoRelPath[] = [...classification.autoUpdate];

  // 設定ファイルの扱いは分類カテゴリではなく sync-plan の判断に従う。
  const sendsConfigUnion = match(zikuConfigPushAction(plan.config))
    .with({ _tag: "Skip" }, () => false)
    .with({ _tag: "TemplateOnly" }, () => {
      skippedTemplateOnly.push(ZIKU_CONFIG_FILE);
      return false;
    })
    .with({ _tag: "SendUnion" }, ({ restoresTemplateDeletion: restores }) => {
      pushablePaths.add(ZIKU_CONFIG_FILE);
      if (restores) restoresTemplateDeletion.add(ZIKU_CONFIG_FILE);
      return true;
    })
    .exhaustive();

  return { pushablePaths, restoresTemplateDeletion, skippedTemplateOnly, sendsConfigUnion };
}

/**
 * 差分一覧から、分類が送信候補と判定したファイルだけを取り出す。
 *
 * 分類（ハッシュ比較）が「送ってよいか」を決め、差分は内容を供給する。両者を突き合わせる
 * のがこの関数で、候補に無いパスの内容が送信対象に混ざることはない。
 */
export function collectPushCandidates(
  diffFiles: readonly FileDiff[],
  pushablePaths: ReadonlySet<RepoRelPath>,
): ChangedFileDiff[] {
  return diffFiles.filter(
    (f): f is ChangedFileDiff => isChangedFileDiff(f) && pushablePaths.has(f.path),
  );
}

/**
 * 送信対象になりうる差分か。種別が増えたときは網羅性検査がここを止める。
 */
function isChangedFileDiff(diff: FileDiff): diff is ChangedFileDiff {
  return match(diff)
    .with({ type: P.union("added", "modified", "deleted") }, () => true)
    .with({ type: "unchanged" }, () => false)
    .exhaustive();
}

// ─── 送信対象の選択 ───

/**
 * 送信対象をどう選ぶか。ユーザーへの問い合わせはこの型の値を作るまでで完結し、
 * 選択そのものの適用は入力として渡された確定値だけで行う。
 */
export type PushFileSelection =
  /** `--files` で明示指定された。候補に無いパスは `notFound` として返る。 */
  | { readonly _tag: "Files"; readonly filesArg: string }
  /** 対話を省く（`--yes` / dry-run プレビュー）ので既定集合を使う。 */
  | {
      readonly _tag: "Default";
      readonly includeDeletions: boolean;
      readonly conflictedPaths: ReadonlySet<string>;
      readonly restoresTemplateDeletion: ReadonlySet<string>;
    }
  /** 対話で選ばれた結果をそのまま使う。 */
  | { readonly _tag: "Chosen"; readonly paths: readonly RepoRelPath[] };

export interface PushFileSelectionResult {
  readonly selected: readonly ChangedFileDiff[];
  /** `--files` に指定されたが候補に存在しなかったパス。他の選択方法では常に空。 */
  readonly notFound: readonly RepoRelPath[];
}

/**
 * `--files` 引数で送信候補を絞り込む。
 *
 * dry-run プレビューと実 push の両方で同じフィルタ規則を使うために共有する。
 * 共有しないと「プレビューに出た集合」と「実際に push される集合」が食い違う。
 *
 * @returns filtered: 指定パスに一致した候補、notFound: 候補に存在しなかった指定パス。
 */
export function filterByFilesArg(
  candidates: readonly ChangedFileDiff[],
  filesArg: string,
): { filtered: ChangedFileDiff[]; notFound: RepoRelPath[] } {
  // `--files` は CLI 引数。ここが相対パスの入口になる。
  const requestedPaths = filesArg
    .split(",")
    .map((p) => p.trim())
    .filter(Boolean)
    .map((p) => repoRelPath(p));
  const availablePaths = new Set<string>(candidates.map((f) => f.path));
  const notFound = requestedPaths.filter((p) => !availablePaths.has(p));
  const requestedSet = new Set<string>(requestedPaths);
  const filtered = candidates.filter((f) => requestedSet.has(f.path));
  return { filtered, notFound };
}

/**
 * 対話選択を経由しないときの既定集合を算出する。dry-run のプレビューと `--yes` の実 push が
 * 同じ集合になるよう共有する。
 *
 * 既定から外すもの:
 * - 未解決の衝突。選ぶと push が中断する。
 * - `--include-deletions` でない削除。テンプレートからファイルが消える。
 * - テンプレート側の削除を取り消すファイル（`restoresTemplateDeletion`）。
 *
 * 削除の取り消しを外す理由は、テンプレートが消したファイルが復活し、そのテンプレートを使う
 * 全プロジェクトへ配られるため。ファイルの削除を送るには `--include-deletions` というゲートが
 * あるのに取り消し側に無いと、`pull` より先に走った非対話 push がテンプレートの削除を黙って
 * 巻き戻す。フラグを増やさず既定から外すだけに留めるのは、削除の取り消しが必要になる場面が
 * 稀で、必要なときはユーザーが対話の一覧（`restores file deleted in template` の注記付き）を
 * 見て明示的に選べる状況だから。候補からは外さないので、意図があれば対話で送れる。
 */
export function defaultPushSelection(
  candidates: readonly ChangedFileDiff[],
  opts: {
    includeDeletions: boolean;
    conflictedPaths: ReadonlySet<string>;
    restoresTemplateDeletion: ReadonlySet<string>;
  },
): ChangedFileDiff[] {
  return candidates.filter(
    (f) =>
      !opts.conflictedPaths.has(f.path) &&
      !opts.restoresTemplateDeletion.has(f.path) &&
      (opts.includeDeletions || f.type !== "deleted"),
  );
}

/**
 * 確定した選択方法を候補へ適用する。
 *
 * 対話の結果（`Chosen`）はパスの集合として渡す。候補の順序が結果の順序になるので、
 * 選択方法が違っても送信対象の並びは候補一覧と同じになる。
 */
export function applyPushSelection(
  candidates: readonly ChangedFileDiff[],
  selection: PushFileSelection,
): PushFileSelectionResult {
  return match(selection)
    .with({ _tag: "Files" }, ({ filesArg }): PushFileSelectionResult => {
      const { filtered, notFound } = filterByFilesArg(candidates, filesArg);
      return { selected: filtered, notFound };
    })
    .with(
      { _tag: "Default" },
      (opts): PushFileSelectionResult => ({
        selected: defaultPushSelection(candidates, opts),
        notFound: [],
      }),
    )
    .with({ _tag: "Chosen" }, ({ paths }): PushFileSelectionResult => {
      const chosen = new Set<string>(paths);
      return { selected: candidates.filter((f) => chosen.has(f.path)), notFound: [] };
    })
    .exhaustive();
}

/**
 * 選択に混ざった未解決の衝突を洗い出す。
 *
 * 未解決ファイルはマージ結果ではなくローカルの内容がそのまま送られ、テンプレートの更新を
 * 黙って上書きしてしまう。1 件でも返ったら呼び出し側は push を中断する。
 */
export function selectedUnresolvedConflicts(
  selected: readonly ChangedFileDiff[],
  unresolvedConflicts: ReadonlySet<string>,
): ChangedFileDiff[] {
  return selected.filter((f) => unresolvedConflicts.has(f.path));
}

// ─── 送信ペイロード ───

/** テンプレートへ実際に送る内容。GitHub / ローカルテンプレートのどちらの経路も同じ形を受け取る。 */
export interface PushPayload {
  readonly files: readonly { readonly path: RepoRelPath; readonly content: PushContent }[];
  readonly deletions: readonly { readonly path: RepoRelPath }[];
}

/**
 * 選択済みの差分から送信ペイロードを組み立てる。
 *
 * 内容は自動マージ済みならその結果を、それ以外はローカルの内容をそのまま採用する。
 * `mergedContents` に載っているのはクリーンにマージできた内容と ziku が組み立てた
 * `ziku.jsonc` だけなので、未解決の衝突内容がここから送信対象へ入ることはない。
 */
export function buildPushPayload(
  selected: readonly ChangedFileDiff[],
  mergedContents: ReadonlyMap<RepoRelPath, PushContent>,
): PushPayload {
  return {
    files: selected
      .filter((f) => f.type !== "deleted")
      .map((f) => ({
        path: f.path,
        content: mergedContents.get(f.path) ?? asPushContent(f.localContent),
      })),
    deletions: selected.filter((f) => f.type === "deleted").map((f) => ({ path: f.path })),
  };
}

// ─── `ziku.jsonc` の伝播 ───

/**
 * 送信対象のファイルに必要な include パターンを、同じ push でテンプレートの `ziku.jsonc`
 * へ届けるための計画。
 *
 * ディスク上の `ziku.jsonc` は push 成功後まで更新されないため、対話で新規追跡したパターンは
 * 分類・差分から見えない。事前に `ziku track` 済みのパターンは見えるが、`--files` で
 * ファイル本体だけを指定すると選択から外れる。どちらも放置すると、テンプレートにファイル
 * 本体だけが届き include パターンが届かないため、他プロジェクトの `init` / `pull` が
 * そのファイルを拾えない。
 */
export type ConfigPropagationPlan =
  /** 追加で伝えるパターンが無い。`ziku.jsonc` の内容を組み直す必要もない。 */
  | { readonly _tag: "NoConfigChange" }
  /**
   * ローカル全体とテンプレートを和集合する。`ziku.jsonc` 自体が選択済みで、ローカルの
   * パターンを送る意図が明確な場合に使う。
   */
  | { readonly _tag: "MergeLocalConfig"; readonly extraIncludes: readonly GlobPattern[] }
  /**
   * テンプレートの内容に、今回の push に関係するパターンだけを足して和集合する。
   * ユーザーが `ziku.jsonc` を選んでいないのに自動同梱する場面で使い、今回の push と
   * 無関係なローカル限定パターンをテンプレートへ漏らさない。
   */
  | { readonly _tag: "MergeScopedConfig"; readonly additionalIncludes: readonly GlobPattern[] };

/**
 * 送信対象に必要な include パターンをどう `ziku.jsonc` へ載せるか決める。
 *
 * @param selectedPaths 送信対象として確定したパス。
 * @param newlyTrackedPaths 今回の push で追跡すると決めたパス。送信対象に残ったものだけが
 *   パターンとして載る（選択で外したファイルのパターンを先に送らない）。
 * @param localOnlyPatterns 送信対象に関係する、ローカルの `ziku.jsonc` にしか無いパターン。
 *   `selectedPaths` が `ziku.jsonc` を含む場合は参照しないので、呼び出し側は調査を省いてよい。
 */
export function planConfigPropagation(params: {
  readonly selectedPaths: readonly RepoRelPath[];
  readonly newlyTrackedPaths: readonly RepoRelPath[];
  readonly localOnlyPatterns: readonly GlobPattern[];
}): ConfigPropagationPlan {
  const configAlreadySelected = params.selectedPaths.some((p) => isZikuConfigPath(p));
  const selectedPathSet = new Set<string>(params.selectedPaths);
  const trackedAndPushed = params.newlyTrackedPaths
    .filter((p) => selectedPathSet.has(p))
    .map((path) => pathAsPattern(path));

  if (configAlreadySelected) {
    return trackedAndPushed.length === 0
      ? { _tag: "NoConfigChange" }
      : { _tag: "MergeLocalConfig", extraIncludes: trackedAndPushed };
  }

  if (trackedAndPushed.length === 0 && params.localOnlyPatterns.length === 0) {
    return { _tag: "NoConfigChange" };
  }

  return {
    _tag: "MergeScopedConfig",
    additionalIncludes: [...trackedAndPushed, ...params.localOnlyPatterns],
  };
}

/**
 * 計算した `ziku.jsonc` の内容を、ローカルの `ziku.jsonc` へそのまま書き戻してよいか。
 *
 * スコープ限定の和集合はテンプレート + 今回関係するパターンだけなので、ローカルの他の
 * パターンを含まない部分集合になりうる。これをローカルへ書き戻すと、無関係なローカル限定
 * パターンを消してしまう（和集合は削除しないという原則に反する）。
 */
export function configWriteBackSafe(plan: ConfigPropagationPlan): boolean {
  return match(plan)
    .with({ _tag: P.union("NoConfigChange", "MergeLocalConfig") }, () => true)
    .with({ _tag: "MergeScopedConfig" }, () => false)
    .exhaustive();
}

/**
 * 自動同梱する `ziku.jsonc` を送信対象へ足すための差分を作る。
 *
 * 和集合がテンプレートの内容と一致するなら伝える追加パターンが無いので `undefined` を返す。
 * テンプレートに `ziku.jsonc` が無ければ新規追加、あればその内容からの変更として表す。
 */
export function configDiffToInject(params: {
  readonly mergedConfig: string;
  readonly templateConfig: string | undefined;
}): ChangedFileDiff | undefined {
  if (params.mergedConfig === params.templateConfig) return undefined;
  return params.templateConfig === undefined
    ? { path: ZIKU_CONFIG_FILE, type: "added", localContent: params.mergedConfig }
    : {
        path: ZIKU_CONFIG_FILE,
        type: "modified",
        localContent: params.mergedConfig,
        templateContent: params.templateConfig,
      };
}

// ─── 未追跡ファイルの追跡 ───

/** 未追跡ファイルを今回の push でどう扱うか。 */
export type UntrackedTrackingPlan =
  /** 未追跡ファイルが無い。 */
  | { readonly _tag: "NoUntracked" }
  /**
   * 追跡判断を行わず、除外されるファイルを通知する。設定変更は人間の明示操作に限るため、
   * 対話を省く実行では include を暗黙に広げない。
   */
  | { readonly _tag: "SkipTracking"; readonly reason: "yes" | "dryRun" }
  /** ユーザーに追跡対象を選ばせる。 */
  | { readonly _tag: "AskUser" };

/**
 * 未追跡ファイルの検知結果と実行モードから、追跡判断の進め方を決める。
 *
 * `--yes` は「対話の省略」であって「追跡しない指定」ではないため、省略の結果として push から
 * 外れたファイルは黙って落とさず通知する（`reason` が通知の文面を決める）。dry-run は
 * 恒久的な除外ではなく判断のスキップなので、両方指定された場合は dry-run として扱う。
 */
export function planUntrackedTracking(params: {
  readonly untrackedCount: number;
  readonly yes: boolean;
  readonly dryRun: boolean;
}): UntrackedTrackingPlan {
  if (params.untrackedCount === 0) return { _tag: "NoUntracked" };
  if (params.dryRun) return { _tag: "SkipTracking", reason: "dryRun" };
  if (params.yes) return { _tag: "SkipTracking", reason: "yes" };
  return { _tag: "AskUser" };
}

/**
 * 追跡すると決めたパスを include へ加えた、以降の走査に使うパターンを組み立てる。
 *
 * 個別に選んだファイルは、そのパス 1 本だけに一致する include として登録する。ハッシュ計算・
 * 分類・差分検出はここで返したパターンで走るため、追跡したファイルがそのまま送信候補に乗る。
 */
export function withNewlyTrackedPatterns(
  patterns: { readonly include: readonly GlobPattern[]; readonly exclude: readonly GlobPattern[] },
  selected: readonly RepoRelPath[],
): {
  effectivePatterns: { include: GlobPattern[]; exclude: GlobPattern[] };
  newlyTrackedPaths: RepoRelPath[];
} {
  return {
    effectivePatterns: {
      include: [...patterns.include, ...selected.map((path) => pathAsPattern(path))],
      exclude: [...patterns.exclude],
    },
    newlyTrackedPaths: [...selected],
  };
}

/**
 * push 成功後に `ziku.jsonc` の include へ永続化するパターンを決める。
 *
 * 実際に送ったファイルのパターンだけを残す。選択で外した追跡候補を落とすことで、
 * 「追跡したのに push していない」状態を作らない。追記するのは選択されたファイルのパス
 * そのものなので、1 パス = 1 パターンで対応が付く。
 */
export function patternsToPersist(
  newlyTrackedPaths: readonly RepoRelPath[],
  pushedPaths: ReadonlySet<string>,
): GlobPattern[] {
  return newlyTrackedPaths.filter((p) => pushedPaths.has(p)).map((path) => pathAsPattern(path));
}

// ─── PR のベースブランチ ───

/** PR の宛先。ブランチへ向けられない参照は送信自体を成立させない。 */
export type PrBaseBranch =
  | { readonly _tag: "Branch"; readonly name: string }
  | { readonly _tag: "UnsupportedRef"; readonly kind: "tag" | "commit" };

/**
 * PR のベースブランチを決める。
 *
 * GitHub の PR はブランチにしか向けられない（ベースの解決に使う `repos.getBranch` は
 * タグやコミット SHA で 404 になる）。ref を持たないソースは既定ブランチ名を使い、
 * タグ・コミットへ固定されたソースは宛先が定まらないので `UnsupportedRef` を返す。
 */
export function resolvePrBaseBranch(source: GitHubSource): PrBaseBranch {
  return match(source.ref)
    .with(undefined, (): PrBaseBranch => ({ _tag: "Branch", name: "main" }))
    .with({ kind: "branch" }, (branch): PrBaseBranch => ({ _tag: "Branch", name: branch.name }))
    .with(
      { kind: P.union("tag", "commit") },
      (ref): PrBaseBranch => ({ _tag: "UnsupportedRef", kind: ref.kind }),
    )
    .exhaustive();
}

// ─── サマリーの行 ───

/** サマリーに出す 1 行分の事実。色や記号の割り当ては表示側が決める。 */
export type PushSummaryRow =
  /** 送信対象として選ばれたファイル。`diff` は実際に送る内容で組み直したもの。 */
  | {
      readonly _tag: "Change";
      readonly diff: ChangedFileDiff;
      readonly restoresTemplateDeletion: boolean;
    }
  /** 選択によらず ziku が付け足したファイル（README の自動更新など）。 */
  | { readonly _tag: "AutoUpdated"; readonly path: RepoRelPath };

/**
 * サマリーに出す行を決める。
 *
 * 差分の種別と行数は、ディスク上のローカル内容ではなく実際に送る内容から計算する。
 * auto-merge や `ziku.jsonc` の和集合では両者が食い違い、そのまま表示すると PR の差分と
 * サマリーの数字がずれる。送る内容がテンプレートと同一になったファイルは行に含めない。
 */
export function buildPushSummaryRows(params: {
  readonly pushableFiles: readonly ChangedFileDiff[];
  readonly files: readonly { readonly path: RepoRelPath; readonly content: string }[];
  readonly deletions: readonly { readonly path: RepoRelPath }[];
  readonly restoresTemplateDeletion: ReadonlySet<string>;
}): PushSummaryRow[] {
  const pushedContentMap = new Map(params.files.map((f) => [f.path, f.content]));
  const rows: PushSummaryRow[] = [];

  for (const file of params.pushableFiles) {
    const pushedContent = pushedContentMap.get(file.path);
    const isDeletion = params.deletions.some((d) => d.path === file.path);
    if (pushedContent === undefined && !isDeletion) continue;

    const diff = effectiveDiff(file, pushedContent);
    if (diff === undefined) continue;
    rows.push({
      _tag: "Change",
      diff,
      restoresTemplateDeletion: params.restoresTemplateDeletion.has(file.path),
    });
  }

  for (const file of params.files) {
    if (!params.pushableFiles.some((pf) => pf.path === file.path)) {
      rows.push({ _tag: "AutoUpdated", path: file.path });
    }
  }

  return rows;
}

/**
 * 実際に送る内容で差分を組み直す。送る内容がテンプレートと同一なら `undefined`。
 *
 * `pushedContent` が無いのは削除を送る場合で、そのときは元の差分をそのまま使う。
 */
function effectiveDiff(
  original: ChangedFileDiff,
  pushedContent: string | undefined,
): ChangedFileDiff | undefined {
  if (pushedContent === undefined) return original;

  const templateContent = templateContentOf(original);
  if (templateContent === undefined) {
    return { path: original.path, type: "added", localContent: pushedContent };
  }
  if (pushedContent === templateContent) return undefined;
  return {
    path: original.path,
    type: "modified",
    localContent: pushedContent,
    templateContent,
  };
}

/**
 * テンプレート側の内容を、持っている種別からだけ取り出す。
 *
 * 「テンプレートにそのファイルがあるか」を判断したい呼び出し元のための問い合わせで、
 * `added` の undefined は欠損ではなく「テンプレートに存在しない」という事実を表す。
 */
export function templateContentOf(diff: FileDiff): string | undefined {
  return match(diff)
    .with({ type: "added" }, () => undefined)
    .with({ type: P.union("deleted", "modified", "unchanged") }, (f) => f.templateContent)
    .exhaustive();
}
