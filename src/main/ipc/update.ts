/**
 * 版本更新：检查 GitHub Releases、应用内下载、启动安装包。
 *
 * 下载进度通过 `app:updateDownloadProgress` 推给渲染进程，
 * 所以这段要拿到窗口 —— 但**拿不到窗口不算失败**，只是不推进度。
 */

import { BrowserWindow, ipcMain, shell } from 'electron'
import { IPC } from '@shared/types'
import { checkForUpdate } from '../services/update/updateChecker'
import { cancelDownload, downloadInstaller, runInstaller } from '../services/update/updateDownloader'

export function registerUpdate(getWindow: () => BrowserWindow | null): void {
  // ---- 更新检测 ---------------------------------------------------------
  ipcMain.handle(IPC.checkUpdate, async (_e, force?: boolean) => checkForUpdate(force))

  ipcMain.handle(IPC.openExternal, async (_e, url: string) => {
    /*
     * 只放行 http(s) —— 这个接口会被渲染进程传入任意字符串，
     * 不校验的话 `file://` 之类可以用它打开本地文件甚至执行程序。
     */
    if (!/^https?:\/\//i.test(url)) {
      throw new Error('只允许打开 http(s) 链接')
    }
    await shell.openExternal(url)
  })

  // ---- 应用内下载更新包 ---------------------------------------------------
  ipcMain.handle(IPC.downloadUpdate, async (e, url: string, fileName: string) => {
    /*
     * 只允许从 GitHub 下载 —— 这个接口接受渲染进程传进来的任意 URL，
     * 不限制的话等于给了「让主进程去下载任意文件」的能力。
     */
    if (
      !/^https:\/\/(api\.)?github\.com\//i.test(url) &&
      !/^https:\/\/objects\.githubusercontent\.com\//i.test(url)
    ) {
      throw new Error('只允许从 GitHub 下载更新包')
    }
    return downloadInstaller(url, fileName, (p) => {
      if (!e.sender.isDestroyed()) e.sender.send(IPC.updateDownloadProgress, p)
    })
  })

  ipcMain.handle(IPC.cancelUpdateDownload, async () => {
    cancelDownload()
  })

  ipcMain.handle(IPC.runUpdateInstaller, async (_e, filePath: string) => {
    return runInstaller(filePath)
  })
}
