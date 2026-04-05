/**
 * README.md の自動生成ユーティリティ
 */

import { existsSync } from "node:fs";
import { readFile, writeFile } from "node:fs/promises";
import { parse } from "jsonc-parser";
import { join } from "pathe";

// マーカー定義
const MARKERS = {
  features: {
    start: "<!-- FEATURES:START -->",
    end: "<!-- FEATURES:END -->",
  },
  commands: {
    start: "<!-- COMMANDS:START -->",
    end: "<!-- COMMANDS:END -->",
  },
  files: {
    start: "<!-- FILES:START -->",
    end: "<!-- FILES:END -->",
  },
} as const;

/**
 * modules.jsonc からパターン一覧を読み込む（フラット形式 or モジュール形式対応）
 */
async function loadPatternsFromFile(
  modulesPath: string,
): Promise<{ include: string[]; exclude: string[] }> {
  if (!existsSync(modulesPath)) {
    return { include: [], exclude: [] };
  }
  const content = await readFile(modulesPath, "utf-8");
  const parsed = parse(content);

  // フラット形式
  if (parsed && Array.isArray(parsed.include)) {
    return {
      include: parsed.include,
      exclude: parsed.exclude ?? [],
    };
  }

  // モジュール形式（後方互換）→ フラット化
  if (parsed && Array.isArray(parsed.modules)) {
    return {
      include: parsed.modules.flatMap((m: { include?: string[] }) => m.include ?? []),
      exclude: parsed.modules.flatMap((m: { exclude?: string[] }) => m.exclude ?? []),
    };
  }

  return { include: [], exclude: [] };
}

/**
 * 機能セクションを生成
 */
function generateFeaturesSection(patterns: string[]): string {
  const lines: string[] = [];
  lines.push("## 機能\n");

  // パターンをディレクトリごとにグルーピング
  const groups = new Map<string, string[]>();
  for (const pattern of patterns) {
    const firstSegment = pattern.split("/")[0];
    const group = firstSegment.startsWith(".") ? firstSegment : "Root";
    if (!groups.has(group)) groups.set(group, []);
    groups.get(group)!.push(pattern);
  }

  for (const [group, groupPatterns] of groups) {
    lines.push(`- **${group}** - ${groupPatterns.length} pattern(s)`);
  }

  lines.push("");
  return lines.join("\n");
}

/**
 * 生成されるファイルセクションを生成
 */
function generateFilesSection(patterns: string[]): string {
  const lines: string[] = [];
  lines.push("## 生成されるファイル\n");
  lines.push("以下のパターンに一致するファイルが同期されます：\n");

  for (const pattern of patterns) {
    const displayPattern = pattern.includes("*") ? `\`${pattern}\` (パターン)` : `\`${pattern}\``;
    lines.push(`- ${displayPattern}`);
  }

  lines.push("");
  lines.push("### 設定ファイル\n");
  lines.push("- `.ziku/config.json` - このツールの設定（同期状態）\n");

  return lines.join("\n");
}

/**
 * README のマーカー間を更新
 */
function updateSection(
  content: string,
  startMarker: string,
  endMarker: string,
  newSection: string,
): { content: string; updated: boolean } {
  const startIndex = content.indexOf(startMarker);
  const endIndex = content.indexOf(endMarker);

  if (startIndex === -1 || endIndex === -1) {
    // マーカーがない場合はそのまま返す
    return { content, updated: false };
  }

  const before = content.slice(0, startIndex + startMarker.length);
  const after = content.slice(endIndex);
  const newContent = `${before}\n\n${newSection}\n${after}`;

  return { content: newContent, updated: newContent !== content };
}

export interface GenerateReadmeOptions {
  /** README.md のパス */
  readmePath: string;
  /** modules.jsonc のパス */
  modulesPath: string;
  /** コマンドセクションを生成する関数（オプション） */
  generateCommandsSection?: () => Promise<string>;
}

export interface GenerateReadmeResult {
  /** README が更新されたかどうか */
  updated: boolean;
  /** 更新後の README の内容 */
  content: string;
  /** README ファイルのパス */
  readmePath: string;
}

/**
 * README を生成
 */
export async function generateReadme(
  options: GenerateReadmeOptions,
): Promise<GenerateReadmeResult> {
  const { readmePath, modulesPath, generateCommandsSection } = options;

  // README が存在しない場合はスキップ
  if (!existsSync(readmePath)) {
    return { updated: false, content: "", readmePath };
  }

  const { include } = await loadPatternsFromFile(modulesPath);

  let readme = await readFile(readmePath, "utf-8");
  let anyUpdated = false;

  // 機能セクション
  if (include.length > 0) {
    const featuresSection = generateFeaturesSection(include);
    const result = updateSection(
      readme,
      MARKERS.features.start,
      MARKERS.features.end,
      featuresSection,
    );
    readme = result.content;
    anyUpdated = anyUpdated || result.updated;
  }

  // コマンドセクション（オプション）
  if (generateCommandsSection) {
    const commandsSection = await generateCommandsSection();
    const result = updateSection(
      readme,
      MARKERS.commands.start,
      MARKERS.commands.end,
      commandsSection,
    );
    readme = result.content;
    anyUpdated = anyUpdated || result.updated;
  }

  // ファイルセクション
  if (include.length > 0) {
    const filesSection = generateFilesSection(include);
    const result = updateSection(readme, MARKERS.files.start, MARKERS.files.end, filesSection);
    readme = result.content;
    anyUpdated = anyUpdated || result.updated;
  }

  return { updated: anyUpdated, content: readme, readmePath };
}

/**
 * README を更新して保存
 */
export async function updateReadmeFile(
  options: GenerateReadmeOptions,
): Promise<GenerateReadmeResult> {
  const result = await generateReadme(options);

  if (result.updated) {
    await writeFile(result.readmePath, result.content);
  }

  return result;
}

/**
 * プロジェクトディレクトリ内の README を検出して更新
 * @param targetDir プロジェクトのルートディレクトリ
 * @param templateDir テンプレートディレクトリ（modules.jsonc の場所）
 */
export async function detectAndUpdateReadme(
  targetDir: string,
  templateDir: string,
): Promise<GenerateReadmeResult | null> {
  const readmePath = join(targetDir, "README.md");
  const modulesPath = join(templateDir, ".ziku/modules.jsonc");

  // README にマーカーがあるか確認
  if (!existsSync(readmePath)) {
    return null;
  }

  const readmeContent = await readFile(readmePath, "utf-8");
  const hasMarkers =
    readmeContent.includes(MARKERS.features.start) || readmeContent.includes(MARKERS.files.start);

  if (!hasMarkers) {
    return null;
  }

  return updateReadmeFile({
    readmePath,
    modulesPath,
  });
}
