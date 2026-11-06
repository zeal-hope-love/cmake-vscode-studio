/**
 * IPC 层的共享件：进程管理器 + 两个小工具函数。
 *
 * 进程实例（`runner`）必须全应用只有一份 —— 通道按域拆成了好几个文件，
 * 谁都不许自己 new 一个，否则「启动」和「取消」会作用在不同实例上。
 *
 * ## 一条历史教训
 *
 * **不要在这个模块顶层调 `configureSnapshots(userDataPath(...))`**。
 * 这个模块在 index.ts 的 import 阶段就被求值了，那时 userData 可能还是默认目录
 * （`CFGSTUDIO_USER_DATA` 的 setPath 还没生效），快照会一直往真实数据目录里写。
 * 所以放在 `registerIpc()` 里，等 Electron ready、目录定下来之后再配置。
 */

import { existsSync } from 'node:fs'
import { join } from 'node:path'
import { generateBundle } from '../services/generate/generators'
import { ProcessRunner } from '../services/runner'

/** 全应用唯一的进程管理器（`run:start` / `run:cancel` 都指向它） */
export const runner = new ProcessRunner()

/** 把 `partial` 里的 undefined 去掉 —— 用于「只改一部分设置」的合并语义 */
export function pruneUndefined<T extends object>(input: T | undefined): Partial<T> {
  if (!input) return {}
  const out: Record<string, unknown> = {}
  for (const [key, value] of Object.entries(input)) {
    if (value !== undefined) out[key] = value
  }
  return out as Partial<T>
}

/**
 * 找 VS Code / Cursor 的 `code` 命令行。
 *
 * 只查几个固定位置，不做 PATH 搜索 —— PATH 里的 `code` 有时是别的程序。
 */
export function findCodeCli(): string | null {
  const candidates = [
    join(process.env.LOCALAPPDATA ?? '', 'Programs', 'Microsoft VS Code', 'bin', 'code.cmd'),
    'C:\\Program Files\\Microsoft VS Code\\bin\\code.cmd',
    'C:\\Program Files (x86)\\Microsoft VS Code\\bin\\code.cmd',
    join(process.env.LOCALAPPDATA ?? '', 'Programs', 'cursor', 'resources', 'app', 'bin', 'cursor.cmd')
  ]
  for (const cand of candidates) {
    if (cand && existsSync(cand)) return cand
  }
  return null
}

/** 在 ipc 层复用的：bundle → 待写文件 */
export function bundleToPayloads(bundle: ReturnType<typeof generateBundle>) {
  const stringify = (value: unknown): string => JSON.stringify(value, null, 4) + '\n'
  const files = [
    { name: 'launch.json', relativePath: '.vscode/launch.json', content: stringify(bundle.launch) },
    { name: 'tasks.json', relativePath: '.vscode/tasks.json', content: stringify(bundle.tasks) },
    {
      name: 'settings.json',
      relativePath: '.vscode/settings.json',
      content: stringify(bundle.settings)
    },
    {
      name: 'c_cpp_properties.json',
      relativePath: '.vscode/c_cpp_properties.json',
      content: stringify(bundle.cpp)
    }
  ]
  if (bundle.openocdCfg) {
    files.push({
      name: bundle.openocdCfg.fileName,
      relativePath: `.vscode/${bundle.openocdCfg.fileName}`,
      content: bundle.openocdCfg.content
    })
  }
  return files
}

/** 应用退出前调用：把所有还在跑的构建/调试进程收掉 */
export function stopAllRuns(): void {
  runner.cancelAll()
}
