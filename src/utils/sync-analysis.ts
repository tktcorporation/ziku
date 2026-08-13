import type { HashMap } from "../modules/schemas";
import type { FileClassification } from "./merge/types";
import { classifyFiles } from "./merge";
import { hashFiles } from "./hash";

/**
 * 3-way ハッシュ比較に必要な3つのハッシュマップ。
 *
 * - base: 前回 sync 時のハッシュ（lock のベース由来）。3-way 比較の共通祖先。
 * - local: 現在のローカルファイルのハッシュ。
 * - template: 現在のテンプレートファイルのハッシュ。
 */
export interface SyncHashes {
  readonly baseHashes: HashMap;
  readonly localHashes: HashMap;
  readonly templateHashes: HashMap;
}

export interface AnalyzeSyncOptions {
  readonly targetDir: string;
  readonly templateDir: string;
  /**
   * 前回 sync 時のハッシュ。`baseHashesOf(lock)` の戻り値をそのまま渡す。
   * ベース未確定の lock では空になり、すべてのテンプレートファイルが `newFiles` に分類される。
   */
  readonly baseHashes: HashMap;
  readonly include: string[];
  readonly exclude?: string[];
}

export interface SyncAnalysis {
  readonly classification: FileClassification;
  readonly hashes: SyncHashes;
}

/**
 * ローカル / テンプレート / lock(base) の3者を比較し、ファイルを分類する。
 *
 * 背景: pull/push/status で重複していた「hashFiles ×2 → classifyFiles」の手順を
 * 単一エントリポイントに集約する SSOT。3つのハッシュマップの取り違え（#148 と類似のリスク）を
 * 型レベルで抑え、各コマンドの実装ぶれを防ぐ。
 *
 * I/O バウンドな2つの hashFiles を Promise.all で並列化する。
 *
 * 規約メモ: hashFiles が plain async のため本関数も plain async に揃えている。
 * 将来 hashFiles を Effect 化する際は本関数も Effect.gen に書き直すこと。
 */
export async function analyzeSync(options: AnalyzeSyncOptions): Promise<SyncAnalysis> {
  const { targetDir, templateDir, baseHashes, include, exclude } = options;
  const [templateHashes, localHashes] = await Promise.all([
    hashFiles(templateDir, include, exclude),
    hashFiles(targetDir, include, exclude),
  ]);
  const classification = classifyFiles({
    baseHashes,
    localHashes,
    templateHashes,
  });
  return {
    classification,
    hashes: { baseHashes, localHashes, templateHashes },
  };
}
