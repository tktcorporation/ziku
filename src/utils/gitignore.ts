import { existsSync } from "node:fs";
import { readFile } from "node:fs/promises";
import ignore, { type Ignore } from "ignore";
import type { AbsPath, RepoRelPath } from "../modules/schemas";
import { joinAbs } from "./paths";

/**
 * 複数リポジトリの `.gitignore` をマージして読み込む。
 *
 * ローカルとテンプレートの両方を読むのは、どちら側が無視すると決めたファイルも同期の対象から
 * 外すため。片側だけを読むと、無視されているはずのマシン固有の内容がもう一方へ流れる。
 *
 * `nestedDirs` 配下の `.gitignore` も同じ Ignore へ畳み込む。git は各ディレクトリの
 * `.gitignore` をそのディレクトリ起点で解釈するので、規則にディレクトリ名を接頭辞として
 * 付け直してから足す（否定パターンは `!` の後ろに付ける）。これを省くと、`.claude/.gitignore`
 * のようにネストして置かれた無視規則だけが判定から漏れ、リポジトリの他の場所にある同名の
 * ファイルまで巻き込んで無視する規則になる。
 *
 * @param dirs `.gitignore` の探索起点（ローカル・テンプレートのリポジトリルート）。
 * @param nestedDirs 各起点の配下で `.gitignore` を追加で読むディレクトリ（起点からの相対）。
 */
export async function loadMergedGitignore(
  dirs: readonly AbsPath[],
  nestedDirs: readonly string[],
): Promise<Ignore> {
  const ig = ignore();
  for (const dir of dirs) {
    const rootRules = await readGitignore(joinAbs(dir, ".gitignore"));
    if (rootRules !== undefined) ig.add(rootRules);

    for (const nested of nestedDirs) {
      const nestedRules = await readGitignore(joinAbs(dir, nested, ".gitignore"));
      if (nestedRules !== undefined) ig.add(prefixRules(nestedRules, nested));
    }
  }
  return ig;
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
      if (trimmed.startsWith("!")) return `!${dir}/${trimmed.slice(1)}`;
      return `${dir}/${trimmed}`;
    })
    .join("\n");
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

export function separateByGitignore(files: readonly RepoRelPath[], ig: Ignore): SeparatedFiles {
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
