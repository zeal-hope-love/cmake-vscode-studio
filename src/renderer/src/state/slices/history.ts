/**
 * 写入历史。
 *
 * 从 `state/store.ts` 里切出来的一段；state 的初始值仍留在门面里 ——
 * 这样「有哪些字段」始终只在 store.ts 一处能看全。
 */

import type { StudioGet, StudioSet, StudioState } from '../storeTypes'

export function historySlice(
  set: StudioSet,
  get: StudioGet
): Pick<StudioState, 'refreshHistory' | 'removeHistoryEntry' | 'clearHistory'> {
  return {
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
    }
  }
}
