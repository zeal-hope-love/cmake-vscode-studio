/**
 * 工程与参数：选工程、探测工具链、改生成参数、页面里手改 bundle。
 *
 * 从 `state/store.ts` 里切出来的一段；state 的初始值仍留在门面里 ——
 * 这样「有哪些字段」始终只在 store.ts 一处能看全。
 */

import type { ConfigBundle } from '@shared/types'
import { normalizeDebugTargets } from '@shared/debugTargets'
import type { StudioGet, StudioSet, StudioState } from '../storeTypes'

export function projectSlice(
  set: StudioSet,
  get: StudioGet
): Pick<StudioState, 'refreshCandidates' | 'browseProject' | 'loadProject' | 'refreshTools' | 'patchOptions' | 'setDebugTargets' | 'regenerate' | 'editBundle' | 'editSettings' | 'editOpenocdCfg'> {
  return {
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
    // ------------------------------------------------------------------------,

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

    setDebugTargets: (targets) => {
      const options = get().options
      if (!options) return

      const next = normalizeDebugTargets(targets)
      // 刻意不碰 activeTemplate：见接口处的注释
      set({ options: { ...options, debugTargets: next } })

      if (get().manualSections.length === 0) {
        void get().regenerate(false)
      } else {
        set({ optionsDirty: true })
      }

      // 写进设置 —— 这样换工程、重开应用都还带着这个组合
      void get().saveSettings({ debugTargets: next })
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
    // ------------------------------------------------------------------------,

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
  }
}
