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
 * モジュールリストから name でモジュールを取得
 */
export function getModuleByName(
  name: string,
  moduleList: TemplateModule[],
): TemplateModule | undefined {
  return moduleList.find((m) => m.name === name);
}

/**
 * 全モジュールの include パターンをフラットに取得
 */
export function getAllIncludePatterns(moduleList: TemplateModule[]): string[] {
  return moduleList.flatMap((m) => m.include);
}

/**
 * 全モジュールの exclude パターンをフラットに取得
 */
export function getAllExcludePatterns(moduleList: TemplateModule[]): string[] {
  return moduleList.flatMap((m) => m.exclude ?? []);
}
