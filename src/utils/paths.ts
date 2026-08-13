/**
 * パスの 3 つの brand（{@link AbsPath} / {@link RepoRelPath} / {@link GlobPattern}）を
 * 作る唯一の場所と、それらの間の変換。
 *
 * 型を分けただけでは、変換が各所で `as` として書かれて元の混同が戻る。値が外の世界から
 * 入ってくる境界（CLI 引数、ディレクトリ走査の結果、設定ファイルの読み込み）でここの関数を
 * 通し、それより内側では brand 付きの型だけが流れるようにする。
 */
import { join, resolve } from "pathe";
import { globSync, isDynamicPattern } from "tinyglobby";
import type { AbsPath, GlobPattern, RepoRelPath } from "../modules/schemas";
import { absPathSchema, globPatternSchema, repoRelPathSchema } from "../modules/schemas";

/**
 * 任意のパス文字列を絶対パスにして brand する。
 *
 * 相対パスを渡してもよい。プロセスのカレントディレクトリ基準で解決してから brand するので、
 * 「相対パスのまま絶対パスとして扱われる」状態がここより内側に入らない。CLI 引数や
 * 一時ディレクトリの作成結果など、外から来たパスの入口で 1 度だけ呼ぶ。
 */
export function absPath(path: string): AbsPath {
  return absPathSchema.parse(resolve(path));
}

/**
 * 基点ディレクトリと相対パスを繋いで絶対パスにする。
 *
 * ファイルを読み書きする直前の {@link AbsPath} は必ずこの関数から作る。素の `join` は
 * 結果が `string` になるため、基点と相対パスを逆に渡してもコンパイルが通ってしまう。
 */
export function joinAbs(base: AbsPath, ...segments: readonly string[]): AbsPath {
  return absPathSchema.parse(join(base, ...segments));
}

/**
 * 同期の基点からの相対パスを brand する。
 *
 * 走査結果や利用者が `--files` で指定したパスなど、既に相対形で得られている値の入口。
 */
export function repoRelPath(path: string): RepoRelPath {
  return repoRelPathSchema.parse(path);
}

/** {@link repoRelPath} の配列版。走査結果をまとめて brand する入口。 */
export function repoRelPaths(paths: readonly string[]): RepoRelPath[] {
  return paths.map((path) => repoRelPath(path));
}

/**
 * include / exclude に書かれた文字列を glob パターンとして brand する。
 *
 * リテラルパスも正当な値なので、glob 記法かどうかの検査はしない（{@link GlobPattern} の
 * 説明を参照）。パターンとパスの区別は照合方法の違いとして {@link selectPatternsMatchingPaths}
 * が担う。
 */
export function globPattern(pattern: string): GlobPattern {
  return globPatternSchema.parse(pattern);
}

/** {@link globPattern} の配列版。設定ファイル以外からパターン列を受け取る入口。 */
export function globPatterns(patterns: readonly string[]): GlobPattern[] {
  return patterns.map((pattern) => globPattern(pattern));
}

/**
 * 追跡対象として登録済みのリテラルパスを、そのままパターンとして扱う。
 *
 * `ziku push` が未追跡ファイルを include へ追記する経路と、ziku 自身の設定ファイルを
 * 常に追跡対象へ戻す経路で使う。どちらも「1 ファイルだけを指す include」を作るので、
 * glob として解釈しても自分自身にしか一致しない。
 */
export function pathAsPattern(path: RepoRelPath): GlobPattern {
  return globPattern(path);
}

/**
 * パターンのうち、与えられたパスのいずれかに一致するものだけを返す。
 *
 * 一致判定を文字列比較で済ませると glob が永久に一致しない。`.claude/rules/*.md` を
 * 追跡した利用者が `.claude/rules/a.md` を push しても「そのファイルに関係するパターンは
 * 無い」と判定され、include がテンプレートへ伝播しないまま本体だけが届く。他プロジェクトの
 * `init` / `pull` はパターンを見てファイルを拾うので、届かない限りそのファイルは配られない。
 *
 * glob の解決は `baseDir` の実ファイルに対して行う。パターンが実際に何に一致するかは
 * ディレクトリの中身で決まるため、パターン文字列だけを見る近似より、走査と同じ規則で
 * 解決したほうが `hashFiles` / `resolvePatterns` の結果と食い違わない。
 *
 * リテラルパスのパターンは走査を挟まず直接比較する。走査に落とすと、削除して push しようと
 * している（＝ディスク上に無い）ファイルのパターンを取りこぼす。
 */
export function selectPatternsMatchingPaths(opts: {
  readonly baseDir: AbsPath;
  readonly patterns: readonly GlobPattern[];
  readonly paths: readonly RepoRelPath[];
}): GlobPattern[] {
  if (opts.patterns.length === 0 || opts.paths.length === 0) return [];

  const pathSet = new Set<string>(opts.paths);

  // 戻り値は `ziku.jsonc` の include へ積まれるので、渡された並びをそのまま保つ。
  // リテラルと glob で 2 周すると、設定ファイルの差分が入力と違う順で現れる。
  return opts.patterns.filter((pattern) => {
    if (pathSet.has(pattern)) return true;
    // 走査するのは glob 記法のパターンだけ。個別ファイルのパスだけで構成された
    // `ziku.jsonc`（既定の運用）にディスク走査のコストを足さない。
    if (!isDynamicPattern(pattern)) return false;
    const resolved = globSync([pattern], { cwd: opts.baseDir, dot: true, onlyFiles: true });
    return resolved.some((file) => pathSet.has(file));
  });
}
