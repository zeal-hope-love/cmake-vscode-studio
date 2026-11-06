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
import {
  toBuiltinPreset,
  type PackPreset
} from '@shared/templateFormat'
import { listPacks } from '../pack/packStore'
import { readStoreFile, userDataPath, writeStoreFile } from './store'

function presetFile(): string {
  return userDataPath('pack-presets.json')
}

/** 用户自己存的那部分（不含内置） */
export function listUserPackPresets(): PackPreset[] {
  const list = readStoreFile<PackPreset[]>(presetFile(), [])
  return Array.isArray(list) ? list : []
}

/**
 * 把每个模块包自带的内置模板展开成 PackPreset。
 *
 * 每次现算而不是落盘 —— 内置模板跟着程序版本走，
 * 落盘的话升级包就要处理「旧的默认模板要不要更新」这种麻烦事。
 */
export function listBuiltinPackPresets(packId?: string): PackPreset[] {
  const out: PackPreset[] = []
  for (const pack of listPacks()) {
    if (packId && pack.id !== packId) continue
    ;(pack.defaultPresets ?? []).forEach((def, i) => {
      out.push(toBuiltinPreset(pack.id, def, i))
    })
  }
  return out
}

/**
 * 全部模板：内置在前，用户存的在后。
 *
 * 顺序有意义 —— 用户扫列表时先看到「官方推荐的那套」，
 * 再看到自己攒的，符合认知顺序。
 */
export function listPackPresets(packId?: string): PackPreset[] {
  const builtin = listBuiltinPackPresets(packId)
  const user = listUserPackPresets().filter((p) => !packId || p.packId === packId)
  return [...builtin, ...user]
}

/** 只列某个模块包的模板（内置 + 自定义） */
export function listPackPresetsFor(packId: string): PackPreset[] {
  return listPackPresets(packId)
}

export function getPackPreset(id: string): PackPreset | null {
  return listPackPresets().find((p) => p.id === id) ?? null
}

/**
 * 存一个模板。
 *
 * `id` 为空表示新建（生成新 UUID）；非空表示覆盖同 id 的。
 * 名字不做唯一性约束 —— 用户可能想存两个「标准步兵」做对比。
 */
export function savePackPreset(input: PackPreset): PackPreset[] {
  const list = listUserPackPresets()
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
  return listPackPresets()
}

/**
 * 删一个模板。
 *
 * 内置模板不允许删 —— 静默忽略，不报错。
 * 界面那边也会把「删除」按钮禁掉，这里是第二道防线。
 */
export function deletePackPreset(id: string): PackPreset[] {
  const list = listUserPackPresets().filter((p) => p.id !== id)
  writeStoreFile(presetFile(), list)
  return listPackPresets()
}