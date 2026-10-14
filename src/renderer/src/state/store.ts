/**
 * 全局状态仓库（zustand）。
 *
 * 数据流是单向的：
 *   载入工程 → project / tools / options / bundle
 *   改生成参数 → options →（无手动改动时）自动重新生成 bundle
 *   页面里的手工编辑 → 直接改 bundle，并标记该节为「已手动修改」
 *   写入 → bundle 摊平成文件 → 预览 → 落盘
 */

import { create } from 'zustand'
import { adaptTemplateOptions } from '@shared/templateAdapt'
import {
  findUnresolvedVariables,
  renderTemplateFiles,
  templateVarsFromOptions
} from '@shared/templateRender'
import {
  DEFAULT_SETTINGS,
  type AppInfo,
  type AppSettings,
  type ConfigBundle,
  type ConfigTemplate,
  type GenOptions,
  type HistoryEntry,
  type PlannedFile,
  type ProjectCandidate,
  type ProjectInfo,
  type RunExit,
  type RunOutput,
  type SettingsFile,
  type SnapshotMeta,
  type ToolPaths,
  type WriteProgress,
  type WriteResult
} from '@shared/types'

export type PageKey =
  | 'project'
  | 'launch'
  | 'tasks'
  | 'settings'
  | 'cpp'
  | 'build'
  | 'inspect'
  | 'templates'
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
export const PAGES_BLOCKED_WITHOUT_PROJECT: readonly PageKey[] = ['launch', 'build']

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

interface StudioState {
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
  regenerate: (force?: boolean) => Promise<void>

  /** 页面编辑 bundle 时调用；section 会被标记为已手动修改 */
  editBundle: <K extends BundleSection>(section: K, value: ConfigBundle[K]) => void
  editSettings: (settings: SettingsFile) => void
  editOpenocdCfg: (content: string) => void

  openPreview: () => Promise<void>
  closePreview: () => void
  writeNow: (backup: boolean) => Promise<WriteResult | null>

  refreshSnapshots: () => Promise<void>
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

let toastSeq = 1
let logSeq = 1

export const useStudio = create<StudioState>()((set, get) => ({
  settings: DEFAULT_SETTINGS,
  appInfo: null,
  activeTemplate: null,
  /**
   * 套用的模板自带了「四份文件内容」时，渲染好的结果放这儿。
   * 写入时它覆盖掉按参数生成的那几份 —— 见 openPreview / writeNow。
   */
  activeTemplateFiles: null,
  history: [],
  pendingTemplateId: null,
  pickerOpen: true,
  /** 正在跑的命令标题，用于历史记录 */
  runTitle: '',
  projectRoot: '',
  project: null,
  tools: null,
  options: null,
  bundle: null,
  candidates: [],
  templates: [],

  activePage: 'project',
  ready: false,
  busy: false,
  busyText: '',
  errorText: null,
  toasts: [],
  logLines: [],
  activeRunId: null,

  manualSections: [],
  optionsDirty: false,

  planned: [],
  previewOpen: false,

  lastWriteResult: null,
  writeProgress: [],
  snapshots: [],

  helpOpen: false,
  writtenProjects: [],

  // ------------------------------------------------------------------------
  // 基础
  // ------------------------------------------------------------------------

  bootstrap: async () => {
    try {
      const [settings, appInfo] = await Promise.all([window.api.getSettings(), window.api.getAppInfo()])
      set({ settings, appInfo, ready: true })
      applyThemeToDom(settings.theme)
      await window.api.setWindowTheme(settings.theme)

      // 选「跟随系统」时，系统在深浅色之间切换要立刻反映到界面上
      const media = window.matchMedia('(prefers-color-scheme: dark)')
      const onSystemThemeChange = (): void => {
        applyThemeToDom(get().settings.theme)
      }
      media.addEventListener('change', onSystemThemeChange)

      // 第一次启动先把新手向导顶上来，别让人对着八个页面发懵
      if (!settings.onboardingDone) set({ helpOpen: true })

      // 模板列表要在多处用到（模板页、写入确认弹窗的模板下拉），启动就拉一次
      void get().refreshTemplates()
      void get().refreshHistory()

      // 故意不自动载入上次的工程。
      // 自动载入会让「三步引导」一打开就停在第三步（工程已就绪、就等写入），
      // 但用户其实什么都没做，看着很困惑。现在一打开停在第一步，
      // 上次的工程以「继续上次」的按钮形式放在工程路径输入框旁边，点一下就行。
    } catch (err) {
      set({ ready: true, errorText: err instanceof Error ? err.message : String(err) })
    }
  },

  setPage: (page) => set({ activePage: page }),

  setTheme: async (theme) => {
    applyThemeToDom(theme)
    const settings = await window.api.saveSettings({ theme })
    set({ settings })
    // 主进程负责标题栏覆盖层与窗口背景色（「跟随系统」由它去问操作系统）
    await window.api.setWindowTheme(theme)
  },

  notify: (kind, text, ms = 3200) => {
    const id = toastSeq++
    set((s) => ({ toasts: [...s.toasts, { id, kind, text }] }))
    window.setTimeout(() => get().dismissToast(id), ms)
  },

  dismissToast: (id) => set((s) => ({ toasts: s.toasts.filter((t) => t.id !== id) })),

  setError: (text) => set({ errorText: text }),

  appendLog: (line) =>
    set((s) => {
      const next = [...s.logLines, { ...line, id: logSeq++ }]
      // 日志最多保留 4000 行，防止长时间构建把内存吃满
      return { logLines: next.length > 4000 ? next.slice(next.length - 4000) : next }
    }),

  clearLog: () => set({ logLines: [] }),

  // ------------------------------------------------------------------------
  // 工程
  // ------------------------------------------------------------------------

  refreshCandidates: async () => {
    try {
      const candidates = await window.api.discoverProjects()
      set({ candidates })
    } catch (err) {
      get().notify('err', `扫描 VSCode 工程失败：${err instanceof Error ? err.message : err}`)
    }
  },

  browseProject: async () => {
    const picked = await window.api.pickDirectory(get().projectRoot || undefined)
    if (!picked) return
    await get().loadProject(picked)
  },

  loadProject: async (projectRoot, overrides) => {
    if (!projectRoot.trim()) return
    set({ busy: true, busyText: '正在检测工程…', errorText: null })

    try {
      const result = await window.api.loadProject(projectRoot, overrides, false)
      set({
        projectRoot: result.project.root,
        project: result.project,
        tools: result.tools,
        options: result.options,
        bundle: result.bundle,
        manualSections: [],
        optionsDirty: false,
        // 重新检测/换工程后就回到「按检测结果生成」，不再挂着旧模板的名字。
        // （套用模板时会在这之后再把 activeTemplate 设回去）
        activeTemplate: null,
        activeTemplateFiles: null,
        // 换了工程，上一次的写入结果/进度/快照都不该继续显示
        lastWriteResult: null,
        writeProgress: [],
        snapshots: [],
        busy: false,
        busyText: '',
        errorText: null
      })

      const settings = await window.api.getSettings()
      set({ settings })

      if (result.project.warnings.length) {
        get().notify('warn', `检测到 ${result.project.warnings.length} 条需要注意的地方`)
      } else {
        get().notify('ok', `已载入工程：${result.project.name}`)
      }

      void get().refreshTemplates()
      void get().refreshSnapshots()

      // 只有「单纯检测工程」才记历史；套用模板传了 overrides，那条会单独记成模板套用
      if (!overrides || Object.keys(overrides).length === 0) {
        void window.api
          .addHistory({
            kind: 'project-load',
            title: `检测工程 ${result.project.name}`,
            detail: result.project.warnings.length
              ? `发现 ${result.project.warnings.length} 条需要注意的问题`
              : '没有发现问题',
            ok: true,
            projectRoot: result.project.root,
            actions: [
              { kind: 'reconfigure', label: '重新配置这个工程', projectRoot: result.project.root },
              { kind: 'open-in-vscode', label: '在 VSCode 打开', projectRoot: result.project.root },
              { kind: 'open-in-explorer', label: '打开目录', projectRoot: result.project.root }
            ]
          })
          .then(() => get().refreshHistory())
          .catch(() => undefined)
      }
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err)
      set({ busy: false, busyText: '', errorText: message })
      get().notify('err', `载入失败：${message}`)
    }
  },

  refreshTools: async (probeVersions = false) => {
    set({ busy: true, busyText: probeVersions ? '正在探测工具版本…' : '正在探测工具…' })
    try {
      const tools = await window.api.detectTools({ probeVersions })
      set({ tools, busy: false, busyText: '' })
      get().notify('ok', probeVersions ? '已重新探测（含版本）' : '已重新探测工具路径')
    } catch (err) {
      set({ busy: false, busyText: '' })
      get().notify('err', `探测失败：${err instanceof Error ? err.message : err}`)
    }
  },

  // ------------------------------------------------------------------------
  // 参数 → 重新生成
  // ------------------------------------------------------------------------

  patchOptions: (patch) => {
    const options = get().options
    if (!options) return

    // 手动改了参数就不再是「纯模板」了，确认弹窗里要如实说
    set({ options: { ...options, ...patch }, optionsDirty: true, activeTemplate: null })

    // 没有手工改过任何一节时，直接静默重算，保持界面与参数一致
    if (get().manualSections.length === 0) {
      void get().regenerate(false)
    }
  },

  regenerate: async (force = true) => {
    const { projectRoot, options, manualSections } = get()
    if (!projectRoot || !options) return

    if (!force && manualSections.length > 0) {
      set({ optionsDirty: true })
      return
    }

    try {
      const bundle = await window.api.generateBundle(projectRoot, options)
      set({
        bundle,
        optionsDirty: false,
        manualSections: force && manualSections.length ? [] : manualSections
      })
      if (force) get().notify('ok', '已按当前参数重新生成配置')
    } catch (err) {
      get().notify('err', `重新生成失败：${err instanceof Error ? err.message : err}`)
    }
  },

  // ------------------------------------------------------------------------
  // 页面编辑
  // ------------------------------------------------------------------------

  editBundle: (section, value) => {
    const bundle = get().bundle
    if (!bundle) return
    const manualSections = get().manualSections.includes(section)
      ? get().manualSections
      : [...get().manualSections, section]
    set({ bundle: { ...bundle, [section]: value } as ConfigBundle, manualSections })
  },

  editSettings: (settings) => get().editBundle('settings', settings),

  editOpenocdCfg: (content) => {
    const bundle = get().bundle
    if (!bundle?.openocdCfg) return
    set({ bundle: { ...bundle, openocdCfg: { ...bundle.openocdCfg, content } } })
  },

  // ------------------------------------------------------------------------
  // 预览 / 写入
  // ------------------------------------------------------------------------

  openPreview: async () => {
    const { bundle, projectRoot, activeTemplateFiles } = get()
    if (!bundle || !projectRoot) return

    try {
      const files = mergeTemplateFiles(bundleToPayloads(bundle), activeTemplateFiles)
      const planned = await window.api.planFiles({ projectRoot, files })
      set({ planned, previewOpen: true })
    } catch (err) {
      get().notify('err', `生成预览失败：${err instanceof Error ? err.message : err}`)
    }
  },

  closePreview: () => set({ previewOpen: false }),

  // ------------------------------------------------------------------------
  // 新手向导
  // ------------------------------------------------------------------------

  openHelp: () => set({ helpOpen: true }),
  closeHelp: () => set({ helpOpen: false }),

  completeOnboarding: async (neverShowAgain) => {
    if (!neverShowAgain) return
    try {
      const settings = await window.api.saveSettings({ onboardingDone: true })
      set({ settings })
    } catch {
      /* 存不上不影响使用 */
    }
  },

  resetOnboarding: async () => {
    const settings = await window.api.saveSettings({ onboardingDone: false })
    set({ settings, helpOpen: true })
  },

  setUiWidth: (key, width) => {
    const current = get().settings
    const uiWidths = { ...current.uiWidths, [key]: Math.round(width) }
    set({ settings: { ...current, uiWidths } })
    // 拖动过程中每帧都存盘太浪费，交给调用方在松手时同步
    void window.api.saveSettings({ uiWidths })
  },

  /**
   * 清除本工具写进工程的 .vscode 配置。
   * 主进程会先存快照，所以误点也能从「备份与还原」里恢复。
   */
  clearVscodeConfig: async () => {
    const { projectRoot } = get()
    if (!projectRoot) return
    set({ busy: true, busyText: '正在清除配置…' })
    try {
      const result = await window.api.clearVscodeConfig(projectRoot)
      set({ busy: false, busyText: '' })

      if (result.errors.length) {
        get().notify('err', `有 ${result.errors.length} 个文件删不掉`)
        set({ errorText: result.errors.join('\n') })
      } else if (result.deleted.length === 0) {
        get().notify('ok', '工程里没有本工具写入的配置，无需清除')
      } else {
        get().notify('ok', `已清除 ${result.deleted.length} 个配置文件，工程回到未配置状态`)
      }

      const reloaded = await window.api.loadProject(projectRoot, get().options ?? undefined, false)
      set({
        project: reloaded.project,
        tools: reloaded.tools,
        manualSections: [],
        optionsDirty: false,
        writtenProjects: get().writtenProjects.filter((p) => p !== projectRoot.toLowerCase())
      })
      void get().refreshSnapshots()
    } catch (err) {
      set({ busy: false, busyText: '' })
      get().notify('err', `清除失败：${err instanceof Error ? err.message : err}`)
    }
  },

  /**
   * 清理构建目录里的陈旧产物。
   *
   * 这是本工具唯一会删工程内文件的操作，所以**删完立刻重新检测** ——
   * 让警告消失、产物列表刷新，用户能马上看到效果。主进程还会记一条历史。
   */
  cleanArtifacts: async (relativePaths) => {
    const { projectRoot } = get()
    if (!projectRoot || !relativePaths.length) return

    set({ busy: true, busyText: '正在清理陈旧产物…' })
    try {
      const result = await window.api.cleanArtifacts(projectRoot, relativePaths)
      set({ busy: false, busyText: '' })

      if (result.errors.length) {
        get().notify('err', `有 ${result.errors.length} 个文件没删掉`)
        set({ errorText: result.errors.join('\n') })
      } else {
        get().notify(
          'ok',
          `已清理 ${result.removed.length} 个陈旧产物，释放 ${(result.freedBytes / 1024).toFixed(0)} KB`
        )
      }

      await get().loadProject(projectRoot, get().options ?? undefined)
      void get().refreshHistory()
    } catch (err) {
      set({ busy: false, busyText: '' })
      get().notify('err', `清理失败：${err instanceof Error ? err.message : err}`)
    }
  },

  writeNow: async (backup) => {
    const { bundle, projectRoot, activeTemplateFiles } = get()
    if (!bundle || !projectRoot) return null

    set({ busy: true, busyText: '正在写入配置…', writeProgress: [], lastWriteResult: null })
    try {
      const files = mergeTemplateFiles(bundleToPayloads(bundle), activeTemplateFiles)
      const result = await window.api.writeFiles({ projectRoot, files, backup })

      const key = projectRoot.toLowerCase()
      const writtenProjects = get().writtenProjects.includes(key)
        ? get().writtenProjects
        : [...get().writtenProjects, key]

      set({
        busy: false,
        busyText: '',
        lastWriteResult: result,
        writtenProjects
      })

      if (result.errors.length) {
        get().notify('err', `有 ${result.errors.length} 个文件写入失败`)
        set({ errorText: result.errors.join('\n') })
      } else if (result.written.length === 0) {
        get().notify('ok', '所有文件内容都已是最新，无需改动')
      } else {
        get().notify(
          'ok',
          `已写入 ${result.written.length} 个文件${result.backups.length ? `（备份 ${result.backups.length} 个）` : ''}`
        )
      }

      // 写完重新检测一次，让「.vscode 现状」立刻反映真实情况
      const reloaded = await window.api.loadProject(projectRoot, get().options ?? undefined, false)
      set({
        project: reloaded.project,
        tools: reloaded.tools,
        manualSections: [],
        optionsDirty: false
      })

      void get().refreshSnapshots()
      return result
    } catch (err) {
      set({ busy: false, busyText: '' })
      get().notify('err', `写入失败：${err instanceof Error ? err.message : err}`)
      return null
    }
  },

  // ------------------------------------------------------------------------
  // 快照 / 还原
  // ------------------------------------------------------------------------

  refreshSnapshots: async () => {
    const { projectRoot } = get()
    if (!projectRoot) {
      set({ snapshots: [] })
      return
    }
    try {
      set({ snapshots: await window.api.listSnapshots(projectRoot) })
    } catch {
      set({ snapshots: [] })
    }
  },

  restoreSnapshot: async (snapshotId) => {
    const { projectRoot } = get()
    if (!projectRoot) return

    set({ busy: true, busyText: '正在还原…' })
    try {
      const result = await window.api.restoreSnapshot(projectRoot, snapshotId)
      set({ busy: false, busyText: '' })

      if (result.errors.length) {
        get().notify(
          'err',
          `还原有 ${result.errors.length} 个问题，已还原 ${result.restored.length} 个文件`
        )
        set({ errorText: result.errors.join('\n') })
      } else {
        const bits: string[] = []
        if (result.restored.length) bits.push(`还原 ${result.restored.length} 个文件`)
        if (result.removed.length) bits.push(`删除 ${result.removed.length} 个（写入前并不存在）`)
        get().notify('ok', bits.length ? `已还原：${bits.join('，')}` : '文件已是还原后的状态')
      }

      // 还原后重新检测 + 刷新快照列表 + 把该工程从「已写入」里摘掉
      const reloaded = await window.api.loadProject(projectRoot, get().options ?? undefined, false)
      set({
        project: reloaded.project,
        tools: reloaded.tools,
        manualSections: [],
        optionsDirty: false,
        writtenProjects: get().writtenProjects.filter((p) => p !== projectRoot.toLowerCase())
      })
      void get().refreshSnapshots()
    } catch (err) {
      set({ busy: false, busyText: '' })
      get().notify('err', `还原失败：${err instanceof Error ? err.message : err}`)
    }
  },

  bindWriteProgress: () =>
    window.api.onWriteProgress((progress: WriteProgress) => {
      set((s) => {
        const rest = s.writeProgress.filter((p) => p.relativePath !== progress.relativePath)
        return { writeProgress: [...rest, progress] }
      })
    }),

  // ------------------------------------------------------------------------
  // 运行
  // ------------------------------------------------------------------------

  startRun: async (title, command, args, cwd) => {
    try {
      const started = await window.api.startRun({ title, command, args, cwd })
      // 记住标题，命令结束时记历史用得上
      set({ activeRunId: started.runId, runTitle: title })
    } catch (err) {
      get().notify('err', `无法启动：${err instanceof Error ? err.message : err}`)
    }
  },

  cancelRun: async () => {
    const runId = get().activeRunId
    if (!runId) return
    await window.api.cancelRun(runId)
  },

  bindRunEvents: () => {
    const offOutput = window.api.onRunOutput((payload: RunOutput) => {
      get().appendLog({ stream: payload.stream, text: payload.text })
    })
    const offExit = window.api.onRunExit((payload: RunExit) => {
      const ok = payload.code === 0
      get().appendLog({
        stream: ok ? 'ok' : 'stderr',
        text: `\n[结束] 退出码 ${payload.code ?? 'null'}，耗时 ${(payload.durationMs / 1000).toFixed(1)}s\n`
      })
      set({ activeRunId: null })
      get().notify(ok ? 'ok' : 'err', ok ? '命令执行完成' : `命令失败（退出码 ${payload.code}）`)

      // 构建 / 烧录也记一条，历史页上能直接回到那个工程
      const { projectRoot } = get()
      if (projectRoot) {
        void window.api
          .addHistory({
            kind: 'run',
            title: `${get().runTitle || '执行命令'}${ok ? ' 成功' : ' 失败'}`,
            detail: `退出码 ${payload.code ?? 'null'}，耗时 ${(payload.durationMs / 1000).toFixed(1)}s`,
            ok,
            projectRoot,
            actions: [
              { kind: 'reconfigure', label: '重新配置这个工程', projectRoot },
              { kind: 'open-in-vscode', label: '在 VSCode 打开', projectRoot },
              { kind: 'open-in-explorer', label: '打开目录', projectRoot }
            ]
          })
          .then(() => get().refreshHistory())
          .catch(() => undefined)
      }
    })
    return () => {
      offOutput()
      offExit()
    }
  },

  // ------------------------------------------------------------------------
  // 模板
  // ------------------------------------------------------------------------

  refreshTemplates: async () => {
    try {
      set({ templates: await window.api.listTemplates() })
    } catch {
      /* 忽略 */
    }
  },

  /**
   * 把模板套用到当前工程。
   *
   * 模板分三层，套用时的处理各不相同：
   *   · target.probe      → 并进生成参数
   *   · options           → 只沿用「用户的选择」，工程相关的按目标工程重算
   *   · files             → 用占位符渲染成可直接写的内容，覆盖掉自动生成的那几份
   */
  applyTemplateToCurrent: async (template) => {
    const { projectRoot, options } = get()
    if (!projectRoot || !options) {
      get().notify('warn', '请先载入一个工程')
      return
    }

    const adapted = adaptTemplateOptions(
      { ...template.options, probeKey: template.target.probe },
      options
    )
    await get().loadProject(projectRoot, adapted)

    // 渲染必须在 loadProject 之后：占位符要填的是**目标工程**的值
    const next = get().options
    const files =
      template.files && next
        ? renderTemplateFiles(template.files, templateVarsFromOptions(next, projectRoot))
        : null

    set({ activeTemplate: { id: template.id, name: template.name }, activeTemplateFiles: files })

    const missing = files
      ? [
          ...new Set(
            Object.values(template.files ?? {}).flatMap((text) =>
              findUnresolvedVariables(text, templateVarsFromOptions(next!, projectRoot))
            )
          )
        ]
      : []
    if (missing.length) {
      get().notify('warn', `模板里有没解析的占位符：${missing.map((m) => '${' + m + '}').join('、')}`)
    } else {
      get().notify('ok', `已套用模板「${template.name}」`)
    }

    void window.api
      .addHistory({
        kind: 'template-apply',
        title: `套用模板「${template.name}」`,
        detail: files ? '四份文件按模板内容替换（占位符已按本工程填充）' : '生成参数已按本工程重新推导',
        ok: true,
        projectRoot,
        templateId: template.id,
        actions: [
          { kind: 'preview', label: '预览差异', projectRoot },
          { kind: 'reconfigure', label: '重新配置这个工程', projectRoot },
          { kind: 'open-template', label: '打开这个模板', templateId: template.id }
        ]
      })
      .then(() => get().refreshHistory())
      .catch(() => undefined)
  },

  /**
   * 按 id 切换模板。
   *
   * 空串 = 「默认：按本工程的检测结果生成」，也就是不带任何模板覆盖重新检测一遍。
   * 切换后如果预览弹窗正开着，顺手把差异重算一遍 —— 否则显示的还是换之前的。
   */
  switchTemplate: async (templateId) => {
    const { projectRoot, project, templates, previewOpen } = get()
    if (!projectRoot) return

    if (!templateId) {
      if (project) await get().loadProject(project.root)
      set({ activeTemplate: null, activeTemplateFiles: null })
    } else {
      const template = templates.find((t) => t.id === templateId)
      if (!template) return
      await get().applyTemplateToCurrent(template)
    }

    if (previewOpen) await get().openPreview()
  },

  saveCurrentAsTemplate: async (name, note) => {
    const { bundle, options, project } = get()
    if (!bundle || !options) {
      get().notify('warn', '请先载入工程')
      return
    }
    const now = Date.now()
    const templates = await window.api.saveTemplate({
      id: '',
      name,
      note,
      createdAt: now,
      updatedAt: now,
      target: {
        editor: 'vscode',
        buildSystem: project?.presets.length ? 'preset' : 'dir',
        probe: options.probeKey
      },
      options,
      bundle
    })
    set({ templates })
    get().notify('ok', `模板「${name}」已保存`)
  },

  saveTemplate: async (template) => {
    const templates = await window.api.saveTemplate(template)
    set({ templates })
    void get().refreshHistory()
    return templates
  },

  deleteTemplate: async (id) => {
    const templates = await window.api.deleteTemplate(id)
    set({ templates })
    void get().refreshHistory()
  },

  duplicateTemplate: async (template) => {
    const now = Date.now()
    const copy: ConfigTemplate = {
      ...template,
      id: '',
      name: `${template.name} 副本`,
      createdAt: now,
      updatedAt: now,
      builtin: false
    }
    const templates = await window.api.saveTemplate(copy)
    set({ templates })
    void get().refreshHistory()
    const created =
      templates.find((t) => t.name === copy.name) ??
      [...templates].filter((t) => !t.builtin).sort((a, b) => b.updatedAt - a.updatedAt)[0] ??
      null
    get().notify('ok', `已复制为「${copy.name}」`)
    return created
  },

  // ------------------------------------------------------------------------
  // 历史记录
  // ------------------------------------------------------------------------

  refreshHistory: async () => {
    try {
      set({ history: await window.api.listHistory() })
    } catch {
      /* 忽略 */
    }
  },

  removeHistoryEntry: async (id) => {
    set({ history: await window.api.removeHistory(id) })
  },

  clearHistory: async () => {
    set({ history: await window.api.clearHistory() })
    get().notify('ok', '历史记录已清空')
  },

  openTemplateInEditor: (templateId) => set({ pendingTemplateId: templateId }),

  consumePendingTemplate: () => set({ pendingTemplateId: null }),

  setPickerOpen: (open) => set({ pickerOpen: open })
}))

// --------------------------------------------------------------------------
// bundle → 待写文件
// --------------------------------------------------------------------------

export function bundleToPayloads(bundle: ConfigBundle): Array<{
  name: string
  relativePath: string
  content: string
}> {
  const stringify = (value: unknown): string => JSON.stringify(value, null, 4) + '\n'

  const files = [
    { name: 'launch.json', relativePath: '.vscode/launch.json', content: stringify(bundle.launch) },
    { name: 'tasks.json', relativePath: '.vscode/tasks.json', content: stringify(bundle.tasks) },
    {
      name: 'settings.json',
      relativePath: '.vscode/settings.json',
      content: stringify(bundle.settings)
    },
    {
      name: 'c_cpp_properties.json',
      relativePath: '.vscode/c_cpp_properties.json',
      content: stringify(bundle.cpp)
    }
  ]

  if (bundle.openocdCfg) {
    files.push({
      name: bundle.openocdCfg.fileName,
      relativePath: `.vscode/${bundle.openocdCfg.fileName}`,
      content: bundle.openocdCfg.content
    })
  }

  return files
}

/**
 * 模板自带的文件内容覆盖掉「按参数生成」的那几份。
 *
 * 只覆盖模板真的提供了内容的那几个文件，其余（比如 openocd-*.cfg）仍按目标工程生成。
 */
function mergeTemplateFiles(
  generated: Array<{ name: string; relativePath: string; content: string }>,
  overrides: Record<string, string> | null
): Array<{ name: string; relativePath: string; content: string }> {
  if (!overrides) return generated
  const merged = generated.map((f) =>
    overrides[f.relativePath] !== undefined ? { ...f, content: overrides[f.relativePath] } : f
  )
  // 模板里有、但按参数生成时没有的文件也补上
  for (const [relativePath, content] of Object.entries(overrides)) {
    if (!merged.some((f) => f.relativePath === relativePath)) {
      merged.push({ name: relativePath.replace(/^\.vscode\//, ''), relativePath, content })
    }
  }
  return merged
}

/**
 * 把主题落到 DOM 上。
 *
 * 主进程会设 `nativeTheme.themeSource`，所以选「跟随系统」时
 * `prefers-color-scheme` 已经等于系统当前的值，这里直接读就行。
 */
export function applyThemeToDom(theme: AppSettings['theme']): void {
  const resolved =
    theme === 'system'
      ? window.matchMedia('(prefers-color-scheme: dark)').matches
        ? 'dark'
        : 'light'
      : theme
  document.documentElement.dataset.theme = resolved
}

/** 当前主题实际显示成什么（「关于」和状态栏里展示用） */
export function themeLabel(theme: AppSettings['theme']): string {
  if (theme === 'system') {
    const dark = window.matchMedia('(prefers-color-scheme: dark)').matches
    return `跟随系统（当前${dark ? '深色' : '浅色'}）`
  }
  return theme === 'dark' ? '深色' : '浅色'
}

export function plannedFileText(file: PlannedFile): string {
  return file.content
}

/**
 * 与键顺序无关的 JSON 序列化。
 *
 * 用来判断「磁盘上的文件」和「将要生成的内容」是否一致 ——
 * 直接 JSON.stringify 会受属性顺序影响（重新解析过的对象顺序和生成时不一定相同）。
 */
export function canonicalJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(',')}]`
  if (value && typeof value === 'object') {
    const obj = value as Record<string, unknown>
    return `{${Object.keys(obj)
      .sort()
      .map((k) => `${JSON.stringify(k)}:${canonicalJson(obj[k])}`)
      .join(',')}}`
  }
  return JSON.stringify(value) ?? 'null'
}

/**
 * 当前工程是否已经写入过配置。
 *
 * 判据是**内容一致**而不是「配置名在不在」：只比名字的话，一个指向错误 ELF
 * （比如工程改名前的残留）的旧 launch.json 会被误判成「已完成」，反而误导人。
 *
 * 按工程分别判断也是必须的 —— 写完 A 再切到 B 时，三步引导条必须跟着重置。
 */
export function useProjectWritten(): boolean {
  return useStudio((s) => {
    if (!s.project || !s.bundle) return false
    if (s.writtenProjects.includes(s.project.root.toLowerCase())) return true

    const onDisk = s.project.vscodeFiles['launch.json']?.data
    if (!onDisk) return false
    return canonicalJson(onDisk) === canonicalJson(s.bundle.launch)
  })
}
