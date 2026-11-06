/**
 * 配置模板存储。
 *
 * 模板分三层（见 shared/types.ts 的 ConfigTemplate）：
 *   1. target  —— 面向什么（编辑器 / 构建系统 / 探针）
 *   2. options —— 生成参数（只存用户的选择）
 *   3. files   —— 四份文件的内容（可含 ${elfName} 等占位符；缺省则按参数生成）
 *
 * 列表里**永远包含内置模板**（shared/builtinTemplates.ts）。内置的只读：
 * 删不掉、也覆盖不了，避免用户把自己唯一的起点弄没了。
 *
 * 老版本（v1）的模板把 probeKey / targetCfg / adapterSpeed 放在顶层、也没有 target，
 * 读的时候统一迁移一遍再返回，**不覆写磁盘** —— 迁移失败也不至于把用户数据弄丢。
 */

import { randomUUID } from 'node:crypto'
import type { ConfigTemplate, GenOptions, ProbeKey, TemplateTarget } from '@shared/types'
import { BUILTIN_TEMPLATES, isBuiltinTemplateId } from '@shared/builtinTemplates'
import { readStoreFile, userDataPath, writeStoreFile } from './store'

function templatesFile(): string {
  return userDataPath('templates.json')
}

/** 把磁盘上的任意形状迁成当前的 ConfigTemplate；实在认不出来就返回 null */
function migrateTemplate(raw: unknown): ConfigTemplate | null {
  if (!raw || typeof raw !== 'object') return null
  const t = raw as Record<string, unknown>
  if (typeof t.id !== 'string' || !t.id) return null

  const options: Partial<GenOptions> =
    t.options && typeof t.options === 'object' ? { ...(t.options as Partial<GenOptions>) } : {}

  // v1 的顶层字段搬进 options
  if (typeof t.probeKey === 'string' && !options.probeKey) options.probeKey = t.probeKey as ProbeKey
  if (typeof t.adapterSpeed === 'number' && options.adapterSpeed === undefined) {
    options.adapterSpeed = t.adapterSpeed
  }
  if (typeof t.targetCfg === 'string' && options.targetCfg === undefined) {
    options.targetCfg = t.targetCfg
  }

  const fallbackProbe = (options.probeKey ?? 'cmsis-dap') as ProbeKey
  const rawTarget = (t.target ?? {}) as Partial<TemplateTarget>
  const target: TemplateTarget = {
    editor: 'vscode',
    buildSystem: rawTarget.buildSystem === 'dir' ? 'dir' : 'preset',
    probe: rawTarget.probe ?? fallbackProbe
  }

  return {
    id: t.id,
    name: typeof t.name === 'string' && t.name ? t.name : '未命名模板',
    note: typeof t.note === 'string' ? t.note : '',
    createdAt: typeof t.createdAt === 'number' ? t.createdAt : 0,
    updatedAt: typeof t.updatedAt === 'number' ? t.updatedAt : 0,
    builtin: false,
    target,
    options,
    files: t.files && typeof t.files === 'object' ? (t.files as ConfigTemplate['files']) : undefined,
    bundle: (t.bundle as ConfigTemplate['bundle']) ?? undefined
  }
}

/** 用户自己存的模板（不含内置的） */
function readUserTemplates(): ConfigTemplate[] {
  const list = readStoreFile<unknown[]>(templatesFile(), [])
  if (!Array.isArray(list)) return []
  return list
    .map(migrateTemplate)
    .filter((t): t is ConfigTemplate => Boolean(t) && !isBuiltinTemplateId(t!.id))
}

export function listTemplates(): ConfigTemplate[] {
  const user = readUserTemplates().sort((a, b) => b.updatedAt - a.updatedAt)
  // 内置的固定排在前面
  return [...BUILTIN_TEMPLATES, ...user]
}

export function saveTemplate(input: ConfigTemplate): ConfigTemplate[] {
  if (isBuiltinTemplateId(input.id)) {
    throw new Error('内置模板不可修改，请复制一份再改')
  }

  const list = readUserTemplates()
  const now = Date.now()
  const template: ConfigTemplate = {
    ...input,
    id: input.id || randomUUID(),
    createdAt: input.createdAt || now,
    updatedAt: now,
    builtin: false
  }

  const index = list.findIndex((t) => t.id === template.id)
  if (index >= 0) list[index] = template
  else list.unshift(template)

  writeStoreFile(templatesFile(), list)
  return listTemplates()
}

export function deleteTemplate(id: string): ConfigTemplate[] {
  if (isBuiltinTemplateId(id)) {
    throw new Error('内置模板不可删除')
  }
  const list = readUserTemplates().filter((t) => t.id !== id)
  writeStoreFile(templatesFile(), list)
  return listTemplates()
}

export function getTemplate(id: string): ConfigTemplate | null {
  return listTemplates().find((t) => t.id === id) ?? null
}
