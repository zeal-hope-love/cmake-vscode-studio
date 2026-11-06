/**
 * 全局状态的**形状**。
 *
 * 单独一个文件是为了让各个 slice 能 import 类型而不 import store 实例 ——
 * 否则 store.ts 与 slice 之间会形成运行时循环依赖。
 */

import type { StoreApi } from 'zustand'
import type {
  AppInfo,
  AppSettings,
  ConfigBundle,
  ConfigTemplate,
  GenOptions,
  HistoryEntry,
  PlannedFile,
  ProjectCandidate,
  ProjectInfo,
  SettingsFile,
  SnapshotMeta,
  ToolPaths,
  WriteProgress,
  WriteResult
} from '@shared/types'
import type { PackManifest } from '@shared/packTypes'
import type { DebugTargetKey } from '@shared/types'

export type PageKey =
  | 'project'
  | 'sources'
  | 'packs'
  | 'launch'
  | 'tasks'
  | 'settings'
  | 'cpp'
  | 'build'
  | 'inspect'
  | 'templates'
  | 'probe'
  | 'tools'
  | 'history'
  | 'about'

/**
 * 没选工程时，由外壳直接挡住、**不渲染页面**的那些页。
 *
 * 只列「自身没有空状态处理」的页面。任务 / 设置 / IntelliSense / 检查与清理
 * 自己都有更贴切的空状态，而且有的还带着**与工程无关的说明内容**
 * （比如任务页的「在 VSCode 里怎么用」）—— 在外壳一刀切拦掉，
 * 那些内容就永远看不到了。
 */

export type BundleSection = 'launch' | 'tasks' | 'settings' | 'cpp'

export interface Toast {
  id: number
  kind: 'ok' | 'warn' | 'err'
  text: string
}

export interface LogLine {
  id: number
  stream: 'stdout' | 'stderr' | 'system' | 'ok'
  text: string
}

export interface StudioState {
  // ---- 设置 ----
  settings: AppSettings
  /** 应用自身的版本与运行环境，「关于」里展示 */
  appInfo: AppInfo | null
  /**
   * 当前这套生成参数是从哪个模板来的。
   * null = 没用模板，就是按检测结果自动生成的默认参数。
   * 写入前的确认弹窗会把它显示出来，免得你不知道自己在写什么。
   */
  activeTemplate: { id: string; name: string } | null
  activeTemplateFiles: Record<string, string> | null

  // ---- 工程 ----
  projectRoot: string
  project: ProjectInfo | null
  tools: ToolPaths | null
  options: GenOptions | null
  bundle: ConfigBundle | null
  candidates: ProjectCandidate[]

  // ---- 界面 ----
  activePage: PageKey
  ready: boolean
  busy: boolean
  busyText: string
  errorText: string | null
  toasts: Toast[]
  logLines: LogLine[]
  activeRunId: string | null

  /** 哪些节被手工改过（改了之后再动生成参数需要用户确认重新生成） */
  manualSections: BundleSection[]
  /** 生成参数改过但还没重新生成 */
  optionsDirty: boolean

  // ---- 写入预览 ----
  planned: PlannedFile[]
  previewOpen: boolean

  /** 上一次写入的逐文件结果（写入完成后展示） */
  lastWriteResult: WriteResult | null
  /** 写入过程中的实时进度 */
  writeProgress: WriteProgress[]
  /** 当前工程的写入快照，可用于还原 */
  snapshots: SnapshotMeta[]

  /** 新手向导是否打开（首次启动自动开，之后从标题栏的「?」打开） */
  helpOpen: boolean
  /**
   * 本次会话里已经写入过配置的工程（小写路径）。
   *
   * 用集合而不是一个布尔值：之前是布尔，写完 A 工程再切到 B 工程时，
   * 三步引导条还是三个勾，非常误导。
   */
  writtenProjects: string[]

  // ---- 动作 ----
  bootstrap: () => Promise<void>
  setPage: (page: PageKey) => void
  setTheme: (theme: AppSettings['theme']) => Promise<void>
  /**
   * 保存任意设置项并同步到 store。
   *
   * 为什么要有这个：以前每个设置项都单独写一个方法（setTheme 之类），
   * 加一个开关就要动一次 store 的接口。这里统一成 patch 风格。
   */
  saveSettings: (patch: Partial<AppSettings>) => Promise<void>
  notify: (kind: Toast['kind'], text: string, ms?: number) => void
  dismissToast: (id: number) => void
  setError: (text: string | null) => void
  appendLog: (line: Omit<LogLine, 'id'>) => void
  clearLog: () => void

  refreshCandidates: () => Promise<void>
  browseProject: () => Promise<void>
  loadProject: (projectRoot: string, overrides?: Partial<GenOptions>) => Promise<void>
  refreshTools: (probeVersions?: boolean) => Promise<void>

  patchOptions: (patch: Partial<GenOptions>) => void
  /**
   * 改「生成哪几个调试配置」。
   *
   * 和 patchOptions 的**唯一也是关键的区别**：不动 activeTemplate。
   *
   * 为什么不能用 patchOptions：它会把 activeTemplate 清成 null（因为手动改参数
   * 就不再是「纯模板」了）。但调试器组合是**设置**（写进 settings.json，换工程
   * 也还在），和「用哪套模板」是两件彼此独立的事 —— 勾一下 ST-Link 就把下拉框
   * 里的模板名弹回「默认」，用户会以为自己刚选的模板失效了。
   */
  setDebugTargets: (targets: DebugTargetKey[]) => void
  regenerate: (force?: boolean) => Promise<void>

  /** 页面编辑 bundle 时调用；section 会被标记为已手动修改 */
  editBundle: <K extends BundleSection>(section: K, value: ConfigBundle[K]) => void
  editSettings: (settings: SettingsFile) => void
  editOpenocdCfg: (content: string) => void

  openPreview: () => Promise<void>
  closePreview: () => void
  writeNow: (backup: boolean) => Promise<WriteResult | null>

  refreshSnapshots: () => Promise<void>
  /** 重新检测当前工程（改名、还原之后用） */
  refreshProject: () => Promise<void>
  restoreSnapshot: (snapshotId: string) => Promise<void>
  bindWriteProgress: () => () => void

  openHelp: () => void
  closeHelp: () => void
  completeOnboarding: (neverShowAgain: boolean) => Promise<void>
  resetOnboarding: () => Promise<void>

  /** 保存可拖动区域的宽度（侧边栏、页面内的列表栏等） */
  setUiWidth: (key: string, width: number) => void

  /** 删除本工具写入的 .vscode 配置，回到「从没配置过」的样子 */
  clearVscodeConfig: () => Promise<void>
  /** 清理构建目录里的陈旧产物；主进程会逐个校验，返回真正删掉的 */
  cleanArtifacts: (relativePaths: string[]) => Promise<void>

  startRun: (title: string, command: string, args: string[], cwd: string) => Promise<void>
  cancelRun: () => Promise<void>
  bindRunEvents: () => () => void

  applyTemplateToCurrent: (template: ConfigTemplate) => Promise<void>
  /** 按 id 切换模板；传空串 = 回到「按本工程检测结果生成」 */
  switchTemplate: (templateId: string) => Promise<void>
  saveCurrentAsTemplate: (name: string, note: string) => Promise<void>
  saveTemplate: (template: ConfigTemplate) => Promise<ConfigTemplate[]>
  deleteTemplate: (id: string) => Promise<void>
  /** 复制一份可编辑的副本（内置模板改不了，先复制） */
  duplicateTemplate: (template: ConfigTemplate) => Promise<ConfigTemplate | null>
  refreshTemplates: () => Promise<void>
  templates: ConfigTemplate[]

  /**
   * 已安装的模块包清单。
   *
   * 提到 store 里是因为**左侧「扩展」组的导航项由它动态生成** ——
   * packs/ 目录下多一个包，导航里就多一行，不需要改代码。
   * PacksPage 也读同一份，避免两处各拉一次导致不一致。
   */
  packs: PackManifest[]
  refreshPacks: () => Promise<void>
  /** 点导航里的某个扩展时记录，PacksPage 打开后直接定位到它 */
  activePackId: string | null
  setActivePackId: (id: string | null) => void

  refreshHistory: () => Promise<void>
  removeHistoryEntry: (id: string) => Promise<void>
  clearHistory: () => Promise<void>
  history: HistoryEntry[]
  /** 历史页点「打开这个模板」时用：请求模板页打开某个模板的编辑器 */
  pendingTemplateId: string | null
  openTemplateInEditor: (templateId: string) => void
  consumePendingTemplate: () => void
  /**
   * 「工程总览」页上「选择工程」卡片是否展开。
   * 选了工程之后默认收起（只显示当前工程），点「换工程」再展开 ——
   * 这样常用状态下页面顶部不会被一整个选择器占满。
   */
  pickerOpen: boolean
  setPickerOpen: (open: boolean) => void
  /** 正在跑的命令标题，用于历史记录 */
  runTitle: string
}

/** zustand 的 setState / getState，slice 里只用到这两个 */
export type StudioSet = StoreApi<StudioState>['setState']
export type StudioGet = StoreApi<StudioState>['getState']
