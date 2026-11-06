/**
 * .vscode 里哪些文件是**本工具写的**。
 *
 * 为什么需要：本工具和别的扩展（STM32Cube for VS Code、CMake Tools…）都往
 * `.vscode/` 里写同名文件。判断「能不能删」如果只看「文件存在」，就会把别人的
 * 配置当成自己的删掉 —— 那是不可逆的破坏。
 *
 * 所以这里按**内容特征**认：只有长得确实像本工具生成的那几个文件才认得下，
 * 认不出来的一律当作别人的，不碰，并在界面上说明「这几个不是我写的，没动」。
 *
 * 宁可少删（留下几个本来该删的），也不能多删（删掉别人的配置）。
 */

import { existsSync, readdirSync, readFileSync } from 'node:fs'
import { join } from 'node:path'

export interface ManagedFileVerdict {
  /** 相对工程根，例如 .vscode/launch.json */
  path: string
  ours: boolean
  /** 为什么这么判，显示给用户看 */
  why: string
}

/** 本工具生成的任务名（生成器里用的就是这几个） */
const OUR_TASK_NAMES = /^(构建 Debug|构建 Release|烧录|擦除|清理|列出串口)/

function readJson(file: string): unknown {
  try {
    return JSON.parse(readFileSync(file, 'utf8'))
  } catch {
    return null
  }
}

/** settings.json：本工具会写 C_Cpp.default.*（其它扩展一般写 cmake.* / files.*） */
function judgeSettings(file: string): { ours: boolean; why: string } {
  const j = readJson(file) as Record<string, unknown> | null
  if (!j || typeof j !== 'object') return { ours: false, why: '解析不了，不确定是谁写的' }
  const keys = Object.keys(j)
  if (keys.some((k) => k.startsWith('C_Cpp.default.'))) {
    return { ours: true, why: '里面有 C_Cpp.default.* 键，是本工具写的' }
  }
  if (keys.some((k) => k.startsWith('cmake.'))) {
    return { ours: false, why: '只有 cmake.* 之类的键，看起来是 CMake Tools / STM32Cube 扩展写的' }
  }
  return { ours: false, why: '没有本工具写入的特征键' }
}

/** c_cpp_properties.json：本工具写的 intelliSenseMode 是 windows/linux/macos-gcc*，不是 msvc */
function judgeCppProps(file: string): { ours: boolean; why: string } {
  const j = readJson(file) as { configurations?: Array<Record<string, unknown>> } | null
  if (!j || !Array.isArray(j.configurations)) {
    return { ours: false, why: '解析不了，不确定是谁写的' }
  }
  const ours = j.configurations.some(
    (c) =>
      typeof c.compileCommands === 'string' &&
      typeof c.intelliSenseMode === 'string' &&
      /gcc/.test(String(c.intelliSenseMode))
  )
  if (ours) return { ours: true, why: '有 compileCommands + gcc 的 IntelliSense 模式，是本工具写的' }
  const msvc = j.configurations.some((c) => /msvc/.test(String(c.intelliSenseMode ?? '')))
  return {
    ours: false,
    why: msvc
      ? 'IntelliSense 模式是 msvc（本工具写 gcc-arm），看起来是别的扩展写的'
      : '没有本工具写入的特征'
  }
}

/** launch.json：本工具写的烧录配置带 preLaunchTask「构建 Debug」 */
function judgeLaunch(file: string): { ours: boolean; why: string } {
  const j = readJson(file) as { configurations?: Array<Record<string, unknown>> } | null
  if (!j || !Array.isArray(j.configurations)) {
    return { ours: false, why: '解析不了，不确定是谁写的' }
  }
  const ours = j.configurations.some((c) =>
    ['构建 Debug', '构建 Release'].includes(String(c.preLaunchTask ?? ''))
  )
  return ours
    ? { ours: true, why: '里面有 preLaunchTask「构建 Debug/Release」，是本工具写的' }
    : { ours: false, why: '没有本工具写入的特征（本工具会带 preLaunchTask「构建 Debug」）' }
}

/** tasks.json：本工具写的任务名是「构建 Debug」「烧录」这些 */
function judgeTasks(file: string): { ours: boolean; why: string } {
  const j = readJson(file) as { tasks?: Array<Record<string, unknown>> } | null
  if (!j || !Array.isArray(j.tasks)) return { ours: false, why: '解析不了，不确定是谁写的' }
  const ours = j.tasks.some((t) => OUR_TASK_NAMES.test(String(t.label ?? '')))
  return ours
    ? { ours: true, why: '任务名对得上本工具生成的（构建 Debug / 烧录 …）' }
    : { ours: false, why: '任务名对不上本工具生成的，没动它' }
}

/**
 * 看看 `.vscode` 里哪些是本工具写的。
 * @returns ours 可以被安全删除；all 里带理由，界面用来解释「为什么没动那几个」
 */
export function inspectVscodeOwnership(projectRoot: string): {
  ours: string[]
  all: ManagedFileVerdict[]
} {
  const vscodeDir = join(projectRoot, '.vscode')
  const all: ManagedFileVerdict[] = []
  if (!existsSync(vscodeDir)) return { ours: [], all }

  const judge = (name: string): { ours: boolean; why: string } => {
    const file = join(vscodeDir, name)
    if (name === 'settings.json') return judgeSettings(file)
    if (name === 'c_cpp_properties.json') return judgeCppProps(file)
    if (name === 'launch.json') return judgeLaunch(file)
    if (name === 'tasks.json') return judgeTasks(file)
    return { ours: false, why: '不认识的文件' }
  }

  const names = ['launch.json', 'tasks.json', 'settings.json', 'c_cpp_properties.json']
  for (const n of names) {
    if (!existsSync(join(vscodeDir, n))) continue
    const v = judge(n)
    all.push({ path: `.vscode/${n}`, ours: v.ours, why: v.why })
  }
  try {
    for (const entry of readdirSync(vscodeDir)) {
      // openocd-*.cfg 这个文件名格式是本工具独有的，出现就是我们写的
      if (/^openocd-.*\.cfg$/i.test(entry)) {
        all.push({
          path: `.vscode/${entry}`,
          ours: true,
          why: 'openocd-*.cfg 这个文件名格式是本工具生成的'
        })
      }
    }
  } catch {
    /* ignore */
  }

  return { ours: all.filter((v) => v.ours).map((v) => v.path), all }
}
