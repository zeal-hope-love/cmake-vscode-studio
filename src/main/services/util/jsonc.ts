/**
 * JSONC（带注释的 JSON）读写。
 *
 * VSCode 的 launch.json / tasks.json / settings.json / c_cpp_properties.json
 * 都允许 `//` 与 `/* *​/` 注释和尾随逗号，JSON.parse 会直接抛错，所以要先清洗。
 */

import { readFileSync, writeFileSync, existsSync, mkdirSync, statSync } from 'node:fs'
import { dirname } from 'node:path'

export interface JsonReadResult {
  exists: boolean
  ok: boolean
  data: unknown
  error: string | null
  raw: string
}

/** 状态机式去注释，保证字符串内部的 `//`（URL、路径）不被误伤 */
export function stripJsonc(text: string): string {
  if (text.charCodeAt(0) === 0xfeff) text = text.slice(1)

  const out: string[] = []
  let i = 0
  const n = text.length
  let inString = false

  while (i < n) {
    const ch = text[i]

    if (inString) {
      out.push(ch)
      if (ch === '\\' && i + 1 < n) {
        out.push(text[i + 1])
        i += 2
        continue
      }
      if (ch === '"') inString = false
      i += 1
      continue
    }

    if (ch === '"') {
      inString = true
      out.push(ch)
      i += 1
      continue
    }

    if (ch === '/' && text[i + 1] === '/') {
      while (i < n && text[i] !== '\n' && text[i] !== '\r') i += 1
      continue
    }

    if (ch === '/' && text[i + 1] === '*') {
      i += 2
      while (i + 1 < n && !(text[i] === '*' && text[i + 1] === '/')) i += 1
      i += 2
      continue
    }

    out.push(ch)
    i += 1
  }

  // 尾随逗号：} 或 ] 之前只允许空白
  return out.join('').replace(/,(\s*[}\]])/g, '$1')
}

export function parseJsonc(text: string): { data: unknown; error: string | null } {
  if (!text || !text.trim()) return { data: null, error: '文件为空' }
  try {
    return { data: JSON.parse(stripJsonc(text)), error: null }
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err)
    return { data: null, error: `JSON 解析失败: ${msg}` }
  }
}

export function readJsonFile(filePath: string): JsonReadResult {
  if (!existsSync(filePath)) {
    return { exists: false, ok: false, data: null, error: null, raw: '' }
  }
  let raw = ''
  try {
    raw = readFileSync(filePath, 'utf8')
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err)
    return { exists: true, ok: false, data: null, error: `读取失败: ${msg}`, raw: '' }
  }
  const { data, error } = parseJsonc(raw)
  return { exists: true, ok: error === null, data, error, raw }
}

export function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

/** 序列化成 VSCode 风格 JSON：4 空格缩进、保留中文、末尾换行 */
export function stringifyJson(value: unknown, indent = 4): string {
  return JSON.stringify(value, null, indent) + '\n'
}

export function writeTextFile(filePath: string, text: string): void {
  mkdirSync(dirname(filePath), { recursive: true })
  writeFileSync(filePath, text, { encoding: 'utf8' })
}

export function isFile(filePath: string): boolean {
  try {
    return statSync(filePath).isFile()
  } catch {
    return false
  }
}
