/**
 * 发现「VSCode 正在打开的工程」与「最近打开过的工程」。
 *
 * 两个来源：
 *   · 正在打开 —— 读 Code.exe 主进程命令行（过滤掉 --type= 的 renderer/gpu 子进程）
 *   · 最近打开 —— 扫描 %APPDATA%\Code\User\workspaceStorage\*\workspace.json
 *
 * 所有外部调用都有超时和异常兜底：失败时返回空数组，绝不让界面崩掉。
 */

import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'
import { spawnSync } from 'node:child_process'
import type { ProjectCandidate } from '@shared/types'
import { findIocFile, parseIoc } from './ioc'
import { findProjectRoot } from './paths'

const CODE_EXE_NAMES = ['Code.exe', 'Code - Insiders.exe', 'Cursor.exe', 'VSCodium.exe']

const STORAGE_ROOTS: Array<[string, string]> = [
  ['Code', 'VSCode'],
  ['Code - Insiders', 'VSCode Insiders'],
  ['Cursor', 'Cursor'],
  ['VSCodium', 'VSCodium']
]

// --------------------------------------------------------------------------
// 工具
// --------------------------------------------------------------------------

function runPowerShell(script: string, timeoutMs = 15000): string {
  const res = spawnSync(
    'powershell.exe',
    [
      '-NoProfile',
      '-NonInteractive',
      '-ExecutionPolicy',
      'Bypass',
      '-Command',
      `[Console]::OutputEncoding=[System.Text.Encoding]::UTF8; ${script}`
    ],
    { encoding: 'utf8', timeout: timeoutMs, windowsHide: true, maxBuffer: 8 * 1024 * 1024 }
  )
  return res.stdout ?? ''
}

/** 按 Windows 命令行规则粗略分词，引号内视为整体 */
function splitCommandLine(commandLine: string): string[] {
  const tokens: string[] = []
  let buf: string[] = []
  let inQuotes = false
  for (const ch of commandLine) {
    if (ch === '"') {
      inQuotes = !inQuotes
      continue
    }
    if (ch === ' ' && !inQuotes) {
      if (buf.length) {
        tokens.push(buf.join(''))
        buf = []
      }
      continue
    }
    buf.push(ch)
  }
  if (buf.length) tokens.push(buf.join(''))
  return tokens
}

/**
 * 把 VSCode 的 workspace.json 里的 folder URI 还原成路径。
 *
 * 踩过的坑：VSCode 写出来的是 `file:///c%3A/Users/...`，**冒号是编码过的**。
 * 早期版本在 decodeURIComponent 之前就判断「第三个字符是不是冒号」，
 * 于是 `/c%3A/...` 判定失败、前缀斜杠没被去掉，路径成了 `/c:/Users/...` ——
 * 一个在 Windows 上根本不存在的路径，「最近打开的工程」于是永远是空的。
 * 正确顺序：先剥 `file://` 前缀 → 再解码 → 最后去掉盘符前的那个斜杠。
 */
export function parseFileUri(uri: string): string | null {
  if (!uri) return null

  let text = uri.trim()
  if (/^file:\/\//i.test(text)) text = text.replace(/^file:\/\/+/i, '')

  try {
    text = decodeURIComponent(text)
  } catch {
    /* 编码坏了就按原样用 */
  }

  // /c:/Users/... → c:/Users/...
  if (/^\/[A-Za-z]:/.test(text)) text = text.slice(1)

  return text || null
}

function readJsonSafe(filePath: string): unknown {
  try {
    return JSON.parse(readFileSync(filePath, 'utf8').replace(/^\uFEFF/, ''))
  } catch {
    return null
  }
}

function foldersFromCodeWorkspace(wsFile: string): string[] {
  const data = readJsonSafe(wsFile)
  if (!data || typeof data !== 'object') return []
  const folders = (data as Record<string, unknown>).folders
  if (!Array.isArray(folders)) return []

  const out: string[] = []
  const base = wsFile.replace(/[\\/][^\\/]+$/, '')
  for (const entry of folders) {
    let raw: string | null = null
    if (typeof entry === 'string') raw = entry
    else if (
      entry &&
      typeof entry === 'object' &&
      typeof (entry as Record<string, unknown>).path === 'string'
    ) {
      raw = (entry as Record<string, string>).path
    }
    if (!raw) continue
    out.push(/^[A-Za-z]:[\\/]|^\\\\/.test(raw) ? raw : join(base, raw))
  }
  return out
}

function makeCandidate(
  folder: string,
  root: string,
  source: string,
  kind: ProjectCandidate['kind'],
  lastUsed = 0
): ProjectCandidate {
  let chip: string | null = null
  const ioc = findIocFile(root)
  if (ioc) {
    const info = parseIoc(ioc)
    if (info?.device) chip = info.device
  }

  let label = root
  if (chip) label += `   [芯片: ${chip}]`

  const bits = [source]
  if (root !== folder) bits.push(`工作区: ${folder}`)

  return { folder, root, source, kind, lastUsed, chip, label, detail: bits.join('  ·  ') }
}

// --------------------------------------------------------------------------
// 正在打开的 VSCode 窗口
// --------------------------------------------------------------------------

export function getOpenProjects(): ProjectCandidate[] {
  const filter = CODE_EXE_NAMES.map((n) => `Name='${n}'`).join(' OR ')
  const script =
    `Get-CimInstance Win32_Process -Filter "${filter}" -ErrorAction SilentlyContinue | ` +
    `ForEach-Object { $_.CommandLine }`
  const text = runPowerShell(script)

  const candidates: ProjectCandidate[] = []
  const seen = new Set<string>()

  for (const line of text.split(/\r?\n/)) {
    const trimmed = line.trim()
    if (!trimmed) continue
    if (!CODE_EXE_NAMES.some((n) => trimmed.includes(n))) continue

    const tokens = splitCommandLine(trimmed)
    if (tokens.some((t) => t.startsWith('--type='))) continue

    for (const token of tokens.slice(1)) {
      if (!token || token.startsWith('-')) continue
      if (!existsSync(token)) continue

      let folders: string[] = []
      let isDirectory = false
      try {
        isDirectory = statSync(token).isDirectory()
      } catch {
        continue
      }

      if (isDirectory) folders = [token]
      else if (token.toLowerCase().endsWith('.code-workspace'))
        folders = foldersFromCodeWorkspace(token)

      for (const folder of folders) {
        const root = findProjectRoot(folder)
        if (!root) continue
        const key = root.toLowerCase()
        if (seen.has(key)) continue
        seen.add(key)
        candidates.push(makeCandidate(folder, root, 'VSCode 正在打开', 'open'))
      }
    }
  }

  return candidates
}

// --------------------------------------------------------------------------
// 最近打开过
// --------------------------------------------------------------------------

export function getRecentProjects(limit = 25): ProjectCandidate[] {
  const appData = process.env.APPDATA ?? join(homedir(), 'AppData', 'Roaming')
  const found: ProjectCandidate[] = []
  const seen = new Set<string>()

  for (const [appFolder, label] of STORAGE_ROOTS) {
    const storage = join(appData, appFolder, 'User', 'workspaceStorage')
    if (!existsSync(storage)) continue

    let entries: string[]
    try {
      entries = readdirSync(storage)
    } catch {
      continue
    }

    for (const entry of entries) {
      const dir = join(storage, entry)
      const wsFile = join(dir, 'workspace.json')
      if (!existsSync(wsFile)) continue

      const data = readJsonSafe(wsFile)
      if (!data || typeof data !== 'object') continue
      const obj = data as Record<string, unknown>

      const folders: string[] = []
      if (typeof obj.folder === 'string') {
        const p = parseFileUri(obj.folder)
        if (p) folders.push(p)
      }
      if (typeof obj.workspace === 'string') {
        const p = parseFileUri(obj.workspace)
        if (p && existsSync(p) && p.toLowerCase().endsWith('.code-workspace')) {
          folders.push(...foldersFromCodeWorkspace(p))
        }
      }

      let mtime = 0
      try {
        mtime = statSync(dir).mtimeMs
      } catch {
        /* ignore */
      }

      for (const folder of folders) {
        const root = findProjectRoot(folder)
        if (!root) continue
        const key = root.toLowerCase()
        if (seen.has(key)) continue
        seen.add(key)
        found.push(makeCandidate(folder, root, `最近打开（${label}）`, 'recent', mtime))
      }
    }
  }

  found.sort((a, b) => b.lastUsed - a.lastUsed)
  return found.slice(0, limit)
}

export function discoverProjects(includeOpen = true, includeRecent = true): ProjectCandidate[] {
  const result: ProjectCandidate[] = []
  const seen = new Set<string>()

  const groups: ProjectCandidate[] = [
    ...(includeOpen ? getOpenProjects() : []),
    ...(includeRecent ? getRecentProjects() : [])
  ]

  for (const cand of groups) {
    const key = (cand.root ?? cand.folder).toLowerCase()
    if (seen.has(key)) continue
    seen.add(key)
    result.push(cand)
  }
  return result
}
