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
 * モジュールリストから ID でモジュールを取得
 */
export function getModuleById(
  id: string,
  moduleList: TemplateModule[],
): TemplateModule | undefined {
  return moduleList.find((m) => m.id === id);
}

/**
 * 全モジュールのパターンを取得
 */
export function getAllPatterns(moduleList: TemplateModule[]): string[] {
  return moduleList.flatMap((m) => m.patterns);
}

/**
 * 指定モジュールIDのパターンを取得
 */
export function getPatternsByModuleIds(
  moduleIds: string[],
  moduleList: TemplateModule[],
): string[] {
  return moduleList.filter((m) => moduleIds.includes(m.id)).flatMap((m) => m.patterns);
}
