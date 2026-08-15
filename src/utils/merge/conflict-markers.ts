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
export const MIN_MARKER_LENGTH = 7;

/** マーカーの種類。コンフリクトブロック内での出現順に対応する。 */
type MarkerKind = "start" | "base" | "separator" | "end";

const MARKER_CHAR: Record<MarkerKind, string> = {
  start: "<",
  base: "|",
  separator: "=",
  end: ">",
};

const MARKER_KINDS: readonly MarkerKind[] = ["start", "base", "separator", "end"];

/**
 * ziku が自分のマーカーに書くラベル。生成（{@link conflictMarkers}）と検出
 * （{@link parseMarkerLine}）が同じ値を読むので、片方だけが変わることはない。
 *
 * 側の名前だけを載せるのは ziku 固有で、git はここにブランチ名を書く。この違いが
 * 「ziku が書いた行か」の判断材料の 1 つになる（{@link findConflictRegions}）ので、ラベルを
 * 変えると既にファイルへ書き込まれたマーカーが残骸として検出されなくなる。
 *
 * 区切り（`=======`）にラベルが無いのは git の形式に合わせているため。ラベルの無い行は
 * 本文の記号列と見分けが付かず、それだけでは残骸と判定できない。
 */
const MARKER_LABEL = {
  start: "LOCAL",
  base: "BASE",
  separator: undefined,
  end: "TEMPLATE",
} as const satisfies Record<MarkerKind, string | undefined>;

interface Marker {
  readonly kind: MarkerKind;
  readonly length: number;
  /** ziku が書いたラベルが付いているか。付いていれば内容ではなく生成された行と分かる。 */
  readonly labeled: boolean;
}

/**
 * 行がコンフリクトマーカーなら種類と長さ、ziku のラベルの有無を返す。
 *
 * マーカー行は「同じ記号が 7 文字以上連続し、その後は行末または空白区切りのラベル」。
 * 記号の直後に別の文字が続く行（`=======>` など）は本文として扱う。
 *
 * ラベル付きと認めるのは、記号列の直後が「空白 1 つ + ラベル」で行が終わる形だけ。
 * 緩めると `>>>>>>> TEMPLATE_DIR の説明` のような本文まで生成行と見なし、解決済みの
 * ファイルで `pull --continue` が通らなくなる。
 */
function parseMarkerLine(line: string): Marker | undefined {
  for (const kind of MARKER_KINDS) {
    const char = MARKER_CHAR[kind];
    let length = 0;
    while (length < line.length && line[length] === char) length++;
    if (length < MIN_MARKER_LENGTH) continue;
    const rest = line.slice(length);
    if (rest !== "" && !/^\s/.test(rest)) continue;
    const label = MARKER_LABEL[kind];
    return { kind, length, labeled: label !== undefined && rest === ` ${label}` };
  }
  return undefined;
}

/**
 * 内容の中に現れるマーカー列より長いマーカー長を決める。
 *
 * 入力に既にマーカーが含まれる場合（前回のコンフリクトを解決しないまま再マージした、
 * マーカーの書き方を説明するドキュメントを同期している等）、同じ長さのマーカーで
 * 囲むとブロックの入れ子が区別できなくなる。git と同様に 1 文字長いマーカーを使う。
 *
 * 戻り値は入力 3 者に現れるどのマーカーよりも真に長い。この不変条件が検出側の根拠になる
 * （{@link GeneratedMarkerSize}）ので、長さの決め方を緩めると検出も緩む。
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
 * 走査する内容に ziku が書いたマーカーの長さ。
 *
 * {@link conflictMarkerSize} の不変条件により、生成時点で内容に含まれていたマーカーは
 * 生成長より必ず短い。したがって「生成長以上の長さを持つラベル付きマーカー」は内容由来では
 * ありえず、ziku が書いた残骸だと言い切れる（{@link findConflictRegions}）。
 *
 * 長さが定まらない経路もある。自動マージを試みなかったファイル、ローカルとテンプレートが
 * 元から同じマーカー入りのテキストだった場合、そして長さを記録していない lock からの再開が
 * それにあたる。省略可能な数値ではなく union で表すのは、この「長さが無い」側にも意味が
 * あるため。`undefined` だと、渡し忘れと区別が付かない。
 */
export type GeneratedMarkerSize =
  | { readonly kind: "known"; readonly size: number }
  | { readonly kind: "unknown" };

/** {@link conflictMarkerSize} が返した生成長を {@link GeneratedMarkerSize} に載せる。 */
export function knownMarkerSize(size: number): GeneratedMarkerSize {
  return { kind: "known", size };
}

/** ziku がマーカーを書いていない、または生成長が残っていない場合。 */
export const UNKNOWN_MARKER_SIZE: GeneratedMarkerSize = { kind: "unknown" };

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

/**
 * 1 ブロック分のマーカー行を組み立てる。
 *
 * ラベルは側の名前だけで、テンプレートの revision は載せない。git がブランチ名をラベルに
 * 出すのは、マージする 2 つがどちらも名前を持つコミットで、その名前が「どちらを残すか」の
 * 判断材料になるため。ziku のマージは片側が利用者の作業ツリー（コミットされていない、
 * 名前の無い内容）なので、片側にだけ revision を書くと対になっていない情報になり、
 * 「どちらの版か」を読み取る手がかりも増えない。
 *
 * どの revision と突き合わせたかは、マージを実行した時点で伝えている（`conflict-io.ts` の
 * ベース取得ログと、push が出す `since <sha>`）。確定した値は `.ziku/lock.json` の
 * `base.ref` が持つので、同じ事実をブロックごとに複製しない。
 */
export function conflictMarkers(size: number): ConflictMarkers {
  return {
    local: markerLine("start", size),
    base: markerLine("base", size),
    separator: markerLine("separator", size),
    template: markerLine("end", size),
  };
}

/** マーカー行 1 本を組み立てる。ラベルを持つ種類だけ空白区切りで後置する。 */
function markerLine(kind: MarkerKind, size: number): string {
  const symbols = MARKER_CHAR[kind].repeat(size);
  const label = MARKER_LABEL[kind];
  return label === undefined ? symbols : `${symbols} ${label}`;
}

// ---- 未解決コンフリクトの検出 ----

/** ブロック内のフェーズ。直前に読んだマーカーがどこまで進んだかを表す。 */
type BlockPhase = "local" | "base" | "template";

/**
 * ブロックの始まり方。
 *
 * 利用者は解決の途中で開始マーカーだけを消すことがあり、残された閉じ側の並びも
 * コンフリクトの残骸である。始まり方を状態に持たせるのは、残骸として数える条件が
 * 両者で違うため（{@link unresolvedStart}）。
 */
type BlockOrigin = "started" | "orphan";

/** 走査中のブロック。開始行・マーカー長・始まり方を持つ。 */
interface OpenBlock {
  readonly startLine: number;
  readonly size: number;
  readonly origin: BlockOrigin;
}

type ScanState = { readonly phase: "outside" } | ({ readonly phase: BlockPhase } & OpenBlock);

const OUTSIDE: ScanState = { phase: "outside" };

/**
 * 開いているブロックを次のフェーズへ移す。
 *
 * 開始行・マーカー長・始まり方はブロックが終わるまで引き継ぐ。フィールドを明示して
 * 組み立てるのは、引数の block が現フェーズを持つ状態そのものであり、spread すると
 * phase まで引き継いでしまうため。
 */
const openBlock = (phase: BlockPhase, block: OpenBlock): ScanState => ({
  phase,
  startLine: block.startLine,
  size: block.size,
  origin: block.origin,
});

interface ScanStep {
  readonly next: ScanState;
  /**
   * このステップで未解決と確定したブロックの開始行番号（1 始まり）。
   *
   * 「順序が揃って閉じた」場合と「揃わないまま打ち切られた」場合の両方がここに入る。
   * 閉じたものだけを報告する形にすると、打ち切りの扱いを遷移ごとにその場で決めることになり、
   * 「本文として捨てる」と「未解決として残す」の境目がどこにも書かれない状態になる。
   */
  readonly unresolved?: number;
}

/**
 * ブロックの終わり方。
 *
 * `closed` は `>>>>>>>` に出会って終わったこと（途中のマーカーが欠けていてもよい）、
 * `cutOff` はそれを見ないまま打ち切られたこと（別のブロックの開始・ファイル末尾）を表す。
 */
type BlockEnding = "closed" | "cutOff";

/**
 * 終わったブロックのうち、並びを根拠に未解決として数えるものの開始行。
 *
 * ラベルを持たない `=======` だけが残った形は、ラベル一致では拾えない
 * （{@link findConflictRegions}）。それを補うのがこの判定で、根拠はマーカーの並びしかない。
 * 並びは利用者の編集で崩れるため、条件はどちらも区切り（`=======`）か base マーカー
 * （`|||||||`）まで進んでいることを求める。単独の `<<<<<<<` は本文にも現れうる一方、複数の
 * マーカーが順序どおり並ぶ形は本文にはまず現れないので、そこに誤検出と取りこぼしの境目を引く。
 * 誤検出すると `pull --continue` が永久に通らず、lock を手で直す以外の復旧手段が無くなる。
 *
 * - 開始マーカーから始まったブロックは、閉じても打ち切られても数える。閉じたものだけを
 *   数えると、`>>>>>>>` を消せば解決したことになってしまう。
 * - 開始マーカーが無い並びは、`>>>>>>>` で閉じたときだけ数える。`=======` は Markdown の
 *   setext 見出しの下線、`|||||||` は空セルだけのテーブル行として本文に現れるので、閉じ側
 *   まで揃わない並びはそれらと区別できない。
 *
 * この判断はここ 1 箇所にある。ブロックの終わり方（別のブロックの開始・`>>>>>>>`・
 * ファイル末尾）が増えても、数える条件は分岐しない。
 */
function unresolvedStart(state: ScanState, ending: BlockEnding): number | undefined {
  return match([state, ending] as const)
    .with(
      [{ phase: P.union("base", "template"), origin: "started" }, P.any],
      ([open]) => open.startLine,
    )
    .with(
      [{ phase: P.union("base", "template"), origin: "orphan" }, "closed"],
      ([open]) => open.startLine,
    )
    .with([{ phase: P.union("base", "template"), origin: "orphan" }, "cutOff"], () => undefined)
    .with([{ phase: P.union("outside", "local") }, P.any], () => undefined)
    .exhaustive();
}

/**
 * マーカー行 1 本を受けて走査状態を進める。
 *
 * `<<<<<<<` → （`|||||||`）→ `=======` → `>>>>>>>` の順序で揃ったときブロックが閉じる。
 * 開始マーカーが無くても、閉じ側のマーカーが順序どおり並べばブロックとして追う。順序から
 * 外れたマーカーは開いているブロックを打ち切るか、新しいブロックの開始として扱う。
 * 終わったブロックを未解決に数えるかは {@link unresolvedStart} が決める。
 */
function stepScan(state: ScanState, marker: Marker, lineNumber: number): ScanStep {
  const opened = (origin: BlockOrigin): OpenBlock => ({
    startLine: lineNumber,
    size: marker.length,
    origin,
  });
  return (
    match([state, marker.kind] as const)
      // 開いているブロックの途中で現れる `<<<<<<<` は、そこまでを打ち切って新しく開き直す。
      .with([P.any, "start"], ([open]) => ({
        next: openBlock("local", opened("started")),
        unresolved: unresolvedStart(open, "cutOff"),
      }))
      // 開始マーカーが無いまま現れる `|||||||` / `=======` は、解決の途中で開始行だけを
      // 消した残骸かもしれない。`>>>>>>>` まで揃うかを見るために開く。
      .with([{ phase: "outside" }, "base"], () => ({ next: openBlock("base", opened("orphan")) }))
      .with([{ phase: "outside" }, "separator"], () => ({
        next: openBlock("template", opened("orphan")),
      }))
      // 単独の `>>>>>>>` は 7 段以上ネストした引用として本文に現れる。並びの先頭にはしない。
      .with([{ phase: "outside" }, "end"], () => ({ next: OUTSIDE }))
      .with([{ phase: "local" }, "base"], ([open]) => ({ next: openBlock("base", open) }))
      .with([{ phase: P.union("local", "base") }, "separator"], ([open]) => ({
        next: openBlock("template", open),
      }))
      .with([{ phase: P.union("base", "template") }, "end"], ([open]) => ({
        next: OUTSIDE,
        unresolved: unresolvedStart(open, "closed"),
      }))
      // 区切りも base マーカーも見ていない `<<<<<<<` → `>>>>>>>` は、コンフリクトの残骸と
      // 言い切れない。ここまでを打ち切る。
      .with([{ phase: "local" }, "end"], ([open]) => ({
        next: OUTSIDE,
        unresolved: unresolvedStart(open, "cutOff"),
      }))
      // ブロック内に重ねて現れる同種のマーカーは本文として読み飛ばす。
      .with([{ phase: "base" }, "base"], ([open]) => ({ next: openBlock("base", open) }))
      .with([{ phase: "template" }, P.union("base", "separator")], ([open]) => ({
        next: openBlock("template", open),
      }))
      .exhaustive()
  );
}

/**
 * ラベル付きマーカー行が属するブロックの開始行。
 *
 * 1 つのブロックに複数のラベル行が残っていても、報告するのはそのブロックが最初に現れた行
 * 1 つにする。開いているブロックの中に現れたラベル行はその先頭へ、外に現れたラベル行は
 * その行自身へ寄せる。開始マーカーは、開いているブロックの中に現れてもそこから新しい
 * ブロックを開く（{@link stepScan}）ので、常に自分の行が先頭になる。
 */
function markerBlockStart(state: ScanState, kind: MarkerKind, lineNumber: number): number {
  if (kind === "start" || state.phase === "outside") return lineNumber;
  return state.startLine;
}

/**
 * ファイル内容に残っている未解決のコンフリクトブロックを列挙する。
 *
 * 未解決と数える根拠は 2 つあり、どちらかが当たれば数える。
 *
 * 1. ziku が書いたラベル（{@link MARKER_LABEL}）付きで、かつ生成長以上のマーカー行が
 *    1 本でも残っている。利用者が解決の途中でどのマーカーを消しても、残った
 *    1 本が根拠になる。ラベルは ziku 固有で、git のマーカーはブランチ名を載せ、setext
 *    見出し・空セルのテーブル行・深い引用はラベルを持たないので、本文と取り違えない。
 *    長さの下限が要るのは、ラベル付きのマーカー行が本文として正当に書かれうるため
 *    （マーカーの書き方を説明する文書を同期している場合）。生成長以上という条件は
 *    {@link GeneratedMarkerSize} の不変条件により「内容由来ではない」と同義になる。
 *    生成長が分からないときは下限を {@link MIN_MARKER_LENGTH} まで下げ、ラベルだけを
 *    根拠にする。内容由来のラベル付き行と区別する手がかりが無い以上、取りこぼすより
 *    多めに数える側へ倒す。
 * 2. ラベルを持たない `=======` だけが残った並びは 1 で拾えないので、マーカーが順序どおり
 *    並ぶ形を並びから判定する（{@link unresolvedStart}）。こちらは ziku が書いたかどうかを
 *    区別できないため、生成長によらず同じ規則で数える。
 *
 * 行頭の前方一致だけで数えると、Markdown の setext 見出し下線や区切り線 `========` を
 * 未解決と誤検出する。誤検出すると `pull --continue` が永久に通らず、解決済みのマージを
 * 確定できなくなる。逆に取りこぼすと、マーカー断片を載せたまま同期ベースが確定し、以後
 * テンプレートへ送られる。
 *
 * ブロックの内側では、開始マーカーより短いマーカー行は本文として扱う。マージ結果は
 * 内容中の最長マーカーより長いマーカーで囲まれているので、この長さ比較で
 * 「内容として書かれたマーカー」と「ziku が生成したマーカー」を区別できる。ラベル一致も
 * この比較の後に行う。マーカーの書き方を説明する文書を同期すると、生成されたブロックの中に
 * ラベル付きの本文行が入るため。
 *
 * 先頭の BOM はエンコーディングの目印であって 1 行目の内容ではないので、走査前に取り除く。
 * 残したまま比べると、1 行目から始まるブロックの開始マーカーが本文として読まれ、未解決の
 * ファイルが解決済みとして通ってしまう。
 */
export function findConflictRegions(
  content: string,
  markerSize: GeneratedMarkerSize,
): ConflictRegion[] {
  const labeledFrom = match(markerSize)
    .with({ kind: "known" }, ({ size }) => size)
    .with({ kind: "unknown" }, () => MIN_MARKER_LENGTH)
    .exhaustive();

  // 2 つの根拠が同じブロックを指すことがあるので、開始行の集合として持つ。
  const startLines = new Set<number>();
  let state: ScanState = OUTSIDE;

  const contentLines = stripBom(content).split("\n");
  for (let i = 0; i < contentLines.length; i++) {
    const marker = parseMarkerLine(contentLines[i]);
    if (marker === undefined) continue;
    if (state.phase !== "outside" && marker.length < state.size) continue;

    const lineNumber = i + 1;
    if (marker.labeled && marker.length >= labeledFrom) {
      startLines.add(markerBlockStart(state, marker.kind, lineNumber));
    }

    const step = stepScan(state, marker, lineNumber);
    state = step.next;
    if (step.unresolved !== undefined) startLines.add(step.unresolved);
  }

  // ファイル末尾も打ち切りの一種。走査の途中で起きる打ち切りと同じ規則で数える。
  const trailing = unresolvedStart(state, "cutOff");
  if (trailing !== undefined) startLines.add(trailing);

  return [...startLines].toSorted((a, b) => a - b).map((startLine) => ({ startLine }));
}
