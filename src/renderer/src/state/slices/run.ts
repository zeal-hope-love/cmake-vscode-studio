/**
 * 跑外部命令（构建 / 烧录 / 调试器）并接它的输出。
 *
 * 从 `state/store.ts` 里切出来的一段；state 的初始值仍留在门面里 ——
 * 这样「有哪些字段」始终只在 store.ts 一处能看全。
 */

import type { RunExit, RunOutput } from '@shared/types'
import type { StudioGet, StudioSet, StudioState } from '../storeTypes'

export function runSlice(
  set: StudioSet,
  get: StudioGet
): Pick<StudioState, 'startRun' | 'cancelRun' | 'bindRunEvents'> {
  return {
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
  }
}
