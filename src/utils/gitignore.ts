import { existsSync } from "node:fs";
import { readFile } from "node:fs/promises";
import ignore, { type Ignore } from "ignore";
import type { AbsPath, RepoRelPath } from "../modules/schemas";
import { joinAbs } from "./paths";

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
 * `nestedDirs` 配下の `.gitignore` は、そのリポジトリの Ignore へ畳み込む。git は各
 * ディレクトリの `.gitignore` をそのディレクトリ起点で解釈するので、規則をルート起点へ
 * 読み替えてから足す（{@link scopeToDir}）。これを省くと、`.claude/.gitignore` のように
 * ネストして置かれた無視規則だけが判定から漏れ、リポジトリの他の場所にある同名のファイルまで
 * 巻き込んで無視する規則になる。同一リポジトリ内では深い側の規則が後に来るので、そこでの
 * 否定は意図どおり効く。
 *
 * @param dirs `.gitignore` の探索起点（ローカル・テンプレートのリポジトリルート）。
 * @param nestedDirs 各起点の配下で `.gitignore` を追加で読むディレクトリ（起点からの相対）。
 */
export async function loadMergedGitignore(
  dirs: readonly AbsPath[],
  nestedDirs: readonly string[],
): Promise<IgnoreDecision> {
  const perRepository: Ignore[] = [];

  for (const dir of dirs) {
    const ig = ignore();
    const rootRules = await readGitignore(joinAbs(dir, ".gitignore"));
    if (rootRules !== undefined) ig.add(rootRules);

    for (const nested of nestedDirs) {
      const nestedRules = await readGitignore(joinAbs(dir, nested, ".gitignore"));
      if (nestedRules !== undefined) ig.add(prefixRules(nestedRules, nested));
    }
    perRepository.push(ig);
  }

  return { ignores: (path) => perRepository.some((ig) => ig.ignores(path)) };
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
