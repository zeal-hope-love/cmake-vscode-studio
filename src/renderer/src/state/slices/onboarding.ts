/**
 * 新手向导、界面宽度、以及两个「清理」动作（都不是常规生成流程）。
 *
 * 从 `state/store.ts` 里切出来的一段；state 的初始值仍留在门面里 ——
 * 这样「有哪些字段」始终只在 store.ts 一处能看全。
 */

import type { StudioGet, StudioSet, StudioState } from '../storeTypes'

export function onboardingSlice(
  set: StudioSet,
  get: StudioGet
): Pick<StudioState, 'openHelp' | 'closeHelp' | 'completeOnboarding' | 'resetOnboarding' | 'setUiWidth' | 'clearVscodeConfig' | 'cleanArtifacts' | 'setPickerOpen'> {
  return {
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

    setPickerOpen: (open) => set({ pickerOpen: open })
  }
}
