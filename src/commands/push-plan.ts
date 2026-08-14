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
import type {
  DeletablePath,
  FileDiff,
  GitHubSource,
  GlobPattern,
  HashMap,
  PushContent,
  RepoRelPath,
} from "../modules/schemas";
import { asDeletablePath, asPushContent } from "../modules/schemas";
import type { ConfigDrift } from "../utils/config-merge";
import type { DefaultBranchResolution } from "../utils/github";
import { decideDefaultBranch } from "../utils/github";
import type { SyncPlan } from "../utils/merge/sync-plan";
import { zikuConfigPushOutcome } from "../utils/merge/sync-plan";
import type { SyncHashes } from "../utils/sync-analysis";
import { pathAsPattern, repoRelPath, repoRelPaths } from "../utils/paths";
import { ZIKU_CONFIG_FILE, classifySyncPath, isZikuConfigPath } from "../utils/ziku-config";

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
  /**
   * テンプレート側だけが変えたので送らないパス。pull を促す対象として見せる。
   *
   * `ziku.jsonc` が入るのは pull が実際にローカルを書き換えるときだけ（`sync-plan.ts` の
   * {@link zikuConfigPushOutcome}）。
   */
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
 *
 * @param drift `ziku.jsonc` のパターン集合が、どちら向きに同期アクションを必要としているか。
 *   分類カテゴリだけでは「テンプレートがパターンを削除した」状態と「pull で取り込める追加が
 *   ある」状態を区別できず、pull しても何も起きない案内を出すことになる。
 */
export function planPushCandidates(plan: SyncPlan, drift: ConfigDrift): PushCandidatePlan {
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
  const sendsConfigUnion = match(zikuConfigPushOutcome(plan.config, drift))
    .with({ _tag: "Skip" }, () => false)
    .with({ _tag: "PullToSync" }, () => {
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
      readonly conflictedPaths: ReadonlySet<RepoRelPath>;
      readonly restoresTemplateDeletion: ReadonlySet<RepoRelPath>;
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
  const availablePaths = new Set<RepoRelPath>(candidates.map((f) => f.path));
  const notFound = requestedPaths.filter((p) => !availablePaths.has(p));
  const requestedSet = new Set<RepoRelPath>(requestedPaths);
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
    conflictedPaths: ReadonlySet<RepoRelPath>;
    restoresTemplateDeletion: ReadonlySet<RepoRelPath>;
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
      const chosen = new Set<RepoRelPath>(paths);
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
  unresolvedConflicts: ReadonlySet<RepoRelPath>,
): ChangedFileDiff[] {
  return selected.filter((f) => unresolvedConflicts.has(f.path));
}

// ─── 送信ペイロード ───

/**
 * 送る内容の出所。同期ベースを前進させてよい範囲を決める（{@link baseAfterPush}）。
 *
 * push はローカルの変更をテンプレートへ送るコマンドで、送るためにローカルのファイルを
 * 書き換えることはしない。そのため ziku が組み立てた内容を送ると、テンプレートだけが
 * その内容になり、ローカルは送る前のまま残る。両者を区別せずに扱うと「テンプレートと
 * 一致していないのにベースだけテンプレート側へ進む」状態を作れてしまう。
 */
export type PushedContentOrigin =
  /** ローカルのファイル内容そのもの。送った後は local == template になる。 */
  | { readonly _tag: "LocalContent" }
  /**
   * ziku が組み立てた内容（3-way マージの結果・`ziku.jsonc` の和集合）。
   * ローカルへ書き戻さない限り local != template のまま残る。
   */
  | { readonly _tag: "Synthesized" };

/** テンプレートへ送る 1 ファイル。 */
export interface PushFile {
  readonly path: RepoRelPath;
  readonly content: PushContent;
  readonly origin: PushedContentOrigin;
}

/** テンプレートへ実際に送る内容。GitHub / ローカルテンプレートのどちらの経路も同じ形を受け取る。 */
export interface PushPayload {
  readonly files: readonly PushFile[];
  readonly deletions: readonly { readonly path: DeletablePath }[];
}

/**
 * 送信対象として確定した集合。
 *
 * 送る中身（{@link PushPayload}）と、それを組み立てる材料を 1 つの値にまとめる。サマリの行は
 * この値からしか作れない（{@link pushSummaryRows}）ので、「送る集合」と「見せる集合」を別々に
 * 組み立てた消費者は存在しえない。付け足すファイルの反映も {@link withAutoUpdatedFile} を
 * 通り、payload と行の両方へ同時に載る。
 */
export interface PushSend {
  /** 実際にテンプレートへ送る内容と削除。 */
  readonly payload: PushPayload;
  /** 送信対象として選ばれた差分。行を組み直す材料になる。 */
  readonly pushableFiles: readonly ChangedFileDiff[];
  /** 送るとテンプレート側の削除を取り消すパス。行の注記に使う。 */
  readonly restoresTemplateDeletion: ReadonlySet<RepoRelPath>;
}

/**
 * 選択に対して実際に送るものがあるか。
 *
 * 選択が空でなくても送るものが無いことがある。自動マージの結果や `ziku.jsonc` の和集合が
 * テンプレートと同一になった場合で、そのまま進むと差分の無い PR を作ろうとして GitHub に
 * 拒まれる。dry-run のプレビューと実 push が同じ判定を通るので、「プレビューには出たのに
 * 実行すると何も送られない」組み合わせを作れない。
 */
export type PushDelivery =
  | { readonly _tag: "Nothing" }
  | { readonly _tag: "Send"; readonly send: PushSend };

/**
 * 選択済みの差分から、実際に送る集合を決める。
 *
 * 送信対象の決定はこの 1 本に閉じる。プレビュー・実 push・サマリ表示のいずれも、ここが
 * 返した {@link PushSend} からしか「何が送られるか」を読めない。
 */
export function planPushDelivery(params: {
  readonly selected: readonly ChangedFileDiff[];
  readonly mergedContents: ReadonlyMap<RepoRelPath, PushContent>;
  readonly restoresTemplateDeletion: ReadonlySet<RepoRelPath>;
}): PushDelivery {
  const payload = buildPushPayload(params.selected, params.mergedContents);
  if (payload.files.length === 0 && payload.deletions.length === 0) return { _tag: "Nothing" };
  return {
    _tag: "Send",
    send: {
      payload,
      pushableFiles: params.selected,
      restoresTemplateDeletion: params.restoresTemplateDeletion,
    },
  };
}

/**
 * 選択とは別に ziku が付け足すファイル（README の自動更新）を送信対象へ載せる。
 *
 * 同じパスが既に載っていれば内容を差し替え、無ければ足す。送る集合への追加をこの関数に
 * 限ることで、PR には出るのにサマリには出ないファイルを作れない（行は常に payload から
 * 導き直される）。
 */
export function withAutoUpdatedFile(send: PushSend, file: PushFile): PushSend {
  const replaced = send.payload.files.some((f) => f.path === file.path);
  return {
    ...send,
    payload: {
      ...send.payload,
      files: replaced
        ? send.payload.files.map((f) => (f.path === file.path ? file : f))
        : [...send.payload.files, file],
    },
  };
}

/**
 * 選択済みの差分から送信ペイロードを組み立てる。
 *
 * 内容は自動マージ済みならその結果を、それ以外はローカルの内容をそのまま採用する。
 * `mergedContents` に載っているのはクリーンにマージできた内容と ziku が組み立てた
 * `ziku.jsonc` だけなので、未解決の衝突内容がここから送信対象へ入ることはない。
 *
 * 出所は内容の比較ではなく、どちらの経路から採ったかで決める（`mergedContents` に
 * あれば `Synthesized`）。比較で決められないのは、自動同梱する `ziku.jsonc` の差分が
 * ディスク上の内容ではなく組み立てた内容を `localContent` に載せて流れてくるため。
 * 経路で決めれば、内容がたまたま一致してもローカルに無い内容を「ある」と読み違えない。
 *
 * 送るかどうかの判定は {@link effectivePushDiff} に任せる。選択に残るのは「ローカルと
 * テンプレートで内容が違う」ファイルだが、実際に送る内容はローカルの内容とは限らない
 * （自動マージの結果・`ziku.jsonc` の和集合）。組み立てた内容がテンプレートと同一になった
 * ファイルを送ると、差分の無いコミットだけの PR ができて GitHub が PR の作成を拒む。
 * サマリーの行（{@link pushSummaryRows}）はここが返した payload から導くので、「見せた集合と
 * 送る集合が違う」組み合わせは作れない。
 *
 * 削除は {@link asDeletablePath} を通ったパスだけが載る。設定ファイルの削除がここへ来ても
 * 落とす理由は {@link DeletablePath} を参照。
 */
function buildPushPayload(
  selected: readonly ChangedFileDiff[],
  mergedContents: ReadonlyMap<RepoRelPath, PushContent>,
): PushPayload {
  const files: PushFile[] = [];
  const deletions: { path: DeletablePath }[] = [];

  for (const diff of selected) {
    match(diff)
      .with({ type: "deleted" }, (deleted) => {
        const path = asDeletablePath(classifySyncPath(deleted.path));
        if (path !== undefined) deletions.push({ path });
      })
      .with({ type: P.union("added", "modified") }, (changed) => {
        const file = pushFileOf(changed, mergedContents.get(changed.path));
        if (file !== undefined) files.push(file);
      })
      .exhaustive();
  }

  return { files, deletions };
}

/**
 * 1 ファイル分の送信内容を組み立てる。テンプレートと同一になるなら `undefined`（送らない）。
 */
function pushFileOf(
  diff: Extract<ChangedFileDiff, { type: "added" | "modified" }>,
  synthesized: PushContent | undefined,
): PushFile | undefined {
  const content = synthesized ?? asPushContent(diff.localContent);
  if (effectivePushDiff(diff, content) === undefined) return undefined;
  return {
    path: diff.path,
    content,
    origin: synthesized === undefined ? { _tag: "LocalContent" } : { _tag: "Synthesized" },
  };
}

// ─── push 後の同期ベース ───

/**
 * push を始める前からローカルとテンプレートが一致していたパス。
 *
 * 一致しているファイルは送るものが無く、テンプレート側にも変更が無い。ベースをテンプレート
 * 側へ揃えても失われる情報が無いので、送信対象でなくてもベースを前進させてよい
 * （{@link baseAfterPush}）。
 *
 * どちらにも存在しないパス（ベースにだけエントリが残っている状態）もここに入る。ベースから
 * 落とさないと、消すものも送るものも無いまま毎回削除候補として報告され続け、`status` が
 * 同期済みにならない。
 */
export function alreadySyncedPaths(hashes: SyncHashes): ReadonlySet<RepoRelPath> {
  const scanned = repoRelPaths([
    ...new Set([
      ...Object.keys(hashes.baseHashes),
      ...Object.keys(hashes.localHashes),
      ...Object.keys(hashes.templateHashes),
    ]),
  ]);
  return new Set(
    scanned.filter((path) => hashes.localHashes[path] === hashes.templateHashes[path]),
  );
}

/**
 * ローカルテンプレートへ push した後に lock へ書く同期ベースを組み立てる。
 *
 * push 後のテンプレートを走査した結果をそのままベースにすると、送っていないファイルの分まで
 * ベースがテンプレート側へ前進する。テンプレートだけが変えたファイル（`autoUpdate`）を選択から
 * 外して push すると、base はテンプレートの内容・local は古い内容という組み合わせになり、次の
 * 分類はそのファイルを `localOnly`（ローカルだけが変えた）と読む。すると `pull` は取り込む
 * ものが無いと判断してテンプレートの更新を永久に落とし、`push --yes` は既定選択に入る古い
 * 内容をテンプレートへ書き戻して更新を巻き戻す。自動マージ済みで選択から外した `conflicts`
 * でも同じことが起きる（マージ結果は捨てられ、テンプレートの変更だけが消える）。
 *
 * そこでベースを前進させるのは次のどちらかに当たるパスだけにする。
 *
 * 1. 実際にテンプレートへ送ったパス（内容・削除のどちらでも）。テンプレートは送った内容に
 *    なっているので、走査結果がそのままベースになる。
 * 2. push 前からローカルとテンプレートが一致していたパス（{@link alreadySyncedPaths}）。
 *
 * ただし 1 には例外がある。送った内容がローカルの内容と違うまま残るパスは、テンプレートに
 * 揃えるとローカルだけが base からずれる（{@link withheldFromLocal}）。
 *
 * それ以外は前回のベースを据え置く。据え置いたファイルは次回も同じカテゴリに分類されるので、
 * テンプレート側の更新は `pull` が取り込むまで残り、push の候補にも上がり続ける。
 *
 * ベースを進める規則がこの 1 箇所に閉じるので、送信対象の選び方が増えてもベースの決まり方は
 * 変わらない。GitHub ソースへの push はベースを動かさない（PR が作られるだけでテンプレートは
 * まだ変わらない）ため、この関数を通らない。
 */
export function baseAfterPush(params: {
  /** push 後のテンプレートを走査したハッシュ。 */
  readonly templateHashes: HashMap;
  /** 今回の比較で共通祖先として使ったベース。 */
  readonly previousBase: HashMap;
  /** 実際にテンプレートへ送った内容と削除。 */
  readonly pushed: PushPayload;
  /** push 前からローカルとテンプレートが一致していたパス。 */
  readonly alreadySynced: ReadonlySet<RepoRelPath>;
  /**
   * 送った内容をローカルのファイルにも書いたパス。書いた側だけが local == template に
   * なるので、`Synthesized` な内容のベースを前進させてよいかはこの集合で決まる。
   */
  readonly writtenBackToLocal: ReadonlySet<RepoRelPath>;
}): HashMap {
  const withheld = withheldFromLocal(params.pushed, params.writtenBackToLocal);
  const advanced = new Set<RepoRelPath>(
    [
      ...params.alreadySynced,
      ...params.pushed.files.map((file) => file.path),
      ...params.pushed.deletions.map((deletion) => deletion.path),
    ].filter((path) => !withheld.has(path)),
  );

  const base: HashMap = {};
  for (const path of repoRelPaths(Object.keys(params.previousBase))) {
    if (advanced.has(path)) continue;
    const previous = params.previousBase[path];
    if (previous !== undefined) base[path] = previous;
  }
  // テンプレートに存在しなくなったパス（送った削除・両側から消えたファイル）はエントリごと
  // 落とす。前進先が「エントリが無いこと」なので、書かないことがそのまま前進になる。
  for (const path of advanced) {
    const advancedHash = params.templateHashes[path];
    if (advancedHash !== undefined) base[path] = advancedHash;
  }
  return base;
}

/**
 * テンプレートへ送ったが、同じ内容がローカルには残らなかったパス。
 *
 * ziku が組み立てた内容（{@link PushedContentOrigin} の `Synthesized`）のうち、ローカルへ
 * 書き戻さなかったものが該当する。3-way マージの結果とスコープ限定の `ziku.jsonc` の
 * 和集合が同じ形になる。
 *
 * ベースをテンプレート側へ進めると local != base == template になり、次の分類はローカルを
 * `localOnly`（ローカルだけが変えた）と読む。すると次の `push --yes` は既定選択に入った
 * 古いローカル内容をテンプレートへ書き戻し、テンプレート側の変更が黙って巻き戻る。
 * `ziku.jsonc` では加えて、スコープ限定で送らずに残したローカル限定パターンが漏れる。
 *
 * **ここで「ベースを進めない」を選び、「マージ結果をローカルへ書く」を選ばない理由**:
 * ローカルへ書くことはテンプレート側の変更をローカルへ取り込むことで、それは `pull` の
 * 役割になる。push にやらせると、送るだけのつもりのコマンドがローカルのファイルを
 * 書き換えることになり、`--yes` を付けた非対話実行では利用者が気づく機会も無い。加えて
 * GitHub ソースでは送った内容は PR に載るだけでテンプレートにはまだ入らないので、
 * その時点でローカルへ書けば「まだマージされていないテンプレートの変更」を先取りして
 * 抱えることになる。ベースを据え置けば、テンプレート側の変更は次の分類でも差分として
 * 残り、取り込むのは `pull` の役目のままになる。
 */
function withheldFromLocal(
  pushed: PushPayload,
  writtenBackToLocal: ReadonlySet<RepoRelPath>,
): ReadonlySet<RepoRelPath> {
  return new Set<RepoRelPath>(
    pushed.files
      .filter((file) =>
        match(file.origin)
          .with({ _tag: "LocalContent" }, () => false)
          .with({ _tag: "Synthesized" }, () => !writtenBackToLocal.has(file.path))
          .exhaustive(),
      )
      .map((file) => file.path),
  );
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
  const selectedPathSet = new Set<RepoRelPath>(params.selectedPaths);
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
 * 送る `ziku.jsonc` の内容を、ローカルの `ziku.jsonc` にも残すか。
 *
 * `Withhold` になるのはスコープ限定の和集合を送るときで、その内容はテンプレート + 今回
 * 関係するパターンだけ、つまりローカルの他のパターンを含まない部分集合になりうる。これを
 * ローカルへ書き戻すと、無関係なローカル限定パターンを消してしまう（和集合は削除しないと
 * いう原則に反する）。
 *
 * 書き戻しの有無は同期ベースの前進範囲も決める。書き戻したパスを {@link baseAfterPush} の
 * `writtenBackToLocal` として渡すことで、「ローカルへ書き戻していないのにベースだけ
 * テンプレート側へ進む」組み合わせを作れなくする。
 */
export type ZikuConfigWriteBack =
  /** 送った内容をローカルの `ziku.jsonc` へも書き、local == template を保つ。 */
  | { readonly _tag: "WriteBack" }
  /** ローカルの `ziku.jsonc` は変えない。送った内容とローカルの内容は一致しない。 */
  | { readonly _tag: "Withhold" };

/** 伝播の計画から、ローカルの `ziku.jsonc` へ書き戻すかを決める。 */
export function zikuConfigWriteBack(plan: ConfigPropagationPlan): ZikuConfigWriteBack {
  return match(plan)
    .with(
      { _tag: P.union("NoConfigChange", "MergeLocalConfig") },
      (): ZikuConfigWriteBack => ({ _tag: "WriteBack" }),
    )
    .with({ _tag: "MergeScopedConfig" }, (): ZikuConfigWriteBack => ({ _tag: "Withhold" }))
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
 * push 成功後に `ziku.jsonc` の include へ永続化するパターンを決める。
 *
 * 実際に送ったファイルのパターンだけを残す。選択で外した追跡候補を落とすことで、
 * 「追跡したのに push していない」状態を作らない。追記するのは選択されたファイルのパス
 * そのものなので、1 パス = 1 パターンで対応が付く。
 */
export function patternsToPersist(
  newlyTrackedPaths: readonly RepoRelPath[],
  pushedPaths: ReadonlySet<RepoRelPath>,
): GlobPattern[] {
  return newlyTrackedPaths.filter((p) => pushedPaths.has(p)).map((path) => pathAsPattern(path));
}

// ─── PR のベースブランチ ───

/** PR の宛先。ブランチへ向けられない参照は送信自体を成立させない。 */
export type PrBaseBranch =
  | { readonly _tag: "Branch"; readonly name: string }
  | { readonly _tag: "UnsupportedRef"; readonly kind: "tag" | "commit" }
  /** トークンを拒否された。控えたブランチ名があっても宛先には使わない。 */
  | { readonly _tag: "AuthRejected"; readonly detail: string }
  /** ref を持たないソースで、リポジトリの既定ブランチも控えも分からなかった。 */
  | { readonly _tag: "DefaultBranchUnresolved" };

/**
 * PR のベースブランチを決める。
 *
 * GitHub の PR はブランチにしか向けられない（ベースの解決に使う `repos.getBranch` は
 * タグやコミット SHA で 404 になる）。ref を持たないソースの宛先はリポジトリの既定
 * ブランチで、タグ・コミットへ固定されたソースは宛先が定まらないので `UnsupportedRef`
 * を返す。
 *
 * 既定ブランチを引けなかったときに控え（`source.defaultBranch`）へ倒すかは
 * {@link decideDefaultBranch} が決める。宛先だけが別の規則で決まると、レート制限下で
 * テンプレートは控えたブランチから取得できるのに PR だけが作れない、という食い違いが出る。
 * 既定ブランチは `main` とは限らず（`master` / `trunk` 等）、控えも無いまま名前を仮定すると
 * 存在しないブランチを宛先にした PR 作成が 404 になり、原因の分からない失敗として出る。
 * 分からないことを `DefaultBranchUnresolved` として返し、呼び出し側が失敗として報告する。
 *
 * @param defaultBranchLookup 既定ブランチの問い合わせ結果。ref を持つソースでは結果を使わない
 *   ので、呼び出し側は問い合わせを省いて undefined を渡してよい。ref を持たないソースで
 *   undefined が渡れば、名前を知る手立てが無いので `DefaultBranchUnresolved` になる。
 */
export function resolvePrBaseBranch(
  source: GitHubSource,
  defaultBranchLookup: DefaultBranchResolution | undefined,
): PrBaseBranch {
  return match(source.ref)
    .with(
      undefined,
      (): PrBaseBranch =>
        defaultBranchLookup === undefined
          ? { _tag: "DefaultBranchUnresolved" }
          : prBaseFromDefaultBranch(defaultBranchLookup, source.defaultBranch),
    )
    .with({ kind: "branch" }, (branch): PrBaseBranch => ({ _tag: "Branch", name: branch.name }))
    .with(
      { kind: P.union("tag", "commit") },
      (ref): PrBaseBranch => ({ _tag: "UnsupportedRef", kind: ref.kind }),
    )
    .exhaustive();
}

/**
 * 既定ブランチ名の決着を PR の宛先へ写す。
 *
 * 引けた名前と控えた名前を同じ `Branch` にするのは、宛先としての意味が変わらないため。
 * 控えを使ったことは、同じ実行のテンプレート取得（`src/utils/template-resolve.ts` の
 * `resolveGitHubFetchSource`）が既に警告している。宛先の決定でも出すと警告が二重になる。
 */
function prBaseFromDefaultBranch(
  lookup: DefaultBranchResolution,
  recorded: string | undefined,
): PrBaseBranch {
  return match(decideDefaultBranch(lookup, recorded))
    .with(
      { _tag: P.union("Fetched", "Recorded") },
      (d): PrBaseBranch => ({ _tag: "Branch", name: d.name }),
    )
    .with(
      { _tag: "AuthRejected" },
      (f): PrBaseBranch => ({ _tag: "AuthRejected", detail: f.detail }),
    )
    .with({ _tag: "Unresolved" }, (): PrBaseBranch => ({ _tag: "DefaultBranchUnresolved" }))
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
 * サマリーに出す行を、実際に送る集合から導く。
 *
 * 差分の種別と行数は、ディスク上のローカル内容ではなく送る内容から計算する。auto-merge や
 * `ziku.jsonc` の和集合では両者が食い違い、そのまま表示すると PR の差分とサマリーの数字が
 * ずれる。送る内容がテンプレートと同一になったファイルは {@link PushSend} の payload に
 * 載っていないので、行にも現れない。
 *
 * 引数を {@link PushSend} に限るのは、送る集合と別のリスト（選択そのもの・ディスク上の差分）
 * から行を組み立てる経路を無くすため。表示したいものは、まず送る集合に載せる必要がある。
 */
export function pushSummaryRows(send: PushSend): PushSummaryRow[] {
  const pushedContentMap = new Map(send.payload.files.map((f) => [f.path, f.content]));
  const rows: PushSummaryRow[] = [];

  for (const file of send.pushableFiles) {
    const pushedContent = pushedContentMap.get(file.path);
    const isDeletion = send.payload.deletions.some((d) => d.path === file.path);
    if (pushedContent === undefined && !isDeletion) continue;

    const diff = effectivePushDiff(file, pushedContent);
    if (diff === undefined) continue;
    rows.push({
      _tag: "Change",
      diff,
      restoresTemplateDeletion: send.restoresTemplateDeletion.has(file.path),
    });
  }

  for (const file of send.payload.files) {
    if (!send.pushableFiles.some((pf) => pf.path === file.path)) {
      rows.push({ _tag: "AutoUpdated", path: file.path });
    }
  }

  return rows;
}

/**
 * 実際に送る内容で差分を組み直す。送る内容がテンプレートと同一なら `undefined`。
 *
 * 「テンプレートと内容が違うものだけを送る」という規則をこの 1 本に閉じる。送信ペイロード
 * （{@link buildPushPayload}）とサマリーの行（{@link pushSummaryRows}）がどちらもここを
 * 通るので、送る集合と見せる集合が食い違わない。
 *
 * `pushedContent` が無いのは削除を送る場合で、そのときは元の差分をそのまま使う。
 */
function effectivePushDiff(
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
