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
import {
  buildCmakeModel,
  buildProjectBuildModel,
  collectReferencedPaths,
  type CmakeModel
} from './cmakeModel'
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
  /** **根 CMakeLists 里**声明的目标 —— 只有这些能被本页改写 */
  targets: SourceTargetRow[]
  /**
   * 整个构建图里的全部 target（含子 CMakeLists / 被 include 的 .cmake 里声明的）。
   * 界面用来说明「为什么有 N 个 CMakeLists」：它们不是 N 个工程，是一个构建图。
   */
  allTargets: Array<{
    name: string
    kind: string
    file: string
    sourceCount: number
    isExecutable: boolean
  }>
  /** 构建入口（永远是根 CMakeLists.txt） */
  buildEntry: string
  /**
   * 疑似「别的构建系统留下的残留」——例如 Keil 时代的 MDK-ARM/ 目录。
   * 这些不是 CMake 的源文件，但也确实不在构建里；要跟「漏加」区分开。
   */
  leftovers: Array<{ relPath: string; reason: string; system: string }>
  /**
   * 构建文件的注释里提到某个「不在构建里」的文件的地方 —— **引用原文 + 出处**。
   *
   * 界面照原样显示，不下「工具判定你故意排除了」这种结论：
   * 一来措辞穷举不完（intentionally excluded / 故意排除 / 暂时不编译…），
   * 二来一旦替注释背书，注释过期了界面还在斩钉截铁地说。
   * 把原话和出处摆出来，判断权留给你。
   */
  orphanNotes: Array<{
    relPath: string
    notes: Array<{ file: string; line: number; text: string }>
  }>
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
    /**
     * 构建定义**没看全**的地方（file(GLOB)、展开不了的变量、跟不进的 include）。
     *
     * 非空时界面必须提醒「这份清单可能不准」并禁用「加入构建」：
     * 只看根 CMakeLists.txt 会漏掉 include()/add_subdirectory() 里的源文件，
     * 把本来就在构建里的报成遗漏，用户照着点会重复编译、链接报 multiple definition。
     */
    cmakeUnresolved: string[]
    /** 解析过哪些 CMake 文件，用来向用户解释结论是怎么来的 */
    cmakeParsedFiles: string[]
    cmakeListsCount: number
  }
  diagnostics: string[]
  /** 解析不出来源文件的条目（变量展不开），界面上灰着显示 */
  unresolved: Array<{ raw: string; line: number }>
  /** 工程里所有含源码的目录（含 '.'），给「新建文件」的下拉用 */
  dirs: string[]
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
  // 「参与构建的源文件」要取**整个构建图**的并集，不能只看根 CMakeLists 里那个目标。
  // 分模块布局（根里 target_sources 是 CubeMX 的空占位，真清单在 include() 进来的
  // cmake/user.cmake）和多目录布局（挂在 add_subdirectory 的子文件上）都靠这个。
  // 只看根文件会得出一份「看起来很确定、实际是错的」遗漏清单 ——
  // 用户照着点「加入构建」会重复编译，链接报 multiple definition。
  const full = buildProjectBuildModel(projectRoot)
  const ref = collectReferencedPaths(projectRoot)

  const rootTarget = model.targets.find((t) => t.kind === 'executable') ?? model.targets[0]

  const inBuild = (
    full.sources.length
      ? full.sources
      : (rootTarget?.sources ?? []).filter((s) => s.relPath).map((s) => s.relPath!)
  ).sort((a, b) => a.localeCompare(b))

  const unresolved = (rootTarget?.sources ?? [])
    .filter((s) => !s.relPath)
    .map((s) => ({ raw: s.raw, line: s.line }))

  const missing = (rootTarget?.sources ?? [])
    .filter((s) => s.relPath && !s.exists)
    .map((s) => ({ relPath: s.relPath!, raw: s.raw, line: s.line }))

  // 磁盘上的可编译文件，逐个和「全工程引用集合」比。
  // 这里必须用**整个构建图**的集合（full.sources），不能用只看根 CMakeLists 的
  // ref.sources —— 否则分模块布局下，写在 include() 进来的 cmake/user.cmake 里的
  // 源文件会被全部误报成「不在构建里」。
  const buildSet = new Set<string>(full.sources.map((s) => s.toLowerCase()))
  for (const s of ref.sources) buildSet.add(s.toLowerCase())
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
    if (!buildSet.has(rel.toLowerCase())) orphans.push(rel)
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

  /**
   * 把「别的构建系统留下的残留」从「漏加的源文件」里分出来。
   *
   * 二者的处理方式完全相反：漏加的要补进 CMakeLists，残留的应该删掉或无视。
   * 混在一起显示，用户很容易把 Keil 时代的 MDK-ARM/delay.c 当成漏加的文件加进构建，
   * 那会引入一份和现在完全无关的旧代码。
   */
  const keilDirs = new Set<string>()
  const scanForBuildSystemFiles = (dir: string, d = 0): void => {
    if (d > 8) return
    let es: import('node:fs').Dirent[]
    try {
      es = readdirSync(dir, { withFileTypes: true })
    } catch {
      return
    }
    for (const e of es) {
      if (e.isDirectory()) {
        if (!SKIP_DIRS.has(e.name)) scanForBuildSystemFiles(join(dir, e.name), d + 1)
      } else if (/\.(uvprojx|uvoptx|ewp|eww)$/i.test(e.name)) {
        // 这个目录属于某个 Keil / IAR 工程
        keilDirs.add(
          dir
            .slice(projectRoot.length)
            .replace(/^[\\/]/, '')
            .split(sep)
            .join(posix.sep)
        )
      }
    }
  }
  scanForBuildSystemFiles(projectRoot)

  const LEGACY_DIR = /(^|\/)(MDK-ARM|EWARM|Objects|Listings|DebugConfig|RTE)(\/|$)/i
  const leftovers: Array<{ relPath: string; reason: string; system: string }> = []
  for (const o of orphans) {
    const dir = o.includes('/') ? o.slice(0, o.lastIndexOf('/')) : ''
    const inKeilTree = [...keilDirs].some((k) => k && (dir === k || dir.startsWith(`${k}/`)))
    if (LEGACY_DIR.test(o)) {
      leftovers.push({
        relPath: o,
        system: 'Keil MDK',
        reason: `在 ${o.split('/')[0]}/ 目录下 —— 这是 Keil 工程目录的常见名字，CMake 构建用不到`
      })
    } else if (inKeilTree) {
      leftovers.push({
        relPath: o,
        system: 'Keil MDK / IAR',
        reason: '所在目录里有 .uvprojx / .ewp 之类的旧工程文件，属于另一个构建系统'
      })
    }
  }
  const leftoverSet = new Set(leftovers.map((l) => l.relPath))

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
    // 「不在构建里」里把残留剔出去 —— 但**不隐藏**，单独一栏显示，
    // 因为二者的处理方式相反（补进去 vs 删掉），混着显示会让人加进无关的旧代码。
    orphans: orphans.filter((o) => !leftoverSet.has(o)),
    allTargets: full.targets.map((t) => ({
      name: t.name,
      kind: t.kind,
      file: t.file,
      sourceCount: t.sourceCount,
      isExecutable: t.kind === 'executable'
    })),
    buildEntry: 'CMakeLists.txt',
    leftovers,
    // 从构建文件的注释里摘出来的说明 —— 界面**引用原文 + 标出处**，不做语义判断
    orphanNotes: findOrphanNotes(
      projectRoot,
      orphans.filter((o) => !leftoverSet.has(o))
    ),
    missing,
    stats: {
      compilableOnDisk: abs.length,
      headersOnDisk: allHeaders,
      referencedProjectWide: full.sources.length || ref.sources.size,
      /** 构建定义没看全的地方；非空时界面必须提醒「清单可能不准」 */
      cmakeUnresolved: full.unresolved,
      cmakeParsedFiles: full.parsedFiles,
      cmakeListsCount: ref.dirs.length
    },
    diagnostics: model.diagnostics,
    unresolved,
    dirs: listSourceDirs(projectRoot)
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

// --------------------------------------------------------------------------
// 变更探测（给界面做自动刷新用）
// --------------------------------------------------------------------------

export interface CmakeSignature {
  /** 扫到多少个目录 */
  dirCount: number
  /** 目录 mtime 的最大值 —— 新增/删除文件会改父目录的 mtime */
  dirMtimeMax: number
  /** 所有 CMakeLists.txt 的 mtime 最大值 */
  cmakeMtimeMax: number
  /** 可编译文件数（用来兜底：某些文件系统上目录 mtime 不刷新） */
  compilableCount: number
}

/**
 * 算一个「工程有没有变」的指纹。
 *
 * 为什么不直接轮询 scanSources：那要遍历所有文件 + 解析所有 CMakeLists，
 * 每秒来一次太重。这里只 stat 目录和 CMakeLists —— 新增或删除文件会改父目录的
 * mtime，改 CMakeLists 会改它自己的 mtime，两样都能测出来，而且便宜得多。
 *
 * 指纹变了才去跑完整的 scanSources。
 */
export function signatureOf(projectRoot: string): CmakeSignature {
  let dirCount = 0
  let dirMtimeMax = 0
  let cmakeMtimeMax = 0
  let compilableCount = 0

  const visit = (dir: string, depth: number): void => {
    if (depth > 8) return
    dirCount += 1
    try {
      dirMtimeMax = Math.max(dirMtimeMax, statSync(dir).mtimeMs)
    } catch {
      /* 读不到就算了 */
    }
    try {
      cmakeMtimeMax = Math.max(cmakeMtimeMax, statSync(join(dir, 'CMakeLists.txt')).mtimeMs)
    } catch {
      /* 这层没有 CMakeLists */
    }
    let entries: import('node:fs').Dirent[]
    try {
      entries = readdirSync(dir, { withFileTypes: true })
    } catch {
      return
    }
    for (const e of entries) {
      if (e.isDirectory()) {
        if (!SKIP_DIRS.has(e.name)) visit(join(dir, e.name), depth + 1)
      } else if (COMPILABLE.test(e.name)) {
        compilableCount += 1
      }
    }
  }

  visit(projectRoot, 0)
  return { dirCount, dirMtimeMax, cmakeMtimeMax, compilableCount }
}

/** 工程里所有含源码的目录（相对工程根、posix、含 '.'），给「新建文件」的下拉用 */
export function listSourceDirs(projectRoot: string): string[] {
  const out = new Set<string>(['.'])
  const visit = (dir: string, rel: string, depth: number): void => {
    if (depth > 8) return
    let entries: import('node:fs').Dirent[]
    try {
      entries = readdirSync(dir, { withFileTypes: true })
    } catch {
      return
    }
    for (const e of entries) {
      if (!e.isDirectory() || SKIP_DIRS.has(e.name)) continue
      const childRel = rel ? `${rel}/${e.name}` : e.name
      out.add(childRel)
      visit(join(dir, e.name), childRel, depth + 1)
    }
  }
  visit(projectRoot, '', 0)
  return [...out].sort((a, b) => a.localeCompare(b))
}

// --------------------------------------------------------------------------
// 从构建文件的注释里找「这个文件为什么没进构建」
// --------------------------------------------------------------------------

/**
 * 在 CMake 构建文件（CMakeLists.txt / *.cmake）的**注释**里，找提到某个文件的地方。
 *
 * 设计上刻意**只引用、不解释**：
 * 界面上显示的是「注释里写着：<原文>（来自 xxx.cmake:25）」，
 * 而不是「工具识别出你故意排除了这个文件」。
 *
 * 为什么不做语义判断：同一件事有人写 intentionally excluded、有人写 故意排除、
 * 有人写 暂时不编译 —— 穷举不完；而且一旦工具替这句话背书，
 * 哪天你改了主意或者那句话是三个月前写的，界面还在斩钉截铁地说「你故意排除的」。
 * 把原话和出处摆出来，判断权留给你，这样不会过期也不会假装懂你。
 *
 * 顺带一个好处：注释里往往还写了**为什么**（比如「不在 Keil 工程里」），
 * 这句话本身比任何自动标注都有用。
 */
export function findOrphanNotes(
  projectRoot: string,
  relPaths: string[]
): Array<{ relPath: string; notes: Array<{ file: string; line: number; text: string }> }> {
  if (!relPaths.length) return []

  // 只看构建文件：源文件里的注释多半和「为什么不进构建」无关，扫了是噪声
  const buildFiles: string[] = []
  const collect = (dir: string, d = 0): void => {
    if (d > 8) return
    let es: import('node:fs').Dirent[]
    try {
      es = readdirSync(dir, { withFileTypes: true })
    } catch {
      return
    }
    for (const e of es) {
      if (e.isDirectory()) {
        if (!SKIP_DIRS.has(e.name)) collect(join(dir, e.name), d + 1)
      } else if (e.name === 'CMakeLists.txt' || /\.cmake$/i.test(e.name)) {
        buildFiles.push(join(dir, e.name))
      }
    }
  }
  collect(projectRoot)

  // 注释块：连续的 # 行算一块，这样跨行的句子能完整拿到。
  // （他们的注释就是两行：第一行点名文件、第二行才写原因）
  const blocksByFile = new Map<string, Array<{ line: number; text: string }>>()
  for (const f of buildFiles) {
    let text: string
    try {
      text = readFileSync(f, 'utf8')
    } catch {
      continue
    }
    const rel = f
      .slice(projectRoot.length)
      .replace(/^[\\/]/, '')
      .split(sep)
      .join(posix.sep)
    // 只保留**注释行本身**（带行号）。不把整个注释块拼起来：
    // user.cmake 的文件头有 27 行注释，整块拼出来是一大坨，夹杂着 FreeRTOS 移植、
    // ARMCC 之类完全无关的内容，真正有用的只有点名那个文件的一两句。
    const commentLines: Array<{ line: number; text: string }> = []
    text.split(/\r?\n/).forEach((raw, i) => {
      if (/^\s*#/.test(raw)) {
        commentLines.push({ line: i + 1, text: raw.replace(/^\s*#\s?/, '').trim() })
      }
    })
    blocksByFile.set(rel, commentLines)
  }

  return relPaths.map((relPath) => {
    const base = relPath.split('/').pop() ?? relPath
    const notes: Array<{ file: string; line: number; text: string }> = []
    for (const [file, lines] of blocksByFile) {
      for (let i = 0; i < lines.length; i++) {
        if (!lines[i].text.includes(base)) continue
        // 摘到这一行，再看下一行是不是同一句话的续行（上一行没写完就接着摘）。
        // 他们的写法正是这样：
        //   # * auto_control.c / solve_trajectory.c exist on disk but are NOT part of
        //   #   the Keil project - intentionally excluded.
        const parts = [lines[i].text]
        let next = i + 1
        while (
          next < lines.length &&
          lines[next].line === lines[next - 1].line + 1 &&
          !/[.。;；]$/.test(parts[parts.length - 1]) &&
          parts.length < 3
        ) {
          parts.push(lines[next].text)
          next += 1
        }
        const text = parts.join(' ').replace(/\s+/g, ' ').trim()
        // 同一个文件里同样的说法只留一条
        if (!notes.some((n) => n.file === file && n.text === text)) {
          notes.push({ file, line: lines[i].line, text })
        }
      }
    }
    return { relPath, notes }
  })
}
