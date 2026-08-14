/**
 * Diff 表示コンポーネント
 *
 * 統計計算・色付け・word diff ハイライトを提供する。picocolors のみで描画し、
 * 出力は単純な行の並びなので less 等へパイプできる。
 *
 * 削除条件: ziku が TUI フレームワーク（ink 等）に移行する場合。
 */
import * as p from "@clack/prompts";
import { diffWords } from "diff";
import pc from "picocolors";
import { match } from "ts-pattern";
import type { DiffType, FileDiff } from "../modules/schemas";
import { isBinaryFileDiff } from "../utils/file-content";
import { generateUnifiedDiff } from "../utils/diff";

// ─── unified diff の行種別 ─────────────────────────────────────

/**
 * unified diff のヘッダー行か判定する。
 *
 * `---` / `+++` で始まる行は本文にも現れる（YAML の文書区切り、Markdown の
 * front matter 境界）。ヘッダーはパスとラベルをタブで区切る `--- path\tlabel`
 * 形式なので、タブの有無で本文と区別する。この判定を怠ると、本文の `---` が
 * 統計から漏れたり、表示から消えたりする。
 *
 * `Index:` と `===` の行はヘッダーブロックにしか現れない。本文行は必ず
 * ` ` / `+` / `-` / `@` / `\` のいずれかで始まるため衝突しない。
 */
export function isDiffHeaderLine(line: string): boolean {
  if (line.startsWith("Index:") || line.startsWith("===")) return true;
  return (line.startsWith("--- ") || line.startsWith("+++ ")) && line.includes("\t");
}

/** unified diff 文字列から、ヘッダーを除いた本文行だけを取り出す */
export function toDiffContentLines(diff: string): string[] {
  return diff.split("\n").filter((line) => !isDiffHeaderLine(line));
}

function isRemovalLine(line: string): boolean {
  return line.startsWith("-") && !isDiffHeaderLine(line);
}

function isAdditionLine(line: string): boolean {
  return line.startsWith("+") && !isDiffHeaderLine(line);
}

// ─── 統計計算 ──────────────────────────────────────────────────

/**
 * 差分の規模。
 *
 * バイナリには行という単位が無いので、加減算の行数を持たない。数値としては 0 で固定し、
 * 種別をタグで区別する。0 を持たせるのは、統計を数値として読む表示経路（ファイル選択の
 * ヒント）が種別を知らなくても壊れないため。「バイナリなのに 10 行追加」は作れない。
 */
export type DiffStats =
  | { readonly kind: "text"; readonly additions: number; readonly deletions: number }
  | { readonly kind: "binary"; readonly additions: 0; readonly deletions: 0 };

/**
 * テキストの実際の行数をカウントする。
 *
 * 背景: `"a\nb\n".split("\n").length` は 3 を返すが、実際の行数は 2。
 * 末尾の改行を除去してからカウントすることで正確な行数を得る。
 */
function countLines(content: string): number {
  if (!content) return 0;
  const normalized = content.endsWith("\n") ? content.slice(0, -1) : content;
  if (normalized === "") return 0;
  return normalized.split("\n").length;
}

/** ファイルの差分統計を計算 */
export function calculateDiffStats(fileDiff: FileDiff): DiffStats {
  // バイナリは種別を先に切る。行数を数えると、デコードできないバイト列を行に切った
  // 結果という無意味な数字が出る。
  if (isBinaryFileDiff(fileDiff)) return BINARY_STATS;

  return match(fileDiff)
    .with({ type: "unchanged" }, () => ({ kind: "text", additions: 0, deletions: 0 }) as const)
    .with(
      { type: "deleted" },
      (f) => ({ kind: "text", additions: 0, deletions: countLines(f.templateContent) }) as const,
    )
    .with(
      { type: "added" },
      (f) => ({ kind: "text", additions: countLines(f.localContent), deletions: 0 }) as const,
    )
    .with({ type: "modified" }, (f) => {
      let additions = 0;
      let deletions = 0;
      for (const line of toDiffContentLines(generateUnifiedDiff(f))) {
        if (line.startsWith("+")) additions++;
        else if (line.startsWith("-")) deletions++;
      }
      return { kind: "text", additions, deletions } as const;
    })
    .exhaustive();
}

const BINARY_STATS = { kind: "binary", additions: 0, deletions: 0 } as const;

/** 統計フォーマット (+10 -5) */
export function formatStats(stats: DiffStats): string {
  return match(stats)
    .with({ kind: "binary" }, () => pc.dim("(binary)"))
    .with({ kind: "text" }, (s) => {
      const parts: string[] = [];
      if (s.additions > 0) parts.push(pc.green(`+${s.additions}`));
      if (s.deletions > 0) parts.push(pc.red(`-${s.deletions}`));
      return parts.length === 0 ? pc.dim("(no changes)") : parts.join(" ");
    })
    .exhaustive();
}

/**
 * ファイル選択一覧の hint に出す差分の要約。出すものが無ければ空文字列。
 *
 * 増減 0 を「ヒント不要」と読めるのはテキストのときだけ。バイナリの {@link DiffStats} は
 * 行という単位を持たないので増減が 0 で固定されており、数値だけで切ると内容が変わった
 * バイナリまでヒント無しで並ぶ。種別で切ってから増減を見る。
 */
export function formatStatHint(file: FileDiff): string {
  const stats = calculateDiffStats(file);
  return match(stats)
    .with({ kind: "binary" }, (s) => formatStats(s))
    .with({ kind: "text" }, (s) => (s.additions === 0 && s.deletions === 0 ? "" : formatStats(s)))
    .exhaustive();
}

// ─── 種別の表示 ────────────────────────────────────────────────

/**
 * ファイル種別のアイコン。
 *
 * unchanged は変更が無い状態なので、変更を示す記号を持たない。
 * リストの桁を揃えるため空白 1 文字を返す。
 */
export function getTypeIcon(type: DiffType): string {
  return match(type)
    .with("added", () => pc.green("+"))
    .with("modified", () => pc.yellow("~"))
    .with("deleted", () => pc.red("-"))
    .with("unchanged", () => pc.dim(" "))
    .exhaustive();
}

/** ファイル種別の表示ラベル */
export function getTypeLabel(type: DiffType): string {
  return match(type)
    .with("added", () => pc.green("added"))
    .with("modified", () => pc.yellow("modified"))
    .with("deleted", () => pc.red("deleted"))
    .with("unchanged", () => pc.dim("unchanged"))
    .exhaustive();
}

// ─── Diff 表示 ─────────────────────────────────────────────────

/** 単一ファイルの diff を表示 */
export function renderFileDiff(file: FileDiff): void {
  const stats = calculateDiffStats(file);
  p.log.step(
    `${pc.bold(file.path)} ${pc.dim("—")} ${getTypeLabel(file.type)} ${formatStats(stats)}`,
  );

  // unchanged は diff 本文を持たないため、見出しだけで終わる
  const diff = generateUnifiedDiff(file);
  if (!diff) return;

  p.log.message(applyWordDiffAndColorize(toDiffContentLines(diff)).join("\n"));
}

/**
 * Diff 行に word diff + 色を適用する。
 *
 * 連続する削除行群と、それに続く追加行群を 1 つの置換ブロックとして扱い、
 * ブロック内で同じ位置にある行同士に diffWords をかける。位置で対応付けないと、
 * 置換ブロックの最後の削除行と最初の追加行のように無関係な行同士が組になり、
 * 一致する語がないため行全体が背景色で塗り潰されて読めなくなる。
 * 削除と追加の行数が揃わないブロックでは、対応先を持たない余りの行に
 * word diff をかけず、通常の色付けだけを行う。
 */
export function applyWordDiffAndColorize(lines: string[]): string[] {
  const result: string[] = [];
  let i = 0;

  while (i < lines.length) {
    if (isRemovalLine(lines[i])) {
      const removals: string[] = [];
      while (i < lines.length && isRemovalLine(lines[i])) {
        removals.push(lines[i]);
        i++;
      }
      const additions: string[] = [];
      while (i < lines.length && isAdditionLine(lines[i])) {
        additions.push(lines[i]);
        i++;
      }
      result.push(...colorizeReplacementBlock(removals, additions));
      continue;
    }

    const line = lines[i];
    if (line.startsWith("@@")) {
      result.push(pc.cyan(line));
    } else if (isAdditionLine(line)) {
      result.push(pc.green(line));
    } else {
      result.push(line);
    }
    i++;
  }

  return result;
}

/**
 * 削除行群と追加行群を色付けする。
 *
 * unified diff の並び順（削除行が全て先、追加行が後）を保つため、
 * 2 本の配列に振り分けてから連結する。
 */
function colorizeReplacementBlock(removals: string[], additions: string[]): string[] {
  const removedLines: string[] = [];
  const addedLines: string[] = [];
  const pairCount = Math.min(removals.length, additions.length);

  for (let k = 0; k < pairCount; k++) {
    const [removed, added] = highlightWordDiff(removals[k], additions[k]);
    removedLines.push(removed);
    addedLines.push(added);
  }
  for (const line of removals.slice(pairCount)) removedLines.push(pc.red(line));
  for (const line of additions.slice(pairCount)) addedLines.push(pc.green(line));

  return [...removedLines, ...addedLines];
}

/**
 * 対応する削除行と追加行の語単位の差分を背景色で示す。
 *
 * @returns [色付けした削除行, 色付けした追加行]
 */
function highlightWordDiff(removalLine: string, additionLine: string): [string, string] {
  let oldLine = pc.red("-");
  let newLine = pc.green("+");

  for (const change of diffWords(removalLine.slice(1), additionLine.slice(1))) {
    if (change.added) {
      newLine += pc.bgGreen(pc.black(change.value));
    } else if (change.removed) {
      oldLine += pc.bgRed(pc.white(change.value));
    } else {
      oldLine += change.value;
      newLine += change.value;
    }
  }

  return [oldLine, newLine];
}

/** ファイル選択用ラベル */
export function getFileLabel(file: FileDiff): string {
  const stats = calculateDiffStats(file);
  return `${getTypeIcon(file.type)} ${file.path} ${formatStats(stats)}`;
}
