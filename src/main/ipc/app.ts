/**
 * 应用信息、设置、系统对话框。
 *
 * 这三类放在一起，因为它们是**跟工程无关**的通道 —— 没选工程也能用。
 */

import { app, BrowserWindow, dialog, ipcMain } from 'electron'
import { join } from 'node:path'
import { IPC, type AppSettings, type AppInfo } from '@shared/types'
import { getSettings, saveSettings } from '../services/data/settingsStore'
import { currentUserDataDir } from '../services/data/store'

export function registerApp(getWindow: () => BrowserWindow | null): void {
  // ---- 应用信息 ---------------------------------------------------------
  ipcMain.handle(IPC.appInfo, (): AppInfo => ({
    // 版本号来自 package.json 的 version；打包时 electron-builder 用它填 exe 的文件版本
    name: app.getName(),
    version: app.getVersion(),
    electron: process.versions.electron ?? '—',
    chrome: process.versions.chrome ?? '—',
    node: process.versions.node ?? '—',
    v8: process.versions.v8 ?? '—',
    platform: `${process.platform} ${process.arch}`,
    isPackaged: app.isPackaged,
    // 用实际生效的目录（可能是迁移后的新目录，也可能是迁移失败时回退的老目录）
    userData: currentUserDataDir(),
    packagePath: join(app.getAppPath(), 'package.json')
  }))

  // ---- 设置 -------------------------------------------------------------
  ipcMain.handle(IPC.settingsGet, (): AppSettings => getSettings())

  ipcMain.handle(IPC.settingsSave, (_e, patch: Partial<AppSettings>): AppSettings =>
    saveSettings(patch)
  )

  // ---- 对话框 -----------------------------------------------------------
  ipcMain.handle(IPC.dialogPickDirectory, async (_e, defaultPath?: string) => {
    const win = getWindow()
    const result = win
      ? await dialog.showOpenDialog(win, {
          title: '选择工程目录',
          defaultPath: defaultPath || undefined,
          properties: ['openDirectory']
        })
      : await dialog.showOpenDialog({ properties: ['openDirectory'], defaultPath })
    return result.canceled || !result.filePaths.length ? null : result.filePaths[0]
  })

  ipcMain.handle(IPC.dialogPickFile, async (_e, filters?: { name: string; extensions: string[] }[]) => {
    const win = getWindow()
    const options = {
      title: '选择文件',
      properties: ['openFile' as const],
      filters: filters?.length ? filters : [{ name: '所有文件', extensions: ['*'] }]
    }
    const result = win
      ? await dialog.showOpenDialog(win, options)
      : await dialog.showOpenDialog(options)
    return result.canceled || !result.filePaths.length ? null : result.filePaths[0]
  })
}
