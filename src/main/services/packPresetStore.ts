/**
 * 模块包模板（PackPreset）的读写。
 *
 * 和工程配置模板（`templateStore.ts`）分开存两个文件：
 *   · templates.json       工程配置模板
 *   · pack-presets.json    模块包模板
 *
 * 为什么不塞进同一个文件：两者生命周期不同 —— 工程配置模板会被
 * 「多工程批量套用」遍历，模块包模板完全不需要。混在一起每次都要过滤。
 * 导出时再由 `templateFormat.ts` 合成一个文件给用户。
 */

import { randomUUID } from 'node:crypto'
import type { PackPreset } from '@shared/templateFormat'
import { readStoreFile, userDataPath, writeStoreFile } from './store'

function presetFile(): string {
  return userDataPath('pack-presets.json')
}

export function listPackPresets(): PackPreset[] {
  const list = readStoreFile<PackPreset[]>(presetFile(), [])
  return Array.isArray(list) ? list : []
}

/** 只列某个模块包的模板 */
export function listPackPresetsFor(packId: string): PackPreset[] {
  return listPackPresets().filter((p) => p.packId === packId)
}

export function getPackPreset(id: string): PackPreset | null {
  return listPackPresets().find((p) => p.id === id) ?? null
}

/**
 * 存一个模板。
 *
 * `id` 为空表示新建（生成新 UUID）；非空表示覆盖同 id 的。
 * 名字不做唯一性约束 —— 用户可能想存两个「标准步兵」再做对比。
 */
export function savePackPreset(input: PackPreset): PackPreset[] {
  const list = listPackPresets()
  const now = Date.now()
  const preset: PackPreset = {
    ...input,
    id: input.id || randomUUID(),
    createdAt: input.createdAt || now,
    updatedAt: now
  }

  const idx = list.findIndex((p) => p.id === preset.id)
  if (idx >= 0) list[idx] = preset
  else list.push(preset)

  writeStoreFile(presetFile(), list)
  return list
}

export function deletePackPreset(id: string): PackPreset[] {
  const list = listPackPresets().filter((p) => p.id !== id)
  writeStoreFile(presetFile(), list)
  return list
}