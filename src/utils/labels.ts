/**
 * ラベル機能: パターンのグループ化と選択的同期。
 *
 * 背景: `.ziku/ziku.jsonc` の `labels` フィールドでパターンを名前付きグループに束ね、
 * `--labels a,b` / `--skip-labels c` で同期スコープを絞り込めるようにする。
 *
 * 設計方針（Ansible / Helm を参考）:
 * - トップレベルの include/exclude は「常時適用の共通プール」（Ansible の `always` 相当）。
 * - ラベル指定は OR マッチ（指定されたラベルのいずれかに属するパターンを合集合で適用）。
 * - ラベル未指定時は全ラベルが合集合で適用される（ラベル導入による破壊的変更を避けるため）。
 * - 未知のラベル名はエラー（typo 検出）。
 * - 設計上、ラベル情報は lock.json に残さない（ランタイムフィルタに徹する）。
 *   複数マシン間で同じリポを別ラベル選択しても整合するようにするため。
 */
import { Data, Effect } from "effect";
import type { ZikuConfig } from "../modules/schemas";
import type { FlatPatterns } from "./patterns";

/**
 * 未知のラベル名が指定されたときのエラー。
 * CLI 側で typo を検出してユーザーに候補を提示するために使う。
 */
export class UnknownLabelError extends Data.TaggedError("UnknownLabelError")<{
  readonly unknown: readonly string[];
  readonly available: readonly string[];
}> {}

export interface LabelFilter {
  /** 指定されたラベルのみ適用（OR マッチ）。undefined なら全ラベルを適用。 */
  readonly include?: readonly string[];
  /** 除外するラベル（`--skip-labels`）。include を満たしてもここに含まれれば除外。 */
  readonly skip?: readonly string[];
}

/**
 * ラベルフィルタを適用して最終的な include/exclude を解決する。
 *
 * 合集合の構築順:
 *   1. トップレベル include/exclude を必ず含める（共通プール）
 *   2. 選択されたラベルの include/exclude をすべて合流させる
 *   3. 重複排除
 *
 * @param config - ziku.jsonc のパース済み設定
 * @param filter - CLI から渡されたラベル選択
 */
export function resolveLabeledPatterns(
  config: ZikuConfig,
  filter: LabelFilter = {},
): Effect.Effect<FlatPatterns, UnknownLabelError> {
  return Effect.gen(function* () {
    const availableLabels = Object.keys(config.labels ?? {});
    const selected = yield* selectLabels(availableLabels, filter);

    const include = new Set<string>(config.include);
    const exclude = new Set<string>(config.exclude ?? []);

    for (const name of selected) {
      const def = config.labels?.[name];
      if (!def) continue;
      for (const p of def.include) include.add(p);
      for (const p of def.exclude ?? []) exclude.add(p);
    }

    return {
      include: [...include],
      exclude: [...exclude],
    };
  });
}

/**
 * フィルタから最終的に採用するラベル名のリストを決める。
 *
 * - filter.include 未指定 → 全ラベルを採用（破壊的変更を避けるため）
 * - filter.include 指定時 → そのラベルのみ採用
 * - filter.skip は最終段で差し引く
 */
function selectLabels(
  available: readonly string[],
  filter: LabelFilter,
): Effect.Effect<readonly string[], UnknownLabelError> {
  return Effect.gen(function* () {
    const requested = filter.include;
    const skip = filter.skip ?? [];

    const unknown = [...(requested ?? []), ...skip].filter((l) => !available.includes(l));
    if (unknown.length > 0) {
      return yield* new UnknownLabelError({ unknown, available });
    }

    const base = requested ?? available;
    return base.filter((l) => !skip.includes(l));
  });
}

/**
 * 現在のフィルタ結果として「有効なラベル」と「スキップされたラベル」を返す。
 * ログ表示用のヘルパー。selectLabels の公開 API 版として使う。
 */
export function computeActiveLabels(
  availableLabels: readonly string[],
  filter: LabelFilter,
): { effective: readonly string[]; skipped: readonly string[] } {
  const requested = filter.include;
  const skip = filter.skip ?? [];
  const base = requested ?? availableLabels;
  const effective = base.filter((l) => !skip.includes(l));
  const skipped = availableLabels.filter((l) => !effective.includes(l));
  return { effective, skipped };
}

/**
 * カンマ区切り文字列（`--labels a,b,c`）を配列にパースする。
 * 空白はトリムし、空要素は除外する。undefined/空文字列なら undefined を返す。
 */
export function parseLabelsFlag(raw: string | undefined): string[] | undefined {
  if (raw === undefined || raw.trim() === "") return undefined;
  const parts = raw
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean);
  return parts.length > 0 ? parts : undefined;
}

/**
 * UnknownLabelError を CLI 向けの ZikuError（タイトル + ヒント）に変換する。
 * pull/push/diff の各コマンドで同じ変換を使うための共通ヘルパー。
 */
export function formatUnknownLabelMessage(e: UnknownLabelError): {
  title: string;
  hint: string;
} {
  return {
    title: `Unknown label(s): ${e.unknown.join(", ")}`,
    hint: `Available labels: ${e.available.length > 0 ? e.available.join(", ") : "(none defined)"}`,
  };
}

/**
 * scope 指定同期時に、baseHashes から scope 外のエントリを除外する。
 *
 * 背景: classifyFiles は baseHashes ∪ local ∪ template の全ファイルを走査するため、
 * scope 外 (今回の sync 対象外) の baseHashes エントリがあると、それらが
 * 「template から削除された」と誤分類される。scope 内に見えるファイル
 * （= template または local にあるファイル）のみを渡すことで誤分類を防ぐ。
 *
 * `mergeScopedBaseHashes` は最終保存用、こちらは classify 入力用で役割が異なる。
 */
export function filterBaseHashesToScope(
  previous: Record<string, string>,
  scopeFiles: ReadonlySet<string>,
): Record<string, string> {
  const result: Record<string, string> = {};
  for (const [file, hash] of Object.entries(previous)) {
    if (scopeFiles.has(file)) result[file] = hash;
  }
  return result;
}

/**
 * スコープ指定同期時に、scope 外の baseHashes エントリを保持しつつ
 * scope 内のハッシュを新しい値に置き換えた結果を返す。
 *
 * 背景: lock.baseHashes は全同期ファイルのハッシュを持つため、ラベルフィルタで
 * scope を絞って sync した場合、scope 外のエントリを失わないように更新する必要がある。
 *
 * セマンティクス:
 * - scopeBoundary に含まれないファイル → previous の値をそのまま保持
 * - scopeBoundary に含まれるファイル:
 *   - scopedHashes にあれば → その値で更新
 *   - scopedHashes になければ → 削除扱いで entry を消す
 */
export function mergeScopedBaseHashes(args: {
  readonly previous: Record<string, string>;
  readonly scopedHashes: Record<string, string>;
  readonly scopeBoundary: ReadonlySet<string>;
}): Record<string, string> {
  const result: Record<string, string> = {};
  for (const [file, hash] of Object.entries(args.previous)) {
    if (!args.scopeBoundary.has(file)) result[file] = hash;
  }
  for (const [file, hash] of Object.entries(args.scopedHashes)) {
    result[file] = hash;
  }
  return result;
}

/**
 * テンプレート側のラベル定義をローカルにマージする。
 *
 * 背景: pull 時にテンプレートの ziku.jsonc に新しいラベルが追加された場合、
 * ローカルにも伝播させる（flat include/exclude と同じ扱い）。
 * 既存のラベルには触らない（ローカルのカスタマイズを尊重）。
 * 既存ラベルへのパターン追加のみ行う。
 */
export function mergeLabelDefinitions(
  local: ZikuConfig["labels"],
  template: ZikuConfig["labels"],
): { merged: ZikuConfig["labels"]; addedLabels: string[]; addedPatterns: number } {
  if (!template || Object.keys(template).length === 0) {
    return { merged: local, addedLabels: [], addedPatterns: 0 };
  }

  const merged: NonNullable<ZikuConfig["labels"]> = local ? { ...local } : {};
  const addedLabels: string[] = [];
  // addedPatterns は include + exclude の追加数合計。
  // include だけカウントするとテンプレートが exclude だけ追加した場合に
  // 呼び出し側の「変更あり判定」が false になり、merged の内容が保存されないバグになる。
  let addedPatterns = 0;

  for (const [name, def] of Object.entries(template)) {
    const result = mergeOneLabel(merged[name], def);
    if (!result) continue;
    merged[name] = result.definition;
    if (result.isNew) addedLabels.push(name);
    addedPatterns += result.addedPatterns;
  }

  return {
    merged: Object.keys(merged).length > 0 ? merged : undefined,
    addedLabels,
    addedPatterns,
  };
}

/**
 * 1つのラベルについて、ローカル定義とテンプレート定義をマージした結果を返す。
 * 変更なしなら null を返す（呼び出し側でスキップするため）。
 */
function mergeOneLabel(
  existing: { include: string[]; exclude?: string[] } | undefined,
  templateDef: { include: string[]; exclude?: string[] },
): {
  definition: { include: string[]; exclude?: string[] };
  isNew: boolean;
  addedPatterns: number;
} | null {
  if (!existing) {
    const def = {
      include: [...templateDef.include],
      ...(templateDef.exclude && templateDef.exclude.length > 0
        ? { exclude: [...templateDef.exclude] }
        : {}),
    };
    return {
      definition: def,
      isNew: true,
      addedPatterns: templateDef.include.length + (templateDef.exclude?.length ?? 0),
    };
  }
  const newInclude = templateDef.include.filter((p) => !existing.include.includes(p));
  const existingExclude = existing.exclude ?? [];
  const newExclude = (templateDef.exclude ?? []).filter((p) => !existingExclude.includes(p));
  if (newInclude.length === 0 && newExclude.length === 0) return null;

  return {
    definition: {
      include: [...existing.include, ...newInclude],
      ...(existingExclude.length + newExclude.length > 0
        ? { exclude: [...existingExclude, ...newExclude] }
        : {}),
    },
    isNew: false,
    addedPatterns: newInclude.length + newExclude.length,
  };
}
