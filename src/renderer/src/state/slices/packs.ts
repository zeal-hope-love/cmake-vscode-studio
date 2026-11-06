/**
 * 模块包清单（左侧导航由它生成）。
 *
 * 从 `state/store.ts` 里切出来的一段；state 的初始值仍留在门面里 ——
 * 这样「有哪些字段」始终只在 store.ts 一处能看全。
 */

import type { StudioGet, StudioSet, StudioState } from '../storeTypes'

export function packsSlice(
  set: StudioSet,
  get: StudioGet
): Pick<StudioState, 'refreshPacks' | 'setActivePackId'> {
  return {
    refreshPacks: async () => {
      try {
        const packs = await window.api.packList()
        set({ packs })
        // 没选过就用第一个，保证「调试模块」这类单包场景点进去就有内容
        const { activePackId } = get()
        if (!activePackId && packs.length > 0) set({ activePackId: packs[0].id })
      } catch {
        /* 忽略：读不到包时导航只显示一个占位项 */
      }
    },

    setActivePackId: (id) => set({ activePackId: id })
  }
}
