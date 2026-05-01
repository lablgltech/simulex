import { stageDependencyGroup } from './stageDependencyGroup';

/** Сколько файловых строк зависимостей для этапа без файла на диске */
export function missingFilesCountForStage(stage, depItems) {
  if (!stage || !Array.isArray(depItems)) return 0;
  const g = stageDependencyGroup(stage);
  return depItems.filter(
    (it) => it.group === g && it.file_rel_path && !it.exists,
  ).length;
}
