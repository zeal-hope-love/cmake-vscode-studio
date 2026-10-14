/**
 * 历史记录。
 *
 * 记在**主进程**而不是渲染进程：真正改文件的操作（写入 / 清除 / 还原 / 批量）
 * 都发生在这里，只有从这里记才不会漏。渲染进程侧的动作（套用模板）
 * 通过 IPC 的 `history:add` 补记。
 *
 * 每条记录都带一组「可直达的操作」，历史页上直接点就能再来一次 ——
 * 比如「重新配置某个工程」「还原到那一次写入之前」「打开那个模板」。
 */

import { randomUUID } from 'node:crypto'
import type { HistoryAction, HistoryEntry } from '@shared/types'
import { readStoreFile, userDataPath, writeStoreFile } from './store'

/** 最多保留多少条，防止文件无限长大 */
const MAX_ENTRIES = 500

function historyFile(): string {
  return userDataPath('history.json')
}

function isValid(raw: unknown): raw is HistoryEntry {
  if (!raw || typeof raw !== 'object') return false
  const e = raw as Record<string, unknown>
  return typeof e.id === 'string' && typeof e.at === 'number' && typeof e.kind === 'string'
}

export function listHistory(): HistoryEntry[] {
  const list = readStoreFile<unknown[]>(historyFile(), [])
  if (!Array.isArray(list)) return []
  return list
    .filter(isValid)
    .map((e) => ({ ...e, actions: Array.isArray(e.actions) ? e.actions : [] }))
    .sort((a, b) => b.at - a.at)
}

export function addHistory(input: Omit<HistoryEntry, 'id' | 'at'>): HistoryEntry[] {
  const entry: HistoryEntry = {
    ...input,
    id: randomUUID(),
    at: Date.now(),
    actions: input.actions ?? []
  }
  const list = [entry, ...listHistory()].slice(0, MAX_ENTRIES)
  writeStoreFile(historyFile(), list)
  return list
}

export function removeHistory(id: string): HistoryEntry[] {
  const list = listHistory().filter((e) => e.id !== id)
  writeStoreFile(historyFile(), list)
  return list
}

export function clearHistory(): HistoryEntry[] {
  writeStoreFile(historyFile(), [])
  return []
}

// --------------------------------------------------------------------------
// 常用条目构造：把「操作」翻译成「带直达按钮的记录」
// --------------------------------------------------------------------------

/** 工程相关的基本按钮：重新配置 / 在 VSCode 打开 / 打开目录 */
export function projectActions(projectRoot: string): HistoryAction[] {
  return [
    { kind: 'reconfigure', label: '重新配置这个工程', projectRoot },
    { kind: 'open-in-vscode', label: '在 VSCode 打开', projectRoot },
    { kind: 'open-in-explorer', label: '打开目录', projectRoot }
  ]
}

export function recordProjectLoad(projectRoot: string, name: string, warnings: number): void {
  addHistory({
    kind: 'project-load',
    title: `检测工程 ${name}`,
    detail: warnings ? `发现 ${warnings} 条需要注意的问题` : '没有发现问题',
    ok: true,
    projectRoot,
    actions: projectActions(projectRoot)
  })
}

export function recordWrite(
  projectRoot: string,
  written: string[],
  errors: string[],
  snapshotId: string | null
): void {
  const actions: HistoryAction[] = [{ kind: 'preview', label: '再看一次差异', projectRoot }]
  if (snapshotId) {
    actions.push({ kind: 'restore-snapshot', label: '还原到这次写入前', snapshotId })
  }
  actions.push(...projectActions(projectRoot))

  addHistory({
    kind: 'write',
    title: written.length ? `写入配置（${written.length} 个文件）` : '写入配置（内容已是最新）',
    detail: errors.length ? `有 ${errors.length} 个文件失败` : written.join('、') || '无需改动',
    ok: errors.length === 0,
    projectRoot,
    actions
  })
}

export function recordClear(
  projectRoot: string,
  deleted: string[],
  errors: string[],
  snapshotId: string | null
): void {
  const actions: HistoryAction[] = []
  if (snapshotId) {
    actions.push({ kind: 'restore-snapshot', label: '还原（撤销这次清除）', snapshotId })
  }
  actions.push({ kind: 'reconfigure', label: '重新配置这个工程', projectRoot })

  addHistory({
    kind: 'clear',
    title: `清除 .vscode 配置（${deleted.length} 个文件）`,
    detail: errors.length ? `有 ${errors.length} 个文件删不掉` : '工程已回到未配置状态',
    ok: errors.length === 0,
    projectRoot,
    actions
  })
}

export function recordRestore(projectRoot: string, restored: string[], removed: string[]): void {
  addHistory({
    kind: 'restore',
    title: `还原到写入前（恢复 ${restored.length} 个、删除 ${removed.length} 个）`,
    detail: restored.join('、') || '没有变化',
    ok: true,
    projectRoot,
    actions: projectActions(projectRoot)
  })
}

export function recordTemplateSave(id: string, name: string, builtin: boolean): void {
  addHistory({
    kind: 'template-save',
    title: builtin ? `复制内置模板为「${name}」` : `保存模板「${name}」`,
    detail: '可在模板与配置页继续编辑',
    ok: true,
    templateId: id,
    actions: [{ kind: 'open-template', label: '打开这个模板', templateId: id }]
  })
}

export function recordTemplateApply(projectRoot: string, templateId: string, name: string): void {
  addHistory({
    kind: 'template-apply',
    title: `套用模板「${name}」`,
    detail: '生成参数已按目标工程重新推导',
    ok: true,
    projectRoot,
    templateId,
    actions: [
      { kind: 'preview', label: '预览差异', projectRoot },
      ...projectActions(projectRoot),
      { kind: 'open-template', label: '打开这个模板', templateId }
    ]
  })
}

export function recordTemplateDelete(name: string): void {
  addHistory({
    kind: 'template-delete',
    title: `删除模板「${name}」`,
    detail: '不可撤销',
    ok: true,
    actions: []
  })
}

export function recordBatch(templateName: string, items: Array<{ ok: boolean }>): void {
  const okCount = items.filter((i) => i.ok).length
  addHistory({
    kind: 'batch',
    title: `批量套用模板「${templateName}」`,
    detail: `成功 ${okCount} 个，失败 ${items.length - okCount} 个`,
    ok: okCount === items.length,
    actions: []
  })
}

export function recordRun(projectRoot: string, label: string, ok: boolean): void {
  addHistory({
    kind: 'run',
    title: label,
    detail: ok ? '执行成功' : '执行失败，详情见构建与烧录页',
    ok,
    projectRoot,
    actions: projectActions(projectRoot)
  })
}
