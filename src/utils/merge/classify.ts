import type { ClassifyOptions, FileClassification } from "./types";

/**
 * base/local/template のハッシュを比較し、各ファイルを分類する。
 *
 * 背景: pull/push 時にファイルごとの処理方法（自動上書き・マージ・スキップ等）を
 * 決定するために使用する。3つのハッシュマップの差分パターンで分類を行う。
 */
export function classifyFiles(opts: ClassifyOptions): FileClassification {
  const { baseHashes, localHashes, templateHashes } = opts;

  const result: FileClassification = {
    autoUpdate: [],
    localOnly: [],
    conflicts: [],
    newFiles: [],
    deletedFiles: [],
    deletedLocally: [],
    unchanged: [],
  };

  const allFiles = new Set([
    ...Object.keys(baseHashes),
    ...Object.keys(localHashes),
    ...Object.keys(templateHashes),
  ]);

  for (const file of allFiles) {
    const base = baseHashes[file];
    const local = localHashes[file];
    const template = templateHashes[file];

    if (base === undefined && template !== undefined && local === undefined) {
      // base にもローカルにもない → テンプレートに新規追加
      result.newFiles.push(file);
    } else if (base !== undefined && template === undefined) {
      // base にはあるがテンプレートで削除された
      result.deletedFiles.push(file);
    } else if (base !== undefined && local === undefined && template !== undefined) {
      // ローカルで削除されたファイル — git の挙動を模倣して分岐:
      // テンプレート未変更 → クリーン削除（push で削除可能）
      // テンプレート変更あり → delete/modify conflict（ユーザー判断が必要）
      if (template === base) {
        result.deletedLocally.push(file);
      } else {
        result.conflicts.push(file);
      }
    } else if (base === undefined && template === undefined && local !== undefined) {
      // ローカルのみに存在（base にもテンプレートにもない）
      result.localOnly.push(file);
    } else if (base === undefined && template !== undefined && local !== undefined) {
      // base にないが両方に存在 → ハッシュ比較
      if (local === template) {
        result.unchanged.push(file);
      } else {
        result.conflicts.push(file);
      }
    } else {
      // base, local, template すべてに存在
      const localChanged = local !== base;
      const templateChanged = template !== base;

      if (!localChanged && !templateChanged) {
        result.unchanged.push(file);
      } else if (!localChanged && templateChanged) {
        result.autoUpdate.push(file);
      } else if (localChanged && !templateChanged) {
        result.localOnly.push(file);
      } else {
        // 両方変更
        if (local === template) {
          // 同じ内容に変更された場合は unchanged 扱い
          result.unchanged.push(file);
        } else {
          result.conflicts.push(file);
        }
      }
    }
  }

  return result;
}
