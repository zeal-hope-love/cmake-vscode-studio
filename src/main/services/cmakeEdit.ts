/**
 * 往 CMakeLists.txt 里加/删源文件 —— 只做**文本编辑**，不重新排版。
 *
 * 核心原则：**绝不重排用户已经写的内容**。
 * 加一个文件就在现有列表里插一行；删一个文件就把那一行整行删掉。
 * 已有行的空格、对齐、注释、换行风格（LF/CRLF）全部原样保留 —— 这是能让人放心的唯一办法。
 *
 * 两种写法（见 planSourceEdit）：
 *   ① 就地插入 —— 插进现有的 `target_sources(...)` / `add_executable(...)` 参数列表末尾
 *   ② 托管区块 —— 找不到锚点时，在文件末尾另起一块带标记的 `target_sources`
 *
 * 为什么不重排：真实工程的 CMakeLists 是人手写的，有分组、有注释、有对齐。
 * 用「解析成 AST 再打印回去」的做法必然把这些全丢掉，diff 会变成整个文件 —— 不可接受。
 */

import { readFileSync } from 'node:fs'
import { posix } from 'node:path'
import {
  type CmakeModel,
  type CmakeSourceEntry,
  findSourceInsertPoint,
  looksLikeSource,
  expandCmakeVars
} from './cmakeModel'

// --------------------------------------------------------------------------
// 类型
// --------------------------------------------------------------------------

/** 一处文本替换：[start, end) 换成 text */
export interface FileEdit {
  start: number
  end: number
  text: string
}

export interface CmakeEditPlan {
  file: string
  /** 改动前的全文 */
  before: string
  /** 改动后的全文 */
  after: string
  edits: FileEdit[]
  /** 实际加进去的（相对路径） */
  added: string[]
  /** 实际删掉的（相对路径） */
  removed: string[]
  /** 用没用托管区块兜底 */
  usedFallback: boolean
  /** 人话说明，给预览界面显示 */
  notes: string[]
}

// 托管区块的标记。改这两个字符串会让老工程的区块「认不出来」，进而重复追加 —— 别乱改。
const BLOCK_BEGIN = '# >>> CMake / VSCode 工程配置器 · 托管区（工具会覆盖这里，请勿手改）>>>'
const BLOCK_END = '# <<< 托管区 <<<'

// --------------------------------------------------------------------------
// 纯文本工具
// --------------------------------------------------------------------------

/** 这一行（含换行符）的取值范围 */
function lineRange(text: string, offset: number): { start: number; end: number; bodyEnd: number } {
  let start = offset
  while (start > 0 && text[start - 1] !== '\n') start -= 1
  let end = offset
  while (end < text.length && text[end] !== '\n') end += 1
  const bodyEnd = end
  if (end < text.length) end += 1 // 连换行一起吃掉
  return { start, end, bodyEnd }
}

function detectEol(text: string): string {
  return text.includes('\r\n') ? '\r\n' : '\n'
}

export function applyEdits(text: string, edits: FileEdit[]): string {
  // 从后往前改，前面的偏移才不会失效
  const sorted = [...edits].sort((a, b) => b.start - a.start)
  let out = text
  let lastStart = Number.POSITIVE_INFINITY
  for (const e of sorted) {
    if (e.end > lastStart) continue // 防御：区间重叠就跳过
    out = out.slice(0, e.start) + e.text + out.slice(e.end)
    lastStart = e.start
  }
  return out
}

/** 这个源文件条目是不是独占一行（是的话删起来可以整行删） */
function isAloneOnLine(text: string, entry: { raw: string }): boolean {
  // 用 raw 反查位置不可靠（可能重复），改由调用方传偏移；这里只做启发式，实际偏移在下面算
  return Boolean(entry.raw)
}

// --------------------------------------------------------------------------
// 查找文件在原文里的位置
// --------------------------------------------------------------------------

interface LocatedSource {
  entry: CmakeSourceEntry
  start: number
  end: number
}

/**
 * 把模型里的源文件条目对应回**原文偏移**。
 *
 * 模型里只记了行号，而删除需要精确区间，所以这里按行号 + 路径在那一行里定位。
 * 用「行号 + 该行包含这个路径」两个条件一起找，比全局搜字符串稳。
 */
function locateSources(model: CmakeModel, entries: CmakeSourceEntry[]): LocatedSource[] {
  const text = readFileSync(model.file, 'utf8')
  const lines = text.split(/\r?\n/)
  const lineStarts: number[] = []
  let acc = 0
  for (const l of lines) {
    lineStarts.push(acc)
    acc += l.length + (text.includes('\r\n') ? 2 : 1)
  }

  const out: LocatedSource[] = []
  for (const entry of entries) {
    const lineIdx = entry.line - 1
    if (lineIdx < 0 || lineIdx >= lines.length) continue
    const lineText = lines[lineIdx]
    // 同一行里可能有多个源文件，用路径片段定位
    const probe = entry.raw.replace(/\\/g, '/')
    let col = lineText.indexOf(probe)
    if (col === -1) {
      const base = posix.basename(probe)
      col = lineText.indexOf(base)
      if (col === -1) continue
      // 只删文件名部分，保留前面的路径写法
      const start = lineStarts[lineIdx] + col
      out.push({ entry, start, end: start + base.length })
      continue
    }
    out.push({ entry, start: lineStarts[lineIdx] + col, end: lineStarts[lineIdx] + col + probe.length })
  }
  return out
}

// --------------------------------------------------------------------------
// 主入口
// --------------------------------------------------------------------------

export interface PlanSourceEditOptions {
  targetName: string
  /** 要加入的相对路径（posix，如 application/vofa_task.c） */
  add?: string[]
  /** 要移除的相对路径 */
  remove?: string[]
}

/**
 * 算出「加/删这些源文件」需要做的文本编辑，返回改前改后的全文。
 *
 * 不做任何磁盘写入 —— 调用方拿 after 去做 diff / 预览 / 落盘。
 */
export function planSourceEdit(model: CmakeModel, opts: PlanSourceEditOptions): CmakeEditPlan {
  const before = readFileSync(model.file, 'utf8')
  const eol = detectEol(before)
  const target = model.targets.find((t) => t.name === opts.targetName)
  const notes: string[] = []
  const edits: FileEdit[] = []
  const added: string[] = []
  const removed: string[] = []

  if (!target) {
    return {
      file: model.file,
      before,
      after: before,
      edits: [],
      added,
      removed,
      usedFallback: false,
      notes: [`找不到目标 ${opts.targetName}，什么都没改。`]
    }
  }

  // ---------- 移除 ----------
  const wantRemove = new Set((opts.remove ?? []).map((p) => p.replace(/\\/g, '/').toLowerCase()))
  if (wantRemove.size) {
    const entries = target.sources.filter((s) => s.relPath && wantRemove.has(s.relPath.toLowerCase()))
    const located = locateSources(model, entries)
    for (const loc of located) {
      const { start, end, bodyEnd } = lineRange(before, loc.start)
      // 整行只剩这个路径（忽略空白）→ 整行删掉；否则只删路径本身
      const lineBody = before.slice(start, bodyEnd)
      const rest = lineBody.replace(loc.entry.raw, '').trim()
      if (rest === '') {
        edits.push({ start, end, text: '' })
      } else {
        edits.push({ start: loc.start, end: loc.end, text: '' })
      }
      removed.push(loc.entry.relPath!)
      notes.push(`移除 ${loc.entry.relPath}（原第 ${loc.entry.line} 行整行删除）`)
    }
    const missed = [...wantRemove].filter((p) => !removed.some((r) => r!.toLowerCase() === p))
    for (const m of missed) notes.push(`跳过 ${m}：不在目标 ${target.name} 的源文件列表里`)
  }

  // ---------- 加入 ----------
  const wantAdd = (opts.add ?? []).map((p) => p.replace(/\\/g, '/')).filter(Boolean)
  if (wantAdd.length) {
    const existing = new Set(
      target.sources.map((s) => s.relPath?.toLowerCase()).filter(Boolean) as string[]
    )
    const fresh = wantAdd.filter((p) => !existing.has(p.toLowerCase()))
    for (const dup of wantAdd.filter((p) => existing.has(p.toLowerCase()))) {
      notes.push(`跳过 ${dup}：已经在目标 ${target.name} 里了`)
    }

    if (fresh.length) {
      const point = findSourceInsertPoint(model, target.name)
      if (point) {
        /**
         * ① 就地插入：插在 `findSourceInsertPoint` 给出的那一行之后。
         *
         * **必须用 point 返回的位置，不要自己再算一遍。**
         * 踩过的坑：这里原来是从 `target.sources` 里取「最后一个源文件」，但那份扁平列表
         * 会把单行写法 `target_sources(t PRIVATE ${EXTRA_SRCS})` 里的文件也收进来，
         * 于是「最后一个」可能是那一条上的文件 —— 插入点就算到了命令**外面**，
         * 新文件名直接变成非法 CMake。插入点函数已经专门挑过「多行列表」了，听它的。
         */
        const { bodyEnd } = lineRange(before, point.offset)
        const lines = fresh.map((p) => `${point.indent}${p}`).join(eol)
        edits.push({ start: bodyEnd, end: bodyEnd, text: `${eol}${lines}` })
        added.push(...fresh)
        notes.push(
          `在 ${point.via} 的列表末尾（原第 ${point.line} 行）插入 ${fresh.length} 行，` +
            `缩进沿用该处已有的 ${point.indent.length} 个空格`
        )
      } else {
        // ② 托管区块兜底
        const block = buildManagedBlock(before, eol, fresh, model)
        edits.push({ start: block.start, end: block.end, text: block.text })
        added.push(...fresh)
        notes.push(
          `没找到可以就地插入的源文件列表，改成在文件末尾维护一个托管区块` +
            `（${fresh.length} 行，带标记，下次会自动更新这一块）`
        )
        return {
          file: model.file,
          before,
          after: applyEdits(before, edits),
          edits,
          added,
          removed,
          usedFallback: true,
          notes
        }
      }
    }
  }

  return {
    file: model.file,
    before,
    after: applyEdits(before, edits),
    edits,
    added,
    removed,
    usedFallback: false,
    notes
  }
}

function lineStartOf(text: string, line: number): number {
  let n = 1
  let i = 0
  while (n < line && i < text.length) {
    if (text[i] === '\n') n += 1
    i += 1
  }
  return i
}

/**
 * 生成（或更新）文件末尾的托管区块。
 *
 * 已经存在就**替换内部内容**而不是再追加一块 —— 否则反复操作会堆出一串重复区块。
 */
function buildManagedBlock(
  text: string,
  eol: string,
  paths: string[],
  model: CmakeModel
): { start: number; end: number; text: string } {
  const targetExpr = model.targets[0]?.rawName ?? '${CMAKE_PROJECT_NAME}'
  const body = paths.map((p) => `    ${p}`).join(eol)
  const fresh = [BLOCK_BEGIN, `target_sources(${targetExpr} PRIVATE`, body, ')', BLOCK_END, ''].join(
    eol
  )

  const beginIdx = text.indexOf(BLOCK_BEGIN)
  const endIdx = text.indexOf(BLOCK_END)

  if (beginIdx !== -1 && endIdx !== -1 && endIdx > beginIdx) {
    // 现有的区块：把 [BLOCK_BEGIN, BLOCK_END] 整段换掉
    let end = endIdx + BLOCK_END.length
    if (text.startsWith('\r\n', end)) end += 2
    else if (text.startsWith('\n', end)) end += 1
    return { start: beginIdx, end, text: fresh }
  }

  // 没有区块：在文件末尾追加（保证前面留一个空行）
  const tail = text.endsWith(eol) ? eol : eol + eol
  return { start: text.length, end: text.length, text: `${tail}${fresh}` }
}

export { BLOCK_BEGIN, BLOCK_END, isAloneOnLine }
export { expandCmakeVars }
