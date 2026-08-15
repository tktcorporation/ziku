/**
 * README.md の自動生成ユーティリティ
 */

import { existsSync } from "node:fs";
import { readFile, writeFile } from "node:fs/promises";
import { join } from "pathe";
import { match } from "ts-pattern";
import type { GlobPattern } from "../modules/schemas";
import { absPath } from "./paths";
import type { ZikuConfigRead } from "./ziku-config";
import { classifyZikuConfigText, readZikuConfig } from "./ziku-config";

/**
 * ziku がマーカー間を組み直す README の区画。
 *
 * マーカー名は、テンプレートの README を書き換える ziku 本体（{@link renderTemplateReadme}）と、
 * このリポジトリの README を生成する `scripts/generate-readme.ts` の間の取り決めでもある。
 * 定義を 2 箇所に置くと、片方の名前を変えたときにもう片方が「マーカーが無い」として無言で
 * 何も書かなくなるので、名前はここだけに持つ。
 */
export const MARKERS = {
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
 * ziku.jsonc の読み取り結果から include パターンを取り出す。
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
 *
 * 読み取りと失敗の分類そのものは持たず、他の入口と同じ分類（`src/utils/ziku-config.ts` の
 * `ZikuConfigRead`）を受け取って倒すだけにする。分類をここで組み直すと、`ziku.jsonc` の
 * 読み方が変わったときに README 生成だけが取り残され、実際の同期対象と食い違うファイル一覧を
 * 「正しい一覧」として書き出す。
 */
function includePatternsOf(read: ZikuConfigRead): readonly GlobPattern[] {
  return match(read)
    .with({ _tag: "Ok" }, ({ config }) => config.include)
    .with(
      { _tag: "NotFound" },
      { _tag: "Unparsable" },
      { _tag: "Invalid" },
      (): readonly GlobPattern[] => [],
    )
    .exhaustive();
}

/**
 * 機能セクションを生成
 */
function generateFeaturesSection(patterns: readonly GlobPattern[]): string {
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
function generateFilesSection(patterns: readonly GlobPattern[]): string {
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
 * マーカー間を差し替えた結果。
 *
 * マーカーが見つからなかったことを値で返すのは、不在の意味が呼び出し側で違うため。任意の
 * テンプレートの README を組み直す経路（{@link renderTemplateReadme}）では、区画を持たない
 * README に触れないのが正しい。自分のリポジトリの README を組み直す生成器
 * （`scripts/generate-readme.ts`）では、不在は書き換え漏れなので止める対象になる。元の内容を
 * そのまま返して潰すと、後者が「生成したのに何も書いていない」ことに気づけない。
 */
export type SectionUpdate =
  | { readonly _tag: "Replaced"; readonly content: string; readonly updated: boolean }
  /** `startMarker` と `endMarker` の対が揃っていない。 */
  | { readonly _tag: "MarkerNotFound"; readonly startMarker: string };

/** README のマーカー間を、渡した内容で差し替える。 */
export function updateSection(
  content: string,
  startMarker: string,
  endMarker: string,
  newSection: string,
): SectionUpdate {
  const startIndex = content.indexOf(startMarker);
  const endIndex = content.indexOf(endMarker);

  if (startIndex === -1 || endIndex === -1) {
    return { _tag: "MarkerNotFound", startMarker };
  }

  const before = content.slice(0, startIndex + startMarker.length);
  const after = content.slice(endIndex);
  const newContent = `${before}\n\n${newSection}\n${after}`;

  return { _tag: "Replaced", content: newContent, updated: newContent !== content };
}

export interface GenerateReadmeOptions {
  /** README.md のパス */
  readmePath: string;
  /** 同期パターンを定義する ziku.jsonc があるディレクトリ */
  configDir: string;
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
  include: readonly GlobPattern[];
  commands: string | undefined;
}): RenderedReadme {
  const sections: { start: string; end: string; body: string }[] = [];

  if (params.include.length > 0) {
    sections.push({
      ...MARKERS.features,
      body: generateFeaturesSection(params.include),
    });
  }
  if (params.commands !== undefined) {
    sections.push({ ...MARKERS.commands, body: params.commands });
  }
  if (params.include.length > 0) {
    sections.push({ ...MARKERS.files, body: generateFilesSection(params.include) });
  }

  return sections.reduce<RenderedReadme>(
    (rendered, section) =>
      match(updateSection(rendered.content, section.start, section.end, section.body))
        .with(
          { _tag: "Replaced" },
          (replaced): RenderedReadme => ({
            content: replaced.content,
            updated: rendered.updated || replaced.updated,
          }),
        )
        // マーカーを持たない区画は飛ばす。どの区画を置くかはテンプレートの README が決めることで、
        // 無い区画を作りに行くと ziku が README の構成を決めてしまう。
        .with({ _tag: "MarkerNotFound" }, () => rendered)
        .exhaustive(),
    { content: params.readme, updated: false },
  );
}

/**
 * README を生成
 */
export async function generateReadme(
  options: GenerateReadmeOptions,
): Promise<GenerateReadmeResult> {
  const { readmePath, configDir, generateCommandsSection } = options;

  // README が存在しない場合はスキップ
  if (!existsSync(readmePath)) {
    return { updated: false, content: "", readmePath };
  }

  const rendered = applyGeneratedSections({
    readme: await readFile(readmePath, "utf-8"),
    include: includePatternsOf(await readZikuConfig(absPath(configDir))),
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
 * テンプレートの README を組み直す入口はこの 1 本だけにする。ディスクから読んで組み直す入口を
 * 別に置くと、push が送る内容と、それを予告する側が別の材料から README を作れてしまう。
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

  const include = includePatternsOf(
    params.config === undefined
      ? await readZikuConfig(absPath(params.templateDir))
      : classifyZikuConfigText(params.config),
  );

  return applyGeneratedSections({ readme, include, commands: undefined });
}

/** マーカー間を ziku が組み直す README か。マーカーが無い README には触れない。 */
function hasGeneratedSections(readme: string): boolean {
  return readme.includes(MARKERS.features.start) || readme.includes(MARKERS.files.start);
}
