/**
 * 地址表（`application/vofa/vofa_addr.json`）的读写。
 *
 * 这份文件跟着工程走，和 vofa_map.json 并列但互不影响：
 *   · vofa_map.json  —— 生成代码要看什么（编译期生效，改完要重新生成 + 重编）
 *   · vofa_addr.json —— 运行时按地址看什么（只在上位机发 `am` 命令，源码不动）
 *
 * 所以这份文件**不参与任何生成**，纯粹是「用户挑了哪几个、按什么类型、什么顺序」的记忆。
 * 也正因为不参与生成，重装模块不会覆盖它。
 */

import { existsSync, readFileSync } from 'node:fs'
import {
  normalizeAddrTable,
  serializeAddrTable,
  type AddrSlot,
  type AddrTableFile
} from '@shared/addrTable'
import { writeFileWithRetry } from '../util/fileWrite'
import { resolveInsideProject } from '../generate/writer'

export const VOFA_ADDR_REL = 'application/vofa/vofa_addr.json'

export function addrTablePath(projectRoot: string): string | null {
  return resolveInsideProject(projectRoot, VOFA_ADDR_REL)
}

/**
 * 读工程里存的地址表。
 *
 * 文件不存在**不是错误**：第一次用这条路的工程本来就没有，
 * 返回空表让界面正常显示就对了，不要弹「读取失败」吓人。
 */
export function loadAddrTable(projectRoot: string): { slots: AddrSlot[]; path: string | null } {
  const abs = addrTablePath(projectRoot)
  if (!abs) return { slots: [], path: null }
  if (!existsSync(abs)) return { slots: [], path: abs }
  try {
    const parsed = normalizeAddrTable(JSON.parse(readFileSync(abs, 'utf8')))
    return { slots: parsed?.slots ?? [], path: abs }
  } catch {
    // 文件坏了也当空表：勾选可以重来，没必要因为一个缓存文件挡住整个面板
    return { slots: [], path: abs }
  }
}

export function saveAddrTable(
  projectRoot: string,
  slots: AddrSlot[]
): { ok: boolean; path: string | null; error?: string } {
  const abs = addrTablePath(projectRoot)
  if (!abs) return { ok: false, path: null, error: '地址表路径越出了工程根' }

  const normalized = normalizeAddrTable({ slots })
  if (!normalized) return { ok: false, path: abs, error: '地址表格式不正确' }

  const table: AddrTableFile = {
    version: 1,
    packId: 'vofa',
    updatedAt: Date.now(),
    slots: normalized.slots
  }
  const r = writeFileWithRetry(abs, serializeAddrTable(table), 'vofa 地址表')
  return r.ok ? { ok: true, path: abs } : { ok: false, path: abs, error: r.error }
}
