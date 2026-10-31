/**
 * 极简 JSON 持久化：设置、模板、快照都用它。
 * 数据放在 Electron 的 userData 目录，不污染用户工程。
 */

import { cpSync, existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { app } from 'electron'

/**
 * 历史上用过的数据目录名，**由新到旧**排列。
 *
 * 背景：Electron 的 `app.getName()` 优先取 `productName`，而 userData 目录名就是它。
 * 名字改过几次，每次都会换一个数据目录 —— 这里负责把老目录的数据搬过来，
 * 别让用户的设置、模板、快照凭空消失。
 *
 * | 时期 | 目录名 | 原因 |
 * |---|---|---|
 * | 最早 | `cmake-vscode-studio` | 当时 package.json 只有 `name` |
 * | v1.x | `CMake-VSCode-Configurator` | 补了 `productName`，让 exe 属性和界面一致 |
 * | v2 起 | `CV Studio` | 改名（当前，即 `app.getPath('userData')`） |
 *
 * 顺序很重要：**新的排前面**。迁移时从最近的旧目录开始找，找到有数据的那一个就搬，
 * 这样连续改过两轮名字的用户也能一次搬到位。
 */
const LEGACY_DIR_NAMES = ['CMake-VSCode-Configurator', 'cmake-vscode-studio']

/** 我们自己的东西；只搬这几个，不碰 Electron 的缓存目录 */
const OUR_ITEMS = ['settings.json', 'templates.json', 'snapshots', 'history.json']

let cachedDir: string | null = null

function resolveUserDataDir(): string {
  const target = app.getPath('userData')
  const appData = app.getPath('appData')

  // 当前目录里已有我们自己的文件 → 说明已经在用了，不用搬。
  // 注意：不能用「target 目录是否存在」来判断 —— Electron 启动时会先把 userData
  // 目录建出来（还有它自己的一堆缓存子目录），所以那个判断永远为真、迁移永远不执行。
  if (existsSync(join(target, 'settings.json'))) return target

  // 按「由新到旧」找第一个有数据的旧目录
  for (const name of LEGACY_DIR_NAMES) {
    const legacy = join(appData, name)
    if (legacy.toLowerCase() === target.toLowerCase()) continue
    if (!existsSync(join(legacy, 'settings.json'))) continue

    try {
      mkdirSync(target, { recursive: true })
      for (const item of OUR_ITEMS) {
        const from = join(legacy, item)
        if (!existsSync(from)) continue
        cpSync(from, join(target, item), { recursive: true, force: true })
      }
      return target
    } catch {
      // 迁移失败就继续用那个老目录 —— 宁可不一致，也不能让用户丢设置
      return legacy
    }
  }

  return target
}

export function userDataPath(...parts: string[]): string {
  if (!cachedDir) cachedDir = resolveUserDataDir()
  return join(cachedDir, ...parts)
}

/** 当前实际使用的数据目录（「关于」里展示用） */
export function currentUserDataDir(): string {
  return userDataPath()
}

export function readStoreFile<T>(filePath: string, fallback: T): T {
  if (!existsSync(filePath)) return fallback
  try {
    const raw = readFileSync(filePath, 'utf8').replace(/^\uFEFF/, '')
    const parsed = JSON.parse(raw)
    return (parsed ?? fallback) as T
  } catch {
    return fallback
  }
}

export function writeStoreFile(filePath: string, value: unknown): void {
  mkdirSync(dirname(filePath), { recursive: true })
  writeFileSync(filePath, JSON.stringify(value, null, 2), 'utf8')
}
