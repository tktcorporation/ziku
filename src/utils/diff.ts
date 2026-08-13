import { existsSync } from "node:fs";
import { readFile } from "node:fs/promises";
import { createPatch } from "diff";
import { join } from "pathe";
import { match } from "ts-pattern";
import type { DiffResult, DiffType, FileDiff } from "../modules/schemas";
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
  let added = 0;
  let modified = 0;
  let deleted = 0;
  let unchanged = 0;

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

    let type: DiffType;
    let localContent: string | undefined;
    let templateContent: string | undefined;

    if (localExists) {
      localContent = await readFile(localPath, "utf-8");
    }
    if (templateExists) {
      templateContent = await readFile(templatePath, "utf-8");
    }

    if (localExists && templateExists) {
      // 両方に存在 → 内容比較
      if (localContent === templateContent) {
        type = "unchanged";
        unchanged++;
      } else {
        type = "modified";
        modified++;
      }
    } else if (localExists && !templateExists) {
      // ローカルのみ → 追加（テンプレートにはない）
      type = "added";
      added++;
    } else {
      // テンプレートのみ → 削除（ローカルにはない）
      type = "deleted";
      deleted++;
    }

    files.push({
      path: filePath,
      type,
      localContent,
      templateContent,
    });
  }

  return {
    files: files.toSorted((a, b) => a.path.localeCompare(b.path)),
    summary: { added, modified, deleted, unchanged },
  };
}

/**
 * 差分があるかどうかを判定
 */
export function hasDiff(diff: DiffResult): boolean {
  return diff.summary.added > 0 || diff.summary.modified > 0 || diff.summary.deleted > 0;
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
  const { path, type, localContent, templateContent } = fileDiff;
  const options = { context: DIFF_CONTEXT_LINES };

  return match(type)
    .with("added", () => createPatch(path, "", localContent ?? "", "template", "local", options))
    .with("modified", () =>
      createPatch(path, templateContent ?? "", localContent ?? "", "template", "local", options),
    )
    .with("deleted", () =>
      createPatch(path, templateContent ?? "", "", "template", "local", options),
    )
    .with("unchanged", () => "")
    .exhaustive();
}
