/**
 * CMake 侧解析：CMakeLists.txt、CMakePresets.json、CMakeCache.txt。
 *
 * 全部是静态解析，不调用 cmake 本身 —— 用户可能只是想把工程选进来看一眼，
 * 不该为这个动作付出一次 configure 的代价。
 */

import { existsSync, readFileSync } from 'node:fs'
import { dirname, normalize } from 'node:path'
import type { CmakeCache, CmakePreset, CmakeTarget } from '@shared/types'
import { isPlainObject, readJsonFile } from './jsonc'

// --------------------------------------------------------------------------
// CMakeLists.txt
// --------------------------------------------------------------------------

const BLOCK_COMMENT = /#\[\[[\s\S]*?\]\]/g
const LINE_COMMENT = /#.*$/gm
const CONTINUATION = /\\\s*\r?\n/g

export function stripCmakeComments(text: string): string {
  return text.replace(BLOCK_COMMENT, ' ').replace(LINE_COMMENT, '').replace(CONTINUATION, ' ')
}

/** 找到 `command( ... )` 的参数原文，支持嵌套括号 */
function findCommandCalls(text: string, command: string): string[] {
  const results: string[] = []
  const re = new RegExp(`(?<![A-Za-z0-9_])${command}\\s*\\(`, 'gi')
  let match: RegExpExecArray | null

  while ((match = re.exec(text)) !== null) {
    let depth = 1
    let i = match.index + match[0].length
    const buf: string[] = []
    while (i < text.length && depth > 0) {
      const ch = text[i]
      if (ch === '(') depth += 1
      else if (ch === ')') {
        depth -= 1
        if (depth === 0) break
      }
      buf.push(ch)
      i += 1
    }
    results.push(buf.join('').trim())
  }
  return results
}

/** 按空白分词，引号内的内容视为一个整体 */
function splitArgs(argText: string): string[] {
  const tokens: string[] = []
  let buf: string[] = []
  let quote: string | null = null
  for (const ch of argText) {
    if (quote) {
      if (ch === quote) quote = null
      else buf.push(ch)
      continue
    }
    if (ch === '"' || ch === "'") {
      quote = ch
      continue
    }
    if (/\s/.test(ch)) {
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

const VAR_RE = /\$\{([A-Za-z_][A-Za-z0-9_]*)\}/g

function collectSetVars(text: string): Record<string, string> {
  const vars: Record<string, string> = {}
  for (const args of findCommandCalls(text, 'set')) {
    const tokens = splitArgs(args)
    if (tokens.length === 2 && /^[A-Za-z_][A-Za-z0-9_]*$/.test(tokens[0])) {
      vars[tokens[0]] = tokens[1]
    }
  }
  return vars
}

/** 展开 ${VAR}；含空格/括号等无法静态确定的量返回 null */
function resolveToken(token: string, vars: Record<string, string>, depth = 0): string | null {
  let t = token.trim().replace(/^["']|["']$/g, '')
  if (!t) return null

  if (depth < 6 && t.includes('${')) {
    const replaced = t.replace(VAR_RE, (m, name: string) => vars[name] ?? m)
    if (replaced !== t) {
      const nested = resolveToken(replaced, vars, depth + 1)
      t = nested ?? replaced
    }
  }
  if (t.includes('${')) return null
  if (/[\s()]/.test(t)) return null
  return t
}

export interface RawCmakeLists {
  exists: boolean
  cmakeMinimum: string | null
  projectName: string | null
  targets: CmakeTarget[]
  includeDirs: string[]
  defines: string[]
  subdirectories: string[]
  hasCompileCommands: boolean
  sources: string[]
}

export function parseCmakelists(filePath: string): RawCmakeLists {
  const result: RawCmakeLists = {
    exists: false,
    cmakeMinimum: null,
    projectName: null,
    targets: [],
    includeDirs: [],
    defines: [],
    subdirectories: [],
    hasCompileCommands: false,
    sources: []
  }
  if (!existsSync(filePath)) return result

  let text: string
  try {
    text = stripCmakeComments(readFileSync(filePath, 'utf8'))
  } catch {
    return result
  }
  result.exists = true

  const mMin = /cmake_minimum_required\s*\(\s*VERSION\s+([0-9][0-9.]*)/i.exec(text)
  if (mMin) result.cmakeMinimum = mMin[1]

  const vars = collectSetVars(text)

  for (const args of findCommandCalls(text, 'project')) {
    const tokens = splitArgs(args)
    if (tokens.length) {
      const name = resolveToken(tokens[0], vars)
      if (name) result.projectName = name
    }
    break
  }

  const targetSpecs: Array<[string, CmakeTarget['kind'], string]> = [
    ['add_executable', 'executable', 'CMakeLists.txt add_executable(...)'],
    ['add_library', 'library', 'CMakeLists.txt add_library(...)']
  ]

  for (const [command, kind, source] of targetSpecs) {
    for (const args of findCommandCalls(text, command)) {
      const tokens = splitArgs(args)
      if (!tokens.length) continue
      const name = resolveToken(tokens[0], vars)
      if (!name) continue
      if (result.targets.some((t) => t.name === name)) continue
      result.targets.push({ name, kind, source })

      for (const extra of tokens.slice(1)) {
        if (extra && !extra.startsWith('$')) result.sources.push(extra)
      }
    }
  }

  // CubeMX / 各家模板生成的头文件目录几乎都写成
  //   ${CMAKE_CURRENT_SOURCE_DIR}/application
  // 这种形式。早期版本见到 `$` 就跳过，结果这类工程一个 include 都解析不出来。
  // 这里把「源码目录」类变量替换成本 CMakeLists 所在目录。
  // （子目录里的 ${CMAKE_SOURCE_DIR} 严格说指的是顶层目录，这里按当前目录近似，
  //   对 IntelliSense 来说够用，而且不会像直接丢弃那样信息全无。）
  const listDir = dirname(filePath)
  const expandSourceVars = (token: string): string => {
    let out = token
    for (const name of [
      'CMAKE_CURRENT_SOURCE_DIR',
      'CMAKE_CURRENT_LIST_DIR',
      'CMAKE_SOURCE_DIR',
      'PROJECT_SOURCE_DIR'
    ]) {
      out = out.split(`\${${name}}`).join(listDir)
    }
    return out
  }

  const collect = (command: string, into: string[]): void => {
    for (const args of findCommandCalls(text, command)) {
      const tokens = splitArgs(args)
      for (const raw of tokens.slice(1)) {
        const upper = raw.toUpperCase()
        if (upper === 'PRIVATE' || upper === 'PUBLIC' || upper === 'INTERFACE') continue
        const tok = expandSourceVars(raw)
        if (!tok || tok.includes('${')) continue
        if (!into.includes(tok)) into.push(tok)
      }
    }
  }
  collect('target_include_directories', result.includeDirs)
  collect('target_compile_definitions', result.defines)
  collect('include_directories', result.includeDirs)

  // add_subdirectory(...)：CubeMX 会把 HAL 相关的东西放进子目录
  for (const args of findCommandCalls(text, 'add_subdirectory')) {
    const tokens = splitArgs(args)
    const sub = tokens.length ? resolveToken(tokens[0], vars) : null
    if (sub && !result.subdirectories.includes(sub)) result.subdirectories.push(sub)
  }

  if (/CMAKE_EXPORT_COMPILE_COMMANDS\s+(TRUE|ON|1)/i.test(text)) {
    result.hasCompileCommands = true
  }

  return result
}

// --------------------------------------------------------------------------
// CMakePresets.json
// --------------------------------------------------------------------------

export function substituteCmakeVars(value: string, mapping: Record<string, string>): string {
  return value.replace(VAR_RE, (m, name: string) => mapping[name] ?? m)
}

export function parseCmakePresets(filePath: string): CmakePreset[] {
  const res = readJsonFile(filePath)
  if (!res.exists || !isPlainObject(res.data)) return []

  const rawList = res.data.configurePresets
  if (!Array.isArray(rawList)) return []

  const byName = new Map<string, Record<string, unknown>>()
  const order: string[] = []
  for (const entry of rawList) {
    if (!isPlainObject(entry)) continue
    const name = entry.name
    if (typeof name !== 'string' || !name) continue
    if (!byName.has(name)) order.push(name)
    byName.set(name, entry)
  }

  const sourceDir = dirname(filePath)

  const expand = (name: string, depth = 0): Record<string, unknown> => {
    if (depth > 10) return {}
    const entry = byName.get(name)
    if (!entry) return {}

    let parents = entry.inherits
    if (typeof parents === 'string') parents = [parents]

    const merged: Record<string, unknown> = {}
    if (Array.isArray(parents)) {
      for (const parent of parents) {
        if (typeof parent !== 'string') continue
        const parentData = expand(parent, depth + 1)
        for (const [key, val] of Object.entries(parentData)) {
          if (key === 'cacheVariables' && isPlainObject(val)) {
            merged.cacheVariables = {
              ...(val as Record<string, unknown>),
              ...((merged.cacheVariables as Record<string, unknown>) ?? {})
            }
          } else if (!(key in merged)) {
            merged[key] = val
          }
        }
      }
    }

    for (const [key, val] of Object.entries(entry)) {
      if (key === 'inherits') continue
      if (key === 'cacheVariables' && isPlainObject(val)) {
        merged.cacheVariables = {
          ...((merged.cacheVariables as Record<string, unknown>) ?? {}),
          ...val
        }
      } else {
        merged[key] = val
      }
    }
    return merged
  }

  const mapping = { sourceDir, hostSystemName: 'Windows' }
  const presets: CmakePreset[] = []

  for (const name of order) {
    const entry = byName.get(name)!
    const merged = expand(name)
    const cacheVars = isPlainObject(merged.cacheVariables) ? merged.cacheVariables : {}

    let binaryDir = typeof merged.binaryDir === 'string' ? merged.binaryDir : null
    if (binaryDir) {
      binaryDir = substituteCmakeVars(binaryDir, { ...mapping, presetName: name })
      // 统一成平台原生分隔符，否则 "…/demo/build/Debug" 和扫描出的
      // "…\demo\build\Debug" 会被当成两个不同的目录
      if (!binaryDir.includes('${')) binaryDir = normalize(binaryDir)
    }

    let toolchainFile = typeof merged.toolchainFile === 'string' ? merged.toolchainFile : null
    if (toolchainFile) {
      toolchainFile = substituteCmakeVars(toolchainFile, { ...mapping, presetName: name })
      if (!toolchainFile.includes('${')) toolchainFile = normalize(toolchainFile)
    }

    let buildType: string | null = null
    for (const key of ['CMAKE_BUILD_TYPE', 'CMAKE_CONFIGURATION_TYPES']) {
      const val = cacheVars[key]
      if (typeof val === 'string' && val) {
        buildType = val.includes(';') ? val.split(';')[0] : val
        break
      }
    }
    if (buildType === null && typeof merged.configuration === 'string') {
      buildType = merged.configuration
    }

    let inheritsRaw: unknown = entry.inherits
    if (typeof inheritsRaw === 'string') inheritsRaw = [inheritsRaw]
    const inherits: string[] = Array.isArray(inheritsRaw)
      ? inheritsRaw.filter((x): x is string => typeof x === 'string')
      : []

    presets.push({
      name,
      hidden: entry.hidden === true,
      generator: typeof merged.generator === 'string' ? merged.generator : null,
      binaryDir,
      buildType,
      toolchainFile,
      inherits: inherits.filter((x): x is string => typeof x === 'string'),
      cacheVariables: Object.fromEntries(
        Object.entries(cacheVars).map(([k, v]) => [k, typeof v === 'string' ? v : JSON.stringify(v)])
      )
    })
  }

  return presets
}

/** buildPresets 里可用的名字，用于 `cmake --build --preset <name>` */
export function parseBuildPresetNames(filePath: string): Set<string> {
  const names = new Set<string>()
  const res = readJsonFile(filePath)
  if (!res.exists || !isPlainObject(res.data)) return names
  const list = res.data.buildPresets
  if (!Array.isArray(list)) return names
  for (const entry of list) {
    if (isPlainObject(entry) && typeof entry.name === 'string') names.add(entry.name)
  }
  return names
}

// --------------------------------------------------------------------------
// CMakeCache.txt
// --------------------------------------------------------------------------

export function parseCmakeCache(filePath: string): CmakeCache | null {
  if (!existsSync(filePath)) return null

  const raw: Record<string, string> = {}
  try {
    for (const line of readFileSync(filePath, 'utf8').split(/\r?\n/)) {
      const trimmed = line.trim()
      if (!trimmed || trimmed.startsWith('//') || trimmed.startsWith('#')) continue
      const eq = trimmed.indexOf('=')
      if (eq < 0) continue
      const keyType = trimmed.slice(0, eq)
      const colon = keyType.indexOf(':')
      if (colon < 0) continue
      raw[keyType.slice(0, colon)] = trimmed.slice(eq + 1)
    }
  } catch {
    return null
  }

  const flag = (key: string): boolean | null => {
    const val = raw[key]
    if (val === undefined) return null
    return ['ON', 'TRUE', '1', 'YES'].includes(val.trim().toUpperCase())
  }

  return {
    path: filePath,
    generator: raw.CMAKE_GENERATOR ?? null,
    buildType: raw.CMAKE_BUILD_TYPE ?? null,
    cCompiler: raw.CMAKE_C_COMPILER ?? null,
    cxxCompiler: raw.CMAKE_CXX_COMPILER ?? null,
    makeProgram: raw.CMAKE_MAKE_PROGRAM ?? null,
    toolchainFile: raw.CMAKE_TOOLCHAIN_FILE ?? null,
    exportCompileCommands: flag('CMAKE_EXPORT_COMPILE_COMMANDS'),
    projectName: raw.CMAKE_PROJECT_NAME ?? null
  }
}
