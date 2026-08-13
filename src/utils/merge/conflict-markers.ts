/**
 * コンフリクトマーカーの生成と検出。
 *
 * 「マーカーが入っているか」の判定を 1 本の関数（`findConflictRegions`）に閉じ、
 * マージ直後の結果とユーザーが手で編集した後のファイルを同じ規則で判定する。
 * 判定が複数箇所に分かれると、片方だけが誤検出したときに `pull --continue` が
 * 通らない／マーカー入りの内容が同期されるといった非対称な壊れ方をする。
 */
import { match, P } from "ts-pattern";
import { stripBom } from "../text-shape";
import type { ConflictRegion } from "./types";

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
export function conflictMarkerSize(contents: readonly string[]): number {
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
export interface ConflictMarkers {
  readonly local: string;
  readonly base: string;
  readonly separator: string;
  readonly template: string;
}

export function conflictMarkers(size: number): ConflictMarkers {
  return {
    local: `${MARKER_CHAR.start.repeat(size)} LOCAL`,
    base: `${MARKER_CHAR.base.repeat(size)} BASE`,
    separator: MARKER_CHAR.separator.repeat(size),
    template: `${MARKER_CHAR.end.repeat(size)} TEMPLATE`,
  };
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
 * ファイル内容に残っている未解決のコンフリクトブロックを列挙する。
 *
 * 行頭の前方一致だけで判定すると、Markdown の setext 見出し下線や区切り線
 * `========` を未解決と誤検出する。誤検出すると `pull --continue` が永久に通らず、
 * 解決済みのマージを確定できなくなるため、マーカーの出現順序と対応が取れた
 * ブロックだけを未解決とみなす。
 *
 * ブロックの内側では、開始マーカーより短いマーカー行は本文として扱う。マージ結果は
 * 内容中の最長マーカーより長いマーカーで囲まれているので、この長さ比較で
 * 「内容として書かれたマーカー」と「ziku が生成したマーカー」を区別できる。
 *
 * 先頭の BOM はエンコーディングの目印であって 1 行目の内容ではないので、走査前に取り除く。
 * 残したまま比べると、1 行目から始まるブロックの開始マーカーが本文として読まれ、未解決の
 * ファイルが解決済みとして通ってしまう。
 */
export function findConflictRegions(content: string): ConflictRegion[] {
  const regions: ConflictRegion[] = [];
  let state: ScanState = OUTSIDE;

  const contentLines = stripBom(content).split("\n");
  for (let i = 0; i < contentLines.length; i++) {
    const marker = parseMarkerLine(contentLines[i]);
    if (marker === undefined) continue;
    if (state.phase !== "outside" && marker.length < state.size) continue;

    const step = stepScan(state, marker, i + 1);
    state = step.next;
    if (step.closed !== undefined) regions.push({ startLine: step.closed });
  }

  return regions;
}
