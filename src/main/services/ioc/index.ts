/**
 * STM32 CubeMX `.ioc` 解析 + 芯片 → OpenOCD target 映射。
 *
 * 芯片型号一律从工程自身读出来，不靠用户手输：
 * Mcu.CPN（完整订货号）→ Mcu.UserName → Mcu.Name，依次回退。
 *
 * ## 这一族三个文件的分工（别再加第四个）
 *
 * | 文件 | 关注点 | 有没有副作用 |
 * | --- | --- | --- |
 * | `index.ts` | **读**：找 .ioc、解析键值、认芯片 | 纯读 |
 * | `edit.ts`  | **写**：按 `key=` 定位改一行，保持编码/换行 | 写盘（调用方决定何时） |
 * | `uart.ts`  | **算**：某个串口要达到目标状态该改哪些键 | 纯读（只算，不写） |
 *
 * 典型调用链：`uart.planUartIoc()` 算出改动 → 调用方展示 diff →
 * `edit.IocEditor` 落盘 → `cubeMx.runCubeMxAndVerify()` 重新生成。
 *
 * ## 一条硬规则
 *
 * `.ioc` 的键会被 CubeMX 重新生成时**整体重排**，所以这里所有写入都必须走
 * `IocEditor.set()`（按 key 匹配），**禁止按行号改**。历史上按行号写过一次，
 * 表现为「改完不生效、也不报错」，排查了两小时。
 */

import { existsSync, readFileSync, readdirSync } from 'node:fs'
import { basename, dirname, join } from 'node:path'
import type { IocInfo } from '@shared/types'
import { guessChipFamily, mapOpenocdTarget, openocdCfgFileName } from '@shared/chipTargets'

/** 在工程根找一个 .ioc；多个时优先与目录同名的那个 */
export function findIocFile(root: string): string | null {
  let entries: string[]
  try {
    entries = readdirSync(root).filter((f) => f.toLowerCase().endsWith('.ioc'))
  } catch {
    return null
  }
  if (!entries.length) return null

  const wanted = basename(root).toLowerCase()
  const exact = entries.find((f) => f.slice(0, -4).toLowerCase() === wanted)
  return join(root, exact ?? entries.sort()[0])
}

/**
 * 读 `.ioc` 里的某个键（原样返回，含 `\:` 这类转义）。
 *
 * 给「兼容性检查想知道当前波特率是多少」这类**只要一个值**的场景用 ——
 * 走 `parseIoc` 会把整份芯片信息都解一遍，没必要。
 */
export function readIocKey(filePath: string, key: string): string | null {
  if (!existsSync(filePath)) return null
  try {
    for (const line of readFileSync(filePath, 'utf8').split(/\r?\n/)) {
      if (!line.startsWith(`${key}=`)) continue
      return line.slice(key.length + 1)
    }
  } catch {
    return null
  }
  return null
}

export function parseIoc(filePath: string): IocInfo | null {
  if (!existsSync(filePath)) return null

  const values: Record<string, string> = {}
  try {
    for (const line of readFileSync(filePath, 'utf8').split(/\r?\n/)) {
      const trimmed = line.trim()
      if (!trimmed || trimmed.startsWith('#') || !trimmed.includes('=')) continue
      const eq = trimmed.indexOf('=')
      values[trimmed.slice(0, eq).trim()] = trimmed.slice(eq + 1).trim()
    }
  } catch {
    return null
  }

  if (!Object.keys(values).length) return null

  const cpn = values['Mcu.CPN'] || null
  const userName = values['Mcu.UserName'] || null
  const mcuName = values['Mcu.Name'] || null

  const device = cpn || userName || (mcuName ? mcuName.split('(')[0].trim() : null)

  return {
    file: filePath,
    cpn,
    userName,
    mcuName,
    family: values['Mcu.Family'] || null,
    package: values['Mcu.Package'] || null,
    projectName: values['ProjectManager.ProjectName'] || null,
    device
  }
}

// --------------------------------------------------------------------------
// 芯片 → OpenOCD target/*.cfg
//
// 映射表本体在 @shared/chipTargets，渲染进程也要用同一份。
// --------------------------------------------------------------------------

/**
 * 候选 target 配置：先按系列映射，再在 scripts/target 里按前缀找实际存在的文件，
 * 兼容不同 OpenOCD 版本文件名不一致的情况。
 */
export function openocdTargetCandidates(
  device: string | null | undefined,
  scriptsDir: string | null
): string[] {
  const result: string[] = []
  const primary = mapOpenocdTarget(device)
  if (primary) result.push(primary)

  const family = guessChipFamily(device)
  if (family && scriptsDir) {
    const targetDir = join(scriptsDir, 'target')
    try {
      const prefix = `stm32${family.toLowerCase()}`
      for (const f of readdirSync(targetDir).sort()) {
        if (f.startsWith(prefix) && f.endsWith('.cfg') && !result.includes(f)) {
          result.push(f)
        }
      }
    } catch {
      /* 目录不存在就算了 */
    }
  }
  return result
}

export { basename, dirname, guessChipFamily, mapOpenocdTarget, openocdCfgFileName }
