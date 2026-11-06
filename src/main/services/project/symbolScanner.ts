/**
 * L1 符号扫描器：从 C 源码里找出「可以被 VOFA 绑定」的东西。
 *
 * 能覆盖：
 *   · 全局变量（extern 声明）
 *   · **文件作用域的变量定义**（`fp32 pid_kp;` 这种没写 extern 的）
 *   · 返回结构体指针的访问器（get_xxx_point）
 *   · typedef struct / union（含匿名嵌套 struct）
 *   · 结构体成员、数组元素、指针成员
 *   · pid_type_def / gimbal_PID_t 识别成「PID 组」
 *   · 函数内变量（能扫到，但标记为不可直接绑定）
 *   · 文件私有变量（static，单独成表：能看见，但别的编译单元取不到地址）
 *
 * ## 为什么「文件作用域的定义」也要扫
 *
 * 生成的 `vofa_bind.c` 是**独立编译单元**，只能用 `vofa_reg_xxx("n", &(表达式))`
 * 在编译期取地址 —— 所以它必须看得见声明。这就是早期版本只认 extern 的原因。
 *
 * 但「看得见声明」不等于「用户必须自己写 extern」：变量在 `.c` 里定义、
 * 头文件没写 extern 时，**生成器自己在 vofa_bind.c 顶部补一行 extern 就行**，
 * 这是合法 C，不需要动用户的任何源文件。
 *
 * 于是零改动的覆盖面从「手写了 extern 的变量」扩到「所有非 static 全局变量」。
 * 真正无解的只剩 static（C 的翻译单元隔离），单独列出来并说明原因。
 */

import { readdirSync, readFileSync } from 'node:fs'
import { join, posix, sep } from 'node:path'
import type { SymbolAccess, SymbolNode, SymbolScanResult, SymbolValueType } from '@shared/vofaMap'

const SKIP_DIR = new Set([
  '.git',
  'build',
  'out',
  'dist',
  'node_modules',
  '.vscode',
  '.idea',
  '.settings',
  'CMakeFiles'
])

const SKIP_CONTENT =
  /(^|[\\/])(Drivers|Middlewares|build|out|node_modules|\.git|\.vscode|\.idea|CMakeFiles)([\\/]|$)/i

const MAX_DEPTH = 8
const MAX_NODES = 5000
const MAX_ARRAY = 32

const PID_TYPES = new Set(['pid_type_def', 'gimbal_PID_t'])

interface MemberDef {
  name: string
  type: string
  pointer: boolean
  const: boolean
  arrayLen: number
  file: string
  line: number
}

interface TypeDef {
  name: string
  kind: 'struct' | 'union' | 'enum'
  members: MemberDef[]
  file: string
  line: number
}

interface AliasDef {
  target: string
  file: string
  line: number
}

interface RawInstance {
  name: string
  type: string
  pointer: boolean
  const: boolean
  arrayLen: number
  file: string
  line: number
  accessor: boolean
  /**
   * 变量定义在 .c 里、头文件没有 extern 声明 —— 生成 vofa_bind.c 时要自己补一行。
   *
   * 有 include 的（extern 在头文件里）不需要，include 已经够了。
   */
  externDecl?: string
  /**
   * 文件作用域但带 `static`。
   *
   * 这类变量**不能**进可绑定列表：static 在链接期是 local symbol，
   * 别的编译单元（vofa_bind.c）拿不到它的地址。扫出来只为让用户「看得见」，
   * 并在界面上说清楚为什么不能绑。
   */
  fileStatic?: boolean
}

interface ScanCtx {
  structs: Map<string, TypeDef>
  aliases: Map<string, AliasDef>
  structRanges: Map<string, Array<[number, number]>>
  includeOf: (file: string) => string | undefined
  nodes: number
  truncated: boolean
}

function rel(root: string, abs: string): string {
  return abs
    .slice(root.length)
    .replace(/^[\\/]/, '')
    .split(sep)
    .join(posix.sep)
}

function includeOf(file: string): string | undefined {
  return /\.h$/i.test(file) ? file : undefined
}

/** 去掉注释和字符串，保持字符偏移不变（行号还能用） */
function stripCommentsAndStrings(text: string): string {
  const out: string[] = []
  let mode: 'normal' | 'line' | 'block' | 'str' | 'char' = 'normal'
  for (let i = 0; i < text.length; i++) {
    const ch = text[i]
    const next = text[i + 1]
    if (mode === 'normal') {
      if (ch === '/' && next === '/') {
        mode = 'line'
        out.push('  ')
        i++
      } else if (ch === '/' && next === '*') {
        mode = 'block'
        out.push('  ')
        i++
      } else if (ch === '"') {
        mode = 'str'
        out.push(' ')
      } else if (ch === "'") {
        mode = 'char'
        out.push(' ')
      } else {
        out.push(ch)
      }
      continue
    }
    if (mode === 'line') {
      if (ch === '\n') {
        mode = 'normal'
        out.push('\n')
      } else {
        out.push(' ')
      }
      continue
    }
    if (mode === 'block') {
      if (ch === '*' && next === '/') {
        mode = 'normal'
        out.push('  ')
        i++
      } else {
        out.push(ch === '\n' ? '\n' : ' ')
      }
      continue
    }
    if (mode === 'str' || mode === 'char') {
      const quote = mode === 'str' ? '"' : "'"
      if (ch === '\\') {
        out.push('  ')
        i++
      } else if (ch === quote) {
        mode = 'normal'
        out.push(' ')
      } else {
        out.push(ch === '\n' ? '\n' : ' ')
      }
    }
  }
  return out.join('')
}

function lineStarts(text: string): number[] {
  const starts = [0]
  for (let i = 0; i < text.length; i++) if (text[i] === '\n') starts.push(i + 1)
  return starts
}

function lineAt(starts: number[], idx: number): number {
  let lo = 0
  let hi = starts.length - 1
  while (lo < hi) {
    const mid = (lo + hi + 1) >> 1
    if (starts[mid] <= idx) lo = mid
    else hi = mid - 1
  }
  return lo + 1
}

function matchBrace(text: string, open: number): number {
  let depth = 0
  for (let i = open; i < text.length; i++) {
    const ch = text[i]
    if (ch === '{') depth++
    else if (ch === '}') {
      depth--
      if (depth === 0) return i
    }
  }
  return -1
}

function cleanType(type: string): string {
  return type
    .replace(/\b(const|volatile|static|register|extern)\b/g, '')
    .replace(/\*/g, '')
    .replace(/\s+/g, ' ')
    .trim()
}

function isConstType(type: string): boolean {
  return /\bconst\b/.test(type)
}

function isPointerType(type: string): boolean {
  return /\*/.test(type)
}

function parseArrayLen(dim: string | undefined): number {
  if (!dim) return 0
  const m = /^\[\s*(\d+)\s*\]$/.exec(dim.trim())
  return m ? Number(m[1]) : 0
}

function splitDeclarators(text: string): string[] {
  const out: string[] = []
  let depth = 0
  let current = ''
  for (const ch of text) {
    if (ch === '(' || ch === '[') depth++
    else if (ch === ')' || ch === ']') depth--
    if (ch === ',' && depth === 0) {
      out.push(current)
      current = ''
    } else {
      current += ch
    }
  }
  if (current.trim()) out.push(current)
  return out
}

function parseMembers(
  body: string,
  file: string,
  baseLine: number,
  structs: Map<string, TypeDef>,
  anonCounter: { n: number }
): MemberDef[] {
  const members: MemberDef[] = []
  let work = body

  // 匿名 struct/union 成员：`struct { ... } rc;`
  for (let guard = 0; guard < 64; guard++) {
    const re = /\b(struct|union)\s*\{/g
    const m = re.exec(work)
    if (!m) break
    const open = work.indexOf('{', m.index)
    const close = matchBrace(work, open)
    if (close < 0) break
    const after = work.slice(close + 1)
    const dm = /^\s*([A-Za-z_]\w*)\s*(\[[^\]]*\])?\s*;/.exec(after)
    if (!dm) {
      work = work.slice(0, open) + ' ' + work.slice(open + 1)
      continue
    }
    const anonName = `__anon_${anonCounter.n++}`
    const inner = work.slice(open + 1, close)
    const innerLine = baseLine + lineAt(lineStarts(work), open + 1) - 1
    const innerMembers = parseMembers(inner, file, innerLine, structs, anonCounter)
    structs.set(anonName, {
      name: anonName,
      kind: m[1] === 'union' ? 'union' : 'struct',
      members: innerMembers,
      file,
      line: innerLine
    })
    const end = close + 1 + dm[0].length
    members.push({
      name: dm[1],
      type: anonName,
      pointer: false,
      const: false,
      arrayLen: parseArrayLen(dm[2]),
      file,
      line: baseLine + lineAt(lineStarts(work), close + 1) - 1
    })
    const blank = work.slice(m.index, end).replace(/[^\n]/g, ' ')
    work = work.slice(0, m.index) + blank + work.slice(end)
  }

  const stmtRe = /([^;{}]*);/g
  for (const sm of work.matchAll(stmtRe)) {
    const stmt = sm[1].trim()
    if (!stmt || stmt.startsWith('#')) continue
    if (/^(typedef|return|if|for|while|switch|case|break|continue)\b/.test(stmt)) continue
    if (stmt.includes('(') && !stmt.includes('(*')) continue
    if (stmt.includes(':')) continue
    if (stmt.includes('(*')) continue

    const normalized = stmt.replace(/\s*\*\s*/g, ' * ')
    const tm =
      /^\s*((?:(?:const|volatile|static|struct|union|enum|unsigned|signed|short|long)\s+)*[A-Za-z_]\w*(?:\s+[A-Za-z_]\w*)*?)\s+(.+)$/.exec(
        normalized
      )
    if (!tm) continue
    const rawType = tm[1].trim()
    const type = cleanType(rawType)
    if (!type || /^(struct|union|enum)$/.test(type)) continue

    for (const partRaw of splitDeclarators(tm[2])) {
      const part = partRaw.replace(/\bconst\b/g, '').trim()
      const dm = /^(\*+)?\s*([A-Za-z_]\w*)\s*((?:\[[^\]]*\])*)\s*$/.exec(part)
      if (!dm) continue
      const dims = [...dm[3].matchAll(/\[[^\]]*\]/g)]
      members.push({
        name: dm[2],
        type,
        pointer: Boolean(dm[1]) || isPointerType(rawType),
        const: isConstType(rawType) || /\bconst\b/.test(partRaw),
        arrayLen: dims.length ? parseArrayLen(dims[0][0]) : 0,
        file,
        line: baseLine + lineAt(lineStarts(work), sm.index ?? 0) - 1
      })
    }
  }

  return members
}

function parseTypeDefs(text: string, file: string, ctx: ScanCtx, stops: number[]): void {
  const ranges: Array<[number, number]> = []

  const bodyRe = /typedef\s+(struct|union|enum)\s*(\w+)?\s*\{/g
  for (const m of text.matchAll(bodyRe)) {
    const open = text.indexOf('{', m.index ?? 0)
    const close = matchBrace(text, open)
    if (close < 0) continue
    const after = text.slice(close + 1)
    const nm = /^\s*([A-Za-z_]\w*)\s*;/.exec(after)
    if (!nm) continue
    const typeName = nm[1]
    const kind = m[1] as 'struct' | 'union' | 'enum'
    const bodyLine = lineAt(stops, open + 1)
    const members =
      kind === 'enum'
        ? []
        : parseMembers(text.slice(open + 1, close), file, bodyLine, ctx.structs, { n: 0 })
    ctx.structs.set(typeName, {
      name: typeName,
      kind,
      members,
      file,
      line: lineAt(stops, m.index ?? 0)
    })
    if (m[2] && m[2] !== typeName) {
      ctx.aliases.set(`${kind} ${m[2]}`, { target: typeName, file, line: lineAt(stops, m.index ?? 0) })
    }
    ranges.push([open, close])
  }

  const plainRe = /\b(struct|union|enum)\s+([A-Za-z_]\w*)\s*\{/g
  for (const m of text.matchAll(plainRe)) {
    const prefix = text.slice(Math.max(0, (m.index ?? 0) - 8), m.index ?? 0)
    if (/typedef/i.test(prefix)) continue
    const open = text.indexOf('{', m.index ?? 0)
    const close = matchBrace(text, open)
    if (close < 0) continue
    const tag = `${m[1]} ${m[2]}`
    const kind = m[1] as 'struct' | 'union' | 'enum'
    const bodyLine = lineAt(stops, open + 1)
    const members =
      kind === 'enum'
        ? []
        : parseMembers(text.slice(open + 1, close), file, bodyLine, ctx.structs, { n: 0 })
    ctx.structs.set(tag, {
      name: tag,
      kind,
      members,
      file,
      line: lineAt(stops, m.index ?? 0)
    })
    ranges.push([open, close])
  }

  const aliasRe = /typedef\s+([A-Za-z_]\w*(?:\s+[A-Za-z_]\w*)*)\s+([A-Za-z_]\w*)\s*;/g
  for (const m of text.matchAll(aliasRe)) {
    const target = m[1].trim()
    if (/^struct\s+\w+$/.test(target) && ctx.structs.has(target.replace(/^struct\s+/, ''))) {
      ctx.aliases.set(m[2], {
        target: m[2] === target ? target : target.replace(/^struct\s+/, ''),
        file,
        line: lineAt(stops, m.index ?? 0)
      })
      continue
    }
    ctx.aliases.set(m[2], { target, file, line: lineAt(stops, m.index ?? 0) })
  }

  ctx.structRanges.set(file, ranges)
}

/**
 * 把预处理器行抹成等长空格，字符偏移不变（行号还能用）。
 *
 * 不抹的话 `#include "pid.h"` 会和下一条语句黏在一起 —— 比如
 * `#include "x.h"\nextern pid_type_def a;` 里那个 extern 会被当成本行内容。
 * 续行（反斜杠结尾）一起抹，否则宏体里的分号会被误当成语句结尾。
 */
function blankPreprocessor(text: string): string {
  const out = text.split('')
  let i = 0
  while (i < text.length) {
    const lineStart = i
    let j = i
    while (j < text.length && (text[j] === ' ' || text[j] === '\t')) j++
    if (text[j] !== '#') {
      while (i < text.length && text[i] !== '\n') i++
      i++
      continue
    }
    let k = j
    for (;;) {
      while (k < text.length && text[k] !== '\n') k++
      if (k >= text.length) break
      let b = k - 1
      while (b > lineStart && (text[b] === ' ' || text[b] === '\t')) b--
      if (text[b] === '\\') {
        k++
        continue
      }
      break
    }
    for (let m = lineStart; m < k && m < out.length; m++) {
      if (out[m] !== '\n') out[m] = ' '
    }
    i = k + 1
  }
  return out.join('')
}

/** 顶层逗号切分：跳过圆括号 / 方括号 / 花括号里的逗号（初始化器里全是逗号） */
function splitTopLevel(text: string): string[] {
  const out: string[] = []
  let depth = 0
  let cur = ''
  for (const ch of text) {
    if (ch === '(' || ch === '[' || ch === '{') depth++
    else if (ch === ')' || ch === ']' || ch === '}') depth--
    if (ch === ',' && depth === 0) {
      out.push(cur)
      cur = ''
    } else {
      cur += ch
    }
  }
  if (cur.trim()) out.push(cur)
  return out
}

/** 去掉 `= 初始化器`（可能带花括号、内部还有逗号） */
function stripInitializer(part: string): string {
  let depth = 0
  for (let i = 0; i < part.length; i++) {
    const ch = part[i]
    if (ch === '(' || ch === '[' || ch === '{') depth++
    else if (ch === ')' || ch === ']' || ch === '}') depth--
    else if (ch === '=' && depth === 0) return part.slice(0, i)
  }
  return part
}

/** 顶层变量最多收多少个（再多说明命中了大数组/生成代码，宁可截断也别撑爆界面） */
const MAX_TOP_VARS = 800

/**
 * 排序权重：用户自己写的模块排前面。
 *
 * 不排的话会按字母排，「链接脚本符号 / CMSIS 表 / freertos 句柄」全跑到前面，
 * 而 application/ 里真正要调的 PID 和姿态量被挤到几十项之后 —— 看起来像没扫到。
 */
function dirRank(file: string): number {
  if (file.startsWith('application/')) return 0
  if (file.startsWith('components/')) return 1
  if (file.startsWith('bsp/')) return 2
  if (file.startsWith('Src/') || file.startsWith('Inc/')) return 3
  return 4
}

function byDirThenPath(a: SymbolNode, b: SymbolNode): number {
  return dirRank(a.file) - dirRank(b.file) || a.path.localeCompare(b.path) || a.file.localeCompare(b.file)
}

/**
 * 扫描**文件作用域**的变量定义（含 static）。
 *
 * 只在花括号深度 0 处按 `;` 切语句 —— 函数体、struct 体、初始化器的花括号
 * 都会把深度抬起来，所以天然不会把函数内局部变量当成全局。
 *
 * 返回的 `externDecl` 是给生成器用的：变量定义在 .c 里、头文件没有 extern 时，
 * vofa_bind.c 自己补一行就行，**用户不用改任何源文件**。
 */
function parseTopLevelVars(text: string, file: string, stops: number[]): RawInstance[] {
  const out: RawInstance[] = []
  const src = blankPreprocessor(text)
  const add = (x: RawInstance): void => {
    if (!x.name || !x.type) return
    if (out.length >= MAX_TOP_VARS) return
    if (out.some((o) => o.name === x.name)) return
    out.push(x)
  }

  let depth = 0
  let stmtStart = 0

  const handle = (end: number): void => {
    const startAt = stmtStart
    stmtStart = end + 1
    const seg = src.slice(startAt, end + 1)
    // 去掉前导空白再算行号：语句起点是上一个 `;` 之后，那里通常隔着空行/预处理行
    const lead = seg.length - seg.trimStart().length
    const stmt = seg.trim().replace(/;\s*$/, '').trim()
    if (!stmt) return
    if (/^typedef\b/.test(stmt)) return
    // 匿名 struct/union/enum 定义体：类型没名字，展开不了
    if (/\b(struct|union|enum)\s*\{/.test(stmt)) return
    // 函数原型 / 函数指针 / 带 __attribute__ 的，都不是简单变量
    if (stmt.includes('(') || stmt.includes('(*')) return
    // extern 交给 parseInstances —— 那边知道该带哪个头文件
    if (/\bextern\b/.test(stmt)) return

    const isStatic = /(^|\s)static\s+/.test(stmt)
    const normalized = stmt.replace(/\s*\*\s*/g, ' * ')
    const tm =
      /^\s*((?:(?:const|volatile|static|extern|register|inline|struct|union|enum|unsigned|signed|short|long)\s+)*[A-Za-z_]\w*(?:\s+[A-Za-z_]\w*)*?)\s+(.+)$/.exec(
        normalized
      )
    if (!tm) return

    const typeText = tm[1]
      .replace(/\b(static|extern|register|inline)\b/g, '')
      .replace(/\s+/g, ' ')
      .trim()
    const type = cleanType(tm[1])
    if (!type) return

    for (const partRaw of splitTopLevel(tm[2])) {
      const part = stripInitializer(partRaw).replace(/\bconst\b/g, '').trim()
      if (!part) continue
      const dm = /^(\*+)?\s*([A-Za-z_]\w*)\s*((?:\[[^\]]*\])*)\s*$/.exec(part)
      if (!dm) continue
      const name = dm[2]
      if (name.length < 2) continue
      // 链接脚本符号（_estack/_end/_Min_Stack_Size）和 CMSIS-DSP 的常量表（arm_*）
      // 是合法全局变量，但绑它们没意义，只会把真正要调的变量挤到后面去
      if (/^(_|arm_|__)/.test(name)) continue
      const dims = [...(dm[3] ?? '').matchAll(/\[[^\]]*\]/g)]
      add({
        name,
        type,
        pointer: Boolean(dm[1]) || isPointerType(tm[1]),
        const: isConstType(tm[1]) || /\bconst\b/.test(partRaw),
        arrayLen: dims.length ? parseArrayLen(dims[0][0]) : 0,
        file,
        line: lineAt(stops, startAt + lead),
        accessor: false,
        // static 不给 externDecl：给了也编译不过（链接期是 local symbol）
        externDecl: isStatic
          ? undefined
          : `extern ${typeText}${dm[1] ? ` ${dm[1]}` : ''} ${name}${dm[3] ?? ''};`
      })
      if (isStatic) out[out.length - 1].fileStatic = true
    }
  }

  for (let i = 0; i < src.length; i++) {
    const ch = src[i]
    if (ch === '{') depth++
    else if (ch === '}') {
      depth--
      if (depth <= 0) {
        depth = 0
        stmtStart = i + 1
      }
    } else if (ch === ';' && depth === 0) {
      handle(i)
    }
  }
  return out
}

function parseInstances(text: string, file: string, stops: number[]): RawInstance[] {
  const out: RawInstance[] = []
  const add = (x: RawInstance): void => {
    if (!x.name || !x.type) return
    if (out.some((o) => o.name === x.name)) return
    out.push(x)
  }

  for (const m of text.matchAll(
    /\bextern\s+(const\s+)?([A-Za-z_]\w*)\s*\*\s*([A-Za-z_]\w*)\s*\(\s*(?:void)?\s*\)\s*;/g
  )) {
    add({
      name: m[3],
      type: m[2],
      pointer: true,
      const: Boolean(m[1]),
      arrayLen: 0,
      file,
      line: lineAt(stops, m.index ?? 0),
      accessor: true
    })
  }

  for (const m of text.matchAll(/\bextern\s+(const\s+)?([A-Za-z_]\w*)\s*\*\s*([A-Za-z_]\w*)\s*;/g)) {
    add({
      name: m[3],
      type: m[2],
      pointer: true,
      const: Boolean(m[1]),
      arrayLen: 0,
      file,
      line: lineAt(stops, m.index ?? 0),
      accessor: false
    })
  }

  for (const m of text.matchAll(
    /\bextern\s+(const\s+)?([A-Za-z_]\w*)\s+([A-Za-z_]\w*)\s*\[([^\]]*)\]\s*;/g
  )) {
    add({
      name: m[3],
      type: m[2],
      pointer: false,
      const: Boolean(m[1]),
      arrayLen: parseArrayLen(`[${m[4]}]`),
      file,
      line: lineAt(stops, m.index ?? 0),
      accessor: false
    })
  }

  for (const m of text.matchAll(/\bextern\s+(const\s+)?([A-Za-z_]\w*)\s+([A-Za-z_]\w*)\s*;/g)) {
    add({
      name: m[3],
      type: m[2],
      pointer: false,
      const: Boolean(m[1]),
      arrayLen: 0,
      file,
      line: lineAt(stops, m.index ?? 0),
      accessor: false
    })
  }

  return out
}

function resolveType(
  type: string,
  structs: Map<string, TypeDef>,
  aliases: Map<string, AliasDef>,
  seen = new Set<string>()
): string {
  const name = cleanType(type)
  if (!name) return 'unknown'
  if (structs.has(name)) return name
  const alias = aliases.get(name)
  if (alias && !seen.has(name)) {
    seen.add(name)
    return resolveType(alias.target, structs, aliases, seen)
  }
  return name
}

function valueTypeOf(
  type: string,
  structs: Map<string, TypeDef>,
  aliases: Map<string, AliasDef>
): SymbolValueType {
  const resolved = resolveType(type, structs, aliases)
  const bare = resolved.replace(/^(struct|union|enum)\s+/, '')
  const lower = bare.toLowerCase()
  if (PID_TYPES.has(bare) || lower === 'pid_type_def' || lower === 'gimbal_pid_t') return 'pid'
  if (bare === 'fp32' || bare === 'fp64' || /\b(float|double)\b/.test(lower)) return 'float'
  if (bare === 'bool_t' || bare === 'bool' || bare === '_Bool' || lower === 'bool') return 'bool'
  if (
    /\b(int|char|short|long|unsigned|signed|size_t|uint\d+_t|int\d+_t)\b/.test(lower) ||
    /^(u?int(8|16|32|64)_t)$/.test(lower)
  ) {
    return 'int'
  }
  const def = structs.get(resolved) ?? structs.get(bare)
  if (def) return def.kind === 'enum' ? 'int' : 'struct'
  return 'unknown'
}

function accessOf(vt: SymbolValueType, isConst: boolean): SymbolAccess {
  if (vt === 'float') return isConst ? 'watch' : 'both'
  if (vt === 'int' || vt === 'bool') return 'watch'
  if (vt === 'pid') return 'tune'
  return 'none'
}

function reasonOf(vt: SymbolValueType, isConst: boolean): string | undefined {
  if (vt === 'struct') return '结构体本身不能直接绑定，请展开选成员'
  if (vt === 'unknown') return '类型无法解析，请手动绑定'
  if (vt === 'pid') return undefined
  if (vt === 'float' && isConst) return 'const 变量只能看，不能在线改'
  return undefined
}

function composeGuard(parent: string | undefined, expr: string): string {
  return parent ? `(${parent} != NULL ? ${expr} : NULL)` : expr
}

interface ExpandArgs {
  name: string
  path: string
  expr: string
  type: string
  pointer: boolean
  const: boolean
  guard?: string
  include?: string
  file: string
  line: number
  depth: number
  typePath: Set<string>
  ctx: ScanCtx
}

function makeNode(args: ExpandArgs, children?: SymbolNode[]): SymbolNode {
  const vt = valueTypeOf(args.type, args.ctx.structs, args.ctx.aliases)
  const isConst = args.const
  const node: SymbolNode = {
    id: `${args.file}:${args.line}:${args.expr}`,
    name: args.name,
    path: args.path,
    expr: args.expr,
    type: args.type,
    valueType: vt,
    access: accessOf(vt, isConst),
    guard: args.guard,
    include: args.include,
    file: args.file,
    line: args.line,
    reason: reasonOf(vt, isConst),
    children
  }
  if (PID_TYPES.has(cleanType(args.type))) {
    node.pidType = cleanType(args.type) as 'pid_type_def' | 'gimbal_PID_t'
    node.fields = children?.map((c) => c.name)
  }
  return node
}

function expandValue(args: ExpandArgs): SymbolNode {
  const { ctx } = args
  ctx.nodes += 1
  if (ctx.nodes > MAX_NODES) {
    ctx.truncated = true
    return makeNode(args)
  }

  const resolved = resolveType(args.type, ctx.structs, ctx.aliases)
  const def =
    ctx.structs.get(resolved) ?? ctx.structs.get(resolved.replace(/^(struct|union|enum)\s+/, ''))
  const vt = valueTypeOf(args.type, ctx.structs, ctx.aliases)
  const include = args.include ?? (def ? includeOf(def.file) : undefined)

  if (vt === 'unknown' || vt === 'struct' || vt === 'pid') {
    if (!def || args.depth >= MAX_DEPTH || args.typePath.has(resolved)) {
      return makeNode({ ...args, include })
    }
    const nextPath = new Set(args.typePath)
    nextPath.add(resolved)
    const children: SymbolNode[] = []
    for (const mem of def.members) {
      const memPath = `${args.path}.${mem.name}`
      const memExpr = `${args.expr}${args.pointer ? '->' : '.'}${mem.name}`
      const memGuard = args.pointer ? args.guard : args.guard
      if (mem.arrayLen > 0) {
        const count = Math.min(mem.arrayLen, MAX_ARRAY)
        for (let i = 0; i < count; i++) {
          children.push(
            expandValue({
              name: `${mem.name}[${i}]`,
              path: `${memPath}[${i}]`,
              expr: `${memExpr}[${i}]`,
              type: mem.type,
              pointer: mem.pointer,
              const: args.const || mem.const,
              guard: memGuard,
              include: includeOf(def.file) ?? args.include,
              file: def.file,
              line: mem.line,
              depth: args.depth + 1,
              typePath: nextPath,
              ctx
            })
          )
        }
      } else {
        children.push(
          expandValue({
            name: mem.name,
            path: memPath,
            expr: memExpr,
            type: mem.type,
            pointer: mem.pointer,
            const: args.const || mem.const,
            guard: mem.pointer ? composeGuard(args.guard, memExpr) : memGuard,
            include: includeOf(def.file) ?? args.include,
            file: def.file,
            line: mem.line,
            depth: args.depth + 1,
            typePath: nextPath,
            ctx
          })
        )
      }
    }
    return makeNode(
      { ...args, expr: vt === 'pid' && args.pointer ? `(*${args.expr})` : args.expr, include },
      children
    )
  }

  if (args.pointer) {
    const deref = `(*${args.expr})`
    return makeNode({
      ...args,
      expr: deref,
      guard: composeGuard(args.guard, args.expr),
      include
    })
  }

  return makeNode({ ...args, include })
}

function expandInstance(inst: RawInstance, ctx: ScanCtx): SymbolNode {
  const displayName = inst.accessor ? inst.name.replace(/^get_/, '').replace(/_point$/, '') : inst.name
  const expr = inst.accessor ? `${inst.name}()` : inst.name
  const guard = inst.pointer ? expr : undefined
  const include = includeOf(inst.file)
  const typePath = new Set<string>()

  if (!inst.pointer && inst.arrayLen > 0) {
    const children: SymbolNode[] = []
    const count = Math.min(inst.arrayLen, MAX_ARRAY)
    const base: SymbolNode = {
      id: `${inst.file}:${inst.line}:${expr}`,
      name: inst.name,
      path: displayName,
      expr,
      type: inst.type,
      valueType: 'struct',
      access: 'none',
      include,
      file: inst.file,
      line: inst.line,
      reason: '数组本身不能直接绑定，请展开选元素',
      isArray: true
    }
    for (let i = 0; i < count; i++) {
      children.push(
        expandValue({
          name: `${inst.name}[${i}]`,
          path: `${displayName}[${i}]`,
          expr: `${expr}[${i}]`,
          type: inst.type,
          pointer: false,
          const: inst.const,
          include,
          file: inst.file,
          line: inst.line,
          depth: 1,
          typePath,
          ctx
        })
      )
    }
    base.children = children
    if (inst.externDecl) base.externDecl = inst.externDecl
    return base
  }

  const node = expandValue({
    name: displayName,
    path: displayName,
    expr,
    type: inst.type,
    pointer: inst.pointer,
    const: inst.const,
    guard,
    include,
    file: inst.file,
    line: inst.line,
    depth: 0,
    typePath,
    ctx
  })
  // externDecl 只对根有意义：子节点的表达式是 `根.成员`，根有声明就够了
  if (inst.externDecl) node.externDecl = inst.externDecl
  return node
}

function collectLocals(
  text: string,
  file: string,
  stops: number[],
  structRanges: Array<[number, number]>,
  ctx: ScanCtx
): SymbolNode[] {
  const out: SymbolNode[] = []
  const fnRe = /(?:^|\n)[A-Za-z_][\w \t\*]*\b([A-Za-z_]\w*)\s*\([^;{}]*\)\s*\{/g
  const ranges: Array<[number, number]> = []
  for (const m of text.matchAll(fnRe)) {
    const open = text.indexOf('{', m.index ?? 0)
    const close = matchBrace(text, open)
    if (close > open) ranges.push([open, close])
  }
  if (!ranges.length) return out

  const declRe =
    /\b(pid_type_def|gimbal_PID_t|float|double|int16_t|uint8_t|bool|bool_t)\s+([A-Za-z_]\w*)\s*;/g
  for (const m of text.matchAll(declRe)) {
    const idx = m.index ?? 0
    const line = lineAt(stops, idx)
    const inFn = ranges.some(([a, b]) => idx >= a && idx <= b)
    const inStruct = structRanges.some(([a, b]) => idx >= a && idx <= b)
    if (!inFn || inStruct) continue
    if (m[2].startsWith('_')) continue
    const vt = valueTypeOf(m[1], ctx.structs, ctx.aliases)
    out.push({
      id: `${file}:${line}:${m[2]}:local`,
      name: m[2],
      path: m[2],
      expr: m[2],
      type: m[1],
      valueType: vt,
      access: 'none',
      file,
      line,
      reason: '函数内变量，生命周期不允许直接绑定；请改成全局、加访问器，或用 vofa_user_bind.c 钩子'
    })
  }
  return out
}

export function scanSymbols(root: string): SymbolScanResult {
  const structs = new Map<string, TypeDef>()
  const aliases = new Map<string, AliasDef>()
  const structRanges = new Map<string, Array<[number, number]>>()
  const ctx: ScanCtx = {
    structs,
    aliases,
    structRanges,
    includeOf,
    nodes: 0,
    truncated: false
  }

  const texts: Array<{ file: string; text: string; stops: number[] }> = []
  const walk = (dir: string, depth: number): void => {
    if (depth > 10) return
    let entries: import('node:fs').Dirent[]
    try {
      entries = readdirSync(dir, { withFileTypes: true })
    } catch {
      return
    }
    for (const e of entries) {
      const full = join(dir, e.name)
      if (e.isDirectory()) {
        if (SKIP_DIR.has(e.name) || SKIP_CONTENT.test(full)) continue
        walk(full, depth + 1)
        continue
      }
      if (!/\.(c|h|cpp|hpp)$/i.test(e.name)) continue
      if (SKIP_CONTENT.test(full)) continue
      try {
        const raw = readFileSync(full, 'utf8')
        const text = stripCommentsAndStrings(raw)
        texts.push({ file: rel(root, full), text, stops: lineStarts(text) })
      } catch {
        /* 读不了就跳过 */
      }
    }
  }
  walk(root, 0)

  for (const t of texts) parseTypeDefs(t.text, t.file, ctx, t.stops)

  const instances: RawInstance[] = []
  const fileStatics: RawInstance[] = []

  // 第一遍：头文件里的 extern 声明 —— 优先，因为它们带 include，生成代价最低
  for (const t of texts) {
    for (const inst of parseInstances(t.text, t.file, t.stops)) {
      const prev = instances.find((x) => x.name === inst.name)
      if (!prev) instances.push(inst)
      else if (!/\.h$/i.test(prev.file) && /\.h$/i.test(inst.file)) {
        instances[instances.indexOf(prev)] = inst
      }
    }
  }

  // 第二遍：文件作用域的变量定义 —— 没写 extern 的那些，生成器自己补声明
  for (const t of texts) {
    for (const inst of parseTopLevelVars(t.text, t.file, t.stops)) {
      if (inst.fileStatic) {
        if (!fileStatics.some((x) => x.name === inst.name)) fileStatics.push(inst)
        continue
      }
      // 已经有 extern 声明的，用那份 —— 有 include，生成的代码更干净
      if (instances.some((x) => x.name === inst.name)) continue
      instances.push(inst)
    }
  }

  const locals: SymbolNode[] = []
  for (const t of texts) {
    locals.push(...collectLocals(t.text, t.file, t.stops, ctx.structRanges.get(t.file) ?? [], ctx))
  }

  const tree = instances.map((i) => expandInstance(i, ctx)).sort(byDirThenPath)

  const flat: SymbolNode[] = []
  const visit = (n: SymbolNode): void => {
    if (n.valueType !== 'struct' && n.valueType !== 'unknown') flat.push(n)
    for (const c of n.children ?? []) visit(c)
  }
  for (const n of tree) visit(n)

  const statics: SymbolNode[] = fileStatics
    .map((i) => ({
      id: `${i.file}:${i.line}:${i.name}:static`,
      name: i.name,
      path: i.name,
      expr: i.name,
      type: i.type,
      valueType: valueTypeOf(i.type, ctx.structs, ctx.aliases),
      access: 'none' as const,
      file: i.file,
      line: i.line,
      reason:
        '文件私有变量（static）：绑定代码在另一个 .c 里，取不到它的地址。' +
        '去掉 static 并在头文件加 extern 后才能绑。'
    }))
    .sort(byDirThenPath)

  return {
    tree,
    flat: flat.sort(byDirThenPath),
    locals: locals.sort(byDirThenPath),
    statics,
    types: [...structs.keys()].sort(),
    scannedFiles: texts.length,
    truncated: ctx.truncated
  }
}
