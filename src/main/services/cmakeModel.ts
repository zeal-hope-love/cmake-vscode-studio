/**
 * 位置感知的 CMakeLists 解析。
 *
 * 和隔壁 `cmakeParser.ts` 的区别（也是为什么必须新写一个）：
 *
 * | | cmakeParser.ts | 本文件 |
 * | --- | --- | --- |
 * | 输入 | `stripCmakeComments()` 之后的文本 | **原始文本** |
 * | 输出 | 扁平的名字列表 | 每个命令/参数的**精确字符区间** |
 * | 能干什么 | 读 | **读 + 回写** |
 *
 * 注释被删掉之后所有偏移都失真了，所以想「在原列表里插一行」就必须在原文上扫。
 *
 * 解析策略：手写单遍扫描器，逐字符跟踪「行注释 / 块注释 / 字符串 / 括号深度」四种状态，
 * 在深度 0 处认出 `命令名(`，一直读到配对的 `)`。不需要完整的 CMake 解释器 ——
 * 我们要的只是**位置**，语义交给上层按命令名分别处理。
 *
 * 已知不做的事（遇到就记进 diagnostics，不猜）：
 *   · `include()` / `add_subdirectory()` 引入的其它文件不递归解析（只记下路径）
 *   · `if()` / `foreach()` 里的分支不做条件求值 —— 两条分支的命令都会看到
 *   · 生成表达式 `$<...>` 不展开
 */

import { existsSync, readFileSync, readdirSync, statSync } from 'node:fs'
import { dirname, isAbsolute, join, posix, resolve, sep } from 'node:path'

// --------------------------------------------------------------------------
// 类型
// --------------------------------------------------------------------------

/** 原文里的一个区间（字符偏移，左闭右开） */
export interface Span {
  start: number
  end: number
}

/** 一个参数在原文里的位置 */
export interface ArgSpan extends Span {
  /** 参数原文（已去掉包裹的引号） */
  text: string
  /** 是否被引号包着 */
  quoted: boolean
}

/** 一条 CMake 命令的完整位置与参数 */
export interface CmakeCommandSpan extends Span {
  /** 命令名，统一小写 */
  command: string
  /** 文件名里的行号，1 起 */
  startLine: number
  endLine: number
  /** 参数区（不含命令名和括号）的原文 */
  argsRaw: string
  /** 参数区在原文里的起点，用来把 token 偏移换算回全文偏移 */
  argsStart: number
  args: ArgSpan[]
}

export type TargetKind = 'executable' | 'library' | 'custom'

/** 一个源文件条目 */
export interface CmakeSourceEntry {
  /** 相对工程根的 posix 路径；解析不出来时为 null */
  relPath: string | null
  /** 源码里写的原样（可能是 ${VAR}） */
  raw: string
  /** 磁盘上真的存在吗 */
  exists: boolean
  /** 写在哪一行（用于展示，也用于删除时定位） */
  line: number
  /** 属于哪条命令（add_executable / target_sources） */
  via: string
}

export interface CmakeTargetModel {
  /** 展开后的名字，例如 standard_robot */
  name: string
  /** 写在文件里的原样，例如 ${CMAKE_PROJECT_NAME} */
  rawName: string
  kind: TargetKind
  /** 声明位置 */
  declaredAt: { line: number; command: string }
  sources: CmakeSourceEntry[]
  includeDirs: Array<{ raw: string; relPath: string | null; line: number; exists: boolean }>
  defines: Array<{ raw: string; line: number }>
  linkLibs: Array<{ raw: string; line: number }>
  /** file(GLOB/GLOB_RECURSE) 收集的源文件模式；非空说明这个目标不用手动加文件 */
  globPatterns: string[]
}

export interface CmakeModel {
  /** 被解析的文件（绝对路径） */
  file: string
  /** 工程根 */
  root: string
  exists: boolean
  projectName: string | null
  cmakeMinimum: string | null
  variables: Record<string, string>
  targets: CmakeTargetModel[]
  subdirectories: Array<{ raw: string; relPath: string | null; line: number; hasCmakeLists: boolean }>
  /** 所有命令的位置，写回时靠它找锚点 */
  commands: CmakeCommandSpan[]
  /** 解析过程中发现的问题（不猜，直接说） */
  diagnostics: string[]
}

// --------------------------------------------------------------------------
// 扫描器
// --------------------------------------------------------------------------

const IDENT = /[A-Za-z_][A-Za-z0-9_]*/
const VAR_RE = /\$\{([A-Za-z_][A-Za-z0-9_]*)\}/g

/**
 * 扫出原文里所有的 `命令名( ... )`，带精确偏移。
 *
 * 四种状态：行注释 / 块注释 / 字符串 / 正常。
 * 只在「正常」状态下、且括号深度为 0 时识别命令名，这样 `if(...)` 里的
 * `add_executable` 之类的文本不会被误认成命令调用（真实的调用会在深度 0）。
 */
export function scanCommands(text: string): CmakeCommandSpan[] {
  const out: CmakeCommandSpan[] = []
  let i = 0
  const n = text.length
  let line = 1

  const countLines = (from: number, to: number): number => {
    let c = 0
    for (let k = from; k < to; k++) if (text[k] === '\n') c += 1
    return c
  }

  while (i < n) {
    const ch = text[i]

    // 换行计数
    if (ch === '\n') {
      line += 1
      i += 1
      continue
    }

    // 块注释 #[[ ... ]]
    if (ch === '#' && text.startsWith('#[[', i)) {
      const close = text.indexOf(']]', i + 3)
      const stop = close === -1 ? n : close + 2
      line += countLines(i, stop)
      i = stop
      continue
    }

    // 行注释
    if (ch === '#') {
      const nl = text.indexOf('\n', i)
      i = nl === -1 ? n : nl
      continue
    }

    // 命令名？
    if (IDENT.test(ch)) {
      const m = IDENT.exec(text.slice(i))!
      const name = m[0]
      let j = i + name.length
      // 命令名和 ( 之间允许空白（含换行）
      while (j < n && /\s/.test(text[j])) j += 1

      if (text[j] === '(') {
        const startLine = line
        const bodyStart = j + 1
        let depth = 1
        let k = bodyStart
        while (k < n && depth > 0) {
          const c = text[k]
          if (c === '#') {
            if (text.startsWith('#[[', k)) {
              const close = text.indexOf(']]', k + 3)
              k = close === -1 ? n : close + 2
              continue
            }
            const nl = text.indexOf('\n', k)
            k = nl === -1 ? n : nl
            continue
          }
          if (c === '"') {
            // 字符串里的引号要处理转义
            k += 1
            while (k < n && text[k] !== '"') {
              if (text[k] === '\\') k += 1
              k += 1
            }
            k += 1
            continue
          }
          if (c === '(') depth += 1
          else if (c === ')') {
            depth -= 1
            if (depth === 0) break
          }
          k += 1
        }

        const end = k // 指向配对的 ')'
        const argsRaw = text.slice(bodyStart, end)
        const endLine = startLine + countLines(i, end)

        out.push({
          command: name.toLowerCase(),
          start: i,
          end: Math.min(end + 1, n),
          startLine,
          endLine,
          argsRaw,
          argsStart: bodyStart,
          args: tokenizeArgs(argsRaw, bodyStart)
        })

        line = endLine
        i = Math.min(end + 1, n)
        continue
      }
    }

    i += 1
  }

  return out
}

/**
 * 把参数区切成 token，每个都带上在**全文**里的偏移。
 *
 * 要点：
 *   · 引号内的空白不算分隔（`"a b.c"` 是一个参数）
 *   · 参数区里的 `#` 注释要跳过，不能当成参数（两个真实工程里都有这种写法）
 *   · `;` 在 CMake 里也是列表分隔符，但保留在 token 里由上层处理更安全 ——
 *     这里只按空白切，和 CMake 对 `add_executable` 的处理一致
 */
export function tokenizeArgs(raw: string, baseOffset: number): ArgSpan[] {
  const tokens: ArgSpan[] = []
  let i = 0
  const n = raw.length

  while (i < n) {
    const ch = raw[i]

    if (/\s/.test(ch)) {
      i += 1
      continue
    }

    // 注释：跳到行尾
    if (ch === '#') {
      if (raw.startsWith('#[[', i)) {
        const close = raw.indexOf(']]', i + 3)
        i = close === -1 ? n : close + 2
      } else {
        const nl = raw.indexOf('\n', i)
        i = nl === -1 ? n : nl
      }
      continue
    }

    const start = i
    let quoted = false
    let value = ''

    if (ch === '"' || ch === "'") {
      const q = ch
      quoted = true
      i += 1
      while (i < n) {
        if (raw[i] === '\\' && q === '"') {
          value += raw[i + 1] ?? ''
          i += 2
          continue
        }
        if (raw[i] === q) {
          i += 1
          break
        }
        value += raw[i]
        i += 1
      }
    } else {
      while (i < n && !/\s/.test(raw[i])) {
        value += raw[i]
        i += 1
      }
    }

    tokens.push({
      start: baseOffset + start,
      end: baseOffset + i,
      text: value,
      quoted
    })
  }

  return tokens
}

// --------------------------------------------------------------------------
// 变量与目标名解析
// --------------------------------------------------------------------------

/** 展开 `${VAR}`；展不开就原样保留，调用方自己判断 */
function expand(token: string, vars: Record<string, string>, depth = 0): string {
  if (depth > 6 || !token.includes('${')) return token
  const replaced = token.replace(VAR_RE, (m, name: string) => vars[name] ?? m)
  return replaced === token ? token : expand(replaced, vars, depth + 1)
}

/** 能不能静态确定（展完之后没有残留的 ${}） */
function isResolved(token: string): boolean {
  return !token.includes('${') && !token.includes('$<')
}

/** 从 set() 收集变量；多值 set 用 `;` 连起来（CMake 的列表语义） */
function collectVariables(commands: CmakeCommandSpan[]): Record<string, string> {
  const vars: Record<string, string> = {}
  for (const c of commands) {
    if (c.command === 'set' && c.args.length >= 2) {
      const name = c.args[0].text
      if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(name)) continue
      const value = c.args
        .slice(1)
        .map((a) => a.text)
        .join(';')
      vars[name] = expand(value, vars)
    }
  }
  return vars
}

// --------------------------------------------------------------------------
// 源文件判定
// --------------------------------------------------------------------------

const SOURCE_EXT = new Set([
  '.c',
  '.cc',
  '.cpp',
  '.cxx',
  '.c++',
  '.m',
  '.mm',
  '.s',
  '.asm',
  '.S'.toLowerCase(),
  '.h',
  '.hh',
  '.hpp',
  '.hxx',
  '.inc'
])

/** target_sources / target_include_directories 之类的关键字，不是文件 */
const KEYWORDS = new Set([
  'PRIVATE',
  'PUBLIC',
  'INTERFACE',
  'SYSTEM',
  'BEFORE',
  'AFTER',
  'FILE_SET',
  'TYPE',
  'BASE_DIRS',
  'FILES',
  'HEADERS',
  'OBJECTS',
  'STATIC',
  'SHARED',
  'MODULE',
  'IMPORTED',
  'ALIAS',
  'EXCLUDE_FROM_ALL',
  'WIN32',
  'MACOSX_BUNDLE'
])

/**
 * 这看起来是一个源文件参数吗？
 *
 * 判据（宁可漏判也不要错判）：
 *   · 是关键字 / 生成表达式 / 展不开的变量 → 不是
 *   · 以已知源码扩展名结尾 → 是
 *   · 含路径分隔符 → 是（`src/foo` 这种没扩展名的也常见）
 */
export function looksLikeSource(text: string): boolean {
  if (!text) return false
  if (text.startsWith('$<')) return false
  if (KEYWORDS.has(text.toUpperCase())) return false
  const lower = text.toLowerCase()
  for (const ext of SOURCE_EXT) {
    if (lower.endsWith(ext)) return true
  }
  return /[\\/]/.test(text)
}

/** 相对工程根的 posix 路径；不在工程内或无法解析时返回 null */
function toRelPath(raw: string, root: string): string | null {
  if (!raw) return null
  const cleaned = raw.replace(/\\/g, '/').replace(/^\.\//, '')
  if (cleaned.startsWith('/') || /^[A-Za-z]:/.test(cleaned)) {
    const abs = resolve(cleaned)
    const rootAbs = resolve(root)
    if (!abs.toLowerCase().startsWith(rootAbs.toLowerCase())) return null
    return abs
      .slice(rootAbs.length)
      .replace(/^[\\/]/, '')
      .split(sep)
      .join(posix.sep)
  }
  return posix.normalize(cleaned)
}

// --------------------------------------------------------------------------
// 组装模型
// --------------------------------------------------------------------------

const TARGET_COMMANDS: Record<string, TargetKind> = {
  add_executable: 'executable',
  add_library: 'library',
  add_custom_target: 'custom'
}

export function buildCmakeModel(file: string, root: string): CmakeModel {
  const model: CmakeModel = {
    file,
    root,
    exists: false,
    projectName: null,
    cmakeMinimum: null,
    variables: {},
    targets: [],
    subdirectories: [],
    commands: [],
    diagnostics: []
  }

  if (!existsSync(file)) {
    model.diagnostics.push(`找不到 ${file}`)
    return model
  }
  model.exists = true

  let text: string
  try {
    text = readFileSync(file, 'utf8')
  } catch (err) {
    model.diagnostics.push(`读不了 ${file}：${(err as Error).message}`)
    return model
  }

  const commands = scanCommands(text)
  model.commands = commands
  const vars = collectVariables(commands)
  /**
   * 内建变量兜底。
   *
   * **必须做**：真实工程里源码几乎都写成
   * `${CMAKE_CURRENT_SOURCE_DIR}/application/main.c`，而 `CMAKE_CURRENT_SOURCE_DIR`
   * 是 CMake 内建变量、不在 `set()` 里 —— 不兜底的话这些 token 展不开，
   * 会被当成「无法静态确定」全部丢掉，表现就是「源文件 0 个」。
   * `set()` 里显式赋过值的优先，所以放后面用 ??=。
   */
  vars.CMAKE_CURRENT_SOURCE_DIR ??= root
  vars.CMAKE_CURRENT_LIST_DIR ??= root
  vars.CMAKE_SOURCE_DIR ??= root
  vars.PROJECT_SOURCE_DIR ??= root
  vars.CMAKE_CURRENT_BINARY_DIR ??= join(root, 'build')
  model.variables = vars

  // ---- project / cmake_minimum_required ----
  for (const c of commands) {
    if (c.command === 'cmake_minimum_required') {
      const m = /VERSION\s+([0-9][0-9.]*)/i.exec(c.argsRaw)
      if (m) model.cmakeMinimum = m[1]
    }
    if (c.command === 'project' && c.args.length) {
      model.projectName = expand(c.args[0].text, vars)
      // project() 之后这两个内建变量才有值（set() 里显式写过的优先）
      vars.CMAKE_PROJECT_NAME ??= model.projectName
      vars.PROJECT_NAME ??= model.projectName
      break
    }
  }

  // ---- 目标 ----
  const byName = new Map<string, CmakeTargetModel>()

  const ensureTarget = (rawName: string, kind: TargetKind, line: number, command: string) => {
    const name = expand(rawName, vars)
    let t = byName.get(name)
    if (!t) {
      t = {
        name,
        rawName,
        kind,
        declaredAt: { line, command },
        sources: [],
        includeDirs: [],
        defines: [],
        linkLibs: [],
        globPatterns: []
      }
      byName.set(name, t)
      model.targets.push(t)
    }
    return t
  }

  const pushSource = (target: CmakeTargetModel, arg: ArgSpan, via: string): void => {
    const raw = arg.text
    const expanded = expand(raw, vars)
    const resolved = isResolved(expanded)

    /**
     * **必须按 `;` 拆开**：CMake 的列表就是 `;` 分隔的，而真实工程里到处都是
     *   set(STM32_Drivers_Src Drivers/a.c Drivers/b.c ...)
     *   target_sources(STM32_Drivers PRIVATE ${STM32_Drivers_Src})
     * 展开变量后是一个 `a.c;b.c;c.c` 的长串。不拆的话整串被当成**一个**源文件，
     * 表现就是「几十个文件的工程只解析出几个源文件」。
     * 一个参数可能产出多条记录，所以下面逐个 push。
     */
    const pieces = resolved ? expanded.split(';') : [expanded]

    for (const piece of pieces) {
      const p = piece.trim()
      if (!p) continue
      /**
       * 保留「有路径但变量展不开」的条目（`${UNKNOWN}/foo.c`），relPath 记 null，
       * 界面上灰着显示 —— 让用户看到「这一行我认不出来」，比直接吞掉要好。
       * 但 `${SOURCES}` 这种完全没线索的整块变量要丢掉，否则会被当成源文件。
       */
      if (!looksLikeSource(p) && !(resolved && looksLikeSource(raw))) continue
      if (!resolved && !/\.[A-Za-z]{1,4}$/.test(p)) continue

      const relPath = resolved ? toRelPath(p, root) : null
      const line = lineOf(text, arg.start)
      let exists = false
      if (relPath) {
        try {
          exists = statSync(join(root, relPath.split(posix.sep).join(sep))).isFile()
        } catch {
          exists = false
        }
      }
      target.sources.push({ relPath, raw: p, exists, line, via })
    }
  }

  for (const c of commands) {
    const kind = TARGET_COMMANDS[c.command]
    if (kind && c.args.length) {
      const target = ensureTarget(c.args[0].text, kind, c.startLine, c.command)
      // add_executable / add_library 的后续参数就是源文件
      for (const a of c.args.slice(1)) pushSource(target, a, c.command)
      continue
    }

    if (c.command === 'target_sources' && c.args.length) {
      const target = ensureTarget(c.args[0].text, 'library', c.startLine, c.command)
      for (const a of c.args.slice(1)) pushSource(target, a, c.command)
      continue
    }

    if (c.command === 'target_include_directories' && c.args.length) {
      const target = ensureTarget(c.args[0].text, 'library', c.startLine, c.command)
      for (const a of c.args.slice(1)) {
        const up = a.text.toUpperCase()
        if (KEYWORDS.has(up) || a.text.startsWith('$<')) continue
        const expanded = expand(a.text, vars)
        const relPath = isResolved(expanded) ? toRelPath(expanded, root) : null
        let exists = false
        if (relPath) {
          try {
            exists = statSync(join(root, relPath.split(posix.sep).join(sep))).isDirectory()
          } catch {
            exists = false
          }
        }
        target.includeDirs.push({ raw: a.text, relPath, line: lineOf(text, a.start), exists })
      }
      continue
    }

    if (c.command === 'target_compile_definitions' && c.args.length) {
      const target = ensureTarget(c.args[0].text, 'library', c.startLine, c.command)
      for (const a of c.args.slice(1)) {
        if (KEYWORDS.has(a.text.toUpperCase()) || a.text.startsWith('$<')) continue
        target.defines.push({ raw: a.text, line: lineOf(text, a.start) })
      }
      continue
    }

    if (c.command === 'target_link_libraries' && c.args.length) {
      const target = ensureTarget(c.args[0].text, 'library', c.startLine, c.command)
      for (const a of c.args.slice(1)) {
        if (KEYWORDS.has(a.text.toUpperCase()) || a.text.startsWith('$<')) continue
        target.linkLibs.push({ raw: a.text, line: lineOf(text, a.start) })
      }
      continue
    }

    // ---- file(GLOB ...) ----
    if (c.command === 'file') {
      const sub = c.args[0]?.text.toUpperCase()
      if (sub === 'GLOB' || sub === 'GLOB_RECURSE') {
        // 第一个非关键字参数是变量名，其余是 glob 模式
        const patterns = c.args
          .slice(1)
          .filter(
            (a) => !/^(CONFIGURE_DEPENDS|LIST_DIRECTORIES|RELATIVE|FOLLOW_SYMLINKS)$/i.test(a.text)
          )
          .map((a) => a.text)
        const varName = patterns.shift()
        // 找到把这个变量喂给哪个 target 的场景太绕，先挂到「所有目标」之外的公共提示上
        for (const t of model.targets) t.globPatterns.push(...patterns)
        model.diagnostics.push(
          `第 ${c.startLine} 行用 file(${sub}) 把匹配到的文件收进了 ${varName ?? '(未知变量)'} ——` +
            `这些目标会**自动**收录新文件，手动往 CMakeLists 里加是多余的。`
        )
      }
      continue
    }

    if (c.command === 'add_subdirectory' && c.args.length) {
      const expanded = expand(c.args[0].text, vars)
      const relPath = isResolved(expanded) ? toRelPath(expanded, root) : null
      let hasCmakeLists = false
      if (relPath) {
        const dir = join(root, relPath.split(posix.sep).join(sep))
        hasCmakeLists = existsSync(join(dir, 'CMakeLists.txt'))
      }
      model.subdirectories.push({
        raw: c.args[0].text,
        relPath,
        line: c.startLine,
        hasCmakeLists
      })
      continue
    }
  }

  // 只有 add_executable/add_library 才算「真目标」；
  // target_* 命令先于目标声明出现时，ensureTarget 会造出 kind='library' 的占位。
  for (const t of model.targets) {
    if (
      t.sources.length === 0 &&
      t.includeDirs.length === 0 &&
      t.declaredAt.command.startsWith('target_')
    ) {
      model.diagnostics.push(
        `命令 ${t.declaredAt.command}(${t.rawName} ...) 在第 ${t.declaredAt.line} 行引用了一个` +
          `没在本文件里声明的目标 —— 可能是在 add_subdirectory 的子目录里定义的。`
      )
    }
  }

  return model
}

/** 字符偏移 → 1 起的行号 */
function lineOf(text: string, offset: number): number {
  let line = 1
  for (let i = 0; i < offset && i < text.length; i++) {
    if (text[i] === '\n') line += 1
  }
  return line
}

// --------------------------------------------------------------------------
// 整个工程的 CMakeLists 收集
// --------------------------------------------------------------------------

/** 扫磁盘时永远跳过的目录名（构建产物、IDE、版本控制） */
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

/**
 * 递归找出工程里所有含 CMakeLists.txt 的目录（绝对路径）。
 *
 * 为什么需要「所有」而不是只看根文件：
 * 真实 STM32 工程把 HAL / FreeRTOS 的源文件放在 `cmake/stm32cubemx/CMakeLists.txt` 里
 * （用 `set(STM32_Drivers_Src ...)` 列出来）。只看根文件的话，这几百个文件会被误判成
 * 「在磁盘上但没进构建」，噪声把「加入构建」这个功能彻底淹没。
 */
export function findCmakeLists(root: string, depth = 0): string[] {
  if (depth > 6) return []
  const found: string[] = []
  let entries: import('node:fs').Dirent[]
  try {
    entries = readdirSync(root, { withFileTypes: true })
  } catch {
    return found
  }
  let has = false
  for (const e of entries) {
    if (e.isDirectory()) {
      if (SKIP_DIRS.has(e.name)) continue
      found.push(...findCmakeLists(join(root, e.name), depth + 1))
    } else if (e.isFile() && e.name === 'CMakeLists.txt') {
      has = true
    }
  }
  if (has) found.unshift(root)
  return found
}

/**
 * 收集**整个工程**里被任何 CMakeLists 提到过的源文件与 include 目录。
 *
 * 实现取巧但够用：不做变量求值的精确追踪，而是把每条命令的每个参数都过一遍，
 * 凡是「看起来像源码路径」的就收进来。因为
 *   set(STM32_Drivers_Src Drivers/a.c Drivers/b.c)
 * 里的参数本身就是路径 —— 不需要展开变量就能收全，反而比求值更不容易漏。
 *
 * 返回的 key 统一成**小写 posix 相对路径**，方便和磁盘扫描结果做集合比较。
 */
export function collectReferencedPaths(projectRoot: string): {
  sources: Set<string>
  includes: Set<string>
  dirs: string[]
} {
  const sources = new Set<string>()
  const includes = new Set<string>()
  const dirs = findCmakeLists(projectRoot)

  for (const dir of dirs) {
    let text: string
    try {
      text = readFileSync(join(dir, 'CMakeLists.txt'), 'utf8')
    } catch {
      continue
    }
    for (const c of scanCommands(text)) {
      for (const a of c.args) {
        const rawArg = a.text.trim()
        if (!rawArg || rawArg.startsWith('$<') || KEYWORDS.has(rawArg.toUpperCase())) continue

        /**
         * 先把已知的内建变量替换掉，再决定要不要跳过。
         *
         * 这里踩过一次坑：CubeMX 生成的子目录 CMakeLists 里路径长这样 ——
         *   ${CMAKE_CURRENT_SOURCE_DIR}/../../Drivers/STM32F4xx_HAL_Driver/Src/xxx.c
         * 如果「见到 ${ 就跳过」，200 多个 HAL 源文件一个都收不到，它们会被误判成
         * 「在磁盘上但没进构建」，噪声直接把「加入构建」这个功能淹没。
         * 剩下来还含 ${ 的（真·自定义变量）才跳过 —— 它们所在的那层会列出实际路径。
         */
        const p = substituteBuiltins(rawArg, dir, projectRoot)
        if (p.includes('${')) continue

        if (looksLikeSource(p)) {
          const rel = toRelPathUnder(p, dir, projectRoot)
          if (rel) sources.add(rel.toLowerCase())
        } else if (c.command === 'target_include_directories' && /[\\/]/.test(p)) {
          const rel = toRelPathUnder(p, dir, projectRoot)
          if (rel) includes.add(rel.toLowerCase())
        }
      }
    }
  }

  return { sources, includes, dirs }
}

/** 替换 CMake 内建变量（值只能从「哪个文件、工程根在哪」推出来） */
function substituteBuiltins(token: string, listDir: string, projectRoot: string): string {
  const d = listDir.replace(/\\/g, '/')
  const r = projectRoot.replace(/\\/g, '/')
  return token
    .replace(/\$\{CMAKE_CURRENT_SOURCE_DIR\}/g, d)
    .replace(/\$\{CMAKE_CURRENT_LIST_DIR\}/g, d)
    .replace(/\$\{CMAKE_SOURCE_DIR\}/g, r)
    .replace(/\$\{PROJECT_SOURCE_DIR\}/g, r)
    .replace(/\$\{CMAKE_CURRENT_BINARY_DIR\}/g, '')
}

/** raw 相对 baseDir 解析成绝对路径，再相对 projectRoot 化；越界或解析不了返回 null */
function toRelPathUnder(raw: string, baseDir: string, projectRoot: string): string | null {
  if (!raw) return null
  const cleaned = raw.replace(/\\/g, '/').replace(/^\.\//, '')
  if (cleaned.includes('${') || cleaned.startsWith('$<')) return null
  const abs = resolve(baseDir, cleaned)
  const a = abs.replace(/\\/g, '/').toLowerCase()
  const r = resolve(projectRoot).replace(/\\/g, '/').toLowerCase()
  if (a !== r && !a.startsWith(`${r}/`)) return null
  return abs
    .replace(/\\/g, '/')
    .slice(resolve(projectRoot).replace(/\\/g, '/').length)
    .replace(/^\//, '')
}

// --------------------------------------------------------------------------
// 给「加入构建」用的辅助
// --------------------------------------------------------------------------

/**
 * 找一个可以用来追加源文件的落点。
 *
 * 优先级：
 *   1. 目标自己已有的 `target_sources(target ...)` 列表末尾
 *   2. 目标声明处 `add_executable(target ...)` 的参数末尾
 *   3. 都没有 → null（上层退到「文件末尾追加托管区块」）
 *
 * 返回的 offset 是**插入点**：在这一行的行首插入，缩进跟着锚点那一行走。
 */
export function findSourceInsertPoint(
  model: CmakeModel,
  targetName: string
): { offset: number; indent: string; line: number; via: string } | null {
  const target = model.targets.find((t) => t.name === targetName)
  if (!target) return null
  const text = readFileSync(model.file, 'utf8')

  /**
   * 一个命令能不能当插入点，取决于**源文件是不是独占一行**。
   *
   * 踩过的坑：真实工程里既有
   *     target_sources(t PRIVATE        ← 多行列表，每个文件一行
   *         a.c
   *     )
   * 也有
   *     target_sources(t PRIVATE ${EXTRA_SRCS})   ← 单行，源文件是变量
   * 如果选中后者，插入点会算在这一行的行尾、「缩进」为空，新文件名就被写到
   * `target_sources(...)` 的**外面**去了 —— 文件直接变成非法 CMake，配置当场失败。
   * 所以只接受「最后一个源文件参数位于命令起始行之后」的命令，也就是多行列表。
   */
  const isMultiLineList = (c: CmakeCommandSpan): boolean => {
    const srcArg = [...c.args].reverse().find((a) => looksLikeSource(expand(a.text, model.variables)))
    if (!srcArg) return false
    return lineOf(text, srcArg.start) > c.startLine
  }

  // 1) target_sources：优先最后一条**多行**列表
  const viaTargetSources = model.commands.filter(
    (c) =>
      c.command === 'target_sources' &&
      c.args.length > 0 &&
      expand(c.args[0].text, model.variables) === targetName &&
      isMultiLineList(c)
  )
  const pick = viaTargetSources.length ? viaTargetSources[viaTargetSources.length - 1] : undefined

  if (pick) {
    const lastArg = [...pick.args]
      .reverse()
      .find((a) => looksLikeSource(expand(a.text, model.variables)))
    if (lastArg) {
      return {
        offset: lineStart(model, lastArg.start),
        indent: indentOf(model, lastArg.start),
        line: lineOf(text, lastArg.start),
        via: 'target_sources'
      }
    }
  }

  // 2) add_executable / add_library 的参数末尾（同样要求多行）
  const declarer = model.commands.find(
    (c) =>
      TARGET_COMMANDS[c.command] !== undefined &&
      c.args.length > 0 &&
      expand(c.args[0].text, model.variables) === targetName &&
      isMultiLineList(c)
  )
  if (declarer) {
    const srcArgs = declarer.args
      .slice(1)
      .filter((a) => looksLikeSource(expand(a.text, model.variables)))
    const lastArg = srcArgs[srcArgs.length - 1]
    return {
      offset: lineStart(model, lastArg.start),
      indent: indentOf(model, lastArg.start),
      line: lineOf(text, lastArg.start),
      via: declarer.command
    }
  }

  // 找不到「多行列表」这种安全落点 → 交给上层退到文件末尾的托管区块。
  // 宁可多一块托管区，也不能把文件名写到命令外面去。
  return null
}

function lineStart(model: CmakeModel, offset: number): number {
  const text = readFileSync(model.file, 'utf8')
  let i = offset
  while (i > 0 && text[i - 1] !== '\n') i -= 1
  return i
}

function indentOf(model: CmakeModel, offset: number): string {
  const text = readFileSync(model.file, 'utf8')
  const start = lineStart(model, offset)
  const m = /^[ \t]*/.exec(text.slice(start, offset + 200))
  return m ? m[0] : '    '
}

export { expand as expandCmakeVars, isResolved as isCmakeTokenResolved }
export { isAbsolute }

// --------------------------------------------------------------------------
// 整个构建图（不只是根 CMakeLists.txt）
// --------------------------------------------------------------------------

export interface ProjectBuildModel {
  /** 根 CMakeLists.txt 的模型 —— 写回锚点仍然用这个 */
  main: CmakeModel
  /** 参与构建的全部源文件（相对工程根，去重排序） */
  sources: string[]
  /** 参与构建的 include 目录（相对工程根，只留存在的） */
  includeDirs: string[]
  /** 解析过的文件（相对工程根），用来向用户解释「我看了哪些」 */
  parsedFiles: string[]
  /**
   * 没看全的地方。**非空时上层必须提醒「清单可能不准」** ——
   * 只在根 CMakeLists.txt 里找源文件会漏掉 include()/add_subdirectory() 里的，
   * 于是一堆本来就在构建里的文件被报成「不在构建里」，用户点了「加入构建」
   * 反而会重复编译、链接报 multiple definition。宁可不给结论，也不能给错的。
   */
  unresolved: string[]
  /** 每个声明过源文件的 target（含 OBJECT 库），用来解释「这些文件是谁加的」 */
  targets: Array<{ name: string; kind: TargetKind; file: string; sourceCount: number }>
}

/**
 * 沿着 include() / add_subdirectory() 把**整个构建定义**读一遍。
 *
 * 为什么需要它：CMake 工程常见两类布局
 *   · 分模块：根 CMakeLists.txt 里的 target_sources 是 CubeMX 生成的空占位，
 *     真正的源文件清单在 include() 进来的 cmake/user.cmake 里
 *   · 多目录：源文件挂在 add_subdirectory() 的子 CMakeLists.txt 上
 * 只看根文件会得出「一个源文件都没有」这种**看起来确定、实际错误**的结论。
 *
 * 这里只做「读」，不负责写回 —— 写回要精确的行号锚点，仍然用 buildCmakeModel(根文件)。
 */
export function buildProjectBuildModel(root: string): ProjectBuildModel {
  const mainFile = join(root, 'CMakeLists.txt')
  const main = buildCmakeModel(mainFile, root)
  const rootN = root.replace(/\\/g, '/').replace(/\/$/, '')

  const sources = new Set<string>()
  const includeDirs = new Set<string>()
  const parsedFiles: string[] = []
  const unresolved: string[] = []
  const targets = new Map<string, { kind: TargetKind; file: string; count: number }>()

  const rel = (abs: string): string => abs.replace(/\\/g, '/').slice(rootN.length).replace(/^\//, '')

  /** 把一个 token 展开成路径：先替换内置变量（注意 include 进来的文件里 两者的含义不同），再展开 set 变量 */
  const expandToken = (
    tok: string,
    vars: Record<string, string>,
    sourceDir: string,
    listDir: string
  ): string => {
    let t = tok.replace(/\\/g, '/')
    // 内置变量和 set 变量必须**在同一轮循环里**反复替换：
    // set(USER_APP_ROOT ${CMAKE_CURRENT_LIST_DIR}/..) 这种，存下来的值里带着
    // 内置变量；只在一开始替换一次内置变量的话，从变量值里新冒出来的那些
    // （例如 ${CMAKE_CURRENT_LIST_DIR}）就永远轮不到，最后判成「展开不了」。
    for (let i = 0; i < 12; i++) {
      const before = t
      t = t.replace(/\$\{CMAKE_CURRENT_SOURCE_DIR\}/g, sourceDir.replace(/\\/g, '/'))
      t = t.replace(/\$\{CMAKE_CURRENT_LIST_DIR\}/g, listDir.replace(/\\/g, '/'))
      t = t.replace(/\$\{(CMAKE_SOURCE_DIR|PROJECT_SOURCE_DIR)\}/g, rootN)
      t = t.replace(/\$\{CMAKE_CURRENT_BINARY_DIR\}/g, '')
      t = t.replace(/\$\{([A-Za-z_]\w*)\}/g, (m, k: string) => (vars[k] !== undefined ? vars[k] : m))
      if (t === before) break
    }
    return t
  }

  /**
   * 读一个 CMake 文件。
   * @param sourceDir ${CMAKE_CURRENT_SOURCE_DIR} 指向哪 ——
   *        被 include() 进来时**仍然指向调用者的目录**（CMake 的语义），
   *        add_subdirectory() 进来时才变成子目录
   */
  const visit = (file: string, sourceDir: string, depth: number): void => {
    if (depth > 8) {
      unresolved.push(`嵌套太深，没继续跟进：${rel(file)}`)
      return
    }
    if (!existsSync(file)) return
    const r = rel(file)
    if (parsedFiles.includes(r)) return
    parsedFiles.push(r)

    let text: string
    try {
      text = readFileSync(file, 'utf8')
    } catch {
      unresolved.push(`读不了：${r}`)
      return
    }

    const commands = scanCommands(text)
    const vars = collectVariables(commands)
    const listDir = dirname(file)

    for (const cmd of commands) {
      const vals = cmd.args.map((a) => a.text)

      if (cmd.command === 'file' && vals.some((v) => /GLOB/i.test(v))) {
        // GLOB 收进来的文件没法静态枚举 —— 老实说看不了，别猜
        unresolved.push(`${r}: 用了 file(GLOB ...)，收进来的源文件列不出来`)
        continue
      }

      if (cmd.command === 'include' || cmd.command === 'include_optional') {
        for (const raw of vals) {
          const t = expandToken(raw, vars, sourceDir, listDir)
          if (t.includes('${') || t.startsWith('$<')) {
            unresolved.push(`${r}: include(${raw}) 展开不了`)
            continue
          }
          const abs = isAbsolute(t) ? t : resolve(listDir, t)
          if (!existsSync(abs)) {
            unresolved.push(`${r}: include(${raw}) 指向的文件不存在`)
            continue
          }
          // include 不改变 CMAKE_CURRENT_SOURCE_DIR —— 传下去的 sourceDir 保持不变
          visit(abs, sourceDir, depth + 1)
        }
        continue
      }

      if (cmd.command === 'add_subdirectory') {
        const raw = vals.find((v) => v && !v.startsWith('$<'))
        if (!raw) continue
        const t = expandToken(raw, vars, sourceDir, listDir)
        if (t.includes('${')) {
          unresolved.push(`${r}: add_subdirectory(${raw}) 展开不了`)
          continue
        }
        const subDir = isAbsolute(t) ? t : resolve(listDir, t)
        const subFile = join(subDir, 'CMakeLists.txt')
        if (!existsSync(subFile)) {
          unresolved.push(`${r}: add_subdirectory(${raw}) 下没有 CMakeLists.txt`)
          continue
        }
        visit(subFile, subDir, depth + 1)
        continue
      }

      if (cmd.command === 'add_executable' || cmd.command === 'add_library') {
        const name = vals[0] ? expandToken(vals[0], vars, sourceDir, listDir) : ''
        if (!name) continue
        const kind: TargetKind =
          cmd.command === 'add_executable'
            ? 'executable'
            : /INTERFACE/i.test(vals.join(' '))
              ? 'custom'
              : 'library'
        const prev = targets.get(name)
        if (!prev) targets.set(name, { kind, file: r, count: 0 })
        else if (kind === 'executable') prev.kind = 'executable'
        continue
      }

      if (cmd.command === 'target_sources') {
        const name = vals[0] ? expandToken(vals[0], vars, sourceDir, listDir) : ''
        let added = 0
        for (const raw of vals.slice(1)) {
          if (/^(PRIVATE|PUBLIC|INTERFACE)$/i.test(raw)) continue
          if (raw.startsWith('$<')) {
            unresolved.push(`${r}: target_sources 里有生成器表达式 ${raw}`)
            continue
          }
          const t = expandToken(raw, vars, sourceDir, listDir)
          if (t.includes('${')) {
            unresolved.push(`${r}: target_sources 里 ${raw} 展开不了`)
            continue
          }
          // set(X a b c) 展开出来是 'a;b;c'，必须按 ; 拆
          for (const piece of t.split(';')) {
            const p = piece.trim()
            if (!p || !looksLikeSource(p)) continue
            const rp = toRelPathUnder(p, listDir, root)
            if (rp) {
              sources.add(rp)
              added += 1
            } else if (!p.includes('$')) {
              // 工程外的源码（比如库），不算遗漏，但也不列进来
            }
          }
        }
        if (name) {
          const prev = targets.get(name) ?? { kind: 'library' as TargetKind, file: r, count: 0 }
          prev.count += added
          targets.set(name, prev)
        }
        continue
      }

      if (cmd.command === 'target_include_directories') {
        for (const raw of vals.slice(1)) {
          if (/^(PRIVATE|PUBLIC|INTERFACE|SYSTEM|BEFORE|AFTER)$/i.test(raw) || raw.startsWith('$<'))
            continue
          const t = expandToken(raw, vars, sourceDir, listDir)
          if (t.includes('${')) continue
          // set(X a b c) 展开出来是 'a;b;c'，必须按 ; 拆成一个个目录。
          // 少了这一步整串会被当成一个路径、解不出来，include 目录永远是 0 ——
          // 源文件那边早就按 ; 拆了，这里漏了。
          for (const piece of t.split(';')) {
            const p = piece.trim()
            if (!p) continue
            const rp = toRelPathUnder(p, listDir, root)
            if (rp && existsSync(join(root, rp.split('/').join(sep)))) includeDirs.add(rp)
          }
        }
      }
    }
  }

  if (existsSync(mainFile)) visit(mainFile, dirname(mainFile), 0)
  else unresolved.push('工程根没有 CMakeLists.txt')

  return {
    main,
    sources: [...sources].sort(),
    includeDirs: [...includeDirs].sort(),
    parsedFiles: parsedFiles.sort(),
    unresolved,
    targets: [...targets].map(([name, v]) => ({
      name,
      kind: v.kind,
      file: v.file,
      sourceCount: v.count
    }))
  }
}
