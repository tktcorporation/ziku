import { existsSync } from "node:fs";
import { readFile } from "node:fs/promises";
import ignore, { type Ignore } from "ignore";
import { join } from "pathe";
import { globSync } from "tinyglobby";
import { defaultModules, getModuleById } from "../modules";
import type { DevEnvConfig, TemplateModule } from "../modules/schemas";
import { getEffectivePatterns, resolvePatterns } from "./patterns";

export interface UntrackedFile {
  path: string;
  folder: string;
  moduleId: string; // modules.jsonc にパターンを追加する際に必要
}

export interface UntrackedFilesByFolder {
  folder: string;
  files: UntrackedFile[];
}

/**
 * ファイルパスからモジュール ID を取得
 * モジュール ID = ディレクトリパス（ルートは "."）
 *
 * 例:
 *   ".devcontainer/file.json" → ".devcontainer"
 *   ".mcp.json" → "."
 *   ".github/workflows/ci.yml" → ".github"
 */
export function getModuleIdFromPath(filePath: string): string {
  const parts = filePath.split("/");
  if (parts.length === 1) {
    return "."; // ルート直下のファイル
  }
  return parts[0]; // 最初のディレクトリ
}

/**
 * 後方互換性のため: フォルダ名を表示用に取得
 * "." は "root" として表示
 */
export function getDisplayFolder(moduleId: string): string {
  return moduleId === "." ? "root" : moduleId;
}

/**
 * モジュールのベースディレクトリを取得
 * モジュール ID がそのままディレクトリパスになる
 */
export function getModuleBaseDir(moduleId: string): string | null {
  if (moduleId === ".") {
    return null; // ルートはディレクトリではない
  }
  return moduleId;
}

/**
 * ディレクトリ内の全ファイルを取得
 */
export function getAllFilesInDirs(baseDir: string, dirs: string[]): string[] {
  if (dirs.length === 0) return [];

  const patterns = dirs.map((d) => `${d}/**/*`);
  return globSync(patterns, {
    cwd: baseDir,
    dot: true,
    onlyFiles: true,
  }).sort();
}

/**
 * ルート直下の隠しファイルを取得
 */
export function getRootDotFiles(baseDir: string): string[] {
  return globSync([".*"], {
    cwd: baseDir,
    dot: true,
    onlyFiles: true,
  }).sort();
}

/**
 * 複数ディレクトリの .gitignore をマージして読み込み
 * サブディレクトリの .gitignore も含める
 */
export async function loadAllGitignores(baseDir: string, dirs: string[]): Promise<Ignore> {
  const ig = ignore();

  // ルートの .gitignore
  const rootGitignore = join(baseDir, ".gitignore");
  if (existsSync(rootGitignore)) {
    const content = await readFile(rootGitignore, "utf-8");
    ig.add(content);
  }

  // 各ディレクトリの .gitignore
  for (const dir of dirs) {
    const gitignorePath = join(baseDir, dir, ".gitignore");
    if (existsSync(gitignorePath)) {
      const content = await readFile(gitignorePath, "utf-8");
      // ディレクトリ相対のパスを絶対パスに変換するため、各パターンにプレフィックスを追加
      const prefixedContent = content
        .split("\n")
        .map((line) => {
          const trimmed = line.trim();
          // コメント行や空行はそのまま
          if (!trimmed || trimmed.startsWith("#")) return line;
          // 否定パターンの場合
          if (trimmed.startsWith("!")) {
            return `!${dir}/${trimmed.slice(1)}`;
          }
          return `${dir}/${trimmed}`;
        })
        .join("\n");
      ig.add(prefixedContent);
    }
  }

  return ig;
}

/**
 * ホワイトリスト外のファイルをフォルダごとに検出
 */
export async function detectUntrackedFiles(options: {
  targetDir: string;
  moduleIds: string[];
  config?: DevEnvConfig;
  moduleList?: TemplateModule[];
}): Promise<UntrackedFilesByFolder[]> {
  const { targetDir, moduleIds, config, moduleList = defaultModules } = options;

  // インストール済みモジュール ID のセット
  const installedModuleIds = new Set(moduleIds);

  // 全モジュールのベースディレクトリを収集（"." 以外）
  const allBaseDirs: string[] = [];
  // 全モジュールのホワイトリスト済みファイル
  const allTrackedFiles = new Set<string>();
  // ルートモジュール（"."）がインストールされているか
  let hasRootModule = false;

  for (const moduleId of moduleIds) {
    const mod = getModuleById(moduleId, moduleList);
    if (!mod) continue;

    const baseDir = getModuleBaseDir(moduleId);
    if (baseDir) {
      allBaseDirs.push(baseDir);
    } else {
      hasRootModule = true;
    }

    // ホワイトリスト済みファイルを収集
    const effectivePatterns = getEffectivePatterns(moduleId, mod.patterns, config);
    const trackedFiles = resolvePatterns(targetDir, effectivePatterns);
    for (const file of trackedFiles) {
      allTrackedFiles.add(file);
    }
  }

  // gitignore を読み込み
  const gitignore = await loadAllGitignores(targetDir, allBaseDirs);

  // ディレクトリ内の全ファイルを取得
  const allDirFiles = getAllFilesInDirs(targetDir, allBaseDirs);
  const filteredDirFiles = gitignore.filter(allDirFiles);

  // ルート直下のファイルを取得（ルートモジュールがインストールされている場合のみ）
  const filteredRootFiles = hasRootModule ? gitignore.filter(getRootDotFiles(targetDir)) : [];

  // 全ファイルをマージ（重複なし）
  const allFiles = new Set([...filteredDirFiles, ...filteredRootFiles]);

  // フォルダごとにグループ化
  const filesByFolder = new Map<string, UntrackedFile[]>();

  for (const filePath of allFiles) {
    // ホワイトリストに含まれていればスキップ
    if (allTrackedFiles.has(filePath)) continue;

    // ファイルパスからモジュール ID を導出
    const moduleId = getModuleIdFromPath(filePath);

    // インストール済みモジュールに属さないファイルはスキップ
    if (!installedModuleIds.has(moduleId)) continue;

    const displayFolder = getDisplayFolder(moduleId);
    const file: UntrackedFile = {
      path: filePath,
      folder: displayFolder,
      moduleId,
    };

    const existing = filesByFolder.get(displayFolder) || [];
    existing.push(file);
    filesByFolder.set(displayFolder, existing);
  }

  // 結果を配列に変換（フォルダ名でソート）
  const result: UntrackedFilesByFolder[] = [];
  const sortedFolders = Array.from(filesByFolder.keys()).sort((a, b) => {
    // root は最後に
    if (a === "root") return 1;
    if (b === "root") return -1;
    return a.localeCompare(b);
  });

  for (const folder of sortedFolders) {
    const files = filesByFolder.get(folder) || [];
    if (files.length > 0) {
      result.push({
        folder,
        files: files.sort((a, b) => a.path.localeCompare(b.path)),
      });
    }
  }

  return result;
}

/**
 * 全フォルダの未追跡ファイル数を取得
 */
export function getTotalUntrackedCount(untrackedByFolder: UntrackedFilesByFolder[]): number {
  return untrackedByFolder.reduce((sum, f) => sum + f.files.length, 0);
}
