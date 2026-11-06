/**
 * 运行：启动/取消一个构建或调试进程，并把输出流回渲染进程。
 *
 * 进程实例在 `common.ts` 里只有一份。这里是**唯一**给它挂监听的地方 ——
 * 重复注册会导致输出事件重复推送（界面上一行变两行）。
 */

import { BrowserWindow, ipcMain } from 'electron'
import { IPC, type RunRequest } from '@shared/types'
import { runner } from './common'

export function registerRun(getWindow: () => BrowserWindow | null): void {
  // ---- 运行 -------------------------------------------------------------
  runner.on('output', (payload) => {
    getWindow()?.webContents.send(IPC.runOutput, payload)
  })
  runner.on('exit', (payload) => {
    getWindow()?.webContents.send(IPC.runExit, payload)
  })

  ipcMain.handle(IPC.runStart, async (_e, request: RunRequest) => runner.start(request))
  ipcMain.handle(IPC.runCancel, async (_e, runId: string) => {
    runner.cancel(runId)
  })
}
