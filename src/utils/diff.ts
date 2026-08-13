import { existsSync } from "node:fs";
import { readFile } from "node:fs/promises";
import { createPatch } from "diff";
import { join } from "pathe";
import { match } from "ts-pattern";
import type { DiffResult, FileDiff } from "../modules/schemas";
import { filterByGitignore, loadMergedGitignore } from "./gitignore";
import type { FlatPatterns } from "./patterns";
import { resolvePatterns } from "./patterns";
import { ZIKU_CONFIG_FILE } from "./ziku-config";

export interface DiffOptions {
  targetDir: string;
  templateDir: string;
  patterns: FlatPatterns;
}

/**
 * ローカルとテンプレート間の差分を検出
 */
export async function detectDiff(options: DiffOptions): Promise<DiffResult> {
  const { targetDir, templateDir, patterns } = options;

  const files: FileDiff[] = [];

  // ローカルとテンプレート両方の .gitignore をマージして読み込み
  const gitignore = await loadMergedGitignore([targetDir, templateDir]);

  // フラットパターンでファイル一覧を取得し、gitignore でフィルタリング
  const templateFiles = filterByGitignore(
    resolvePatterns(templateDir, patterns.include, patterns.exclude),
    gitignore,
  );
  const localFiles = filterByGitignore(
    resolvePatterns(targetDir, patterns.include, patterns.exclude),
    gitignore,
  );

  const allFiles = new Set([...templateFiles, ...localFiles]);

  // ziku.jsonc は ziku 自身の制御ファイル（追跡対象の SSOT）。プロジェクトや
  // テンプレートが `.ziku/` を gitignore していても、パターン同期のために必ず
  // 差分対象に含める。これをしないと `ziku track` の変更がテンプレへ届かない（codex P2）。
  for (const dir of [targetDir, templateDir]) {
    if (existsSync(join(dir, ZIKU_CONFIG_FILE))) {
      allFiles.add(ZIKU_CONFIG_FILE);
    }
  }

  for (const filePath of allFiles) {
    const localPath = join(targetDir, filePath);
    const templatePath = join(templateDir, filePath);

    const localExists = existsSync(localPath);
    const templateExists = existsSync(templatePath);

    // 内容の読み取りは種別が決まってから行う。「存在する側だけを読む」ことを
    // 分岐と一体にしておかないと、読めなかった側を後から埋める処理が必要になる。
    if (localExists && templateExists) {
      const localContent = await readFile(localPath, "utf-8");
      const templateContent = await readFile(templatePath, "utf-8");
      files.push(
        localContent === templateContent
          ? { path: filePath, type: "unchanged", localContent, templateContent }
          : { path: filePath, type: "modified", localContent, templateContent },
      );
    } else if (localExists) {
      // ローカルのみ → 追加（テンプレートにはない）
      files.push({
        path: filePath,
        type: "added",
        localContent: await readFile(localPath, "utf-8"),
      });
    } else if (templateExists) {
      // テンプレートのみ → 削除（ローカルにはない）
      files.push({
        path: filePath,
        type: "deleted",
        templateContent: await readFile(templatePath, "utf-8"),
      });
    }
    // どちらにも存在しないパスは差分ではない。パターン解決は実在するファイルだけを
    // 返すため通常は起きないが、列挙後に消えた場合はここで落とす。
  }

  return { files: files.toSorted((a, b) => a.path.localeCompare(b.path)) };
}

/**
 * 差分があるかどうかを判定
 */
export function hasDiff(diff: DiffResult): boolean {
  return diff.files.some((file) => file.type !== "unchanged");
}

/**
 * unified diff のハンク前後に付ける文脈行数。
 *
 * git の既定値と揃える。jsdiff の既定は 4 行で、そのままだと同じ変更でも
 * `git diff` よりハンクが広くなり、両者を見比べたときに変更範囲が食い違って見える。
 */
const DIFF_CONTEXT_LINES = 3;

/**
 * FileDiff から unified diff 形式の文字列を生成する。
 *
 * 差分の向きは常にテンプレート → ローカルで、ローカル側が「変更後」になる。
 * deleted（テンプレートにのみ存在する）は、テンプレート側の全行が削除される
 * patch として表す。削除をテンプレートへ push するかどうかを、内容を見てから
 * 判断できるようにするため。
 * unchanged は表示すべき差分が無いので空文字列を返す。
 */
export function generateUnifiedDiff(fileDiff: FileDiff): string {
  const options = { context: DIFF_CONTEXT_LINES };

  // 空文字列を渡すのは「その側にファイルが無い」ことを patch として表すため。
  // 内容が読めなかった場合の穴埋めではない。
  return match(fileDiff)
    .with({ type: "added" }, (f) =>
      createPatch(f.path, "", f.localContent, "template", "local", options),
    )
    .with({ type: "modified" }, (f) =>
      createPatch(f.path, f.templateContent, f.localContent, "template", "local", options),
    )
    .with({ type: "deleted" }, (f) =>
      createPatch(f.path, f.templateContent, "", "template", "local", options),
    )
    .with({ type: "unchanged" }, () => "")
    .exhaustive();
}
