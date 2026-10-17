/**
 * Preload：把主进程能力以受控 API 形式暴露给渲染进程。
 *
 * 渲染进程拿不到 ipcRenderer 本体，只能调用下面这些明确列出的方法。
 */

import { contextBridge, ipcRenderer } from 'electron'
import {
  IPC,
  type AppSettings,
  type AppInfo,
  type BatchRequest,
  type BatchResult,
  type CleanArtifactsResult,
  type ClearResult,
  type CmakeApplyResult,
  type CmakeChangePreview,
  type CmakeChangeRequest,
  type CmakeScanResult,
  type CmakeSignature,
  type ConfigTemplate,
  type CreateSourceFileResult,
  type NewFileKind,
  type GenOptions,
  type HistoryEntry,
  type PackInspectResult,
  type PackPlanOptions,
  type RenamePlan,
  type PlanRequest,
  type PlannedFile,
  type ProjectCandidate,
  type ProjectLoadResult,
  type RunExit,
  type RunOutput,
  type RunRequest,
  type RunStarted,
  type RestoreResult,
  type SnapshotMeta,
  type StudioApi,
  type ToolPaths,
  type WriteProgress,
  type WriteRequest,
  type WriteResult
} from '@shared/types'
import type { PackApplyResult, PackManifest, PackPlan } from '@shared/packTypes'

function subscribe<T>(channel: string, cb: (payload: T) => void): () => void {
  const listener = (_event: unknown, payload: T): void => cb(payload)
  ipcRenderer.on(channel, listener as never)
  return () => {
    ipcRenderer.removeListener(channel, listener as never)
  }
}

const api: StudioApi = {
  getSettings: () => ipcRenderer.invoke(IPC.settingsGet) as Promise<AppSettings>,
  saveSettings: (patch) => ipcRenderer.invoke(IPC.settingsSave, patch) as Promise<AppSettings>,
  getAppInfo: () => ipcRenderer.invoke(IPC.appInfo) as Promise<AppInfo>,

  pickDirectory: (defaultPath) =>
    ipcRenderer.invoke(IPC.dialogPickDirectory, defaultPath) as Promise<string | null>,
  pickFile: (filters) => ipcRenderer.invoke(IPC.dialogPickFile, filters) as Promise<string | null>,

  loadProject: (projectRoot, overrides, probeVersions) =>
    ipcRenderer.invoke(
      IPC.projectLoad,
      projectRoot,
      overrides ?? {},
      probeVersions ?? false
    ) as Promise<ProjectLoadResult>,
  generateBundle: (projectRoot, options: GenOptions) =>
    ipcRenderer.invoke(IPC.projectGenerate, projectRoot, options),
  discoverProjects: () => ipcRenderer.invoke(IPC.projectDiscover) as Promise<ProjectCandidate[]>,
  readVscodeFile: (projectRoot, name) =>
    ipcRenderer.invoke(IPC.projectReadFile, projectRoot, name) as Promise<{
      exists: boolean
      text: string
      error: string | null
    }>,
  openInVSCode: (path) => ipcRenderer.invoke(IPC.projectOpenInVSCode, path) as Promise<void>,
  openInExplorer: (path) => ipcRenderer.invoke(IPC.projectOpenInExplorer, path) as Promise<void>,

  detectTools: (options) => ipcRenderer.invoke(IPC.toolsDetect, options) as Promise<ToolPaths>,

  planFiles: (request: PlanRequest) =>
    ipcRenderer.invoke(IPC.configPlan, request) as Promise<PlannedFile[]>,
  writeFiles: (request: WriteRequest) =>
    ipcRenderer.invoke(IPC.configWrite, request) as Promise<WriteResult>,
  onWriteProgress: (cb) => subscribe<WriteProgress>(IPC.configWriteProgress, cb),

  listSnapshots: (projectRoot) =>
    ipcRenderer.invoke(IPC.snapshotList, projectRoot) as Promise<SnapshotMeta[]>,
  restoreSnapshot: (projectRoot, snapshotId) =>
    ipcRenderer.invoke(IPC.snapshotRestore, projectRoot, snapshotId) as Promise<RestoreResult>,
  clearVscodeConfig: (projectRoot) =>
    ipcRenderer.invoke(IPC.configClear, projectRoot) as Promise<ClearResult>,
  cleanArtifacts: (projectRoot, relativePaths) =>
    ipcRenderer.invoke(IPC.projectCleanArtifacts, projectRoot, relativePaths),

  // ---- CMake 构建目标与源文件 ----
  cmakeScan: (projectRoot) =>
    ipcRenderer.invoke(IPC.cmakeScan, projectRoot) as Promise<CmakeScanResult>,

  // ---- 模块包 ----
  packList: () => ipcRenderer.invoke(IPC.packList) as Promise<PackManifest[]>,
  packInspect: (packId, projectRoot) =>
    ipcRenderer.invoke(IPC.packInspect, packId, projectRoot) as Promise<PackInspectResult>,
  packPlan: (options: PackPlanOptions) =>
    ipcRenderer.invoke(IPC.packPlan, options) as Promise<PackPlan>,
  packApply: (options: PackPlanOptions) =>
    ipcRenderer.invoke(IPC.packApply, options) as Promise<PackApplyResult>,

  cmakeTrashFiles: (projectRoot, relPaths) =>
    ipcRenderer.invoke(IPC.cmakeTrashFiles, projectRoot, relPaths) as Promise<{
      ok: boolean
      trashed: string[]
      errors: string[]
    }>,

  projectRenamePlan: (projectRoot, newName, withIoc) =>
    ipcRenderer.invoke(IPC.projectRenamePlan, projectRoot, newName, withIoc) as Promise<RenamePlan>,
  projectRenameApply: (plan: RenamePlan) =>
    ipcRenderer.invoke(IPC.projectRenameApply, plan) as Promise<{
      ok: boolean
      written: string[]
      errors: string[]
      snapshotId: string | null
    }>,

  cmakeSignature: (projectRoot) =>
    ipcRenderer.invoke(IPC.cmakeSignature, projectRoot) as Promise<CmakeSignature>,

  cmakePreview: (req: CmakeChangeRequest) =>
    ipcRenderer.invoke(IPC.cmakePreview, req) as Promise<CmakeChangePreview>,

  cmakeApply: (req: CmakeChangeRequest) =>
    ipcRenderer.invoke(IPC.cmakeApply, req) as Promise<CmakeApplyResult>,

  cmakeCreateFile: (projectRoot, relPath, kind: NewFileKind) =>
    ipcRenderer.invoke(
      IPC.cmakeCreateFile,
      projectRoot,
      relPath,
      kind
    ) as Promise<CreateSourceFileResult>,

  listTemplates: () => ipcRenderer.invoke(IPC.templateList) as Promise<ConfigTemplate[]>,
  saveTemplate: (template) =>
    ipcRenderer.invoke(IPC.templateSave, template) as Promise<ConfigTemplate[]>,
  deleteTemplate: (id) => ipcRenderer.invoke(IPC.templateDelete, id) as Promise<ConfigTemplate[]>,
  listHistory: () => ipcRenderer.invoke(IPC.historyList) as Promise<HistoryEntry[]>,
  addHistory: (entry) => ipcRenderer.invoke(IPC.historyAdd, entry) as Promise<HistoryEntry[]>,
  removeHistory: (id) => ipcRenderer.invoke(IPC.historyRemove, id) as Promise<HistoryEntry[]>,
  clearHistory: () => ipcRenderer.invoke(IPC.historyClear) as Promise<HistoryEntry[]>,
  applyTemplateToProjects: (request: BatchRequest) =>
    ipcRenderer.invoke(IPC.templateApplyBatch, request) as Promise<BatchResult>,

  startRun: (request: RunRequest) => ipcRenderer.invoke(IPC.runStart, request) as Promise<RunStarted>,
  cancelRun: (runId) => ipcRenderer.invoke(IPC.runCancel, runId) as Promise<void>,
  onRunOutput: (cb) => subscribe<RunOutput>(IPC.runOutput, cb),
  onRunExit: (cb) => subscribe<RunExit>(IPC.runExit, cb),

  setWindowTheme: (theme) => ipcRenderer.invoke(IPC.windowSetTheme, theme) as Promise<void>
}

contextBridge.exposeInMainWorld('api', api)
