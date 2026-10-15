/**
 * 模块包（Pack）的装载与「这个包能不能装到这个工程上」的检查。
 *
 * 两件事：
 *   1. 把 packs/<id>/pack.json 读成 PackManifest
 *   2. 摸清目标工程里有什么（头文件、串口、DMA、中断、已有模块），据此
 *      · 给出兼容性报告（能不能装、要替你适配什么）
 *      · 推出参数默认值（比如「这个串口没配 RX DMA」→ 自动选逐字节中断）
 *      · 扫出可以一键注册的 PID 结构体
 *
 * 「探测」和「判断」分开写：inspectProject 只负责把事实收集起来，不预设哪个包要用；
 * 包相关的判断都在 checkPackCompat 里，加新包不用改探测逻辑。
 */

import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs'
import { join, posix, sep } from 'node:path'
import type { PackCheck, PackCompatReport, PackManifest, PidCandidate } from '@shared/packTypes'

// --------------------------------------------------------------------------
// 包目录
// --------------------------------------------------------------------------

/**
 * packs 放哪。
 * 打包后走 extraResources 复制到 resources/packs；开发时就是仓库根的 packs/。
 * 两者内容一样，所以开发时看到的和用户装到的完全一致。
 */
export function packsDir(): string {
  // packs 的位置随运行方式变，所以按顺序试几个候选，第一个存在的就用：
  //   · 打包后：进程里 __dirname 是 <app>/resources/app.asar/out/main，
  //     packs 在 asar 外面（extraResources → resources/packs）
  //   · 开发时：__dirname 是 <repo>/out/main，packs 在仓库根
  //   · 自检运行器：它把 TS 打包成仓库根的一个 .cjs，__dirname 就是仓库根
  // 刻意**不问** electron 的 app.isPackaged —— 自检是纯 Node，压根没有 electron。
  const candidates: string[] = []
  // 注意：纯 Node 下 process.resourcesPath 是 undefined，join('', 'packs') 会得到
  // 相对路径 "packs" —— 靠当前目录侥幸命中，换个工作目录就废。所以先判空再加。
  if (process.resourcesPath) candidates.push(join(process.resourcesPath, 'packs'))
  candidates.push(
    join(__dirname, '../../packs'),
    join(__dirname, 'packs'),
    join(__dirname, '../packs'),
    join(process.cwd(), 'packs')
  )
  for (const c of candidates) {
    if (c && existsSync(c)) return c
  }
  return candidates[0]
}

export function listPacks(): PackManifest[] {
  const dir = packsDir()
  if (!existsSync(dir)) return []
  const out: PackManifest[] = []
  for (const e of readdirSync(dir, { withFileTypes: true })) {
    if (!e.isDirectory()) continue
    const m = loadPack(e.name)
    if (m) out.push(m)
  }
  return out.sort((a, b) => a.name.localeCompare(b.name))
}

export function loadPack(id: string): PackManifest | null {
  if (!/^[a-z0-9-]+$/i.test(id)) return null
  const dir = join(packsDir(), id)
  const file = join(dir, 'pack.json')
  if (!existsSync(file)) return null
  try {
    const m = JSON.parse(readFileSync(file, 'utf8')) as PackManifest
    m.dir = dir
    m.params ??= []
    m.files ??= []
    m.generated ??= []
    m.patches ??= []
    m.manualSteps ??= []
    m.requires ??= {}
    return m
  } catch {
    return null
  }
}

/** 读 pack 里的一个文件（固定文件或模板） */
export function readPackFile(id: string, relName: string): string | null {
  const dir = join(packsDir(), id, 'files', relName)
  if (!existsSync(dir)) return null
  try {
    return readFileSync(dir, 'utf8')
  } catch {
    return null
  }
}

// --------------------------------------------------------------------------
// 工程探测
// --------------------------------------------------------------------------

export interface UartFact {
  /** huart1 */
  name: string
  /** USART1_IRQn */
  irq: string
  /** USART1_IRQHandler */
  handler: string
  /** hdma_usart1_tx，没有则 null */
  txDma: string | null
  /** hdma_usart1_rx，没有则 null —— 没有说明 CubeMX 里没配 RX DMA */
  rxDma: string | null
  /** 工程里已经定义了这个中断处理函数吗 */
  handlerDefined: boolean
  /** 谁在用它（从文件名猜的，给界面提示别抢串口） */
  usedBy: string[]
}

export interface ProjectFacts {
  root: string
  /** 头文件名（小写）→ 相对路径 */
  headers: Map<string, string>
  /** 符号名 → 出现的文件（相对路径） */
  symbols: Map<string, string>
  /** 符号名 → 声明它的头文件（用来生成 #include） */
  symbolHeaders: Map<string, string>
  uarts: UartFact[]
  hasStructTypedef: boolean
  /** 工程里已经有 application/vofa 之类的目录 */
  existingVofa: string[]
  /** 参与扫描的源文件数 */
  scannedFiles: number
}

/** 这些目录不参与内容扫描（太大且和业务无关），但仍然会按文件名索引头文件 */
const SKIP_CONTENT =
  /(^|[\\/])(Drivers|Middlewares|build|out|node_modules|\.git|\.vscode|\.idea|CMakeFiles)([\\/]|$)/i
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

function rel(root: string, abs: string): string {
  return abs
    .slice(root.length)
    .replace(/^[\\/]/, '')
    .split(sep)
    .join(posix.sep)
}

export function inspectProject(root: string): ProjectFacts {
  const facts: ProjectFacts = {
    root,
    headers: new Map(),
    symbols: new Map(),
    symbolHeaders: new Map(),
    uarts: [],
    hasStructTypedef: false,
    existingVofa: [],
    scannedFiles: 0
  }

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
        if (SKIP_DIR.has(e.name)) continue
        if (/^vofa/i.test(e.name) || /(^|[\\/])vofa$/i.test(dir))
          facts.existingVofa.push(rel(root, full))
        walk(full, depth + 1)
        continue
      }
      if (!/\.(c|h|cpp|hpp)$/i.test(e.name)) continue

      const r = rel(root, full)
      const lower = e.name.toLowerCase()
      if (!facts.headers.has(lower)) facts.headers.set(lower, r)
      if (/vofa/i.test(r)) facts.existingVofa.push(r)
      if (SKIP_CONTENT.test(full)) continue

      facts.scannedFiles += 1
      let text: string
      try {
        text = readFileSync(full, 'utf8')
      } catch {
        continue
      }
      for (const sym of [
        'usart1_tx_dma_enable',
        'HAL_UARTEx_ReceiveToIdle_DMA',
        'HAL_UART_Receive_IT',
        // 生成绑定表达式会用到的访问器，顺手记下它们声明在哪个头文件
        'get_remote_control_point',
        'get_yaw_motor_point',
        'get_pitch_motor_point'
      ]) {
        if (text.includes(sym) && !facts.symbols.has(sym)) facts.symbols.set(sym, r)
        // 「声明它的头文件」必须是**真的声明**（`extern ... sym(...)`），不能只看出现。
        // 否则工具自己生成的 vofa_config.h 里也有 usart1_tx_dma_enable 这个词
        // （在 VOFA_TX_FN 宏里），会被误当成声明处 —— 于是生成出
        // #define VOFA_TX_HEADER "vofa_config.h"，自己 include 自己，函数还是没声明。
        const declares = new RegExp(
          `\\bextern\\b[^;{}]*\\b${sym.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\s*\\(`
        )
        if (/\.h$/i.test(e.name) && declares.test(text) && !facts.symbolHeaders.has(sym)) {
          facts.symbolHeaders.set(sym, r)
        }
      }
      if (lower === 'struct_typedef.h') facts.hasStructTypedef = true
    }
  }
  walk(root, 0)
  facts.hasStructTypedef = facts.headers.has('struct_typedef.h')

  // ---- 串口事实 ----
  // 从 usart.h/usart.c 里找 huartN，从全工程找 hdma_usartN_rx / USARTn_IRQHandler
  const usartH = facts.headers.get('usart.h')
  const usartC = facts.headers.get('usart.c')
  const names = new Set<string>()
  for (const f of [usartH, usartC]) {
    if (!f) continue
    try {
      const t = readFileSync(join(root, f.split(posix.sep).join(sep)), 'utf8')
      for (const m of t.matchAll(/UART_HandleTypeDef\s+(huart\d+)\s*;/g)) names.add(m[1])
    } catch {
      /* ignore */
    }
  }

  const allText: string[] = []
  const collectText = (dir: string, depth: number): void => {
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
        if (SKIP_DIR.has(e.name)) continue
        collectText(full, depth + 1)
      } else if (/\.(c|h)$/i.test(e.name) && !SKIP_CONTENT.test(full)) {
        try {
          allText.push(readFileSync(full, 'utf8'))
        } catch {
          /* ignore */
        }
      }
    }
  }
  collectText(root, 0)
  const joined = allText.join('\n')

  for (const name of [...names].sort()) {
    const n = name.replace('huart', '')
    const usedBy: string[] = []
    if (new RegExp(`USART${n}_IRQHandler`, 'i').test(joined)) usedBy.push('工程里已有中断处理')
    facts.uarts.push({
      name,
      irq: `USART${n}_IRQn`,
      handler: `USART${n}_IRQHandler`,
      txDma: new RegExp(`\\bhdma_usart${n}_tx\\b`).test(joined) ? `hdma_usart${n}_tx` : null,
      rxDma: new RegExp(`\\bhdma_usart${n}_rx\\b`).test(joined) ? `hdma_usart${n}_rx` : null,
      handlerDefined: new RegExp(`void\\s+USART${n}_IRQHandler\\s*\\(`).test(joined),
      usedBy
    })
  }

  // 谁在用哪个串口（从文件名 + 常见关键字猜，只用于提示）
  for (const u of facts.uarts) {
    const n = u.name.replace('huart', '')
    const owners: string[] = []
    for (const f of facts.headers.values()) {
      if (/remote_control|bsp_rc/.test(f) && n === '3') owners.push(f)
      if (/referee/.test(f) && n === '6') owners.push(f)
    }
    u.usedBy = [...new Set(owners)]
  }

  return facts
}

// --------------------------------------------------------------------------
// 兼容性检查
// --------------------------------------------------------------------------

/**
 * 判断这个包能不能装到这个工程上，并把「要替你适配什么」说清楚。
 *
 * 探测到的情况会转成 derived 参数覆盖 pack.json 的默认值 —— 例如这个串口没配
 * RX DMA，就自动选逐字节中断，而不是让用户自己去理解 DMA 和中断的区别。
 */
export function checkPackCompat(
  pack: PackManifest,
  root: string,
  facts?: ProjectFacts
): PackCompatReport {
  const f = facts ?? inspectProject(root)
  const checks: PackCheck[] = []
  const derived: Record<string, string | number | boolean> = {}

  // ---- 必需头文件 ----
  for (const h of pack.requires.headers ?? []) {
    const found = f.headers.has(h.toLowerCase())
    checks.push({
      level: found ? 'ok' : 'err',
      label: `头文件 ${h}`,
      detail: found ? `找到于 ${f.headers.get(h.toLowerCase())}` : '工程里找不到，装了也编译不过'
    })
  }

  // ---- 可选头文件（决定适配方式）----
  for (const h of pack.requires.optionalHeaders ?? []) {
    const found = f.headers.has(h.toLowerCase())
    checks.push({
      level: found ? 'ok' : 'info',
      label: `头文件 ${h}（可选）`,
      detail: found ? `找到于 ${f.headers.get(h.toLowerCase())}` : '没有',
      adapted: found ? undefined : adaptNote(pack.id, h)
    })
  }

  // ---- 必需符号 ----
  for (const s of pack.requires.symbols ?? []) {
    const hit = f.symbols.get(s)
    checks.push({
      level: hit ? 'ok' : 'warn',
      label: `符号 ${s}`,
      detail: hit
        ? `出现于 ${hit}`
        : '没找到。TX 发送要靠它，装之前先确认工程里有类似的「一次性 DMA 发送」封装'
    })
  }

  // ---- 串口 ----
  if (pack.id === 'vofa') {
    const wanted = String(pack.params.find((p) => p.key === 'uart')?.default ?? 'huart1')
    const uart = f.uarts.find((u) => u.name === wanted)

    if (!uart) {
      checks.push({
        level: 'err',
        label: `串口 ${wanted}`,
        detail: f.uarts.length
          ? `工程里只有 ${f.uarts.map((u) => u.name).join(' / ')}，没有 ${wanted}`
          : '在 usart.h / usart.c 里没找到任何 UART 句柄'
      })
    } else {
      checks.push({
        level: 'ok',
        label: `串口 ${uart.name}`,
        detail: `TX DMA ${uart.txDma ?? '无'} · RX DMA ${uart.rxDma ?? '无'}${
          uart.usedBy.length ? ` · 可能被 ${uart.usedBy.join('、')} 占用` : ''
        }`
      })

      // TX：没有 TX DMA 的话发波形会退化成阻塞发送，能跑但会影响实时性
      if (!uart.txDma) {
        checks.push({
          level: 'warn',
          label: 'TX DMA',
          detail: `${uart.name} 没有配 TX DMA，波形发送会占用 CPU`
        })
      }

      // RX：这是「要不要回 CubeMX」的关键
      if (uart.rxDma) {
        derived.rxMode = 'dma'
        checks.push({
          level: 'ok',
          label: '命令接收方式',
          detail: `${uart.name} 已经有 RX DMA，自动选 DMA Circular（吞吐更好）`,
          adapted: 'rxMode = dma'
        })
      } else {
        derived.rxMode = 'it'
        checks.push({
          level: 'ok',
          label: '命令接收方式',
          detail: `${uart.name} 没配 RX DMA，自动选逐字节中断 —— 这样不用回 CubeMX 加 DMA`,
          adapted: 'rxMode = it'
        })
      }

      // 中断入口：工程里已有就不要再定义
      if (uart.handlerDefined) {
        derived.builtinIrq = false
        checks.push({
          level: 'ok',
          label: '中断入口',
          detail: `工程里已经有 ${uart.handler}，模块不重复定义`,
          adapted: 'builtinIrq = false'
        })
      } else {
        derived.builtinIrq = true
        checks.push({
          level: 'ok',
          label: '中断入口',
          detail: `工程里没有 ${uart.handler}。模块会自己在运行时使能 NVIC 并自带中断入口 —— 一行 CubeMX 都不用改`,
          adapted: 'builtinIrq = true'
        })
      }

      derived.uart = uart.name
      derived.uartHeader = f.headers.get('usart.h') ?? 'usart.h'
      derived.irq = uart.irq
      derived.irqHandler = uart.handler
    }

    derived.hasStructTypedef = f.hasStructTypedef ? 1 : 0
    if (!f.hasStructTypedef) {
      checks.push({
        level: 'info',
        label: 'fp32 / bool_t',
        detail: '工程里没有 struct_typedef.h，模块改用 <stdint.h>/<stdbool.h> 自己定义',
        adapted: 'VOFA_HAS_STRUCT_TYPEDEF = 0'
      })
    }
  }

  // ---- 已有同名模块 ----
  const existing = f.existingVofa.filter((p) => /vofa/i.test(p))
  if (existing.length) {
    checks.push({
      level: 'warn',
      label: '工程里已经有 vofa 相关文件',
      detail: `会覆盖：${existing.slice(0, 6).join('、')}${existing.length > 6 ? ' …' : ''}`,
      adapted: '定稿前会自动存快照，可一键还原'
    })
  }

  return {
    packId: pack.id,
    root,
    blocked: checks.some((c) => c.level === 'err'),
    checks,
    derived,
    existingModule: existing.length > 0
  }
}

/** 缺了某个可选头文件时，我们做了什么替代 */
function adaptNote(packId: string, header: string): string {
  if (packId !== 'vofa') return '可选'
  if (header === 'struct_typedef.h') return '改用 <stdint.h>/<stdbool.h> 定义 fp32 / bool_t'
  if (header === 'bsp_usart.h') return '需要把 TX 发送函数指到工程里现成的那个'
  return '可选'
}

// --------------------------------------------------------------------------
// PID 结构体扫描
// --------------------------------------------------------------------------

// 不要求写在行首：`typedef struct { pid_type_def some_pid; } other_t;` 这种单行
// 写法很常见，锚了 ^ 就整行扫不到（自检里就是这么抓出来的）。
const PID_TYPE_RE = /(pid_type_def|gimbal_PID_t)\s+([A-Za-z_]\w*)\s*(\[[^\]]*\])?\s*;/g

/**
 * 找出工程里所有 `pid_type_def` / `gimbal_PID_t` 的声明。
 *
 * 关键点：**大部分不是全局变量，而是结构体成员**
 * （`gimbal_motor_t` 里的 `gimbal_motor_gyro_pid` 这种），注册时要通过实例访问，
 * 例如 `&yaw->gimbal_motor_gyro_pid`。所以这里要区分「是不是成员」并给出所属结构体名，
 * 界面才好提示用户填实例表达式。
 *
 * 判定办法：先用正则把每个 `typedef struct { ... } Name;` 的行号范围找出来，
 * 再看每个 PID 声明落在哪个范围里。简单但够用（这些工程里没有深层嵌套结构体）。
 */
export function scanPidStructs(root: string): PidCandidate[] {
  const out: PidCandidate[] = []
  /**
   * 类型名 → 工程里**真实存在**的全局实例名（来自 `extern Type name;`）。
   * 早期版本对 chassis_move_t 直接编了个 "chassis_move"，生成代码报 undeclared ——
   * 这个变量工程里压根没有，而且猜错了不编译根本发现不了。
   */
  const instanceByType = new Map<string, string>()
  /** 工程里声明过的函数名，用来确认访问器真的存在 */
  const declaredFns = new Set<string>()

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
      if (!/\.(c|h)$/i.test(e.name)) continue

      let text: string
      try {
        text = readFileSync(full, 'utf8')
      } catch {
        continue
      }

      // 0) 收集全局实例与已声明的函数（要给候选拼表达式用）
      for (const m of text.matchAll(/\bextern\s+([A-Za-z_]\w*)\s+([A-Za-z_]\w*)\s*;/g)) {
        if (!instanceByType.has(m[1])) instanceByType.set(m[1], m[2])
      }
      for (const m of text.matchAll(/\bextern\s+[A-Za-z_][\w \t*]*?\b([A-Za-z_]\w*)\s*\(/g)) {
        declaredFns.add(m[1])
      }

      // 1) 找出所有 typedef struct 块的行号范围
      const structs: Array<{ start: number; end: number; name: string }> = []
      for (const m of text.matchAll(/typedef\s+struct[^;{]*\{([\s\S]*?)\}\s*([A-Za-z_]\w*)\s*;/g)) {
        const idx = m.index ?? 0
        const start = text.slice(0, idx).split('\n').length
        const end = text.slice(0, idx + m[0].length).split('\n').length
        structs.push({ start, end, name: m[2] })
      }

      // 2) 找 PID 声明，看落在哪个结构体里
      const relPath = rel(root, full)
      for (const m of text.matchAll(PID_TYPE_RE)) {
        const idx = m.index ?? 0
        const line = text.slice(0, idx).split('\n').length
        const name = m[2]
        const owner = structs.find((s) => line >= s.start && line <= s.end) ?? null
        out.push({
          id: `${relPath}:${line}:${name}`,
          name,
          pidType: m[1] as PidCandidate['pidType'],
          isMember: Boolean(owner),
          ownerType: owner?.name ?? null,
          isArray: Boolean(m[3]),
          file: relPath,
          line,
          hint: owner ? suggestHint(owner.name) : '全局变量',
          ...suggestExpr(owner?.name ?? null, name, instanceByType, declaredFns)
        })
      }
    }
  }
  walk(root, 0)

  return out.sort((a, b) => a.file.localeCompare(b.file) || a.line - b.line)
}

/** 给界面显示的一句提示 */
function suggestHint(typeName: string): string {
  if (/gimbal_motor/i.test(typeName)) return 'yaw-> 或 pitch->（预填的是 yaw，要调 pitch 就改一下）'
  return '要填「实例.字段」，实例名得工程里真实存在'
}

/**
 * 猜一个**可以直接用**的表达式。
 *
 * 为什么不是只给一句「yaw-> 或 pitch->」：那样用户还得自己拼完整表达式，
 * 等于变相手输。这里按结构体名猜一个常用访问方式，预填进去，用户最多改个 yaw/pitch。
 *
 * 判空也跟着一起给：`get_xxx_point()` 在模块初始化前可能返回 NULL，
 * 原实现里是判过空的，生成代码不能丢这一步。
 */
function suggestExpr(
  ownerType: string | null,
  field: string,
  instanceByType: Map<string, string>,
  declaredFns: Set<string>
): {
  suggestedExpr: string
  suggestedGuard: string
  needsInstance?: boolean
} {
  if (!ownerType) return { suggestedExpr: field, suggestedGuard: '' }

  // 云台：有配套访问器就用它，顺带给出判空表达式（原实现里也判过空）
  if (/gimbal_motor/i.test(ownerType) && declaredFns.has('get_yaw_motor_point')) {
    return {
      suggestedExpr: `get_yaw_motor_point()->${field}`,
      suggestedGuard: 'get_yaw_motor_point()'
    }
  }

  // 其它类型：只在工程里**确实存在**该类型的全局实例时才敢拼。
  // 早期版本对 chassis_move_t 直接编了个 "chassis_move"，结果生成代码报
  // 'chassis_move' undeclared —— 这个变量工程里压根没有，而且猜错了不编译发现不了。
  const inst = instanceByType.get(ownerType)
  if (inst) return { suggestedExpr: `${inst}.${field}`, suggestedGuard: '' }

  // 查不到就**留空**并标记出来，让界面提示用户先填实例
  return { suggestedExpr: '', suggestedGuard: '', needsInstance: true }
}
