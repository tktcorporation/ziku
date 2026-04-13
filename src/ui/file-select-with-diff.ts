/**
 * ファイル選択 + Diff プレビュー付きインタラクティブセレクタ
 *
 * 背景: @clack/prompts の multiselect はプレビュー機能を持たない。
 * ファイル選択時に差分を確認しながら判断できるよう、
 * カスタムのターミナルプロンプトを実装する。
 *
 * レイアウト:
 *   上部: カーソル位置のファイルの unified diff プレビュー（スクロール可能）
 *   下部: チェックボックス付きファイルリスト
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
import { applyWordDiffAndColorize, calculateDiffStats, formatStats } from "./diff-view";

// ─── ANSI ユーティリティ ──────────────────────────────────────

/**
 * ANSI エスケープシーケンスを除去してプレーンテキストの文字幅を得る。
 *
 * ESC (0x1B) + "[" + パラメータ + "m" 形式の SGR シーケンスを除去する。
 * 正規表現を文字列から構築し、no-control-regex lint ルールを回避する。
 */
const ansiPattern = new RegExp(`${String.fromCodePoint(0x1b)}\\[[0-9;]*m`, "g");
export function stripAnsi(str: string): string {
  return str.replaceAll(ansiPattern, "");
}

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

// ─── Diff フォーマット ──────────────────────────────────────────

/**
 * FileDiff から色付きの diff 行配列を生成する。
 *
 * unified diff を生成し、隣接する -/+ ペアに word diff ハイライトを適用する。
 * ヘッダー行（Index:, ===, ---, +++）は除外する。
 */
export function buildColoredDiffLines(file: FileDiff): string[] {
  if (file.type === "unchanged") return [pc.dim("(no changes)")];

  const raw = generateUnifiedDiff(file);
  if (!raw) return [pc.dim("(no diff available)")];

  const lines = raw
    .split("\n")
    .filter(
      (l) =>
        !l.startsWith("Index:") &&
        !l.startsWith("===") &&
        !l.startsWith("---") &&
        !l.startsWith("+++"),
    );

  return applyWordDiffAndColorize(lines);
}

// ─── ファイルリストアイテム ──────────────────────────────────────

export interface FileItem {
  readonly file: FileDiff;
  readonly label: string;
  readonly hint: string;
  readonly diffLines: string[];
}

export function buildFileItems(files: FileDiff[]): FileItem[] {
  return files.map((file) => {
    const icon = match(file.type)
      .with("added", () => pc.green("+"))
      .with("modified", () => pc.yellow("~"))
      .with("deleted", () => pc.red("-"))
      .otherwise(() => " ");

    const stats = calculateDiffStats(file);
    const hint = stats.additions === 0 && stats.deletions === 0 ? "" : formatStats(stats);

    return {
      file,
      label: `${icon} ${file.path}`,
      hint,
      diffLines: buildColoredDiffLines(file),
    };
  });
}

// ─── レンダリング ──────────────────────────────────────────────

interface RenderState {
  readonly items: FileItem[];
  readonly selected: Set<string>;
  cursorIndex: number;
  diffScrollOffset: number;
  /** 前回レンダリングした行数（再描画時のクリアに使用） */
  lastRenderedLines: number;
}

/**
 * diff プレビュー領域に使える行数を計算する。
 *
 * ターミナル高さからファイルリスト・ヘッダー・フッターを引いた残りを diff に割り当てる。
 * 最低 3 行は確保し、最大でターミナル高さの 50% まで。
 */
export function getDiffPreviewHeight(termRows: number, fileCount: number): number {
  // ヘッダー(1) + 空行(1) + diff枠上(1) + diff枠下(1) + 空行(1) + ファイルリスト + フッター(2)
  const overhead = 7;
  const fileListHeight = fileCount;
  const available = termRows - overhead - fileListHeight;
  const maxHeight = Math.floor(termRows * 0.5);
  return Math.max(3, Math.min(available, maxHeight));
}

/** diff 行を指定幅で切り詰める */
export function truncateLine(line: string, maxWidth: number): string {
  const plain = stripAnsi(line);
  if (plain.length <= maxWidth) return line;

  // ANSI コードを維持しながら文字数制限する簡易実装
  // 完全な実装は複雑になるため、プレーンテキストベースで切り詰め
  let visibleLen = 0;
  let result = "";
  let inEscape = false;

  for (let ci = 0; ci < line.length; ci++) {
    const ch = line[ci];
    if (ch === "\u001B") {
      inEscape = true;
      result += ch;
      continue;
    }
    if (inEscape) {
      result += ch;
      if (ch === "m") inEscape = false;
      continue;
    }
    if (visibleLen >= maxWidth - 1) {
      result += pc.dim("…");
      break;
    }
    result += ch;
    visibleLen++;
  }

  return result;
}

/** テスト用にターミナルサイズを注入できるオプション */
interface TerminalSize {
  readonly columns: number;
  readonly rows: number;
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
  const { items, selected, cursorIndex, diffScrollOffset } = state;
  const currentItem = items[cursorIndex];

  // ── ヘッダー
  const lines: string[] = [`${pc.gray("◆")}  ${pc.bold("Select files to include in PR")}`, ""];

  // ── Diff プレビュー
  const diffHeight = getDiffPreviewHeight(rows, items.length);
  const diffLines = currentItem.diffLines;
  const maxScroll = Math.max(0, diffLines.length - diffHeight);
  const scrollOffset = Math.min(diffScrollOffset, maxScroll);

  const diffTitle = ` ${currentItem.file.path} `;
  const typeLabel = match(currentItem.file.type)
    .with("added", () => pc.green("added"))
    .with("modified", () => pc.yellow("modified"))
    .with("deleted", () => pc.red("deleted"))
    .otherwise(() => "");
  const headerText = `${diffTitle}${pc.dim("—")} ${typeLabel} ${currentItem.hint}`;

  // diff 枠上部
  lines.push(`${pc.dim("┌")} ${headerText}`);

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
  lines.push(`${pc.dim("└")}${scrollInfo}`);

  lines.push("");

  // ── ファイルリスト
  for (let fi = 0; fi < items.length; fi++) {
    const item = items[fi];
    const isSelected = selected.has(item.file.path);
    const isCursor = fi === cursorIndex;

    const checkbox = isSelected ? pc.green("◼") : pc.dim("◻");
    const cursor = isCursor ? pc.cyan("›") : " ";
    const label = isCursor ? pc.underline(item.label) : item.label;
    const hint = item.hint ? ` ${pc.dim(item.hint)}` : "";

    lines.push(`${cursor} ${checkbox} ${label}${hint}`);
  }

  // ── フッター
  lines.push("");
  lines.push(
    pc.dim("  ↑↓/jk navigate · space toggle · a all/none · enter confirm · Ctrl+C cancel"),
  );

  return lines.join("\n");
}

// ─── キー入力 → アクション解決 ──────────────────────────────────

/** キーボードアクション名 */
type KeyAction =
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
function resolveKeyAction(key: readline.Key): KeyAction | undefined {
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

// ─── メインプロンプト ──────────────────────────────────────────

export interface FileSelectWithDiffOptions {
  /** 削除ファイルをデフォルトで選択するか */
  preselectDeletions?: boolean;
}

/**
 * Diff プレビュー付きファイル選択プロンプト。
 *
 * ↑↓ でファイルリストを移動すると、上部に対応する unified diff がプレビュー表示される。
 * Space で選択/解除、Enter で確定、Ctrl+C でキャンセル（process.exit(0)）。
 *
 * @returns 選択されたファイルの配列。空配列 = 何も選択せず確定。
 */
export function selectFilesWithDiffPreview(
  files: FileDiff[],
  options?: FileSelectWithDiffOptions,
): Promise<FileDiff[]> {
  if (files.length === 0) return Promise.resolve([]);

  const items = buildFileItems(files);

  const initialSelected = new Set<string>(
    options?.preselectDeletions === true
      ? files.map((f) => f.path)
      : files.filter((f) => f.type !== "deleted").map((f) => f.path),
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

    /** アクションを実行する */
    function handleAction(action: KeyAction): void {
      match(action)
        .with("cancel", () => {
          stdout.write(showCursor + "\n");
          if (stdin.isTTY) stdin.setRawMode(wasRaw ?? false);
          process.exit(0);
        })
        .with("confirm", () => {
          finish(files.filter((f) => state.selected.has(f.path)));
        })
        .with("cursorUp", () => {
          if (state.cursorIndex > 0) {
            state.cursorIndex--;
            state.diffScrollOffset = 0;
          }
          redraw();
        })
        .with("cursorDown", () => {
          if (state.cursorIndex < items.length - 1) {
            state.cursorIndex++;
            state.diffScrollOffset = 0;
          }
          redraw();
        })
        .with("scrollDiffUp", () => {
          if (state.diffScrollOffset > 0) state.diffScrollOffset--;
          redraw();
        })
        .with("scrollDiffDown", () => {
          const currentItem = items[state.cursorIndex];
          const termRows = process.stdout.rows || 24;
          const diffHeight = getDiffPreviewHeight(termRows, items.length);
          const maxScroll = Math.max(0, currentItem.diffLines.length - diffHeight);
          if (state.diffScrollOffset < maxScroll) state.diffScrollOffset++;
          redraw();
        })
        .with("toggle", () => {
          const path = items[state.cursorIndex].file.path;
          if (state.selected.has(path)) {
            state.selected.delete(path);
          } else {
            state.selected.add(path);
          }
          redraw();
        })
        .with("toggleAll", () => {
          const allSelected = items.every((item) => state.selected.has(item.file.path));
          if (allSelected) {
            state.selected.clear();
          } else {
            for (const item of items) state.selected.add(item.file.path);
          }
          redraw();
        })
        .exhaustive();
    }

    function onKeypress(_ch: string | undefined, key: readline.Key | undefined): void {
      if (!key) return;
      const action = resolveKeyAction(key);
      if (action) handleAction(action);
    }

    stdin.on("keypress", onKeypress);

    // 初回描画
    redraw();
  });
}
