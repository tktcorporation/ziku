import { diff3Merge } from "node-diff3";
import { match, P } from "ts-pattern";
import { validateStructuredContent } from "./file-detection";
import type { MergeResult } from "./types";

// ---- コンフリクトマーカー ----

/** マーカーの最小長。git の既定と同じ 7 文字。 */
const MIN_MARKER_LENGTH = 7;

/** マーカーの種類。コンフリクトブロック内での出現順に対応する。 */
type MarkerKind = "start" | "base" | "separator" | "end";

const MARKER_CHAR: Record<MarkerKind, string> = {
  start: "<",
  base: "|",
  separator: "=",
  end: ">",
};

const MARKER_KINDS: readonly MarkerKind[] = ["start", "base", "separator", "end"];

interface Marker {
  readonly kind: MarkerKind;
  readonly length: number;
}

/**
 * 行がコンフリクトマーカーなら種類と長さを返す。
 *
 * マーカー行は「同じ記号が 7 文字以上連続し、その後は行末または空白区切りのラベル」。
 * 記号の直後に別の文字が続く行（`=======>` など）は本文として扱う。
 */
function parseMarkerLine(line: string): Marker | undefined {
  for (const kind of MARKER_KINDS) {
    const char = MARKER_CHAR[kind];
    let length = 0;
    while (length < line.length && line[length] === char) length++;
    if (length < MIN_MARKER_LENGTH) continue;
    const rest = line.slice(length);
    if (rest === "" || /^\s/.test(rest)) return { kind, length };
  }
  return undefined;
}

/**
 * 内容の中に現れるマーカー列より長いマーカー長を決める。
 *
 * 入力に既にマーカーが含まれる場合（前回のコンフリクトを解決しないまま再マージした、
 * マーカーの書き方を説明するドキュメントを同期している等）、同じ長さのマーカーで
 * 囲むとブロックの入れ子が区別できなくなる。git と同様に 1 文字長いマーカーを使う。
 */
function conflictMarkerSize(contents: readonly string[]): number {
  let longest = 0;
  for (const content of contents) {
    for (const line of content.split("\n")) {
      const marker = parseMarkerLine(line);
      if (marker !== undefined) longest = Math.max(longest, marker.length);
    }
  }
  return Math.max(MIN_MARKER_LENGTH, longest + 1);
}

/**
 * 1 つのコンフリクトブロックを構成する 4 本のマーカー行。
 *
 * git の `merge.conflictStyle=diff3` と同じ並び（局所側・base・テンプレート側）で出力し、
 * ユーザーが「共通祖先が何だったか」を見ながら解決できるようにする。
 */
interface ConflictMarkers {
  readonly local: string;
  readonly base: string;
  readonly separator: string;
  readonly template: string;
}

function conflictMarkers(size: number): ConflictMarkers {
  return {
    local: `${MARKER_CHAR.start.repeat(size)} LOCAL`,
    base: `${MARKER_CHAR.base.repeat(size)} BASE`,
    separator: MARKER_CHAR.separator.repeat(size),
    template: `${MARKER_CHAR.end.repeat(size)} TEMPLATE`,
  };
}

// ---- テキスト 3-way マージ ----

/**
 * GNU diff3 と同等の行レベル 3-way マージ。
 *
 * base/local/template の3者を比較し、同じ領域を両側が異なる内容へ変更した場合は
 * 必ずコンフリクトにする。「パッチが物理的に適用可能か」だけを見る patch 適用系の
 * 手法と違い、片側の変更がサイレントに消えたり内容が二重化したりしない。
 *
 * @param filePath 構造ファイル（JSON/TOML/YAML）の検証に使う。省略すると検証しない。
 */
export function textThreeWayMerge(
  base: string,
  local: string,
  template: string,
  filePath?: string,
): MergeResult {
  const markers = conflictMarkers(conflictMarkerSize([base, local, template]));

  // node-diff3: diff3Merge(a, o, b) — a=local, o=base, b=template
  const regions = diff3Merge(local.split("\n"), base.split("\n"), template.split("\n"));

  const resultLines: string[] = [];
  let hasConflicts = false;

  for (const region of regions) {
    if ("ok" in region && region.ok) {
      resultLines.push(...region.ok);
    } else if ("conflict" in region && region.conflict) {
      hasConflicts = true;
      resultLines.push(
        markers.local,
        ...region.conflict.a,
        markers.base,
        ...region.conflict.o,
        markers.separator,
        ...region.conflict.b,
        markers.template,
      );
    }
  }

  const content = resultLines.join("\n");

  // 構造ファイル（JSON/TOML/YAML）のクリーンマージ結果をパースで検証。
  // diff3Merge は行レベルで競合を判定するため、構造的に壊れた出力を
  // クリーンマージとして返す可能性がある。検証失敗時はファイル全体を
  // コンフリクトとしてマークし、壊れたファイルの生成を防ぐ。
  if (!hasConflicts && filePath !== undefined && !validateStructuredContent(content, filePath)) {
    return { content: wholeFileConflict({ base, local, template, markers }), hasConflicts: true };
  }

  return { content, hasConflicts };
}

/**
 * ファイル全体を 1 つのコンフリクトブロックにする。
 *
 * 各セクションは行へ分解してから結合する。末尾改行付きの内容をそのまま連結すると
 * 次のマーカーの直前に空行が入り、ファイル末尾の改行も失われる。
 */
function wholeFileConflict(params: {
  base: string;
  local: string;
  template: string;
  markers: ConflictMarkers;
}): string {
  const { base, local, template, markers } = params;
  const lines = [
    markers.local,
    ...toLines(local),
    markers.base,
    ...toLines(base),
    markers.separator,
    ...toLines(template),
    markers.template,
  ];
  // 最終行はマーカーなので必ず改行で終端する（git のマーカー出力と同じ）。
  return `${lines.join("\n")}\n`;
}

/** 内容を行へ分解する。末尾改行は行の区切りとして扱い、空行を作らない。 */
function toLines(content: string): string[] {
  const lines = content.split("\n");
  return lines.at(-1) === "" ? lines.slice(0, -1) : lines;
}

// ---- 未解決コンフリクトの検出 ----

/** 走査中のブロック。開始行と、そのブロックのマーカー長を持つ。 */
interface OpenBlock {
  readonly startLine: number;
  readonly size: number;
}

type ScanState =
  | { readonly phase: "outside" }
  | ({ readonly phase: "local" | "base" | "template" } & OpenBlock);

const OUTSIDE: ScanState = { phase: "outside" };

/**
 * 開いているブロックを次のフェーズへ移す。
 *
 * 開始行とマーカー長はブロックが閉じるまで引き継ぐ。フィールドを明示して組み立てるのは、
 * 引数の block が現フェーズを持つ状態そのものであり、spread すると phase まで引き継いで
 * しまうため。
 */
const openBlock = (phase: "local" | "base" | "template", block: OpenBlock): ScanState => ({
  phase,
  startLine: block.startLine,
  size: block.size,
});

interface ScanStep {
  readonly next: ScanState;
  /** 対応の取れたブロックが閉じた場合、その開始行番号（1 始まり） */
  readonly closed?: number;
}

/**
 * マーカー行 1 本を受けて走査状態を進める。
 *
 * `<<<<<<<` → （`|||||||`）→ `=======` → `>>>>>>>` の順序で揃ったときだけブロックが閉じる。
 * 順序から外れたマーカーはブロックを破棄するか、新しいブロックの開始として扱う。
 */
function stepScan(state: ScanState, marker: Marker, lineNumber: number): ScanStep {
  const started = { startLine: lineNumber, size: marker.length };
  return (
    match([state, marker.kind] as const)
      .with([P.any, "start"], () => ({ next: openBlock("local", started) }))
      // 開始マーカーが無いまま現れる `=======` は、setext 見出しの下線や区切り線などの本文。
      .with([{ phase: "outside" }, P.any], () => ({ next: OUTSIDE }))
      .with([{ phase: "local" }, "base"], ([open]) => ({ next: openBlock("base", open) }))
      .with([{ phase: P.union("local", "base") }, "separator"], ([open]) => ({
        next: openBlock("template", open),
      }))
      .with([{ phase: "template" }, "end"], ([open]) => ({ next: OUTSIDE, closed: open.startLine }))
      // `=======` を伴わない `>>>>>>>` は対応の取れたブロックではない。ここまでを破棄する。
      .with([{ phase: P.union("local", "base") }, "end"], () => ({ next: OUTSIDE }))
      // ブロック内に重ねて現れる同種のマーカーは本文として読み飛ばす。
      .with([{ phase: "base" }, "base"], ([open]) => ({ next: openBlock("base", open) }))
      .with([{ phase: "template" }, P.union("base", "separator")], ([open]) => ({
        next: openBlock("template", open),
      }))
      .exhaustive()
  );
}

/**
 * ファイル内容に未解決のコンフリクトブロックが残っているかを検出する。
 *
 * `lines` は検出したブロックの開始行（`<<<<<<<` の行番号、1 始まり）。
 *
 * 行頭の前方一致だけで判定すると、Markdown の setext 見出し下線や区切り線
 * `========` を未解決と誤検出する。誤検出すると `pull --continue` が永久に通らず、
 * 解決済みのマージを確定できなくなるため、マーカーの出現順序と対応が取れた
 * ブロックだけを未解決とみなす。
 *
 * ブロックの内側では、開始マーカーより短いマーカー行は本文として扱う。マージ結果は
 * 内容中の最長マーカーより長いマーカーで囲まれているので、この長さ比較で
 * 「内容として書かれたマーカー」と「ziku が生成したマーカー」を区別できる。
 */
export function hasConflictMarkers(content: string): { found: boolean; lines: number[] } {
  const lines: number[] = [];
  let state: ScanState = OUTSIDE;

  const contentLines = content.split("\n");
  for (let i = 0; i < contentLines.length; i++) {
    const marker = parseMarkerLine(contentLines[i]);
    if (marker === undefined) continue;
    if (state.phase !== "outside" && marker.length < state.size) continue;

    const step = stepScan(state, marker, i + 1);
    state = step.next;
    if (step.closed !== undefined) lines.push(step.closed);
  }

  return { found: lines.length > 0, lines };
}
