/**
 * 极简 JSON 持久化：设置、模板、快照都用它。
 * 数据放在 Electron 的 userData 目录，不污染用户工程。
 */

import { cpSync, existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { app } from 'electron'

/**
 * package.json 补上 productName 之前用过的数据目录名。
 *
 * 背景：Electron 的 `app.getName()` 优先取 `productName`，而 userData 目录名就是它。
 * 早期 package.json 只有 `name: cmake-vscode-studio`，所以数据都存在那个目录里；
 * 后来为了让 exe 属性和应用内显示一致，补上了 `productName: CMake-VSCode-Configurator`，
 * userData 就变成了新目录 —— 这里负责把老目录的数据搬过去，别让用户的设置凭空消失。
 */
const LEGACY_DIR_NAME = 'cmake-vscode-studio'

/** 我们自己的东西；只搬这几个，不碰 Electron 的缓存目录 */
const OUR_ITEMS = ['settings.json', 'templates.json', 'snapshots']

let cachedDir: string | null = null

function resolveUserDataDir(): string {
  const target = app.getPath('userData')
  const legacy = join(app.getPath('appData'), LEGACY_DIR_NAME)

  if (target.toLowerCase() === legacy.toLowerCase()) return target
  if (!existsSync(join(legacy, 'settings.json'))) return target
  // 注意：不能用「target 目录是否存在」来判断 —— Electron 启动时会先把 userData
  // 目录建出来（还有它自己的一堆缓存子目录），所以那个判断永远为真、迁移永远不执行。
  // 要看的是「我们自己的文件在不在」。
  if (existsSync(join(target, 'settings.json'))) return target

  try {
    mkdirSync(target, { recursive: true })
    for (const item of OUR_ITEMS) {
      const from = join(legacy, item)
      if (!existsSync(from)) continue
      cpSync(from, join(target, item), { recursive: true, force: true })
    }
    return target
  } catch {
    // 迁移失败就继续用老目录 —— 宁可不一致，也不能让用户丢设置
    return legacy
  }
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
