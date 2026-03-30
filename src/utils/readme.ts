/**
 * README.md の自動生成ユーティリティ
 */

import { existsSync } from "node:fs";
import { readFile, writeFile } from "node:fs/promises";
import { parse } from "jsonc-parser";
import { join } from "pathe";
import type { TemplateModule } from "../modules/schemas";

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

interface ModulesFile {
  modules: TemplateModule[];
}

/**
 * modules.jsonc を読み込み
 */
async function loadModulesFromFile(modulesPath: string): Promise<TemplateModule[]> {
  if (!existsSync(modulesPath)) {
    return [];
  }
  const content = await readFile(modulesPath, "utf-8");
  const parsed = parse(content) as ModulesFile;
  return parsed.modules;
}

/**
 * 機能セクションを生成
 */
function generateFeaturesSection(modules: TemplateModule[]): string {
  const lines: string[] = [];
  lines.push("## 機能\n");

  for (const mod of modules) {
    lines.push(`- **${mod.name}** - ${mod.description}`);
  }

  lines.push("");
  return lines.join("\n");
}

/**
 * 生成されるファイルセクションを生成
 */
function generateFilesSection(modules: TemplateModule[]): string {
  const lines: string[] = [];
  lines.push("## 生成されるファイル\n");
  lines.push("選択したモジュールに応じて以下のファイルが生成されます：\n");

  for (const mod of modules) {
    const dirName = mod.id === "." ? "ルート" : `\`${mod.id}/\``;
    lines.push(`### ${dirName}\n`);
    lines.push(`${mod.description}\n`);

    for (const pattern of mod.patterns) {
      const displayPattern = pattern.includes("*") ? `\`${pattern}\` (パターン)` : `\`${pattern}\``;
      lines.push(`- ${displayPattern}`);
    }
    lines.push("");
  }

  lines.push("### 設定ファイル\n");
  lines.push("- `.devenv.json` - このツールの設定（適用したモジュール情報）\n");

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

  const modules = await loadModulesFromFile(modulesPath);

  let readme = await readFile(readmePath, "utf-8");
  let anyUpdated = false;

  // 機能セクション
  if (modules.length > 0) {
    const featuresSection = generateFeaturesSection(modules);
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
  if (modules.length > 0) {
    const filesSection = generateFilesSection(modules);
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
  const modulesPath = join(templateDir, ".devenv/modules.jsonc");

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
