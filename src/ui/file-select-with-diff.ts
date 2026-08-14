/**
 * ファイル選択 + Diff プレビュー付きインタラクティブセレクタ
 *
 * 背景: @clack/prompts の multiselect はプレビュー機能を持たない。
 * ファイル選択時に差分を確認しながら判断できるよう、
 * カスタムのターミナルプロンプトを実装する。
 *
 * レイアウト:
 *   上部: カーソル位置のファイルの unified diff プレビュー（スクロール可能）
 *   下部: チェックボックス付きファイルリスト（カーソル追従のスクロール窓）
 *
 * 操作:
 *   ↑/↓ (k/j): ファイルリストのカーソル移動
 *   Space: 選択トグル
 *   a: 全選択/全解除
 *   Enter: 確定
 *   Ctrl+C: キャンセル（process.exit）
 *
 * 削除条件: @clack/prompts がプレビュー機能を持った場合。
 */
import * as readline from "node:readline";
import pc from "picocolors";
import { match } from "ts-pattern";
import type { FileDiff } from "../modules/schemas";
import { generateUnifiedDiff } from "../utils/diff";
import {
  applyWordDiffAndColorize,
  formatStatHint,
  getTypeIcon,
  getTypeLabel,
  toDiffContentLines,
} from "./diff-view";
import { graphemeWidth, stringWidth, toGraphemes } from "./text-width";

// ─── ANSI ユーティリティ ──────────────────────────────────────

/**
 * CSI シーケンスを除去して、端末に描かれるテキストだけを取り出す。
 *
 * ESC (0x1B) + "[" + パラメータバイト + 中間バイト + 終端バイトの形をすべて対象にする。
 * 色付けに使う SGR (`ESC[…m`) だけでなく、テンプレートファイルの中身に混入した
 * 制御シーケンスも幅 0 として扱う必要があるため、SGR に限定しない。
 *
 * 正規表現を文字列から構築し、no-control-regex lint ルールを回避する。
 */
const csiPattern = new RegExp(`${String.fromCodePoint(0x1b)}\\[[0-?]*[ -/]*[@-~]`, "g");
export function stripCsi(str: string): string {
  return str.replaceAll(csiPattern, "");
}

/** CSI シーケンスと、端末に描かれるテキストに分けた 1 区間。 */
interface LineToken {
  readonly isCsi: boolean;
  readonly text: string;
}

/** 行を CSI シーケンスと表示テキストへ分解する。幅を数える対象は後者だけになる。 */
function tokenizeLine(line: string): LineToken[] {
  const tokens: LineToken[] = [];
  let plainStart = 0;

  for (const csiMatch of line.matchAll(csiPattern)) {
    const index = csiMatch.index ?? 0;
    if (index > plainStart) {
      tokens.push({ isCsi: false, text: line.slice(plainStart, index) });
    }
    tokens.push({ isCsi: true, text: csiMatch[0] });
    plainStart = index + csiMatch[0].length;
  }
  if (plainStart < line.length) {
    tokens.push({ isCsi: false, text: line.slice(plainStart) });
  }
  return tokens;
}

/* v8 ignore start -- ターミナル制御定数。インタラクティブプロンプト専用でユニットテスト不可。 */
/** カーソルを非表示にする */
const hideCursor = "\u001B[?25l";
/** カーソルを表示する */
const showCursor = "\u001B[?25h";
/** 行をクリアする */
const clearLine = "\u001B[2K";
/** カーソルを行頭に移動 */
const carriageReturn = "\r";

/** カーソルを N 行上に移動 */
function cursorUp(n: number): string {
  return n > 0 ? `\u001B[${n}A` : "";
}
/* v8 ignore stop */

// ─── Diff フォーマット ──────────────────────────────────────────

/**
 * FileDiff から色付きの diff 行配列を生成する。
 *
 * unified diff を生成し、置換ブロックに word diff ハイライトを適用する。
 * 差分本文を持たないのは unchanged だけなので、空の diff はそのまま
 * 「変更なし」として表示する。
 */
export function buildColoredDiffLines(file: FileDiff): string[] {
  const raw = generateUnifiedDiff(file);
  if (!raw) return [pc.dim("(no changes)")];

  return applyWordDiffAndColorize(toDiffContentLines(raw));
}

// ─── ファイルリストアイテム ──────────────────────────────────────

export interface FileItem {
  readonly file: FileDiff;
  readonly label: string;
  readonly hint: string;
  readonly diffLines: string[];
}

/**
 * 一覧に出す 1 行の見え方と既定チェックを決める材料。
 *
 * 選択画面の 2 実装（TTY のプレビュー付きセレクタと非 TTY のフォールバック）が同じ型を
 * 受け取り、同じ関数（{@link fileSelectionHint} / {@link isPreselectedByDefault}）で
 * 判断する。片方だけが注記や既定チェックを持つと、端末の種類で挙動が変わる。
 */
export interface FileSelectionMarks {
  /** 削除ファイルをデフォルトで選択するか */
  readonly preselectDeletions?: boolean;
  /** 未解決の衝突ファイル。マーク表示し、デフォルト未選択にする。 */
  readonly conflictedPaths?: ReadonlySet<string>;
  /**
   * 送るとテンプレート側の削除を取り消すファイル。マーク表示し、デフォルト未選択にする。
   *
   * 見た目は新規追加と同じ `+` なので、注記が無いと「テンプレートが消したファイルを
   * 復活させる」操作だと画面から分からない。
   */
  readonly restoresTemplateDeletion?: ReadonlySet<string>;
}

/**
 * 行に添える注記。
 *
 * 未解決の衝突を先に見せる。選ぶと push そのものが中断するので、他の注記より
 * 行動への影響が大きい。
 */
export function fileSelectionHint(file: FileDiff, marks: FileSelectionMarks): string {
  if (marks.conflictedPaths?.has(file.path) === true) {
    return pc.red("conflict — resolve with ziku pull");
  }
  if (marks.restoresTemplateDeletion?.has(file.path) === true) {
    return pc.yellow("restores file deleted in template");
  }
  return formatStatHint(file);
}

/**
 * 既定でチェックを入れるか。
 *
 * 外すのは、選ぶと push が中断する未解決の衝突、`--include-deletions` でない削除、
 * テンプレート側の削除を取り消すファイル。理由は `defaultPushSelection`（非対話実行の
 * 既定集合）と同じで、対話実行だけが既定で送ってしまうことのないよう揃える。
 */
export function isPreselectedByDefault(file: FileDiff, marks: FileSelectionMarks): boolean {
  return (
    marks.conflictedPaths?.has(file.path) !== true &&
    marks.restoresTemplateDeletion?.has(file.path) !== true &&
    (marks.preselectDeletions === true || file.type !== "deleted")
  );
}

export function buildFileItems(files: FileDiff[], marks?: FileSelectionMarks): FileItem[] {
  return files.map((file) => ({
    file,
    label: `${getTypeIcon(file.type)} ${file.path}`,
    hint: fileSelectionHint(file, marks ?? {}),
    diffLines: buildColoredDiffLines(file),
  }));
}

// ─── レンダリング ──────────────────────────────────────────────

export interface RenderState {
  readonly items: FileItem[];
  readonly selected: Set<string>;
  cursorIndex: number;
  diffScrollOffset: number;
  /** 前回レンダリングした行数（再描画時のクリアに使用） */
  lastRenderedLines: number;
}

/**
 * diff プレビューとファイルリスト以外が消費する固定行数。
 *
 * ヘッダー(1) + 空行(1) + diff 枠上(1) + diff 枠下(1) + リスト前の空行(1)
 * + フッター前の空行(1) + フッター(1)。
 */
const chromeLines = 7;

/** diff プレビューの最小行数。変更行とその前後 1 行ずつが見えないと差分の意味が取れない。 */
const minDiffHeight = 3;

/**
 * ファイルリスト領域の最小行数。
 *
 * 窓に入りきらない項目があるとき、カーソル行と上下 2 本のインジケータ行が同時に要る。
 */
const minListAreaHeight = 3;

/** diff プレビューが端末高さに占めてよい割合。リストが短いときに diff で埋め尽くさない。 */
const diffHeightRatio = 0.5;

/** 端末の行数を diff プレビューとファイルリストへ配分した結果。 */
export interface ScreenLayout {
  /** diff プレビューの内容行数 */
  readonly diffHeight: number;
  /** ファイルリスト領域の行数。窓外インジケータ行もここから消費する。 */
  readonly listAreaHeight: number;
}

/**
 * 端末の行数を diff プレビューとファイルリストに配分する。
 *
 * `chromeLines + diffHeight + listAreaHeight` が端末行数を超えないことを保証する。
 * 超えると出力の上端がスクロールアウトし、再描画時のカーソル上移動が画面最上行で
 * クランプされてクリア対象がずれるため、キー入力のたびに画面が壊れていく。
 *
 * ファイルリストを優先し、余りを diff に回す。全ファイルが収まらない場合は diff を
 * 最小行数まで縮め、それでも入りきらない分をスクロール窓が吸収する。
 *
 * ただし端末が `chromeLines + minDiffHeight + minListAreaHeight` 行に満たない場合は
 * 最小構成を返し、合計が端末行数を超える。この高さではどう配分しても diff とリストの
 * どちらかが消えて選択の判断ができなくなるため、最小構成の維持を優先する。
 */
export function computeScreenLayout(termRows: number, fileCount: number): ScreenLayout {
  const available = Math.max(minDiffHeight + minListAreaHeight, termRows - chromeLines);
  const diffCap = Math.max(minDiffHeight, Math.floor(termRows * diffHeightRatio));

  const diffHeight = Math.min(diffCap, Math.max(minDiffHeight, available - fileCount));
  const listAreaHeight = Math.min(fileCount, Math.max(minListAreaHeight, available - diffHeight));

  return { diffHeight, listAreaHeight };
}

/** diff プレビュー領域に使える行数を返す。 */
export function getDiffPreviewHeight(termRows: number, fileCount: number): number {
  return computeScreenLayout(termRows, fileCount).diffHeight;
}

/** ファイルリストのうち実際に描画する範囲と、その外に隠れている件数。 */
export interface ListWindow {
  /** 描画する最初の項目の index */
  readonly start: number;
  /** 描画する最後の項目の次の index */
  readonly end: number;
  /** 窓より上に隠れている項目数 */
  readonly hiddenAbove: number;
  /** 窓より下に隠れている項目数 */
  readonly hiddenBelow: number;
}

/**
 * カーソルを中心にしたスクロール窓を決める。
 *
 * 全件が `listAreaHeight` に収まるなら窓で区切らない。収まらない場合は隠れた項目が
 * あることを示すインジケータ行が同じ領域を消費するので、その分だけ項目数を減らす。
 * カーソルは常に窓の内側に入り、リストの上下端では窓を固定してカーソルだけが動く。
 */
export function computeListWindow(
  itemCount: number,
  cursorIndex: number,
  listAreaHeight: number,
): ListWindow {
  if (itemCount <= listAreaHeight) {
    return { start: 0, end: itemCount, hiddenAbove: 0, hiddenBelow: 0 };
  }

  // 端に寄せた窓はインジケータが片側だけ、途中の窓は上下両方に出る。
  // 領域が極端に狭くても 1 項目は描くため下限を 1 にする。
  const edgeCapacity = Math.max(1, listAreaHeight - 1);
  const middleCapacity = Math.max(1, listAreaHeight - 2);

  let start = cursorIndex - Math.floor((middleCapacity - 1) / 2);
  let end = start + middleCapacity;

  if (start <= 0) {
    start = 0;
    end = edgeCapacity;
  } else if (end >= itemCount) {
    end = itemCount;
    start = Math.max(0, itemCount - edgeCapacity);
  }

  return { start, end, hiddenAbove: start, hiddenBelow: itemCount - end };
}

/**
 * 表示カラム数が `maxWidth` に収まるよう行を切り詰める。
 *
 * 幅は端末のカラム数で数え、全角文字は 2 カラムとして扱う。切り詰めは書記素クラスタ
 * 境界で行うため、サロゲートペアや結合文字列は割れない。CSI シーケンスは幅 0 のまま
 * 残し、末尾にリセットを入れて色が後続行へ漏れるのを防ぐ。
 */
export function truncateLine(line: string, maxWidth: number): string {
  if (maxWidth <= 0) return "";
  if (stringWidth(stripCsi(line)) <= maxWidth) return line;

  // 省略記号 "…" が 1 カラム占めるので、本文に使えるのは maxWidth - 1 カラム。
  const contentBudget = maxWidth - 1;
  let result = "";
  let width = 0;
  let budgetExhausted = false;

  for (const token of tokenizeLine(line)) {
    if (budgetExhausted) break;
    if (token.isCsi) {
      result += token.text;
      continue;
    }
    for (const cluster of toGraphemes(token.text)) {
      const clusterWidth = graphemeWidth(cluster);
      if (width + clusterWidth > contentBudget) {
        budgetExhausted = true;
        break;
      }
      result += cluster;
      width += clusterWidth;
    }
  }

  // 色の漏れを断つリセットを挟んでから省略記号を置く
  return `${result}\u001B[0m${pc.dim("…")}\u001B[0m`;
}

/** テスト用にターミナルサイズを注入できるオプション */
interface TerminalSize {
  readonly columns: number;
  readonly rows: number;
}

/**
 * 窓外に項目があることを示すインジケータの字下げ幅。
 *
 * リスト行の「カーソル(1) + 空白(1) + チェックボックス(1) + 空白(1)」に揃え、
 * ラベルと同じ位置から始める。
 */
const listIndicatorIndent = " ".repeat(4);

/**
 * ファイルリスト部分の行を組み立てる。
 *
 * 返る行数は `listAreaHeight` 以内に収まる。窓の外にある項目は件数だけを示す。
 */
function renderFileList(state: RenderState, listAreaHeight: number, cols: number): string[] {
  const { items, selected, cursorIndex } = state;
  const listWindow = computeListWindow(items.length, cursorIndex, listAreaHeight);
  const lines: string[] = [];

  if (listWindow.hiddenAbove > 0) {
    lines.push(pc.dim(`${listIndicatorIndent}… ${listWindow.hiddenAbove} more above`));
  }

  for (let fi = listWindow.start; fi < listWindow.end; fi++) {
    const item = items[fi];
    const isSelected = selected.has(item.file.path);
    const isCursor = fi === cursorIndex;

    const checkbox = isSelected ? pc.green("◼") : pc.dim("◻");
    const cursor = isCursor ? pc.cyan("›") : " ";
    const label = isCursor ? pc.underline(item.label) : item.label;
    const hint = item.hint ? ` ${pc.dim(item.hint)}` : "";

    lines.push(truncateLine(`${cursor} ${checkbox} ${label}${hint}`, cols));
  }

  if (listWindow.hiddenBelow > 0) {
    lines.push(pc.dim(`${listIndicatorIndent}… ${listWindow.hiddenBelow} more below`));
  }

  return lines;
}

/**
 * 画面全体をレンダリングし、出力文字列を返す。
 *
 * 副作用なし: 呼び出し側が stdout に書き込む。
 * termSize を省略すると process.stdout のサイズを使用する。
 */
export function render(state: RenderState, termSize?: TerminalSize): string {
  const cols = termSize?.columns ?? process.stdout.columns ?? 80;
  const rows = termSize?.rows ?? process.stdout.rows ?? 24;
  const { items, cursorIndex, diffScrollOffset } = state;
  const currentItem = items[cursorIndex];

  // ── ヘッダー
  // どの行も端末幅で折り返されると 1 行が 2 行を占め、レイアウトの行数計算が崩れる。
  // そのため可変長になりうる行はすべて cols に切り詰める。
  const lines: string[] = [
    truncateLine(`${pc.gray("◆")}  ${pc.bold("Select files to include in PR")}`, cols),
    "",
  ];

  // ── Diff プレビュー
  const { diffHeight, listAreaHeight } = computeScreenLayout(rows, items.length);
  const diffLines = currentItem.diffLines;
  const maxScroll = Math.max(0, diffLines.length - diffHeight);
  const scrollOffset = Math.min(diffScrollOffset, maxScroll);

  const diffTitle = ` ${currentItem.file.path} `;
  const typeLabel = getTypeLabel(currentItem.file.type);
  const headerText = `${diffTitle}${pc.dim("—")} ${typeLabel} ${currentItem.hint}`;

  // diff 枠上部
  lines.push(truncateLine(`${pc.dim("┌")} ${headerText}`, cols));

  // diff 内容
  const visibleDiff = diffLines.slice(scrollOffset, scrollOffset + diffHeight);
  const contentWidth = cols - 4; // "│ " prefix + padding
  for (const dl of visibleDiff) {
    const truncated = truncateLine(dl, contentWidth);
    lines.push(`${pc.dim("│")} ${truncated}`);
  }
  // 空行でパディング
  for (let pi = visibleDiff.length; pi < diffHeight; pi++) {
    lines.push(pc.dim("│"));
  }

  // スクロールインジケータ
  const scrollInfo =
    diffLines.length > diffHeight
      ? pc.dim(
          ` [${scrollOffset + 1}-${Math.min(scrollOffset + diffHeight, diffLines.length)}/${diffLines.length}] ↑↓ scroll with Shift`,
        )
      : "";
  lines.push(truncateLine(`${pc.dim("└")}${scrollInfo}`, cols));

  lines.push("");

  // ── ファイルリスト
  lines.push(...renderFileList(state, listAreaHeight, cols));

  // ── フッター
  lines.push("");
  lines.push(
    truncateLine(
      pc.dim("  ↑↓/jk navigate · space toggle · a all/none · enter confirm · Ctrl+C cancel"),
      cols,
    ),
  );

  return lines.join("\n");
}

// ─── キー入力 → アクション解決 ──────────────────────────────────

/** キーボードアクション名 */
export type KeyAction =
  | "cancel"
  | "confirm"
  | "toggle"
  | "toggleAll"
  | "scrollDiffUp"
  | "scrollDiffDown"
  | "cursorUp"
  | "cursorDown";

/** 単純キー名 → アクションの静的マッピング */
const simpleKeyMap: Record<string, KeyAction> = {
  return: "confirm",
  space: "toggle",
  a: "toggleAll",
};

/** キー入力を正規化されたアクション名に変換する */
export function resolveKeyAction(key: readline.Key): KeyAction | undefined {
  if (key.ctrl === true) {
    return key.name === "c" ? "cancel" : undefined;
  }
  if (key.name !== undefined && key.name !== "" && key.name in simpleKeyMap) {
    return simpleKeyMap[key.name];
  }

  // 方向キー: Shift でスクロール、なしでカーソル移動
  if (key.name === "up") return key.shift === true ? "scrollDiffUp" : "cursorUp";
  if (key.name === "down") return key.shift === true ? "scrollDiffDown" : "cursorDown";
  // vim キー (Shift なし)
  if (key.name === "k" && key.shift !== true) return "cursorUp";
  if (key.name === "j" && key.shift !== true) return "cursorDown";
  return undefined;
}

// ─── 純粋な状態遷移（テスト可能） ──────────────────────────────

/** アクション実行結果: UI 副作用の指示 */
export type ActionEffect = "redraw" | "cancel" | "confirm";

/**
 * アクションに応じて RenderState を変更し、必要な副作用を返す。
 *
 * 副作用なし（純粋関数）: state は in-place 変更される。
 * テスタビリティのため、ターミナル I/O は呼び出し側が ActionEffect に基づいて行う。
 */
export function applyAction(state: RenderState, action: KeyAction, termRows: number): ActionEffect {
  return match(action)
    .with("cancel", (): ActionEffect => "cancel")
    .with("confirm", (): ActionEffect => "confirm")
    .with("cursorUp", (): ActionEffect => {
      if (state.cursorIndex > 0) {
        state.cursorIndex--;
        state.diffScrollOffset = 0;
      }
      return "redraw";
    })
    .with("cursorDown", (): ActionEffect => {
      if (state.cursorIndex < state.items.length - 1) {
        state.cursorIndex++;
        state.diffScrollOffset = 0;
      }
      return "redraw";
    })
    .with("scrollDiffUp", (): ActionEffect => {
      if (state.diffScrollOffset > 0) state.diffScrollOffset--;
      return "redraw";
    })
    .with("scrollDiffDown", (): ActionEffect => {
      const currentItem = state.items[state.cursorIndex];
      const diffHeight = getDiffPreviewHeight(termRows, state.items.length);
      const maxScroll = Math.max(0, currentItem.diffLines.length - diffHeight);
      if (state.diffScrollOffset < maxScroll) state.diffScrollOffset++;
      return "redraw";
    })
    .with("toggle", (): ActionEffect => {
      const path = state.items[state.cursorIndex].file.path;
      if (state.selected.has(path)) {
        state.selected.delete(path);
      } else {
        state.selected.add(path);
      }
      return "redraw";
    })
    .with("toggleAll", (): ActionEffect => {
      const allSelected = state.items.every((item) => state.selected.has(item.file.path));
      if (allSelected) {
        state.selected.clear();
      } else {
        for (const item of state.items) state.selected.add(item.file.path);
      }
      return "redraw";
    })
    .exhaustive();
}

// ─── メインプロンプト ──────────────────────────────────────────

export type FileSelectWithDiffOptions = FileSelectionMarks;

/**
 * Diff プレビュー付きファイル選択プロンプト。
 *
 * ↑↓ でファイルリストを移動すると、上部に対応する unified diff がプレビュー表示される。
 * Space で選択/解除、Enter で確定、Ctrl+C でキャンセル（process.exit(0)）。
 *
 * @returns 選択されたファイルの配列。空配列 = 何も選択せず確定。
 */
/* v8 ignore start -- readline raw mode のインタラクティブ I/O。ユニットテストでは再現不可。 */
export function selectFilesWithDiffPreview(
  files: FileDiff[],
  options?: FileSelectWithDiffOptions,
): Promise<FileDiff[]> {
  if (files.length === 0) return Promise.resolve([]);

  const marks = options ?? {};
  const items = buildFileItems(files, marks);

  const initialSelected = new Set<string>(
    files.filter((f) => isPreselectedByDefault(f, marks)).map((f) => f.path),
  );

  const state: RenderState = {
    items,
    selected: initialSelected,
    cursorIndex: 0,
    diffScrollOffset: 0,
    lastRenderedLines: 0,
  };

  return new Promise<FileDiff[]>((resolve) => {
    const stdin = process.stdin;
    const stdout = process.stdout;

    // raw mode を有効化
    const wasRaw = stdin.isRaw;
    if (stdin.isTTY) {
      stdin.setRawMode(true);
    }
    readline.emitKeypressEvents(stdin);
    stdin.resume();

    // カーソル非表示
    stdout.write(hideCursor);

    /** 画面をクリアして再描画 */
    function redraw(): void {
      // 前回の出力をクリア
      if (state.lastRenderedLines > 0) {
        stdout.write(cursorUp(state.lastRenderedLines - 1));
        for (let li = 0; li < state.lastRenderedLines; li++) {
          stdout.write(clearLine + carriageReturn + (li < state.lastRenderedLines - 1 ? "\n" : ""));
        }
        stdout.write(cursorUp(state.lastRenderedLines - 1));
      }

      const output = render(state);
      const outputLines = output.split("\n");
      state.lastRenderedLines = outputLines.length;
      stdout.write(carriageReturn + output);
    }

    /** クリーンアップして resolve */
    function finish(result: FileDiff[]): void {
      stdin.removeListener("keypress", onKeypress);
      stdout.write(showCursor + "\n");
      if (stdin.isTTY) {
        stdin.setRawMode(wasRaw ?? false);
      }
      stdin.pause();
      resolve(result);
    }

    function onKeypress(_ch: string | undefined, key: readline.Key | undefined): void {
      if (!key) return;
      const action = resolveKeyAction(key);
      if (!action) return;

      const effect = applyAction(state, action, process.stdout.rows ?? 24);
      match(effect)
        .with("redraw", () => {
          redraw();
        })
        .with("cancel", () => {
          stdout.write(showCursor + "\n");
          if (stdin.isTTY) stdin.setRawMode(wasRaw ?? false);
          process.exit(0);
        })
        .with("confirm", () => {
          finish(files.filter((f) => state.selected.has(f.path)));
        })
        .exhaustive();
    }

    stdin.on("keypress", onKeypress);

    // 初回描画
    redraw();
  });
}
/* v8 ignore stop */
