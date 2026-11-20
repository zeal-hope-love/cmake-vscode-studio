/**
 * 更新状态镜像 + 动作。
 *
 * 状态的**所有权在主进程**（services/update/updateService.ts）：它负责查 GitHub、
 * 后台下载、记「下好了没」。这里只做两件事：订阅推送、把用户点击转回去。
 *
 * 为什么要过一道 store 而不是让每个组件各自订阅：标题栏芯片、设置页的更新区块
 * 要显示同一份东西。各自订阅虽然也行，但组件重挂载时会漏掉订阅窗口期的推送，
 * 两处显示就会短暂不一致（比如芯片显示 100%、设置页还在 42%）。
 */

import type { StudioGet, StudioSet, StudioState } from '../storeTypes'
import type { UpdateState } from '@shared/updateTypes'

/**
 * 上一帧的阶段。
 *
 * 用来识别「刚刚下载完」这一个瞬间 —— 只对比阶段变化，不去改主进程的状态。
 * 放模块级而不是 state 里：界面不需要读它，写了反而多一个字段要维护。
 */
let lastPhase: UpdateState['phase'] | null = null

export function updateSlice(
  set: StudioSet,
  get: StudioGet
): Pick<
  StudioState,
  | 'bindUpdateState'
  | 'checkUpdateNow'
  | 'downloadUpdateNow'
  | 'cancelUpdateDownload'
  | 'installUpdate'
  | 'dismissUpdate'
> {
  /** 收到新状态：写进 store，并在「刚下好」那一下提示一句 */
  const apply = (s: UpdateState): void => {
    const before = lastPhase
    lastPhase = s.phase
    set({ updateState: s })

    if (s.phase === 'ready' && before !== 'ready') {
      const v = s.readyVersion ?? s.info?.latestVersion ?? ''
      get().notify(
        'ok',
        s.canInstall
          ? `v${v} 更新包已下载完成 —— 点标题栏右上角的「重启更新」完成安装`
          : `v${v} 安装包已下载完成 —— 到「设置 → 版本更新」可以看出所在文件夹`,
        9000
      )
    }
  }

  return {
    bindUpdateState: () => {
      // 先拉一次：窗口可能比主进程的检查晚挂载，光靠推送会漏掉前几次变化
      void window.api
        .getUpdateState()
        .then(apply)
        .catch(() => {
          /* 拉不到就等推送，不打扰用户 */
        })

      return window.api.onUpdateState(apply)
    },

    checkUpdateNow: async (force = true) => {
      try {
        // 主进程会按设置决定要不要顺带自动下载，所以返回值直接就是最新状态
        apply(await window.api.checkUpdate(force))
      } catch (err) {
        get().notify('err', `检查更新失败：${err instanceof Error ? err.message : String(err)}`)
      }
    },

    downloadUpdateNow: async () => {
      try {
        apply(await window.api.downloadUpdate())
      } catch (err) {
        get().notify('err', `下载失败：${err instanceof Error ? err.message : String(err)}`)
      }
    },

    cancelUpdateDownload: async () => {
      try {
        await window.api.cancelUpdateDownload()
      } catch {
        /* 取消失败无所谓：主进程那边下载已经结束 */
      }
    },

    installUpdate: async () => {
      const r = await window.api.installUpdate()
      if (!r.ok) {
        get().notify('err', `没能启动安装程序：${r.error ?? '未知原因'}`)
        return
      }
      /*
       * 不在这里 quit —— 主进程启动安装器后会自己退出（要先让安装器起来）。
       * 这里只提示一句，免得那 600ms 里用户又点了一次。
       */
      get().notify('ok', '正在启动安装程序，应用即将退出…', 6000)
    },

    dismissUpdate: () => {
      const latest = get().updateState?.info?.latestVersion ?? null
      set({ updateDismissedVersion: latest })
    }
  }
}
