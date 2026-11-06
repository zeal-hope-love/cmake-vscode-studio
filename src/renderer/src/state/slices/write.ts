/**
 * 预览与写入：把 bundle 摊平成文件、写盘、快照与还原。
 *
 * 从 `state/store.ts` 里切出来的一段；state 的初始值仍留在门面里 ——
 * 这样「有哪些字段」始终只在 store.ts 一处能看全。
 */

import type { WriteProgress } from '@shared/types'
import type { StudioGet, StudioSet, StudioState } from '../storeTypes'
import { bundleToPayloads, mergeTemplateFiles } from '../helpers'

export function writeSlice(
  set: StudioSet,
  get: StudioGet
): Pick<StudioState, 'openPreview' | 'closePreview' | 'writeNow' | 'refreshProject' | 'refreshSnapshots' | 'restoreSnapshot' | 'bindWriteProgress'> {
  return {
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
    // ------------------------------------------------------------------------,

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
    // ------------------------------------------------------------------------,

    refreshProject: async () => {
      const root = get().projectRoot
      if (!root) return
      const reloaded = await window.api.loadProject(root, get().options ?? undefined, false)
      set({ project: reloaded.project, tools: reloaded.tools })
    },

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
  }
}
