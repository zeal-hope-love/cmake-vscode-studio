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

/**
 * 还没落盘的条目。
 *
 * 历史文件本身也可能写不进去（同目录下两个实例抢同一个 history.json，
 * 或者 EPERM）。以前这里只 console.warn 一句就算了 —— 结果就是
 * **「刚才那次失败的操作」在历史页上完全不存在**，用户回头查不到任何线索。
 * 现在写失败时把条目留在内存里，下一次写历史时一并补上。
 */
let pending: HistoryEntry[] = []

/** pending 上限，防止历史文件长期不可写时内存无限增长 */
const MAX_PENDING = 50

export function addHistory(input: Omit<HistoryEntry, 'id' | 'at'>): HistoryEntry[] {
  const entry: HistoryEntry = {
    ...input,
    id: randomUUID(),
    at: Date.now(),
    actions: input.actions ?? []
  }
  const list = [entry, ...pending, ...listHistory()].slice(0, MAX_ENTRIES)
  // 历史是**辅助记录**，不能反过来把主操作判成失败。
  // config:write 是「先写文件、后记历史」，如果这里把 EPERM 抛出去，
  // 用户会看到「写入失败」，但配置文件其实已经落盘了 —— 更难排查。
  try {
    writeStoreFile(historyFile(), list)
    pending = []
  } catch (err) {
    pending = [entry, ...pending].slice(0, MAX_PENDING)
    console.warn(
      `[history] 历史记录写入失败（不影响本次操作，已暂存 ${pending.length} 条待补写）：${
        err instanceof Error ? err.message : String(err)
      }`
    )
  }
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

/** 明细里最多列多少个失败文件（太多会把历史页撑爆） */
const MAX_ERROR_LINES = 8

/** 绝对路径 → 工程内的短路径，只用于给人看的明细 */
function shortName(projectRoot: string, abs: string): string {
  const root = projectRoot.replace(/[\\/]+$/, '')
  const norm = abs.replace(/[\\/]+/g, '/')
  const normRoot = root.replace(/[\\/]+/g, '/')
  if (norm.toLowerCase().startsWith(normRoot.toLowerCase() + '/')) {
    return norm.slice(normRoot.length + 1)
  }
  return abs
}

/**
 * 把一次写入的结果翻译成历史条目（纯函数，便于单测）。
 *
 * 两个要点（都是踩过的坑）：
 *   1. **失败也要留档**。只记成功的话，用户看到红字之后翻历史是一片安静，
 *      没法回答「刚才到底是哪几个文件没写进去、什么错」。
 *   2. detail 里带**文件名 + 错误码**，不只是数量。「有 5 个文件失败」这种
 *      信息量等于零 —— 用户还得回来再点一次才能看到是哪五个。
 */
export function buildWriteRecord(
  projectRoot: string,
  written: string[],
  errors: string[],
  snapshotId: string | null
): Omit<HistoryEntry, 'id' | 'at'> {
  const failed = errors.length > 0
  const actions: HistoryAction[] = [{ kind: 'preview', label: '再看一次差异', projectRoot }]
  if (failed) {
    // 排在最前面：失败之后最想做的事就是「再试一次」
    actions.unshift({
      kind: 'retry-write',
      label: `重试写入（${errors.length} 个失败）`,
      projectRoot
    })
  }
  if (snapshotId) {
    actions.push({ kind: 'restore-snapshot', label: '还原到这次写入前', snapshotId })
  }
  actions.push(...projectActions(projectRoot))

  let title: string
  if (failed && written.length === 0) {
    title = `写入配置失败（${errors.length} 个文件全没写进去）`
  } else if (failed) {
    title = `写入配置（成功 ${written.length} 个、失败 ${errors.length} 个）`
  } else if (written.length) {
    title = `写入配置（${written.length} 个文件）`
  } else {
    title = '写入配置（内容已是最新）'
  }

  const lines: string[] = []
  if (failed) {
    lines.push('没写进去：')
    lines.push(...errors.slice(0, MAX_ERROR_LINES))
    if (errors.length > MAX_ERROR_LINES) {
      lines.push(`…另有 ${errors.length - MAX_ERROR_LINES} 个`)
    }
    if (written.length) {
      lines.push(`已写入：${written.map((w) => shortName(projectRoot, w)).join('、')}`)
    }
  } else {
    lines.push(written.map((w) => shortName(projectRoot, w)).join('、') || '无需改动')
  }

  return {
    kind: 'write',
    title,
    detail: lines.join('\n'),
    ok: !failed,
    projectRoot,
    actions
  }
}

export function recordWrite(
  projectRoot: string,
  written: string[],
  errors: string[],
  snapshotId: string | null
): void {
  addHistory(buildWriteRecord(projectRoot, written, errors, snapshotId))
}

/**
 * 写入流程**中途炸了**（快照失败、规划异常、IPC 抛错）时也要留档。
 *
 * 这类失败最容易「消失」：recordWrite 根本执行不到，界面只弹一个错误框，
 * 关掉就没了，用户过一会儿回来查历史，什么都没有。
 */
export function recordWriteAbort(projectRoot: string, message: string): void {
  addHistory({
    kind: 'write',
    title: '写入配置没走完（中途出错）',
    detail: message,
    ok: false,
    projectRoot,
    actions: [
      { kind: 'retry-write', label: '重试写入', projectRoot },
      { kind: 'preview', label: '再看一次差异', projectRoot },
      ...projectActions(projectRoot)
    ]
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
