/**
 * 「构建目标与源文件」页的服务层。
 *
 * 三件事：
 *   1. scanSources   —— 读工程，列出目标、已在构建里的源文件、以及**磁盘上有但没进构建的**
 *   2. previewSourceChange —— 算出加/删之后的全文，交给界面做 diff（不落盘）
 *   3. applySourceChange   —— 落盘（先存快照，可一键还原）+ 记历史
 *
 * 最关键的一条判断：「没进构建」要拿**整个工程所有 CMakeLists** 里的引用做参照，
 * 而不是只看根文件。真实 STM32 工程把 HAL / FreeRTOS 的源文件放在
 * `cmake/stm32cubemx/CMakeLists.txt` 里，只比根文件的话会冒出几百条假警报。
 *
 * 第二条：**只拿可编译的扩展名做比较**。头文件本来就不需要写进 CMakeLists
 * （编译器靠 `#include` 找），把它们算进来同样会淹没真正的遗漏。
 */

import { existsSync, mkdirSync, readdirSync, readFileSync, statSync, writeFileSync } from 'node:fs'
import { dirname, join, posix, sep } from 'node:path'
import { buildCmakeModel, collectReferencedPaths, type CmakeModel } from './cmakeModel'
import { planSourceEdit, type CmakeEditPlan } from './cmakeEdit'
import { captureSnapshot } from './snapshotStore'
import { recordWrite } from './historyStore'

// --------------------------------------------------------------------------
// 扫描
// --------------------------------------------------------------------------

/** 需要写进 CMakeLists 才会被编译的扩展名（**不含**头文件） */
const COMPILABLE = /\.(c|cc|cpp|cxx|c\+\+|m|mm|s|asm)$/i
/** 头文件 —— 只统计数量，不参与「没进构建」的判断 */
const HEADER = /\.(h|hh|hpp|hxx|inc)$/i

const SKIP_DIRS = new Set([
  '.git',
  '.hg',
  '.svn',
  'build',
  'out',
  'dist',
  'node_modules',
  '.vscode',
  '.idea',
  '.settings',
  '.cache',
  'CMakeFiles'
])

export interface SourceTargetRow {
  name: string
  kind: string
  declaredLine: number
  declaredCommand: string
  sourceCount: number
  includeCount: number
  defineCount: number
  linkCount: number
  usesGlob: boolean
}

export interface CmakeScanResult {
  root: string
  cmakeFile: string
  /** 根 CMakeLists 的工程名 */
  projectName: string | null
  targets: SourceTargetRow[]
  /** **根目标**在构建里的源文件（相对路径，posix 排序后） */
  inBuild: string[]
  /** 磁盘上可编译、但整个工程都没引用到的 —— 这才是「要加进构建」的候选 */
  orphans: string[]
  /** 模型里写了、磁盘上却没有的（改名/删除留下的残迹） */
  missing: Array<{ relPath: string; raw: string; line: number }>
  stats: {
    compilableOnDisk: number
    headersOnDisk: number
    referencedProjectWide: number
    cmakeListsCount: number
  }
  diagnostics: string[]
  /** 解析不出来源文件的条目（变量展不开），界面上灰着显示 */
  unresolved: Array<{ raw: string; line: number }>
}

function walkCompilable(root: string, depth = 0, acc: string[] = []): string[] {
  if (depth > 8) return acc
  let entries: import('node:fs').Dirent[]
  try {
    entries = readdirSync(root, { withFileTypes: true })
  } catch {
    return acc
  }
  for (const e of entries) {
    const full = join(root, e.name)
    if (e.isDirectory()) {
      if (SKIP_DIRS.has(e.name)) continue
      walkCompilable(full, depth + 1, acc)
    } else if (COMPILABLE.test(e.name)) {
      acc.push(full)
    }
  }
  return acc
}

export function scanSources(projectRoot: string): CmakeScanResult {
  const cmakeFile = join(projectRoot, 'CMakeLists.txt')
  const model = buildCmakeModel(cmakeFile, projectRoot)
  const ref = collectReferencedPaths(projectRoot)

  const rootTarget = model.targets.find((t) => t.kind === 'executable') ?? model.targets[0]

  const inBuild = (rootTarget?.sources ?? [])
    .filter((s) => s.relPath)
    .map((s) => s.relPath!)
    .sort((a, b) => a.localeCompare(b))

  const unresolved = (rootTarget?.sources ?? [])
    .filter((s) => !s.relPath)
    .map((s) => ({ raw: s.raw, line: s.line }))

  const missing = (rootTarget?.sources ?? [])
    .filter((s) => s.relPath && !s.exists)
    .map((s) => ({ relPath: s.relPath!, raw: s.raw, line: s.line }))

  // 磁盘上的可编译文件，逐个和「全工程引用集合」比
  const abs = walkCompilable(projectRoot)
  const orphans: string[] = []
  let headersOnDisk = 0
  for (const f of abs) {
    const rel = f
      .slice(projectRoot.length)
      .replace(/^[\\/]/, '')
      .split(sep)
      .join(posix.sep)
    if (HEADER.test(rel)) headersOnDisk += 1
    if (!ref.sources.has(rel.toLowerCase())) orphans.push(rel)
  }

  // 头文件单独数一遍（walkCompilable 只收可编译的，所以走一次全量）
  let allHeaders = 0
  const countHeaders = (dir: string, d = 0): void => {
    if (d > 8) return
    let es: import('node:fs').Dirent[]
    try {
      es = readdirSync(dir, { withFileTypes: true })
    } catch {
      return
    }
    for (const e of es) {
      if (e.isDirectory()) {
        if (!SKIP_DIRS.has(e.name)) countHeaders(join(dir, e.name), d + 1)
      } else if (HEADER.test(e.name)) allHeaders += 1
    }
  }
  countHeaders(projectRoot)

  orphans.sort((a, b) => a.localeCompare(b))

  return {
    root: projectRoot,
    cmakeFile,
    projectName: model.projectName,
    targets: model.targets.map((t) => ({
      name: t.name,
      kind: t.kind,
      declaredLine: t.declaredAt.line,
      declaredCommand: t.declaredAt.command,
      sourceCount: t.sources.length,
      includeCount: t.includeDirs.length,
      defineCount: t.defines.length,
      linkCount: t.linkLibs.length,
      usesGlob: t.globPatterns.length > 0
    })),
    inBuild,
    orphans,
    missing,
    stats: {
      compilableOnDisk: abs.length,
      headersOnDisk: allHeaders,
      referencedProjectWide: ref.sources.size,
      cmakeListsCount: ref.dirs.length
    },
    diagnostics: model.diagnostics,
    unresolved
  }
}

// --------------------------------------------------------------------------
// 预览与写入
// --------------------------------------------------------------------------

export interface CmakeChangeRequest {
  root: string
  targetName: string
  add?: string[]
  remove?: string[]
}

export interface CmakeChangePreview {
  file: string
  /** 相对工程根，用于快照 */
  relativePath: string
  before: string
  after: string
  notes: string[]
  added: string[]
  removed: string[]
  usedFallback: boolean
  /** 有没有实际改动 */
  changed: boolean
}

function planFor(req: CmakeChangeRequest): { model: CmakeModel; plan: CmakeEditPlan } {
  const cmakeFile = join(req.root, 'CMakeLists.txt')
  const model = buildCmakeModel(cmakeFile, req.root)
  const plan = planSourceEdit(model, {
    targetName: req.targetName,
    add: req.add ?? [],
    remove: req.remove ?? []
  })
  return { model, plan }
}

export function previewSourceChange(req: CmakeChangeRequest): CmakeChangePreview {
  const { plan } = planFor(req)
  return {
    file: plan.file,
    relativePath: 'CMakeLists.txt',
    before: plan.before,
    after: plan.after,
    notes: plan.notes,
    added: plan.added,
    removed: plan.removed,
    usedFallback: plan.usedFallback,
    changed: plan.before !== plan.after
  }
}

export interface CmakeApplyResult {
  ok: boolean
  file: string
  added: string[]
  removed: string[]
  notes: string[]
  usedFallback: boolean
  /** 写入前存的快照 id，可用于一键还原；没改动时为 null */
  snapshotId: string | null
  errors: string[]
}

export function applySourceChange(req: CmakeChangeRequest): CmakeApplyResult {
  const result: CmakeApplyResult = {
    ok: false,
    file: join(req.root, 'CMakeLists.txt'),
    added: [],
    removed: [],
    notes: [],
    usedFallback: false,
    snapshotId: null,
    errors: []
  }

  let planned: CmakeChangePreview
  try {
    planned = previewSourceChange(req)
  } catch (err) {
    result.errors.push(`解析失败：${(err as Error).message}`)
    return result
  }

  result.notes = planned.notes
  result.added = planned.added
  result.removed = planned.removed
  result.usedFallback = planned.usedFallback

  if (!planned.changed) {
    result.ok = true
    result.notes.push('内容没有变化，没有写入。')
    return result
  }

  // 1) 先存快照 —— 顺序很重要：快照必须在写之前
  try {
    result.snapshotId = captureSnapshot(req.root, [
      { relativePath: 'CMakeLists.txt', previous: planned.before }
    ])
  } catch (err) {
    result.errors.push(`存快照失败，已中止写入：${(err as Error).message}`)
    return result
  }

  // 2) 落盘
  try {
    writeFileSync(planned.file, planned.after, 'utf8')
  } catch (err) {
    result.errors.push(`写 CMakeLists.txt 失败：${(err as Error).message}`)
    return result
  }

  // 3) 记历史（复用现有的 recordWrite，历史页能直接看到「还原到这次写入前」）
  try {
    const what = [
      planned.added.length ? `加入 ${planned.added.length} 个源文件` : '',
      planned.removed.length ? `移除 ${planned.removed.length} 个源文件` : ''
    ]
      .filter(Boolean)
      .join('、')
    recordWrite(req.root, [`CMakeLists.txt（${what}）`], [], result.snapshotId)
  } catch {
    /* 历史记不上不影响主流程 */
  }

  result.ok = true
  return result
}

// --------------------------------------------------------------------------
// 新建源文件
// --------------------------------------------------------------------------

export type NewFileKind = 'c' | 'h' | 'cpp' | 'task-c' | 'task-h'

/** 从文件名推 include guard：`application/vofa_task.h` → `VOFA_TASK_H` */
function guardFrom(relPath: string): string {
  const base = posix.basename(relPath).replace(/\.[^.]+$/, '')
  return `${base.replace(/[^A-Za-z0-9]+/g, '_').toUpperCase()}_H`
}

export function renderNewFile(kind: NewFileKind, relPath: string, projectName?: string): string {
  const base = posix.basename(relPath).replace(/\.[^.]+$/, '')
  const guard = guardFrom(relPath)
  const banner = `/**\n  ******************************************************************************\n  * @file    ${posix.basename(relPath)}\n  * @brief   TODO\n  ******************************************************************************\n  */`

  switch (kind) {
    case 'h':
      return `${banner}\n#ifndef ${guard}\n#define ${guard}\n\n#ifdef __cplusplus\nextern "C" {\n#endif\n\n/* TODO: 声明 */\n\n#ifdef __cplusplus\n}\n#endif\n\n#endif /* ${guard} */\n`

    case 'cpp':
      return `${banner}\n\n#include "${base}.h"\n\nnamespace {\n\n} // namespace\n`

    case 'task-h':
      return `${banner}\n#ifndef ${guard}\n#define ${guard}\n\n#include "struct_typedef.h"\n\n#ifdef __cplusplus\nextern "C" {\n#endif\n\n/**\n  * @brief  ${base} 任务入口，在 freertos.c 里用 osThreadCreate 创建\n  */\nextern void ${base}(void const *argument);\n\n#ifdef __cplusplus\n}\n#endif\n\n#endif /* ${guard} */\n`

    case 'task-c':
      return `${banner}\n\n#include "${base}.h"\n\n#include "cmsis_os.h"\n\n/**\n  * @brief  ${base} 任务\n  * @note   在 Src/freertos.c 里创建：\n  *           osThreadDef(${base}, ${base}, osPriorityNormal, 0, 512);\n  *           osThreadCreate(osThread(${base}), NULL);\n  */\nvoid ${base}(void const *argument)\n{\n    (void)argument;\n\n    for (;;)\n    {\n        osDelay(1);\n    }\n}\n`

    case 'c':
    default:
      return `${banner}\n\n#include "${base}.h"\n\n/* TODO: 实现 */\n`
  }
}

export interface CreateFileResult {
  ok: boolean
  relPath: string
  absPath: string
  error?: string
}

export function createSourceFile(
  projectRoot: string,
  relPath: string,
  kind: NewFileKind
): CreateFileResult {
  const clean = relPath.replace(/\\/g, '/').replace(/^\/+/, '')
  const abs = join(projectRoot, clean.split(posix.sep).join(sep))
  const res: CreateFileResult = { ok: false, relPath: clean, absPath: abs }

  // 不许越界
  const rootNorm = projectRoot.replace(/\\/g, '/').toLowerCase()
  if (!abs.replace(/\\/g, '/').toLowerCase().startsWith(rootNorm)) {
    res.error = '路径越出工程范围'
    return res
  }
  if (!COMPILABLE.test(abs) && !HEADER.test(abs)) {
    res.error = '只支持 .c / .cpp / .h 这类源码文件'
    return res
  }
  if (existsSync(abs)) {
    res.error = `${clean} 已经存在了`
    return res
  }

  try {
    mkdirSync(dirname(abs), { recursive: true })
    writeFileSync(abs, renderNewFile(kind, clean), 'utf8')
    res.ok = true
  } catch (err) {
    res.error = (err as Error).message
  }
  return res
}

/** 读一个源文件的前若干行，给界面做预览 */
export function peekSourceFile(
  projectRoot: string,
  relPath: string,
  maxLines = 40
): { ok: boolean; text: string; truncated: boolean; error?: string } {
  const abs = join(projectRoot, relPath.replace(/\\/g, '/').split(posix.sep).join(sep))
  const rootNorm = projectRoot.replace(/\\/g, '/').toLowerCase()
  if (!abs.replace(/\\/g, '/').toLowerCase().startsWith(rootNorm)) {
    return { ok: false, text: '', truncated: false, error: '路径越出工程范围' }
  }
  try {
    const st = statSync(abs)
    if (!st.isFile()) return { ok: false, text: '', truncated: false, error: '不是文件' }
    const text = readFileSync(abs, 'utf8')
    const lines = text.split(/\r?\n/)
    const truncated = lines.length > maxLines
    return { ok: true, text: lines.slice(0, maxLines).join('\n'), truncated }
  } catch (err) {
    return { ok: false, text: '', truncated: false, error: (err as Error).message }
  }
}
