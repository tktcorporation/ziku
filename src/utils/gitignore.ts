import { existsSync, statSync } from "node:fs";
import { readFile, readdir } from "node:fs/promises";
import ignore, { type Ignore } from "ignore";
import type { AbsPath, GlobPattern, RepoRelPath } from "../modules/schemas";
import { joinAbs } from "./paths";
import { getBaseDirsFromPatterns } from "./patterns";
import { UNSCANNED_DIRS } from "./scan-exclusions";

/** git が無視規則を読むファイル名。 */
const GITIGNORE_FILE = ".gitignore";

/**
 * 複数リポジトリの無視判定をまとめたもの。
 *
 * 表す規則は「どれか 1 つのリポジトリが無視すると決めたら無視する」。判定の結果だけを見せて
 * 規則の集合を見せないのは、規則を連結して 1 つの matcher にすると別の演算になるため
 * （{@link loadMergedGitignore}）。
 */
export interface IgnoreDecision {
  readonly ignores: (path: RepoRelPath) => boolean;
}

/**
 * 複数リポジトリの `.gitignore` を読み、無視判定をまとめる。
 *
 * ローカルとテンプレートの両方を読むのは、どちら側が無視すると決めたファイルも同期の対象から
 * 外すため。片側だけを読むと、無視されているはずのマシン固有の内容がもう一方へ流れる。
 *
 * 判定はリポジトリごとに独立して行い、結果を論理和で束ねる。全リポジトリの規則を 1 つの
 * Ignore へ連結すると、gitignore の「後の規則が勝つ」順序が働いて、片方の否定規則
 * （`!secret.env`）がもう片方の無視を打ち消す。ローカルが無視すると決めた資格情報が、
 * テンプレート側の否定規則によって同期対象へ戻る。否定規則が効くのは、それが書かれた
 * リポジトリの中だけでよい。
 *
 * ルート以外に置かれた `.gitignore` も、そのリポジトリの Ignore へ畳み込む。git は各
 * ディレクトリの `.gitignore` をそのディレクトリ起点で解釈するので、規則をルート起点へ
 * 読み替えてから足す（{@link scopeToDir}）。これを省くと、`.claude/.gitignore` のように
 * ネストして置かれた無視規則だけが判定から漏れ、リポジトリの他の場所にある同名のファイルまで
 * 巻き込んで無視する規則になる。浅い順に足すので、同一リポジトリ内では深い側の `.gitignore`
 * が浅い側を上書きし、そこでの否定も意図どおり効く。
 *
 * 読む先はディスクを走査して決める（{@link findGitignoreDirs}）。include パターンを受け取る
 * のは探索範囲を絞るためだけで、どのディレクトリを見るかを呼び出し側が列挙する必要はない。
 *
 * @param dirs `.gitignore` の探索起点（ローカル・テンプレートのリポジトリルート）。
 * @param include 同期対象の include パターン。探索するサブツリーをここから導く。
 */
export async function loadMergedGitignore(
  dirs: readonly AbsPath[],
  include: readonly GlobPattern[],
): Promise<IgnoreDecision> {
  const baseDirs = gitignoreScanRoots(include);
  const perRepository: Ignore[] = [];

  for (const dir of dirs) {
    const ig = ignore();
    const rootRules = await readGitignore(joinAbs(dir, GITIGNORE_FILE));
    if (rootRules !== undefined) ig.add(rootRules);

    for (const nested of await findGitignoreDirs(dir, baseDirs)) {
      const nestedRules = await readGitignore(joinAbs(dir, nested, GITIGNORE_FILE));
      if (nestedRules !== undefined) ig.add(prefixRules(nestedRules, nested));
    }
    perRepository.push(ig);
  }

  return { ignores: (path) => perRepository.some((ig) => ig.ignores(path)) };
}

/**
 * `.gitignore` の探索を始めるディレクトリを、include パターンから決める。
 *
 * 先頭セグメントが実在のディレクトリ名を指すパターンは、そのディレクトリから下だけを見れば
 * よい。先頭セグメントが glob の記法を含むパターン（`**\/*.env`、`{services,apps}/**`）は
 * どこへでも届きうるので、リポジトリ全体を起点にする。展開先をディレクトリ名として
 * 静的に読むと、その名前のディレクトリは実在せず走査が始まらないため、`services/app/.gitignore`
 * のような規則が読まれないまま、そのファイルが同期対象に残る。
 *
 * ルートを起点にする場合は他の起点を持たない。ルートから辿れば全て含まれる。
 */
function gitignoreScanRoots(include: readonly GlobPattern[]): readonly string[] {
  const { dirs, reachesWholeRepo } = getBaseDirsFromPatterns(include);
  return reachesWholeRepo ? [REPO_ROOT] : dirs;
}

/** 走査の起点としてのリポジトリルート。ルートからの相対で表すので空文字列になる。 */
const REPO_ROOT = "";

/**
 * `.gitignore` を持つディレクトリを、走査対象のサブツリーから浅い順に集める。
 *
 * どこに `.gitignore` が置かれているかは、走査しなければ分からない。パターンの先頭
 * セグメントのような静的な列挙で決めると、`.claude/sub/.gitignore` のように深い位置に
 * 置かれた規則が判定から漏れる。漏れた規則が資格情報を無視していれば、そのファイルは
 * 同期の対象に残り、pull が上書きし push が送る。
 *
 * 探索は include パターンが到達しうるサブツリーに限る（{@link gitignoreScanRoots}）。
 * 同期の対象にならないディレクトリまで歩くと、実行時間をそこに取られる。
 *
 * 戻り値は浅い順で、リポジトリルート自身は含まない（ルートの `.gitignore` は呼び出し側が
 * 先に読む）。呼び出し側がこの順で規則を足すことで、深い側が浅い側を上書きするという
 * git の規則が、Ignore へ追加する順序として表れる。
 *
 * @param repoDir 走査するリポジトリのルート。
 * @param baseDirs ルートからの相対で表した、走査を始めるサブツリー。ルート自身は空文字列。
 */
async function findGitignoreDirs(repoDir: AbsPath, baseDirs: readonly string[]): Promise<string[]> {
  const found: string[] = [];
  // 深さごとに区切って進める。幅優先にすることで、戻り値の並びがそのまま浅い順になる。
  let frontier = baseDirs.filter((rel) => isDirectory(joinAbs(repoDir, rel)));

  while (frontier.length > 0) {
    const deeper: string[] = [];
    for (const rel of frontier) {
      const entries = await readdir(joinAbs(repoDir, rel), { withFileTypes: true });
      for (const entry of entries) {
        // シンボリックリンクは辿らない（`isDirectory()` はリンク自体には false を返す）。
        // リンク先がサブツリーの外なら、そこの `.gitignore` はこのリポジトリの規則ではなく、
        // リンクが循環すれば走査が終わらない。
        const descend = entry.isDirectory() && !UNSCANNED_DIRS.has(entry.name);
        if (descend) deeper.push(rel === REPO_ROOT ? entry.name : `${rel}/${entry.name}`);
        // ルートの `.gitignore` は接頭辞を付けずに読むので、ここでは拾わない。
        else if (rel !== REPO_ROOT && !entry.isDirectory() && entry.name === GITIGNORE_FILE) {
          found.push(rel);
        }
      }
    }
    frontier = deeper;
  }

  return found;
}

/** パスがディレクトリとして存在するか。不在・ファイルのどちらも false。 */
function isDirectory(path: AbsPath): boolean {
  return statSync(path, { throwIfNoEntry: false })?.isDirectory() === true;
}

/** `.gitignore` の中身を読む。無ければ undefined（規則ゼロと区別する必要はない）。 */
async function readGitignore(path: AbsPath): Promise<string | undefined> {
  if (!existsSync(path)) return undefined;
  return await readFile(path, "utf-8");
}

/** ネストした `.gitignore` の規則を、リポジトリルート起点のパスへ読み替える。 */
function prefixRules(content: string, dir: string): string {
  return content
    .split("\n")
    .map((line) => {
      const trimmed = line.trim();
      if (!trimmed || trimmed.startsWith("#")) return line;
      const negated = trimmed.startsWith("!");
      const pattern = negated ? trimmed.slice(1) : trimmed;
      return `${negated ? "!" : ""}${scopeToDir(pattern, dir)}`;
    })
    .join("\n");
}

/**
 * 1 つの規則を、それが書かれたディレクトリ起点の意味を保ったままルート起点へ読み替える。
 *
 * git は規則の形で適用範囲を変える。`/` を含む規則はその `.gitignore` のあるディレクトリに
 * 固定され、含まない規則は配下のどの深さにも当たる。後者にディレクトリ名を前置するだけだと
 * 固定された規則へ化けて、深い階層にある同名のファイルが無視されなくなる（`*.pem` を
 * `.claude/*.pem` にすると `.claude/sub/key.pem` が追跡対象になる）。
 */
function scopeToDir(pattern: string, dir: string): string {
  // 末尾の `/` はディレクトリ限定を表すだけで、適用範囲を決める `/` には数えない。
  const body = pattern.endsWith("/") ? pattern.slice(0, -1) : pattern;
  // 先頭の `/` は「このディレクトリ直下」を意味するので、区切りを重ねずに繋ぐ。
  if (body.startsWith("/")) return `${dir}${pattern}`;
  if (body.includes("/")) return `${dir}/${pattern}`;
  // `**/` は 0 段以上のディレクトリに当たるので、直下と深い階層の両方を 1 つの規則で表せる。
  return `${dir}/**/${pattern}`;
}

/**
 * ファイルリストを ignored と non-ignored に分離
 */
export interface SeparatedFiles {
  /** gitignore に該当しないファイル */
  tracked: RepoRelPath[];
  /** gitignore に該当するファイル */
  ignored: RepoRelPath[];
}

export function separateByGitignore(
  files: readonly RepoRelPath[],
  ig: IgnoreDecision,
): SeparatedFiles {
  const tracked: RepoRelPath[] = [];
  const ignored: RepoRelPath[] = [];

  for (const file of files) {
    if (ig.ignores(file)) {
      ignored.push(file);
    } else {
      tracked.push(file);
    }
  }

  return { tracked, ignored };
}
