/**
 * 主进程与渲染进程共享的类型定义 —— 也就是整个 IPC 的契约。
 *
 * 约定：所有跨进程传递的对象都必须是可结构化克隆的纯数据（不能有 Date、
 * class 实例、函数），因此这里全部用 string / number / boolean / null / 数组 / 对象。
 * 路径统一用 Windows 原生反斜杠字符串；写进 VSCode 配置时再转成正斜杠。
 */

// ==========================================================================
// CMake
// ==========================================================================

export interface CmakeTarget {
  name: string
  kind: 'executable' | 'library' | 'unknown'
  /** 从哪条指令解析出来的，用来向用户解释 */
  source: string
}

export interface CmakePreset {
  name: string
  hidden: boolean
  generator: string | null
  binaryDir: string | null
  buildType: string | null
  toolchainFile: string | null
  inherits: string[]
  cacheVariables: Record<string, string>
}

export interface CmakeCache {
  path: string | null
  generator: string | null
  buildType: string | null
  cCompiler: string | null
  cxxCompiler: string | null
  makeProgram: string | null
  toolchainFile: string | null
  exportCompileCommands: boolean | null
  projectName: string | null
}

// ==========================================================================
// STM32 / CubeMX
// ==========================================================================

export interface IocInfo {
  file: string | null
  /** Mcu.CPN，完整订货号，例如 STM32F103C8T6 */
  cpn: string | null
  userName: string | null
  mcuName: string | null
  family: string | null
  package: string | null
  projectName: string | null
  /** 综合推断出的芯片型号 */
  device: string | null
}

// ==========================================================================
// 构建目录 / 工程
// ==========================================================================

export interface BuildDir {
  path: string
  name: string
  presetName: string | null
  buildType: string | null
  generator: string | null
  cache: CmakeCache | null
  artifacts: string[]
  elf: string | null
  compileCommands: string | null
  configured: boolean
}

export interface VscodeFileState {
  name: string
  path: string
  exists: boolean
  /** null 表示文件不存在、无从判断 */
  valid: boolean | null
  error: string | null
  /** 一句人话描述，例如「存在，含 3 个调试配置」 */
  note: string
  /** 解析出来的原始对象；不存在或解析失败时为 null */
  data: unknown
}

/**
 * 一条「需要注意的问题」上可以附带的直接修复动作。
 *
 * 目前只有「删掉构建目录里的陈旧产物」这一种 —— 这是本工具唯一会**删工程内文件**的
 * 动作，所以主进程会对每个路径重新校验（必须在工程内、必须是构建产物后缀），
 * 不信任调用方传来的东西。
 */
export interface ProjectIssueFix {
  kind: 'remove-build-artifacts'
  label: string
  /** 相对工程根的路径 */
  files: string[]
  hint: string
}

export interface ProjectIssue {
  message: string
  fix?: ProjectIssueFix
}

export interface ProjectInfo {
  root: string
  name: string
  cmakeMinimum: string | null
  targets: CmakeTarget[]
  cmakeProjectName: string | null
  presets: CmakePreset[]
  presetFile: string | null
  presetFileKind: string
  buildDirs: BuildDir[]
  ioc: IocInfo | null
  toolchainHint: string | null
  vscodeDir: string
  vscodeFiles: Record<string, VscodeFileState>
  openocdCfgFiles: string[]
  includeDirs: string[]
  defines: string[]
  hasCompileCommands: boolean
  /** 注意：由 issues 派生，保持两者一一对应 */
  warnings: string[]
  /** 与 warnings 一一对应，但带可执行动作 */
  issues: ProjectIssue[]
  notes: string[]

  // 派生字段（由主进程算好，渲染进程直接展示）
  elfName: string
  elfSource: string
  /**
   * 固件名的可信度。决定「构建目录里的产物」能不能覆盖它：
   *   declared —— 来自 CMakeLists 的 add_executable，权威；产物不一致时只报警告
   *   derived  —— 来自 project() / set(CMAKE_PROJECT_NAME)，较可信
   *   guessed  —— 来自 .ioc 或目录名，属于猜测，可以让实际产物来纠正
   */
  elfNameConfidence: 'declared' | 'derived' | 'guessed'
  device: string | null
  isEmbedded: boolean
}

// ==========================================================================
// 工具链
// ==========================================================================

export type ToolKey =
  'openocd' | 'arm_gcc' | 'arm_gdb' | 'cmake' | 'ninja' | 'make' | 'gdb' | 'clangd' | 'jlink' | 'stlink'

export interface ToolItem {
  key: string
  path: string | null
  source: string
  version: string | null
  found: boolean
}

/** 一个被识别的工具链环境变量（例如 STM32CLT_PATH） */
export interface EnvRoot {
  name: string
  label: string
  value: string
  /** 变量存在但目录不存在时为 false，界面上要标出来 */
  exists: boolean
}

export interface ToolPaths {
  items: Record<string, ToolItem>
  openocdScripts: string | null
  openocdScriptsNote: string
  toolchainDir: string | null
  /** 识别到的工具链安装根环境变量 */
  envRoots: EnvRoot[]
  /** SVD 文件目录（STM32CubeCLT 自带一份），用于自动填 svdFile */
  svdDir: string | null
}

// ==========================================================================
// VSCode 已打开 / 最近工程
// ==========================================================================

export interface ProjectCandidate {
  folder: string
  root: string | null
  source: string
  /** 正在打开的窗口 / 最近打开过的；界面按这个分组显示 */
  kind: 'open' | 'recent'
  lastUsed: number
  chip: string | null
  label: string
  detail: string
}

// ==========================================================================
// 调试探针
// ==========================================================================

export type ProbeKey = 'cmsis-dap' | 'stlink' | 'jlink' | 'jlink-native' | 'stlink-native' | 'pyocd'

export interface ProbeOption {
  key: ProbeKey
  label: string
  interfaceCfg: string
  resetConfig: string
  servertype: string
  /** 是否需要 OpenOCD（原生 jlink/stlink/pyocd 不需要写 openocd-*.cfg） */
  needsOpenocdCfg: boolean
}

// ==========================================================================
// 生成的配置内容
// ==========================================================================

export interface LaunchFile {
  version: string
  configurations: LaunchConfig[]
}

export interface LaunchConfig {
  name: string
  type: string
  request: string
  [key: string]: unknown
}

export interface TaskDef {
  label: string
  type: string
  command: string
  args?: string[]
  options?: { cwd?: string; env?: Record<string, string> }
  group?: string | { kind: string; isDefault?: boolean }
  problemMatcher?: unknown[]
  dependsOn?: string[]
  detail?: string
  [key: string]: unknown
}

export interface TasksFile {
  version: string
  tasks: TaskDef[]
}

export interface CppConfiguration {
  name: string
  compileCommands?: string
  includePath?: string[]
  defines?: string[]
  cStandard?: string
  cppStandard?: string
  intelliSenseMode?: string
  forcedInclude?: string[]
  [key: string]: unknown
}

export interface CppPropertiesFile {
  version: number
  configurations: CppConfiguration[]
}

export type SettingsFile = Record<string, unknown>

export interface ConfigBundle {
  launch: LaunchFile
  tasks: TasksFile
  settings: SettingsFile
  cpp: CppPropertiesFile
  /** openocd 接线配置；探针不需要时为 null */
  openocdCfg: { fileName: string; content: string } | null
}

/** 生成配置时用到的全部可调参数 */
export interface GenOptions {
  elfName: string
  device: string
  probeKey: ProbeKey
  interfaceCfg: string
  resetConfig: string
  targetCfg: string
  adapterSpeed: number
  openocdExe: string
  cmakeExe: string
  ninjaExe: string
  toolchainDir: string
  /** 相对工程根，例如 build/Debug */
  debugDir: string
  releaseDir: string
  debugPreset: string
  releasePreset: string
  hasBuildPresets: boolean
  configurePreset: string
  /** 相对工程根，例如 build/Debug/compile_commands.json */
  compileCommands: string
  svdFile: string
  generator: string
  /** IntelliSense 用的 include 路径（相对或绝对） */
  includeDirs: string[]
  defines: string[]
  cStandard: string
  cppStandard: string
}

// ==========================================================================
// 写入
// ==========================================================================

export interface FilePayload {
  /** 显示名，例如 launch.json */
  name: string
  /** 相对工程根的路径，例如 .vscode/launch.json */
  relativePath: string
  content: string
}

export interface PlanRequest {
  projectRoot: string
  files: FilePayload[]
}

export interface PlannedFile {
  name: string
  path: string
  relativePath: string
  content: string
  exists: boolean
  previous: string | null
}

export interface WriteRequest extends PlanRequest {
  backup: boolean
}

export interface WriteResult {
  written: string[]
  unchanged: string[]
  backups: string[]
  errors: string[]
  backupDir: string | null
  /** 本次写入前存下的快照 id，可用于还原；内容没有变化时为 null */
  snapshotId: string | null
}

/** 写入过程中的逐文件进度 */
export interface WriteProgress {
  relativePath: string
  name: string
  index: number
  total: number
  status: 'writing' | 'written' | 'unchanged' | 'error'
  message?: string
}

// ==========================================================================
// 快照 / 还原
// ==========================================================================

export interface SnapshotMeta {
  id: string
  projectRoot: string
  createdAt: number
  /** 快照记录了几个文件 */
  fileCount: number
  /** 其中写入前并不存在的（还原时会被删掉） */
  newFileCount: number
}

export interface RestoreResult {
  /** 还原回旧内容的文件 */
  restored: string[]
  /** 被删除的文件（写入前本来就不存在） */
  removed: string[]
  errors: string[]
}

/** 清除本工具写入的 .vscode 配置的结果 */
export interface ClearResult {
  deleted: string[]
  errors: string[]
  /** 清除前也存了快照，所以这一步同样可以撤销 */
  snapshotId: string | null
}

// ==========================================================================
// 模板 / 批量
// ==========================================================================

export interface BatchRequest {
  projectRoots: string[]
  templateId: string
  backup: boolean
}

export interface BatchItemResult {
  projectRoot: string
  ok: boolean
  message: string
  written: string[]
}

export interface BatchResult {
  templateId: string
  items: BatchItemResult[]
}

// ==========================================================================
// 运行（构建 / 烧录）
// ==========================================================================

export interface RunRequest {
  /** 给用户看的标题，例如「构建 Debug」 */
  title: string
  command: string
  args: string[]
  cwd: string
}

export interface RunStarted {
  runId: string
  title: string
  commandLine: string
}

export interface RunOutput {
  runId: string
  stream: 'stdout' | 'stderr' | 'system'
  text: string
}

export interface RunExit {
  runId: string
  code: number | null
  signal: string | null
  durationMs: number
}

/** 应用自身的版本与运行环境信息，「关于」里展示 */
export interface AppInfo {
  name: string
  version: string
  electron: string
  chrome: string
  node: string
  v8: string
  platform: string
  isPackaged: boolean
  userData: string
  /** 版本号来自哪个 package.json，排查「版本对不上」时有用 */
  packagePath: string
}

/** 模板管理的四份文件 */
export type TemplateFileKey = 'launch.json' | 'tasks.json' | 'settings.json' | 'c_cpp_properties.json'

export const TEMPLATE_FILE_KEYS: TemplateFileKey[] = [
  'launch.json',
  'tasks.json',
  'settings.json',
  'c_cpp_properties.json'
]

/**
 * 模板的**层级一：这套配置面向什么**。
 *
 * 这一层刻意做得「少而稳」：以后要支持 CLion / CMake 之外的构建系统，
 * 往联合类型里加成员即可，不用动下面两层。
 */
export interface TemplateTarget {
  /** 目标编辑器；目前只有 VSCode，留成联合类型方便以后扩 */
  editor: 'vscode'
  /** 构建系统怎么接：走 CMakePresets 还是直接给构建目录 */
  buildSystem: 'preset' | 'dir'
  /** 调试探针 —— 决定 interface/target 配置与烧录命令 */
  probe: ProbeKey
}

export interface ConfigTemplate {
  id: string
  name: string
  note: string
  createdAt: number
  updatedAt: number
  /** 内置模板：不可删除、不可覆盖 */
  builtin?: boolean

  /** 层级一：面向什么（编辑器 / 构建系统 / 探针） */
  target: TemplateTarget

  /**
   * 层级二：生成参数，只存「用户的选择」。
   * 固件名、芯片、构建目录这些从工程推导的字段留空，套用时按目标工程重算。
   */
  options: Partial<GenOptions>

  /**
   * 层级三：四份文件的内容。
   *
   * · 有值 = 按这份内容写（其中的 `${elfName}` 等占位符按目标工程替换）
   * · 没值 = 按 options 自动生成（老模板和内置模板走这条）
   */
  files?: Partial<Record<TemplateFileKey, string>>

  /** 旧版遗留字段：保存当时的完整生成结果，只用于「看 JSON」 */
  bundle?: ConfigBundle
}

/** 清理构建目录里的陈旧产物（本工具唯一会删工程内文件的操作） */
export interface CleanArtifactsResult {
  /** 真正删掉的文件（相对工程根） */
  removed: string[]
  errors: string[]
  freedBytes: number
}

// ==========================================================================
// 历史记录
// ==========================================================================

export type HistoryKind =
  | 'project-load'
  | 'write'
  | 'clear'
  | 'restore'
  | 'template-save'
  | 'template-delete'
  | 'template-apply'
  | 'batch'
  | 'run'

/** 历史条目上可以直接点的「再来一次」 */
export interface HistoryAction {
  kind:
    | 'reconfigure'
    | 'preview'
    | 'open-in-vscode'
    | 'open-in-explorer'
    | 'restore-snapshot'
    | 'open-template'
  label: string
  projectRoot?: string
  snapshotId?: string
  templateId?: string
}

export interface HistoryEntry {
  id: string
  at: number
  kind: HistoryKind
  title: string
  detail: string
  ok: boolean
  projectRoot?: string
  templateId?: string
  actions: HistoryAction[]
}

// ==========================================================================
// 应用设置
// ==========================================================================

export interface AppSettings {
  /** 'system' = 跟随操作系统的深浅色设置 */
  theme: 'dark' | 'light' | 'system'
  /** 用户手动指定的工具路径：ToolKey -> 绝对路径 */
  tools: Record<string, string>
  recentProjects: string[]
  lastProject: string | null
  /** 上次用的探针与烧录参数 */
  probeKey: ProbeKey
  adapterSpeed: number
  targetCfgOverride: string
  backupBeforeWrite: boolean
  autoDetectOnStart: boolean
  /** 首次启动的新手向导是否已经看过（跳过也算看过） */
  onboardingDone: boolean
  /** 界面上可拖动区域的宽度：'nav' / 'split' 等 → 像素 */
  uiWidths: Record<string, number>
}

export const DEFAULT_SETTINGS: AppSettings = {
  theme: 'system',
  tools: {},
  recentProjects: [],
  lastProject: null,
  probeKey: 'cmsis-dap',
  adapterSpeed: 1000,
  targetCfgOverride: '',
  backupBeforeWrite: false,
  autoDetectOnStart: true,
  onboardingDone: false,
  uiWidths: {}
}

// ==========================================================================
// IPC 通道名
// ==========================================================================

// --------------------------------------------------------------------------
// CMake 构建目标与源文件（「构建目标与源文件」页）
// --------------------------------------------------------------------------

export interface SourceTargetRow {
  name: string
  kind: string
  declaredLine: number
  declaredCommand: string
  sourceCount: number
  includeCount: number
  defineCount: number
  linkCount: number
  /** 用了 file(GLOB) 自动收集 —— 手动加文件是多余的 */
  usesGlob: boolean
}

export interface CmakeScanResult {
  root: string
  cmakeFile: string
  projectName: string | null
  targets: SourceTargetRow[]
  /** 根目标在构建里的源文件 */
  inBuild: string[]
  /** 磁盘上可编译、但整个工程都没引用到的 —— 「加入构建」的候选 */
  orphans: string[]
  /** 写了但磁盘上没有的 */
  missing: Array<{ relPath: string; raw: string; line: number }>
  stats: {
    compilableOnDisk: number
    headersOnDisk: number
    referencedProjectWide: number
    cmakeListsCount: number
  }
  diagnostics: string[]
  /** 展不开变量的条目（认不出是哪个文件），界面上灰着显示 */
  unresolved: Array<{ raw: string; line: number }>
}

export interface CmakeChangeRequest {
  root: string
  targetName: string
  add?: string[]
  remove?: string[]
}

export interface CmakeChangePreview {
  file: string
  relativePath: string
  before: string
  after: string
  notes: string[]
  added: string[]
  removed: string[]
  /** 用了「文件末尾托管区块」而不是就地插入 */
  usedFallback: boolean
  changed: boolean
}

export interface CmakeApplyResult {
  ok: boolean
  file: string
  added: string[]
  removed: string[]
  notes: string[]
  usedFallback: boolean
  snapshotId: string | null
  errors: string[]
}

export type NewFileKind = 'c' | 'h' | 'cpp' | 'task-c' | 'task-h'

export interface CreateSourceFileResult {
  ok: boolean
  relPath: string
  absPath: string
  error?: string
}
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

  templateList: 'template:list',
  templateSave: 'template:save',
  templateDelete: 'template:delete',
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
  /** 新建一个源码文件（骨架），不自动加入构建 */
  cmakeCreateFile(
    projectRoot: string,
    relPath: string,
    kind: NewFileKind
  ): Promise<CreateSourceFileResult>

  listTemplates(): Promise<ConfigTemplate[]>
  saveTemplate(template: ConfigTemplate): Promise<ConfigTemplate[]>
  deleteTemplate(id: string): Promise<ConfigTemplate[]>
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
