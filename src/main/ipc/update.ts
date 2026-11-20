/**
 * 更新相关的 IPC 入口 —— 只是把渲染进程的动作转给 updateService。
 *
 * 这里**不存任何状态、不做任何判断**：状态在 updateService 里唯一持有，
 * 判断（该不该自动下、能不能一键装）也在那边。IPC 层薄一点，
 * 以后加一个「静默安装」开关之类的东西时不用同时改三个文件。
 */

import { BrowserWindow, ipcMain, shell } from 'electron'
import { IPC } from '@shared/types'
import {
  cancelNow,
  downloadNow,
  getUpdateState,
  installNow,
  runCheck
} from '../services/update/updateService'

export function registerUpdate(_getWindow: () => BrowserWindow | null): void {
  /** 检查（force=true 忽略 6 小时缓存），返回那一刻的完整状态 */
  ipcMain.handle(IPC.checkUpdate, async (_e, force?: boolean) => runCheck(force === true, true))

  ipcMain.handle(IPC.getUpdateState, async () => getUpdateState())

  /** 手动下载 / 重试 */
  ipcMain.handle(IPC.downloadUpdate, async () => downloadNow())

  ipcMain.handle(IPC.cancelUpdateDownload, async () => {
    cancelNow()
  })

  /** 启动安装器 → 应用退出，由安装器接手 */
  ipcMain.handle(IPC.installUpdate, async () => installNow())

  ipcMain.handle(IPC.openExternal, async (_e, url: string) => {
    /*
     * 只放行 http(s) 和本地 file://（打开「安装包所在文件夹」要用）。
     *
     * file:// 是这次新加的：以前一律拒绝，导致「打开所在文件夹」只能作罢。
     * 限制成 file:// 且不允许 file:// 指向 .exe 之类可执行文件没必要 ——
     * shell.openExternal 对 file:// 只是交给资源管理器打开，不会执行程序。
     */
    if (!/^(https?:|file:)/i.test(url)) {
      throw new Error('只允许打开 http(s) 或 file:// 链接')
    }
    await shell.openExternal(url)
  })
}
