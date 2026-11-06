/**
 * 基础：启动、切页、主题、提示、日志。几乎没有业务，其他 slice 都依赖它的 notify。
 *
 * 从 `state/store.ts` 里切出来的一段；state 的初始值仍留在门面里 ——
 * 这样「有哪些字段」始终只在 store.ts 一处能看全。
 */

import type { StudioGet, StudioSet, StudioState } from '../storeTypes'
import { applyThemeToDom } from '../helpers'

// 提示 / 日志的自增序号。原本是 store.ts 的模块级变量，
// 只有这两个动作在用，所以跟着一起搬过来。
let toastSeq = 1
let logSeq = 1

export function coreSlice(
  set: StudioSet,
  get: StudioGet
): Pick<
  StudioState,
  | 'bootstrap'
  | 'setPage'
  | 'focusUpdate'
  | 'setTheme'
  | 'saveSettings'
  | 'notify'
  | 'dismissToast'
  | 'setError'
  | 'appendLog'
  | 'clearLog'
> {
  return {
    bootstrap: async () => {
      try {
        const [settings, appInfo] = await Promise.all([
          window.api.getSettings(),
          window.api.getAppInfo()
        ])
        set({ settings, appInfo, ready: true })
        applyThemeToDom(settings.theme)
        // 只影响标题栏配色，写盘失败也不该阻断启动 —— 吞掉错误，
        // 真正需要用户知道的是「设置没保存成功」，那是 setTheme 那边的事。
        try {
          await window.api.setWindowTheme(settings.theme)
        } catch {
          /* 忽略：主题没写进去不影响使用 */
        }

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
        // 模块包：左侧「扩展」组的导航项由它生成，必须启动就拉到
        void get().refreshPacks()

        // 故意不自动载入上次的工程。
        // 自动载入会让「三步引导」一打开就停在第三步（工程已就绪、就等写入），
        // 但用户其实什么都没做，看着很困惑。现在一打开停在第一步，
        // 上次的工程以「继续上次」的按钮形式放在工程路径输入框旁边，点一下就行。
      } catch (err) {
        set({ ready: true, errorText: err instanceof Error ? err.message : String(err) })
      }
    },

    setPage: (page) => set({ activePage: page }),

    /*
     * 顶部「有新版本」横幅的「查看更新」走这里。
     *
     * 以前是直接 shell.openExternal 打开 GitHub 发布页 —— 用户被扔到浏览器里，
     * 还得自己分辨哪个是安装包、下完再回来手动运行。现在统一落到「关于与版本」页，
     * 那一页本来就有带真实进度的应用内下载（下完直接启动安装器）。
     *
     * 序号自增是为了让 AboutPage 的副作用每次都触发：连点两次也能重新滚回去。
     */
    focusUpdate: () => set((s) => ({ activePage: 'about', updateFocusSeq: s.updateFocusSeq + 1 })),

    setTheme: async (theme) => {
      // 先把界面换掉 —— 这一步不依赖磁盘，永远会成功。
      // 万一后面写盘失败，用户至少看到主题已经变了，而不是「点了没反应还报错」。
      applyThemeToDom(theme)
      try {
        const settings = await window.api.saveSettings({ theme })
        set({ settings })
        // 主进程负责标题栏覆盖层与窗口背景色（「跟随系统」由它去问操作系统）
        await window.api.setWindowTheme(theme)
      } catch (err) {
        get().notify(
          'err',
          `主题已切换，但没能保存到设置文件：${err instanceof Error ? err.message : String(err)}`
        )
      }
    },

    saveSettings: async (patch) => {
      try {
        const settings = await window.api.saveSettings(patch)
        set({ settings })
      } catch (err) {
        get().notify('err', `设置没保存成功：${err instanceof Error ? err.message : String(err)}`)
      }
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

    clearLog: () => set({ logLines: [] })

    // ------------------------------------------------------------------------
    // 工程
    // ------------------------------------------------------------------------
  }
}
