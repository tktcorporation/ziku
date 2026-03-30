import type { TemplateModule } from "./schemas";

// Re-export loader functions
export {
  addPatternToModulesFile,
  addPatternToModulesFileWithCreate,
  getModulesFilePath,
  loadModulesFile,
  modulesFileExists,
  saveModulesFile,
} from "./loader";

/**
 * デフォルトモジュール（modules.jsonc がない場合のフォールバック）
 * モジュール ID = ディレクトリパス（ルートは "."）
 */
export const defaultModules: TemplateModule[] = [
  {
    id: ".",
    name: "ルート設定",
    description: "MCP、mise などのルート設定ファイル",
    setupDescription: "プロジェクトルートの設定ファイルが適用されます",
    patterns: [".mcp.json", ".mise.toml"],
  },
  {
    id: ".devcontainer",
    name: "DevContainer",
    description: "VS Code DevContainer、Docker-in-Docker",
    setupDescription: "VS Code で DevContainer を開くと自動でセットアップされます",
    patterns: [
      ".devcontainer/devcontainer.json",
      ".devcontainer/.gitignore",
      ".devcontainer/setup-*.sh",
      ".devcontainer/test-*.sh",
      ".devcontainer/.env.devcontainer.example",
    ],
  },
  {
    id: ".github",
    name: "GitHub",
    description: "GitHub Actions、labeler ワークフロー",
    setupDescription: "PR 作成時に自動でラベル付け、Issue リンクが行われます",
    patterns: [
      ".github/workflows/issue-link.yml",
      ".github/workflows/label.yml",
      ".github/labeler.yml",
    ],
  },
  {
    id: ".claude",
    name: "Claude",
    description: "Claude Code のプロジェクト共通設定",
    setupDescription: "Claude Code のプロジェクト設定が適用されます",
    patterns: [".claude/settings.json"],
  },
];

// 後方互換性のためのエイリアス
export const modules = defaultModules;

/**
 * モジュールリストから ID でモジュールを取得
 */
export function getModuleById(
  id: string,
  moduleList: TemplateModule[] = defaultModules,
): TemplateModule | undefined {
  return moduleList.find((m) => m.id === id);
}

/**
 * 全モジュールのパターンを取得
 */
export function getAllPatterns(moduleList: TemplateModule[] = defaultModules): string[] {
  return moduleList.flatMap((m) => m.patterns);
}

/**
 * 指定モジュールIDのパターンを取得
 */
export function getPatternsByModuleIds(
  moduleIds: string[],
  moduleList: TemplateModule[] = defaultModules,
): string[] {
  return moduleList.filter((m) => moduleIds.includes(m.id)).flatMap((m) => m.patterns);
}
