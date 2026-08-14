/**
 * README.md の自動生成ユーティリティ
 */

import { existsSync } from "node:fs";
import { readFile, writeFile } from "node:fs/promises";
import { join } from "pathe";
import { match } from "ts-pattern";
import { zikuConfigSchema } from "../modules/schemas";
import { parseJsonc } from "./jsonc";
import { ZIKU_CONFIG_FILE } from "./ziku-config";

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
 * ziku.jsonc の内容から include パターンを取り出す。
 *
 * 同期対象パターンの SSOT は ziku.jsonc なので、README の機能一覧と
 * ファイル一覧はここから導出する。
 *
 * README の更新は同期処理の付随作業であり、これを理由に同期そのものを
 * 止めたくない。読めない場合はパターン無しとして扱い、
 * マーカー間を書き換えずに現状の README を残す。
 *
 * 構文の破綻を検証違反と同じ「パターン無し」に倒すのは、エラー回復が拾えた分だけの
 * 部分的な include を採ると、実際より短いファイル一覧を載せた README を、正しい一覧として
 * 書き出してしまうため。手を触れない README は古いだけだが、書き換えた README は嘘になる。
 * 壊れている事実は `ziku.jsonc` を読む他の入口が報告するので、ここで重ねて止める必要はない。
 */
function parseIncludePatterns(config: string): string[] {
  const parsed = match(parseJsonc(config))
    .with({ kind: "parsed" }, ({ value }) => zikuConfigSchema.safeParse(value))
    .with({ kind: "unparsable" }, () => undefined)
    .exhaustive();
  return parsed?.success === true ? parsed.data.include : [];
}

/** ディスク上の ziku.jsonc から include パターンを読む。無ければパターン無し。 */
async function loadIncludePatterns(configPath: string): Promise<string[]> {
  if (!existsSync(configPath)) {
    return [];
  }
  return parseIncludePatterns(await readFile(configPath, "utf-8"));
}

/**
 * 機能セクションを生成
 */
function generateFeaturesSection(patterns: string[]): string {
  const lines: string[] = ["## 機能\n"];

  // パターンをディレクトリごとにグルーピング
  const groups = new Map<string, string[]>();
  for (const pattern of patterns) {
    const firstSegment = pattern.split("/")[0];
    const group = firstSegment.startsWith(".") ? firstSegment : "Root";
    if (!groups.has(group)) groups.set(group, []);
    groups.get(group)?.push(pattern);
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
  const lines: string[] = [
    "## 生成されるファイル\n",
    "以下のパターンに一致するファイルが同期されます：\n",
  ];

  for (const pattern of patterns) {
    const displayPattern = pattern.includes("*") ? `\`${pattern}\` (パターン)` : `\`${pattern}\``;
    lines.push(`- ${displayPattern}`);
  }

  lines.push("");
  lines.push("### 設定ファイル\n");
  lines.push("- `.ziku/ziku.jsonc` - 同期設定（ソースとパターン）\n");
  lines.push("- `.ziku/lock.json` - 同期状態（自動管理）\n");

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
  /** 同期パターンを定義する ziku.jsonc のパス */
  configPath: string;
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

/** マーカー間を組み直した README。ディスク上の場所は持たない。 */
export interface RenderedReadme {
  readonly content: string;
  readonly updated: boolean;
}

/**
 * README のマーカー間を、渡した include パターンから組み直す。ディスクには触れない。
 *
 * @param commands コマンドセクションの内容。生成元を持たない呼び出しでは undefined。
 */
function applyGeneratedSections(params: {
  readme: string;
  include: readonly string[];
  commands: string | undefined;
}): RenderedReadme {
  const sections: { start: string; end: string; body: string }[] = [];

  if (params.include.length > 0) {
    sections.push({
      ...MARKERS.features,
      body: generateFeaturesSection([...params.include]),
    });
  }
  if (params.commands !== undefined) {
    sections.push({ ...MARKERS.commands, body: params.commands });
  }
  if (params.include.length > 0) {
    sections.push({ ...MARKERS.files, body: generateFilesSection([...params.include]) });
  }

  let content = params.readme;
  let updated = false;
  for (const section of sections) {
    const result = updateSection(content, section.start, section.end, section.body);
    content = result.content;
    updated = updated || result.updated;
  }

  return { content, updated };
}

/**
 * README を生成
 */
export async function generateReadme(
  options: GenerateReadmeOptions,
): Promise<GenerateReadmeResult> {
  const { readmePath, configPath, generateCommandsSection } = options;

  // README が存在しない場合はスキップ
  if (!existsSync(readmePath)) {
    return { updated: false, content: "", readmePath };
  }

  const rendered = applyGeneratedSections({
    readme: await readFile(readmePath, "utf-8"),
    include: await loadIncludePatterns(configPath),
    commands: generateCommandsSection === undefined ? undefined : await generateCommandsSection(),
  });

  return { updated: rendered.updated, content: rendered.content, readmePath };
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
 * テンプレートの README を、これから配る内容から組み直す。ディスクへは書かない。
 *
 * 生成元をディスクではなく引数で受け取れるようにしている理由: マーカー間は `ziku.jsonc` の
 * include から導出される派生物なので、導出元と派生物が同じ変更（同じ PR）に載るときは、
 * 生成もその変更に載る内容から行わないと配る README が導出元と食い違う。ディスク上の
 * `ziku.jsonc` から作ると、`ziku track` で足したばかりのパターンを反映しない README を
 * 配ることになる。
 *
 * @param params.templateDir README / ziku.jsonc をディスクから読む既定の出所。
 * @param params.readme これから配る README の内容。配る内容に含まれないなら undefined。
 * @param params.config これから配る ziku.jsonc の内容。配る内容に含まれないなら undefined。
 * @returns README が無い / マーカーが無い場合は null。
 */
export async function renderTemplateReadme(params: {
  readonly templateDir: string;
  readonly readme: string | undefined;
  readonly config: string | undefined;
}): Promise<RenderedReadme | null> {
  const readmePath = join(params.templateDir, "README.md");
  if (params.readme === undefined && !existsSync(readmePath)) return null;

  const readme = params.readme ?? (await readFile(readmePath, "utf-8"));
  if (!hasGeneratedSections(readme)) return null;

  const include =
    params.config === undefined
      ? await loadIncludePatterns(join(params.templateDir, ZIKU_CONFIG_FILE))
      : parseIncludePatterns(params.config);

  return applyGeneratedSections({ readme, include, commands: undefined });
}

/** マーカー間を ziku が組み直す README か。マーカーが無い README には触れない。 */
function hasGeneratedSections(readme: string): boolean {
  return readme.includes(MARKERS.features.start) || readme.includes(MARKERS.files.start);
}

/**
 * プロジェクトディレクトリ内の README を検出し、更新後の内容を返す。ディスクへは書かない。
 *
 * 書き込みを伴わないので、更新の有無だけを知りたい呼び出し元（push の dry-run プレビュー）が
 * そのまま使える。「何も変えない」ことを守るためにプレビュー側で判定を書き直すと、予告した
 * 内容と実 push が同梱する内容が食い違う。
 *
 * @param targetDir 更新対象の README.md があるディレクトリ
 * @param templateDir 同期パターンを定義する ziku.jsonc があるディレクトリ
 * @returns README が無い / マーカーが無い場合は null。
 */
export async function detectReadmeUpdate(
  targetDir: string,
  templateDir: string,
): Promise<GenerateReadmeResult | null> {
  const readmePath = join(targetDir, "README.md");
  const configPath = join(templateDir, ZIKU_CONFIG_FILE);

  // README にマーカーがあるか確認
  if (!existsSync(readmePath)) {
    return null;
  }

  if (!hasGeneratedSections(await readFile(readmePath, "utf-8"))) {
    return null;
  }

  return generateReadme({ readmePath, configPath });
}
