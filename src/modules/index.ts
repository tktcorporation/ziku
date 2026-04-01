import type { TemplateModule } from "./schemas";

// Re-export loader functions
export {
  addIncludePattern,
  getModulesFilePath,
  loadLocalPatternsFile,
  loadPatternsFile,
  loadTemplateModulesFile,
  modulesFileExists,
  saveModulesFile,
} from "./loader";

/**
 * モジュールリストから name でモジュールを取得（init 時のみ使用）
 */
export function getModuleByName(
  name: string,
  moduleList: TemplateModule[],
): TemplateModule | undefined {
  return moduleList.find((m) => m.name === name);
}
