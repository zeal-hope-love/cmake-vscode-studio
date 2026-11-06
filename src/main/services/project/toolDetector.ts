/**
 * 工具链 / 调试器自动探测。
 *
 * 查找优先级（从上到下，命中即停）：
 *   1. 用户在上次使用中手动指定的路径 —— 明确的覆盖，永远最高
 *   2. 环境变量 —— 直接指向可执行文件的（OPENOCD、CMAKE…）
 *   3. 环境变量 —— 安装根目录（STM32CLT_PATH、OPENOCD_HOME、SEGGER_PATH…），
 *      再按各家安装布局拼出子路径。STM32CubeCLT / CubeIDE 这类套件把
 *      CMake / Ninja / 工具链 / 烧录器都装在同一个根下，从根推最准。
 *   4. 系统 PATH
 *   5. 本机常见安装位置（DevEnv / PlatformIO / Program Files / Keil / scoop / choco…）
 *
 * 不联网、不写注册表；版本号是可选步骤（会起子进程），由界面上按钮触发。
 */

import { existsSync, readdirSync, statSync } from 'node:fs'
import { homedir } from 'node:os'
import { basename, join } from 'node:path'
import { spawnSync } from 'node:child_process'
import type { EnvRoot, ToolItem, ToolPaths } from '@shared/types'

export const TOOL_LABELS: Record<string, string> = {
  openocd: 'OpenOCD',
  arm_gcc: 'arm-none-eabi-gcc',
  arm_gdb: 'arm-none-eabi-gdb',
  cmake: 'CMake',
  ninja: 'Ninja',
  make: 'Make',
  gdb: 'gdb（本机）',
  clangd: 'clangd',
  jlink: 'J-Link 命令行',
  stlink: 'ST-Link / CubeProgrammer'
}

const EXE_NAMES: Record<string, string[]> = {
  openocd: ['openocd.exe', 'openocd'],
  arm_gcc: ['arm-none-eabi-gcc.exe', 'arm-none-eabi-gcc'],
  arm_gdb: ['arm-none-eabi-gdb.exe', 'arm-none-eabi-gdb'],
  cmake: ['cmake.exe', 'cmake'],
  ninja: ['ninja.exe', 'ninja'],
  make: ['mingw32-make.exe', 'make.exe', 'make'],
  gdb: ['gdb.exe', 'gdb'],
  clangd: ['clangd.exe', 'clangd'],
  jlink: ['JLink.exe', 'JLink'],
  stlink: ['STM32_Programmer_CLI.exe', 'ST-LINK_gdbserver.exe', 'ST-LINK_CLI.exe', 'st-info.exe']
}

// --------------------------------------------------------------------------
// 环境变量
// --------------------------------------------------------------------------

/** 会指向「安装根目录」的环境变量 */
const ENV_ROOTS: Array<{ name: string; label: string }> = [
  { name: 'STM32CLT_PATH', label: 'STM32CubeCLT' },
  { name: 'STM32CUBECLT_PATH', label: 'STM32CubeCLT' },
  { name: 'STM32CubeCLT_PATH', label: 'STM32CubeCLT' },
  { name: 'STM32CUBEIDE_PATH', label: 'STM32CubeIDE' },
  { name: 'STM32CUBEPROG_PATH', label: 'STM32CubeProgrammer' },
  { name: 'STM32CubeMX_PATH', label: 'STM32CubeMX' },
  { name: 'OPENOCD_HOME', label: 'OpenOCD' },
  { name: 'OPENOCD_ROOT', label: 'OpenOCD' },
  { name: 'OPENOCD_PATH', label: 'OpenOCD' },
  { name: 'SEGGER_PATH', label: 'SEGGER J-Link' },
  { name: 'JLINK_PATH', label: 'SEGGER J-Link' },
  { name: 'ARM_TOOLCHAIN_PATH', label: 'Arm GNU Toolchain' },
  { name: 'ARM_GCC_PATH', label: 'Arm GNU Toolchain' },
  { name: 'GCC_ARM_PATH', label: 'Arm GNU Toolchain' },
  { name: 'CMSIS_DAP_PATH', label: 'CMSIS-DAP' },
  { name: 'PLATFORMIO_CORE_DIR', label: 'PlatformIO' }
]

/**
 * 各家套件在安装根下的相对布局。
 * 顺序要按「最可能」排，命中即停。
 */
const ENV_RELATIVE: Record<string, string[]> = {
  openocd: [
    'bin/openocd.exe',
    'openocd/bin/openocd.exe',
    'OpenOCD/bin/openocd.exe',
    'xpack-openocd-*/bin/openocd.exe',
    'openocd.exe'
  ],
  arm_gcc: [
    'GNU-tools-for-STM32/bin/arm-none-eabi-gcc.exe',
    'bin/arm-none-eabi-gcc.exe',
    'arm-none-eabi/bin/arm-none-eabi-gcc.exe',
    'bin/arm-none-eabi-gcc'
  ],
  arm_gdb: [
    'GNU-tools-for-STM32/bin/arm-none-eabi-gdb.exe',
    'bin/arm-none-eabi-gdb.exe',
    'arm-none-eabi/bin/arm-none-eabi-gdb.exe',
    'bin/arm-none-eabi-gdb'
  ],
  cmake: ['CMake/bin/cmake.exe', 'bin/cmake.exe', 'cmake.exe'],
  ninja: ['Ninja/bin/ninja.exe', 'bin/ninja.exe', 'ninja.exe'],
  make: ['bin/mingw32-make.exe', 'bin/make.exe'],
  gdb: ['bin/gdb.exe'],
  clangd: ['bin/clangd.exe'],
  jlink: ['JLink.exe', 'JLink/JLink.exe', 'bin/JLink.exe'],
  stlink: [
    'STM32CubeProgrammer/bin/STM32_Programmer_CLI.exe',
    'bin/STM32_Programmer_CLI.exe',
    'STLink-gdb-server/bin/ST-LINK_gdbserver.exe',
    'bin/ST-LINK_gdbserver.exe',
    'bin/ST-LINK_CLI.exe',
    'bin/st-info.exe'
  ]
}

/** 直接指向可执行文件的环境变量 */
const ENV_EXE: Record<string, string[]> = {
  openocd: ['OPENOCD', 'OPENOCD_EXE', 'OPENOCD_BIN'],
  arm_gcc: ['ARM_GCC', 'ARM_NONE_EABI_GCC'],
  arm_gdb: ['ARM_GDB', 'ARM_NONE_EABI_GDB'],
  cmake: ['CMAKE', 'CMAKE_EXE'],
  ninja: ['NINJA'],
  jlink: ['JLINK'],
  stlink: ['STLINK', 'STM32_PROGRAMMER_CLI'],
  clangd: ['CLANGD']
}

/** OpenOCD 官方支持用 OPENOCD_SCRIPTS 指定脚本目录 */
const OPENOCD_SCRIPTS_ENV = 'OPENOCD_SCRIPTS'

function readEnvRoots(): EnvRoot[] {
  const roots: EnvRoot[] = []
  for (const { name, label } of ENV_ROOTS) {
    const raw = (process.env[name] ?? '').trim()
    if (!raw) continue
    roots.push({ name, label, value: raw, exists: existsSync(raw) })
  }
  return roots
}

function fromEnvExe(key: string): { path: string; source: string } | null {
  for (const name of ENV_EXE[key] ?? []) {
    const value = (process.env[name] ?? '').trim()
    if (value && isFile(value)) return { path: value, source: `环境变量 ${name}` }
  }
  return null
}

function fromEnvRoots(key: string, roots: EnvRoot[]): { path: string; source: string } | null {
  const relatives = ENV_RELATIVE[key] ?? []
  if (!relatives.length) return null

  for (const root of roots) {
    if (!root.exists) continue
    for (const relative of relatives) {
      if (relative.includes('*')) {
        for (const hit of globSimple(root.value, relative)) {
          return { path: hit, source: `环境变量 ${root.name}` }
        }
      } else {
        const full = join(root.value, relative.replace(/\//g, '\\'))
        if (isFile(full)) return { path: full, source: `环境变量 ${root.name}` }
      }
    }
  }
  return null
}

// --------------------------------------------------------------------------
// PATH 与简易 glob
// --------------------------------------------------------------------------

function isFile(p: string): boolean {
  try {
    return statSync(p).isFile()
  } catch {
    return false
  }
}

function isDir(p: string): boolean {
  try {
    return statSync(p).isDirectory()
  } catch {
    return false
  }
}

function fromPath(names: string[]): string | null {
  const pathEnv = process.env.PATH ?? ''
  const exts = (process.env.PATHEXT ?? '.EXE;.CMD;.BAT;.COM').split(';').filter(Boolean)

  for (const dir of pathEnv.split(';').filter(Boolean)) {
    for (const name of names) {
      const direct = join(dir, name)
      if (isFile(direct)) return direct
      if (!name.includes('.')) {
        for (const ext of exts) {
          if (isFile(join(dir, name + ext.toLowerCase()))) return join(dir, name + ext.toLowerCase())
          if (isFile(join(dir, name + ext.toUpperCase()))) return join(dir, name + ext.toUpperCase())
        }
      }
    }
  }
  return null
}

/** 只支持单段 `*` 的简易 glob，够用且没有额外依赖 */
function globSimple(root: string, pattern: string, limit = 12): string[] {
  const segments = pattern.replace(/\\/g, '/').split('/').filter(Boolean)
  let current: string[] = [root]
  const hits: string[] = []

  for (let i = 0; i < segments.length; i += 1) {
    const segment = segments[i]
    const isLast = i === segments.length - 1
    const next: string[] = []

    for (const base of current) {
      if (segment.includes('*')) {
        const re = new RegExp(
          '^' + segment.replace(/[.+^${}()|[\]\\]/g, '\\$&').replace(/\*/g, '.*') + '$',
          'i'
        )
        let entries: string[]
        try {
          entries = readdirSync(base)
        } catch {
          continue
        }
        for (const entry of entries) {
          if (!re.test(entry)) continue
          const full = join(base, entry)
          if (isLast) {
            if (isFile(full)) hits.push(full)
          } else if (isDir(full)) {
            next.push(full)
          }
        }
      } else {
        const full = join(base, segment)
        if (isLast) {
          if (isFile(full)) hits.push(full)
        } else if (isDir(full)) {
          next.push(full)
        }
      }
      if (hits.length >= limit) return hits
    }
    current = next
    if (!current.length) break
  }
  return hits
}

// --------------------------------------------------------------------------
// 常见安装位置（最后兜底）
// --------------------------------------------------------------------------

const GLOB_PATTERNS: Record<string, string[]> = {
  openocd: [
    'xpack-openocd-*/bin/openocd.exe',
    'openocd-*/bin/openocd.exe',
    'OpenOCD*/bin/openocd.exe',
    'tool-openocd*/bin/openocd.exe',
    '*/bin/openocd.exe',
    'openocd.exe'
  ],
  arm_gcc: [
    'gnu-tools-for-stm32/*/bin/arm-none-eabi-gcc.exe',
    'GNU-tools-for-stm32/*/bin/arm-none-eabi-gcc.exe',
    'GNU-tools-for-stm32/bin/arm-none-eabi-gcc.exe',
    'Arm GNU Toolchain arm-none-eabi/*/bin/arm-none-eabi-gcc.exe',
    '*/bin/arm-none-eabi-gcc.exe',
    'bin/arm-none-eabi-gcc.exe'
  ],
  cmake: ['cmake-*/bin/cmake.exe', 'CMake/bin/cmake.exe', '*/bin/cmake.exe', 'cmake.exe'],
  ninja: ['*/ninja.exe', '*/bin/ninja.exe', 'ninja.exe'],
  jlink: ['SEGGER/JLink*/JLink.exe', 'JLink*/JLink.exe', '*/JLink.exe']
}

function candidateRoots(): string[] {
  const home = homedir()
  const local = process.env.LOCALAPPDATA ?? join(home, 'AppData', 'Local')
  const roaming = process.env.APPDATA ?? join(home, 'AppData', 'Roaming')

  const roots = [
    join(home, 'Desktop', 'STM32', 'DevEnv'),
    join(home, 'Desktop', 'STM32'),
    join(local, 'stm32cube', 'bundles'),
    join(local, 'stm32cube', 'bundles', 'gnu-tools-for-stm32'),
    join(local, 'Programs'),
    'C:\\ST',
    'C:\\Program Files',
    'C:\\Program Files (x86)',
    join(home, '.platformio', 'packages'),
    'C:\\Keil_v5\\ARM\\ARMCLANG\\bin',
    'C:\\msys64\\mingw64\\bin',
    'C:\\tools',
    join(home, 'scoop', 'apps'),
    'C:\\ProgramData\\chocolatey\\bin',
    roaming
  ]

  // 环境变量指向的根也算兜底候选（万一上面的相对路径没命中）
  for (const root of readEnvRoots()) {
    if (root.exists) roots.push(root.value)
  }

  return roots.filter(isDir)
}

function globCandidates(key: string): string[] {
  const patterns = GLOB_PATTERNS[key] ?? (EXE_NAMES[key] ?? []).map((n) => `*/${n}`)
  const found: string[] = []
  for (const root of candidateRoots()) {
    for (const pattern of patterns) {
      for (const hit of globSimple(root, pattern)) {
        if (!found.includes(hit)) found.push(hit)
      }
    }
  }
  return found
}

// --------------------------------------------------------------------------
// OpenOCD 脚本目录 / SVD 目录
// --------------------------------------------------------------------------

export function findOpenocdScripts(openocdExe: string | null): {
  scripts: string | null
  note: string
} {
  // 1) OpenOCD 自己的环境变量，最权威
  const envScripts = (process.env[OPENOCD_SCRIPTS_ENV] ?? '').trim()
  if (envScripts && isDir(envScripts)) {
    return { scripts: envScripts, note: `环境变量 ${OPENOCD_SCRIPTS_ENV}: ${envScripts}` }
  }

  if (!openocdExe) return { scripts: null, note: '未探测到 openocd.exe' }
  if (!existsSync(openocdExe)) return { scripts: null, note: 'openocd.exe 路径不存在' }

  const exeDir = openocdExe.replace(/[\\/][^\\/]+$/, '')
  const root = exeDir.replace(/[\\/][^\\/]+$/, '')

  const candidates = [
    join(root, 'openocd', 'scripts'), // xpack 布局
    join(root, 'share', 'openocd', 'scripts'), // 官方布局
    join(exeDir, 'scripts'),
    join(root, 'scripts')
  ]

  for (const cand of candidates) {
    if (isDir(cand)) return { scripts: cand, note: `已定位: ${cand}` }
  }
  return { scripts: null, note: '未找到 scripts 目录（请检查 OpenOCD 安装是否完整）' }
}

/**
 * 从 CubeCLT / CubeIDE 自带的 SVD 包里，为某个芯片型号找对应的 .svd。
 * 找到了就能直接填进 cortex-debug 的 svdFile，调试时能看外设寄存器。
 *
 * 注意 SVD 文件名是**按产品线**而不是按具体料号命名的（STM32F100/STM32F101/
 * STM32F103…），所以不能简单地「谁先匹配算谁」—— STM32F103C8T6 用 startsWith
 * 依次比对会先命中 STM32F100。这里改成「谁的型号前缀最长谁最像」。
 */
export function findSvdFile(svdDir: string | null, device: string | null): string | null {
  if (!svdDir || !isDir(svdDir) || !device) return null

  const dev = device.trim().toLowerCase()
  if (!/^stm32/.test(dev)) return null

  const candidates: string[] = []
  const collect = (dir: string, depth: number): void => {
    let entries: string[]
    try {
      entries = readdirSync(dir)
    } catch {
      return
    }
    for (const entry of entries) {
      const full = join(dir, entry)
      if (entry.toLowerCase().endsWith('.svd')) {
        candidates.push(full)
      } else if (depth > 0 && isDir(full)) {
        collect(full, depth - 1)
      }
    }
  }
  collect(svdDir, 2)

  let best: { path: string; score: number } | null = null
  for (const candidate of candidates) {
    const base = basename(candidate)
      .replace(/\.svd$/i, '')
      .toLowerCase()
    if (dev === base) return candidate // 完全一致，直接用
    // 文件名必须是型号的前缀；至少长到 "stm32x#" 才算有意义
    if (base.length >= 7 && dev.startsWith(base)) {
      if (!best || base.length > best.score) best = { path: candidate, score: base.length }
    }
  }

  return best?.path ?? null
}

/** CubeCLT 里自带 STMicroelectronics_CMSIS_SVD */
function findSvdDir(roots: EnvRoot[]): string | null {
  for (const root of roots) {
    if (!root.exists) continue
    for (const relative of ['STMicroelectronics_CMSIS_SVD', 'STM32CubeIDE/plugins']) {
      const full = join(root.value, relative.replace(/\//g, '\\'))
      if (isDir(full)) return full
    }
  }
  return null
}

// --------------------------------------------------------------------------
// 主入口
// --------------------------------------------------------------------------

export function probeVersion(key: string, exe: string, timeoutMs = 6000): string | null {
  const argsMap: Record<string, string[]> = {
    openocd: ['--version'],
    cmake: ['--version'],
    ninja: ['--version'],
    arm_gcc: ['--version'],
    arm_gdb: ['--version'],
    gdb: ['--version'],
    clangd: ['--version']
  }
  const args = argsMap[key]
  if (!args) return null

  const res = spawnSync(exe, args, { timeout: timeoutMs, encoding: 'utf8', windowsHide: true })
  const text = `${res.stdout ?? ''}\n${res.stderr ?? ''}`

  const lines = text
    .split(/\r?\n/)
    .map((l) => l.trim())
    .filter(Boolean)
  if (!lines.length) return null

  const preferred = lines.find((l) =>
    /^(open on-chip|cmake version|gnu gdb|clangd version|ninja)/i.test(l)
  )
  return (preferred ?? lines[0]).slice(0, 140)
}

export function detectTools(preferred: Record<string, string> = {}, probeVersions = false): ToolPaths {
  const envRoots = readEnvRoots()
  const items: Record<string, ToolItem> = {}

  for (const key of Object.keys(EXE_NAMES)) {
    let path: string | null = null
    let source = ''

    // 1) 用户手动指定（最高优先级）
    const saved = (preferred[key] ?? '').trim()
    if (saved && existsSync(saved)) {
      path = saved
      source = '手动指定'
    }

    // 2) 直接指向可执行文件的环境变量
    if (!path) {
      const hit = fromEnvExe(key)
      if (hit) {
        path = hit.path
        source = hit.source
      }
    }

    // 3) 从环境变量的安装根推导
    if (!path) {
      const hit = fromEnvRoots(key, envRoots)
      if (hit) {
        path = hit.path
        source = hit.source
      }
    }

    // 4) 系统 PATH
    if (!path) {
      const hit = fromPath(EXE_NAMES[key])
      if (hit) {
        path = hit
        source = '系统 PATH'
      }
    }

    // 5) 常见安装位置
    if (!path) {
      const hit = globCandidates(key)[0]
      if (hit) {
        path = hit
        source = '常见安装位置'
      }
    }

    items[key] = { key, path, source: path ? source : '', version: null, found: path !== null }
  }

  // 工具链目录：arm_gcc 所在目录；同目录下有 gdb 就补上
  const gccPath = items.arm_gcc?.path
  const toolchainDir = gccPath ? gccPath.replace(/[\\/][^\\/]+$/, '') : null
  if (toolchainDir && !items.arm_gdb?.found) {
    const gdb = join(toolchainDir, 'arm-none-eabi-gdb.exe')
    if (isFile(gdb)) {
      items.arm_gdb = {
        key: 'arm_gdb',
        path: gdb,
        source: '工具链目录',
        version: null,
        found: true
      }
    }
  }

  const { scripts, note } = findOpenocdScripts(items.openocd?.path ?? null)

  if (probeVersions) {
    for (const key of ['openocd', 'cmake', 'arm_gcc', 'ninja']) {
      const item = items[key]
      if (item?.found && item.path) item.version = probeVersion(key, item.path)
    }
  }

  return {
    items,
    openocdScripts: scripts,
    openocdScriptsNote: note,
    toolchainDir,
    envRoots,
    svdDir: findSvdDir(envRoots)
  }
}
