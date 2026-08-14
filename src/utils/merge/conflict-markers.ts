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
    local: `${MARKER_CHAR.start.repeat(size)} LOCAL`,
    base: `${MARKER_CHAR.base.repeat(size)} BASE`,
    separator: MARKER_CHAR.separator.repeat(size),
    template: `${MARKER_CHAR.end.repeat(size)} TEMPLATE`,
  };
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
 * 終わったブロックのうち、未解決として数えるものの開始行。
 *
 * 数える条件は 2 つある。どちらも区切り（`=======`）か base マーカー（`|||||||`）まで
 * 進んでいることを求める。単独の `<<<<<<<` は本文にも現れうる一方、複数のマーカーが順序どおり
 * 並ぶ形は本文にはまず現れないので、そこに誤検出と取りこぼしの境目を引く。誤検出すると
 * `pull --continue` が永久に通らず、lock を手で直す以外の復旧手段が無くなる。
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
 * ファイル内容に残っている未解決のコンフリクトブロックを列挙する。
 *
 * 行頭の前方一致だけで判定すると、Markdown の setext 見出し下線や区切り線
 * `========` を未解決と誤検出する。誤検出すると `pull --continue` が永久に通らず、
 * 解決済みのマージを確定できなくなるため、マーカーが順序どおり並ぶブロックだけを未解決と
 * みなす。開始マーカーが消えていても、閉じ側の並びが揃っていれば数える
 * （{@link unresolvedStart}）。数える条件を開始マーカーで定義すると、それを消しただけの
 * 残骸が未解決 0 件になり、マーカー断片を載せたまま同期ベースが確定する。
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
    if (step.unresolved !== undefined) regions.push({ startLine: step.unresolved });
  }

  // ファイル末尾も打ち切りの一種。走査の途中で起きる打ち切りと同じ規則で数える。
  const trailing = unresolvedStart(state, "cutOff");
  if (trailing !== undefined) regions.push({ startLine: trailing });

  return regions;
}
