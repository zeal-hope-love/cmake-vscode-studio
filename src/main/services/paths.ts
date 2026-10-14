/**
 * 路径工具：工程根定位、分隔符归一化。
 */

import { existsSync, readdirSync, statSync } from 'node:fs'
import { basename, dirname, isAbsolute, join, normalize, relative, resolve } from 'node:path'

/** 命中其一即认为该目录是工程根 */
export const PROJECT_MARKERS = ['CMakeLists.txt', 'CMakePresets.json']

function hasIoc(dir: string): boolean {
  try {
    return readdirSync(dir).some((f) => f.toLowerCase().endsWith('.ioc'))
  } catch {
    return false
  }
}

export function isProjectDir(dir: string): boolean {
  try {
    if (!statSync(dir).isDirectory()) return false
  } catch {
    return false
  }
  if (PROJECT_MARKERS.some((m) => existsSync(join(dir, m)))) return true
  return hasIoc(dir)
}

/**
 * 从 start（文件或目录）向上找最近的工程根；找不到返回 null。
 */
export function findProjectRoot(start: string | null | undefined): string | null {
  if (!start) return null
  let current: string
  try {
    current = resolve(start)
    if (statSync(current).isFile()) current = dirname(current)
  } catch {
    return null
  }

  for (;;) {
    if (isProjectDir(current)) return current
    const parent = dirname(current)
    if (parent === current) return null
    current = parent
  }
}

/** 转成 VSCode 配置里习惯的正斜杠 */
export function toPosix(p: string | null | undefined): string {
  return p ? String(p).replace(/\\/g, '/') : ''
}

/** 转成 Windows 原生反斜杠 */
export function toNative(p: string | null | undefined): string {
  return p ? String(p).replace(/\//g, '\\') : ''
}

/** 相对工程根的路径，统一正斜杠 */
export function relativePosix(from: string, to: string): string {
  return toPosix(relative(from, to))
}

export function shortenPath(p: string | null | undefined, maxLen = 72): string {
  const text = String(p ?? '')
  if (text.length <= maxLen) return text
  return '…' + text.slice(-(maxLen - 1))
}

export function samePath(a: string | null | undefined, b: string | null | undefined): boolean {
  if (!a || !b) return false
  return normalize(a).toLowerCase() === normalize(b).toLowerCase()
}

export { basename, dirname, isAbsolute, join, normalize, relative, resolve }
