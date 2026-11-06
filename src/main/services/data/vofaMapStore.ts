/**
 * vofa 映射表的读写。
 *
 * 映射表放在 `application/vofa/vofa_map.json`：
 *   · 跟工程走，可以提交到 git，队友共享同一套通道/参数
 *   · 不参与编译，只给工具读
 *   · 重新安装模块时会被一起写回（planPackInstall 会生成这一条 change）
 */

import { existsSync, readFileSync } from 'node:fs'
import { normalizeVofaMap, serializeVofaMap, type VofaMap } from '@shared/vofaMap'
import { writeFileWithRetry } from '../util/fileWrite'
import { resolveInsideProject } from '../generate/writer'

export const VOFA_MAP_REL = 'application/vofa/vofa_map.json'

export function vofaMapPath(projectRoot: string): string | null {
  return resolveInsideProject(projectRoot, VOFA_MAP_REL)
}

export function readVofaMapRaw(projectRoot: string): string | null {
  const abs = vofaMapPath(projectRoot)
  if (!abs || !existsSync(abs)) return null
  try {
    return readFileSync(abs, 'utf8')
  } catch {
    return null
  }
}

export function loadVofaMap(projectRoot: string): VofaMap | null {
  const raw = readVofaMapRaw(projectRoot)
  if (!raw) return null
  try {
    return normalizeVofaMap(JSON.parse(raw))
  } catch {
    return null
  }
}

export function saveVofaMap(
  projectRoot: string,
  map: VofaMap
): { ok: boolean; path: string | null; error?: string } {
  const abs = vofaMapPath(projectRoot)
  if (!abs) return { ok: false, path: null, error: '映射表路径越出了工程根' }
  const normalized = normalizeVofaMap({
    ...map,
    version: 1,
    packId: 'vofa',
    updatedAt: map.updatedAt || Date.now()
  })
  if (!normalized) return { ok: false, path: abs, error: '映射表格式不正确' }
  const r = writeFileWithRetry(abs, serializeVofaMap(normalized), 'vofa 映射表')
  return r.ok ? { ok: true, path: abs } : { ok: false, path: abs, error: r.error }
}
