import { existsSync } from "node:fs";
import { createPatch } from "diff";
import { match } from "ts-pattern";
import type { AbsPath, DiffResult, FileDiff, RepoRelPath } from "../modules/schemas";
import { isBinaryFileDiff, readFileContent, toTransportText } from "./file-content";
import { joinAbs } from "./paths";
import { resolvePatterns } from "./patterns";
import type { SyncScope } from "./sync-scope";
import { declaredPaths, scanExceedsDeclared, withinScope } from "./sync-scope";

export interface DiffOptions {
  targetDir: AbsPath;
  templateDir: AbsPath;
  /**
   * 走査範囲。分類（{@link import("./sync-analysis").analyzeSync}）と同じものを渡す。
   * 別々に決めると、分類では変更ありと出たファイルが差分に現れず、送信候補から黙って
   * 落ちる。
   */
  scope: SyncScope;
}

/**
 * ローカルとテンプレート間の差分を検出
 */
export async function detectDiff(options: DiffOptions): Promise<DiffResult> {
  const { targetDir, templateDir, scope } = options;

  const files: FileDiff[] = [];

  const templateFiles = withinScope(
    resolvePatterns(templateDir, scope.scan.include, scope.scan.exclude),
    scope,
  );
  const localFiles = withinScope(
    resolvePatterns(targetDir, scope.scan.include, scope.scan.exclude),
    scope,
  );

  const allFiles = new Set<RepoRelPath>([...templateFiles, ...localFiles]);

  // 走査は宣言より広いことがある（テンプレートが外したパターンの分。`utils/sync-scope.ts` の
  // `ScanPatterns`）。広い分のうちテンプレートに残っているファイルは、pull も push も触らない
  // ので差分として見せない。見せると、実行しても何も起きない操作を勧めることになる。
  // 分類側の同じ規則は `utils/sync-analysis.ts` の `restrictToDeclaredScope`。
  const declared = scanExceedsDeclared(scope)
    ? declaredPaths({ targetDir, templateDir, scope })
    : undefined;

  // 常に追跡するファイルは ziku 自身の制御ファイル（追跡対象の SSOT）。プロジェクトや
  // テンプレートが `.ziku/` を gitignore していても、パターン同期のために必ず差分対象に
  // 含める。これをしないと `ziku track` の変更がテンプレへ届かない。
  for (const path of scope.alwaysTracked) {
    allFiles.add(path);
  }

  for (const filePath of allFiles) {
    const localPath = joinAbs(targetDir, filePath);
    const templatePath = joinAbs(templateDir, filePath);

    const localExists = existsSync(localPath);
    const templateExists = existsSync(templatePath);

    if (declared !== undefined && templateExists && !declared.has(filePath)) continue;

    // 内容の読み取りは種別が決まってから行う。「存在する側だけを読む」ことを
    // 分岐と一体にしておかないと、読めなかった側を後から埋める処理が必要になる。
    if (localExists && templateExists) {
      const localContent = await readContent(localPath);
      const templateContent = await readContent(templatePath);
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
        localContent: await readContent(localPath),
      });
    } else if (templateExists) {
      // テンプレートのみ → 削除（ローカルにはない）
      files.push({
        path: filePath,
        type: "deleted",
        templateContent: await readContent(templatePath),
      });
    }
    // どちらにも存在しないパスは差分ではない。パターン解決は実在するファイルだけを
    // 返すため通常は起きないが、列挙後に消えた場合はここで落とす。
  }

  return { files: files.toSorted((a, b) => a.path.localeCompare(b.path)) };
}

/**
 * 差分の 1 ファイル分の内容を読む。
 *
 * バイト列として読んでから種別を判定する。バイナリを utf-8 としてデコードすると不正バイトが
 * U+FFFD へ潰れ、内容の違うファイルが同じ文字列になって「差分なし」と判定される。差分の型
 * （`FileDiff`）は内容を `string` で持つので、バイナリはバイト列を保つエンコードで載せる
 * （`src/utils/file-content.ts`）。
 */
async function readContent(path: AbsPath): Promise<string> {
  return toTransportText(await readFileContent(path));
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
      isBinaryFileDiff(f)
        ? binaryNotice(MISSING_SIDE, `local/${f.path}`)
        : createPatch(f.path, "", f.localContent, "template", "local", options),
    )
    .with({ type: "modified" }, (f) =>
      isBinaryFileDiff(f)
        ? binaryNotice(`template/${f.path}`, `local/${f.path}`)
        : createPatch(f.path, f.templateContent, f.localContent, "template", "local", options),
    )
    .with({ type: "deleted" }, (f) =>
      isBinaryFileDiff(f)
        ? binaryNotice(`template/${f.path}`, MISSING_SIDE)
        : createPatch(f.path, f.templateContent, "", "template", "local", options),
    )
    .with({ type: "unchanged" }, () => "")
    .exhaustive();
}

/** 片側にファイルが無いことを示す名前。git が同じ状況で使う表記に揃える。 */
const MISSING_SIDE = "/dev/null";

/**
 * バイナリの差分を 1 行で示す。
 *
 * 内容は出さない。バイナリを行として並べても読めず、端末の表示も壊れる。
 * git が同じ状況で出す `Binary files ... differ` と同じ形にして、意味を推測させない。
 */
function binaryNotice(from: string, to: string): string {
  return `Binary files ${from} and ${to} differ\n`;
}
