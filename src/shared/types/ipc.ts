/**
 * IPC 契约：通道名常量、preload 暴露的接口形状、渲染进程的全局类型。
 *
 * ## 加一个通道要改三处
 *
 * 1. 这里的 `IPC` 加常量
 * 2. `preload/index.ts` 的桥里加一行（**最容易漏**，漏了运行时报「不是函数」）
 * 3. `main/ipc/*.ts` 里加 handler
 *
 * `StudioApi` 是渲染进程能看到的全部能力，也就是安全边界：
 * 这里没列的东西，界面碰不到。
 */

import type { RenamePlan, ProjectInfo } from './project'
import type { ToolPaths, ProjectCandidate } from './tools'
import type { ConfigBundle } from './debug'
import type { GenOptions, PlanRequest, PlannedFile, WriteRequest, WriteResult, WriteProgress, SnapshotMeta, RestoreResult, ClearResult } from './generate'
import type { BatchRequest, BatchResult, RunRequest, RunStarted, RunOutput, RunExit } from './runtime'
import type { AppInfo, ConfigTemplate, CleanArtifactsResult, HistoryEntry } from './app'
import type { AppSettings } from './settings'
import type { CmakeScanResult, CmakeSignature, CmakeChangeRequest, CmakeChangePreview, CmakeApplyResult, NewFileKind, CreateSourceFileResult } from './cmake'
import type { PackInspectResult, PackPlanOptions } from './pack'

export const IPC = {
  settingsGet: 'settings:get',
  settingsSave: 'settings:save',
  appInfo: 'app:info',

  dialogPickDirectory: 'dialog:pickDirectory',
  dialogPickFile: 'dialog:pickFile',

  projectScan: 'project:scan',
  projectLoad: 'project:load',
  projectGenerate: 'project:generate',
  projectDiscover: 'project:discover',
  projectReadFile: 'project:readFile',
  projectOpenInVSCode: 'project:openInVSCode',
  projectOpenInExplorer: 'project:openInExplorer',

  toolsDetect: 'tools:detect',

  configPlan: 'config:plan',
  configWrite: 'config:write',
  configWriteProgress: 'config:writeProgress',

  snapshotList: 'snapshot:list',
  snapshotRestore: 'snapshot:restore',
  configClear: 'config:clear',
  projectCleanArtifacts: 'project:clean-artifacts',

  cmakeScan: 'cmake:scan',
  cmakePreview: 'cmake:preview',
  cmakeApply: 'cmake:apply',
  cmakeCreateFile: 'cmake:create-file',
  cmakeSignature: 'cmake:signature',
  projectRenamePlan: 'project:renamePlan',
  projectRenameApply: 'project:renameApply',
  cmakeTrashFiles: 'cmake:trashFiles',

  packList: 'pack:list',
  packInspect: 'pack:inspect',
  packPlan: 'pack:plan',
  packApply: 'pack:apply',
  /** 只保存映射表（application/vofa/vofa_map.json），不动生成文件 */
  vofaMapSave: 'vofa:mapSave',
  /**
   * 从编译产物 .elf 的符号表里读「变量名 → 地址」。
   *
   * 这是「地址表」那条路的数据源：拿到地址就能直接下发 `am` 命令读内存，
   * 不用生成代码、不用重新编译烧录。读的是磁盘上的文件，纯只读。
   */
  vofaElfVars: 'vofa:elfVars',
  /**
   * 地址表的读写（`application/vofa/vofa_addr.json`）。
   *
   * 存的是「这个工程挑了哪几个变量、按什么类型、什么顺序」。
   * 不存的话关一次工具就丢，而地址每次重编都可能变，重新勾的时候还得回想上次选了谁。
   */
  vofaAddrLoad: 'vofa:addrLoad',
  vofaAddrSave: 'vofa:addrSave',
  packPortPreflight: 'pack:portPreflight',
  packPortInstall: 'pack:portInstall',
  /**
   * 常规包写入过程中的进度（主进程 → 渲染进程）。
   *
   * 和 `packPortProgress` 分开是因为语义不同：那条是移植流水线的步骤，
   * 这条是「写文件 → 跑 CubeMX → 核对波特率」三步。CubeMX 一次要几十秒，
   * 不给进度的话界面只能显示一个转圈，用户会以为卡死了。
   */
  packApplyProgress: 'pack:applyProgress',
  /**
   * 移植过程中的**实时进度推送**（主进程 → 渲染进程）。
   *
   * `ipcRenderer.invoke` 是一次往返：调用开始到结束之间，渲染进程拿不到
   * 任何中间状态。所以移植跑着的时候界面只能显示「执行中…」，
   * 用户盯着一个转圈等 CubeMX 那 40 秒，不知道卡在哪一步、也不知道
   * 已经完成了多少。改成主进程每完成一步就往这条通道发一条。
   */
  packPortProgress: 'pack:portProgress',

  /** 检查更新（读 GitHub Releases） */
  checkUpdate: 'app:checkUpdate',
  /** 打开 Release 页面 / 下载指定附件 */
  openExternal: 'app:openExternal',
  /** 应用内下载安装包 */
  downloadUpdate: 'app:downloadUpdate',
  /** 下载进度推送 */
  updateDownloadProgress: 'app:updateDownloadProgress',
  /** 取消下载 */
  cancelUpdateDownload: 'app:cancelUpdateDownload',
  /** 启动下载好的安装包 */
  runUpdateInstaller: 'app:runUpdateInstaller',

  templateList: 'template:list',
  templateSave: 'template:save',
  templateDelete: 'template:delete',
  /** 导出模板到 .json 文件（弹保存对话框） */
  templateExport: 'template:export',
  /** 从 .json 文件导入模板（弹打开对话框） */
  templateImport: 'template:import',
  templateFormatDoc: 'template:formatDoc',
  packPresetList: 'packPreset:list',
  packPresetSave: 'packPreset:save',
  packPresetDelete: 'packPreset:delete',
  historyList: 'history:list',
  historyAdd: 'history:add',
  historyRemove: 'history:remove',
  historyClear: 'history:clear',
  templateApplyBatch: 'template:applyBatch',

  runStart: 'run:start',
  runCancel: 'run:cancel',
  runOutput: 'run:output',
  runExit: 'run:exit',

  windowSetTheme: 'window:setTheme'
} as const

/** 一次「载入工程」的完整结果：检测 + 工具探测 + 默认参数 + 初始配置 */
export interface ProjectLoadResult {
  project: ProjectInfo
  tools: ToolPaths
  options: GenOptions
  bundle: ConfigBundle
}

export interface StudioApi {
  getSettings(): Promise<AppSettings>
  saveSettings(patch: Partial<AppSettings>): Promise<AppSettings>
  getAppInfo(): Promise<AppInfo>

  pickDirectory(defaultPath?: string): Promise<string | null>
  pickFile(filters?: { name: string; extensions: string[] }[]): Promise<string | null>

  loadProject(
    projectRoot: string,
    overrides?: Partial<GenOptions>,
    probeVersions?: boolean
  ): Promise<ProjectLoadResult>
  generateBundle(projectRoot: string, options: GenOptions): Promise<ConfigBundle>
  discoverProjects(): Promise<ProjectCandidate[]>
  readVscodeFile(
    projectRoot: string,
    name: string
  ): Promise<{ exists: boolean; text: string; error: string | null }>
  openInVSCode(path: string): Promise<void>
  openInExplorer(path: string): Promise<void>

  detectTools(options?: { probeVersions?: boolean }): Promise<ToolPaths>

  planFiles(request: PlanRequest): Promise<PlannedFile[]>
  writeFiles(request: WriteRequest): Promise<WriteResult>
  onWriteProgress(cb: (payload: WriteProgress) => void): () => void

  listSnapshots(projectRoot: string): Promise<SnapshotMeta[]>
  restoreSnapshot(projectRoot: string, snapshotId: string): Promise<RestoreResult>
  /** 删除本工具管理的 .vscode 文件，让工程回到「从未配置过」的样子 */
  clearVscodeConfig(projectRoot: string): Promise<ClearResult>
  /** 清理构建目录里的陈旧产物；主进程会逐个校验路径与后缀 */
  cleanArtifacts(projectRoot: string, relativePaths: string[]): Promise<CleanArtifactsResult>

  /** 读工程的 CMake 目标与源文件，并找出「磁盘上有但没进构建」的 */
  cmakeScan(projectRoot: string): Promise<CmakeScanResult>
  /** 算出加/删源文件之后的 CMakeLists 全文（不落盘） */
  cmakePreview(req: CmakeChangeRequest): Promise<CmakeChangePreview>
  /** 落盘（先存快照）+ 记历史 */
  cmakeApply(req: CmakeChangeRequest): Promise<CmakeApplyResult>
  /** 算一个「工程变了没」的指纹，界面据此决定要不要重新扫描 */
  /** 改名：先算计划（不写盘），看 diff 再决定 */
  projectRenamePlan(projectRoot: string, newName: string, withIoc?: boolean): Promise<RenamePlan>
  /** 落盘（先存快照，可还原） */
  projectRenameApply(plan: RenamePlan): Promise<{
    ok: boolean
    written: string[]
    errors: string[]
    snapshotId: string | null
  }>

  cmakeSignature(projectRoot: string): Promise<CmakeSignature>
  /**
   * 把文件**移到回收站**（不是直接删）—— 可还原。
   * 用于清理 Keil/IAR 时代的残留：删错了还能从回收站捞回来。
   */
  cmakeTrashFiles(
    projectRoot: string,
    relPaths: string[]
  ): Promise<{ ok: boolean; trashed: string[]; errors: string[] }>
  /** 已安装的模块包列表 */
  packList(): Promise<import('../packTypes').PackManifest[]>
  /** 读工程事实 + 兼容性检查 + PID 候选，只读不写 */
  packInspect(packId: string, projectRoot: string): Promise<PackInspectResult>
  /** 算出改动清单（含每个文件的改前改后全文），只读不写 */
  packPlan(options: PackPlanOptions): Promise<import('../packTypes').PackPlan>
  /** 落盘（先存快照）+ 记历史 */
  packApply(options: PackPlanOptions): Promise<import('../packTypes').PackApplyResult>
  /** 只保存 vofa 映射表（application/vofa/vofa_map.json），不写生成文件 */
  vofaMapSave(
    projectRoot: string,
    map: import('../vofaMap').VofaMap
  ): Promise<{ ok: boolean; path: string | null; error?: string }>
  /**
   * 从 .elf 读全局变量地址表（地址级调参的数据源）。
   * 不传 elfPath 时自动挑工程里最新的那个 .elf。
   */
  vofaElfVars(
    projectRoot: string,
    elfPath?: string
  ): Promise<import('../addrTable').ElfVarsResult>
  /** 读工程里存的地址表；文件不存在时返回空表（不是错误） */
  vofaAddrLoad(
    projectRoot: string
  ): Promise<{ slots: import('../addrTable').AddrSlot[]; path: string | null }>
  /** 写回地址表。slots 为空数组时也照写（代表用户主动清空） */
  vofaAddrSave(
    projectRoot: string,
    slots: import('../addrTable').AddrSlot[]
  ): Promise<{ ok: boolean; path: string | null; error?: string }>

  // ---- 移植包（VT13 这类）----
  //
  // 和上面的 packApply 是两条不同的路：
  //   · packPlan/packApply —— 常规包，先算出每个文件的改前改后，用户看 diff 再确认
  //   · packPortInstall    —— 移植包，要调外部程序（CubeMX）改一堆文件，
  //                           没法事先算出完整 diff，靠「快照 + 回滚」保底
  /** 移植前预检，只读 */
  packPortPreflight(
    packId: string,
    projectRoot: string
  ): Promise<import('../packTypes').PackPortPreflightResult>
  /**
   * 检查有没有新版本。
   *
   * @param force 忽略缓存强制重新请求（用户点「检查更新」时）
   */
  checkUpdate(force?: boolean): Promise<import('../updateTypes').UpdateInfo>
  /** 用系统浏览器打开 URL（Release 页面、下载链接） */
  openExternal(url: string): Promise<void>

  /** 在应用内下载更新包，返回下载好的文件路径 */
  downloadUpdate(
    url: string,
    fileName: string
  ): Promise<{
    ok: boolean
    path?: string
    error?: string
    cancelled?: boolean
  }>
  /** 订阅下载进度。返回取消订阅函数 */
  onUpdateDownloadProgress(handler: (p: import('../updateTypes').DownloadProgress) => void): () => void
  /** 取消进行中的下载 */
  cancelUpdateDownload(): Promise<void>
  /** 启动下载好的安装包 */
  runUpdateInstaller(path: string): Promise<{ ok: boolean; error?: string }>

  /** 执行移植流水线（先存快照） */
  packPortInstall(options: {
    packId: string
    projectRoot: string
    skipCubeMx?: boolean
  }): Promise<import('../packTypes').PackPortResult>

  /**
   * 订阅移植进度。返回取消订阅的函数。
   *
   * 每一步开始、结束都会推一条，界面据此实时显示「哪一步在跑、哪几步已经好了」，
   * 而不是等整个流程跑完才一次性看到结果。
   */
  onPortProgress(
    handler: (payload: { runId: string; step: import('../packTypes').PackPortStep }) => void
  ): () => void

  /**
   * 订阅常规包写入的进度（写文件 → 跑 CubeMX → 核对波特率）。
   *
   * 之所以要单独一条：CubeMX 一次要跑几十秒，`packApply` 是一次 invoke，
   * 期间界面拿不到任何中间状态。
   */
  onApplyProgress(
    handler: (payload: {
      runId: string
      step: import('../packTypes').PackApplyStep
    }) => void
  ): () => void

  /** 新建一个源码文件（骨架），不自动加入构建 */
  cmakeCreateFile(
    projectRoot: string,
    relPath: string,
    kind: NewFileKind
  ): Promise<CreateSourceFileResult>

  listTemplates(): Promise<ConfigTemplate[]>
  saveTemplate(template: ConfigTemplate): Promise<ConfigTemplate[]>
  deleteTemplate(id: string): Promise<ConfigTemplate[]>
  /**
   * 导出模板到文件。
   *
   * 一次可以带两类模板（工程配置 + 模块包），会写进同一个文件。
   * 返回保存后的路径；用户取消或没东西可导返回 null。
   */
  exportTemplate(payload: {
    projectTemplates?: ConfigTemplate[]
    packPresets?: import('../templateFormat').PackPreset[]
    defaultName?: string
  }): Promise<string | null>
  /**
   * 从文件导入模板（可多选文件，每个文件可含多条）。
   * 按每条记录的 kind 自动分流到对应存储；用户取消返回 null。
   */
  importTemplates(): Promise<{
    imported: number
    importedProject: number
    importedPack: number
    skipped: number
    /** 文件里引用了但本机没装的模块包 id */
    missingPacks: string[]
    templates: ConfigTemplate[]
    presets: import('../templateFormat').PackPreset[]
  } | null>

  // ---- 模块包模板 -------------------------------------------------------
  listPackPresets(packId?: string): Promise<import('../templateFormat').PackPreset[]>
  savePackPreset(
    preset: import('../templateFormat').PackPreset
  ): Promise<import('../templateFormat').PackPreset[]>
  deletePackPreset(id: string): Promise<import('../templateFormat').PackPreset[]>
  /** 模板文件格式说明（给「复制格式说明」按钮） */
  getTemplateFormatDoc(): Promise<string>

  applyTemplateToProjects(request: BatchRequest): Promise<BatchResult>

  listHistory(): Promise<HistoryEntry[]>
  addHistory(entry: Omit<HistoryEntry, 'id' | 'at'>): Promise<HistoryEntry[]>
  removeHistory(id: string): Promise<HistoryEntry[]>
  clearHistory(): Promise<HistoryEntry[]>

  startRun(request: RunRequest): Promise<RunStarted>
  cancelRun(runId: string): Promise<void>
  onRunOutput(cb: (payload: RunOutput) => void): () => void
  onRunExit(cb: (payload: RunExit) => void): () => void

  /** 切换主题时同步更新无边框标题栏的配色 */
  setWindowTheme(theme: AppSettings['theme']): Promise<void>
}

declare global {
  interface Window {
    api: StudioApi
  }
}
