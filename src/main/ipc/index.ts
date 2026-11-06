/**
 * 所有 IPC 处理器的注册入口。
 *
 * 渲染进程没有任何 Node 能力（contextIsolation + sandbox），
 * 凡是碰文件系统/进程的动作都必须经过这里。
 *
 * ## 为什么按域拆成多个文件
 *
 * 原来是一个 942 行的 `ipc.ts`，57 个 `ipcMain.handle` 全靠 `// ---- xxx ----`
 * 注释分段。改一个域要在整份文件里翻，而且很容易把两个域的 import 搞混。
 *
 * 现在每个文件只注册自己那一域的通道，签名统一为
 * `registerX(getWindow: () => BrowserWindow | null): void`。
 *
 * ## 加新通道的步骤
 *
 * 1. `shared/types.ts` 的 `IPC` 里加常量
 * 2. `preload/index.ts` 的桥里加一行
 * 3. 在对应域的 `ipc/*.ts` 里加 handler（`ipcMain.handle(通道常量, ...)`）
 *
 * 三处都要改，漏了 preload 那行会在运行时报「不是函数」—— 所以别只改两处。
 *
 * ## 注册顺序
 *
 * 顺序不影响功能（通道名互不相同），但保持和界面上的功能分组一致，
 * 读起来顺：先能用的（应用信息/工程），再是重活（包安装/历史）。
 */

import type { BrowserWindow } from 'electron'
import { configureSnapshots } from '../services/data/snapshotStore'
import { userDataPath } from '../services/data/store'
import { registerApp } from './app'
import { registerCmake } from './cmake'
import { registerHistory } from './history'
import { registerPack } from './pack'
import { registerProject } from './project'
import { registerRun } from './run'
import { registerTemplate } from './template'
import { registerUpdate } from './update'

export { stopAllRuns } from './common'

export function registerIpc(getWindow: () => BrowserWindow | null): void {
  // 快照存在应用自己的数据目录里，不往用户工程里塞东西。
  // 必须等 Electron ready、userData 目录定下来之后再配置 —— 放在模块顶层会
  // 在 CFGSTUDIO_USER_DATA 的 setPath 生效前就求值，快照会写进真实数据目录。
  configureSnapshots(userDataPath('snapshots'))

  registerApp(getWindow)
  registerProject(getWindow)
  registerCmake(getWindow)
  registerPack(getWindow)
  registerUpdate(getWindow)
  registerTemplate(getWindow)
  registerHistory(getWindow)
  registerRun(getWindow)
}
