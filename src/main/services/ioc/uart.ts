/**
 * 把一个串口的外设配置直接写进 `.ioc`，而不是让用户自己回 CubeMX 点。
 *
 * ## 为什么这条路值得做
 *
 * 模块本身（`vofa_task.c`）在运行时能自己开 NVIC、自己补中断入口，所以
 * 「能收命令」不需要动 CubeMX。但有**两样东西模块改不了**：
 *
 *   ① 波特率 —— 那是 `Src/usart.c` 里 `huart1.Init.BaudRate`，由 CubeMX 生成
 *   ② RX DMA 的接线（Stream / Channel 是芯片硬件决定的，只能在 .ioc 里配）
 *
 * 所以「参数面板里选了 dma 却什么都没发生」这种体验必须消灭：选了什么，
 * 就得真的落到 `.ioc` 上，并且顺带把 CubeMX 跑一遍，让 `Src/` 真的变。
 *
 * ## 为什么只改「语义键」不按行号
 *
 * CubeMX 重新生成后会把无关字段重排，按行号改明天就写错键（详见
 * `edit.ts` 头部）。这里全部走 `IocEditor.set()`。
 *
 * ## 不复用 `vt13/iocSpec.ts` 的原因
 *
 * 那份是**给 USART1 + 固定 921600 写死**的常量。这里用户能在 6 个串口里选、
 * 波特率也是变量，所以映射表按「芯片 + 串口」组织；两者只是长得像，
 * 抽成一个反而两边都别扭。
 */

import { existsSync, readFileSync } from 'node:fs'
import { join, relative, sep } from 'node:path'
import { findIocFile, parseIoc } from './index'
import { IocEditor } from './edit'

export interface IocUartParams {
  /** HAL 句柄名：huart1 */
  uart: string
  baud: number
  rxMode: 'it' | 'dma'
  /**
   * RX DMA 的工作模式。
   *
   * - `circular`（默认）：DMA 一直跑，空闲中断里按偏移取新字节，**没有重挂间隙**
   * - `normal`：一次空闲/传输完成事件后 DMA 就停，固件得在回调里重新挂
   *
   * 这条以前是写死的 `DMA_NORMAL`，而固件按 circular 写的（用 `last % SIZE`
   * 记偏移、从不重挂）—— 于是第一条命令收完就再也收不到。
   */
  dmaMode: 'circular' | 'normal'
  /** 由模块自己开 NVIC 并自带中断入口（true 时不动 .ioc 的 NVIC） */
  builtinIrq: boolean
  irqPriority: number
}

export interface IocUartChange {
  key: string
  before: string | null
  after: string
}

export interface IocUartPlan {
  ok: boolean
  /** `.ioc` 绝对路径 */
  iocPath: string | null
  /** 相对工程根、正斜杠 */
  relPath: string | null
  /** 改前 / 改后的完整文本（界面拿去做 diff，不落盘） */
  before: string | null
  after: string | null
  changes: IocUartChange[]
  /** 人话说明这次改了什么 */
  notes: string[]
  /** 不影响成功、但用户该知道的 */
  warnings: string[]
  error?: string
  /** CubeMX 重新生成后要盯住的产物（相对工程根） */
  watch: string[]
  /** 用来事后核对波特率的 HAL 句柄 */
  handle: string
  /** .ioc 里这个串口是不是已经启用了（没启用就什么都不能改） */
  enabled: boolean
}

// --------------------------------------------------------------------------
// huart1 → USART1 / UART4
// --------------------------------------------------------------------------

/** HAL 句柄名 → `.ioc` 里的外设名 */
export function peripheralOf(handle: string): string | null {
  const h = handle.trim().toLowerCase()
  const lpuart = /^hlpuart(\d+)$/.exec(h)
  if (lpuart) return `LPUART${lpuart[1]}`
  const m = /^huart(\d+)$/.exec(h)
  if (!m) return null
  const n = Number(m[1])
  // STM32 命名规则：1/2/3/6 是 USART（带同步模式），4/5/7/8/9/10 是 UART
  return n === 1 || n === 2 || n === 3 || n === 6 ? `USART${n}` : `UART${n}`
}

/** `.ioc` 里的外设名 → HAL 句柄名 */
export function handleOf(peripheral: string): string {
  return `h${peripheral.toLowerCase()}`
}

// --------------------------------------------------------------------------
// DMA 接线（芯片硬约束）
// --------------------------------------------------------------------------

interface DmaRoute {
  /** 可用的 Stream，顺序即优先尝试顺序 */
  streams: string[]
  channel: string
}

/**
 * F4 / F7 上各串口 RX 可用的 DMA 通道。
 *
 * 这是**硬件连线**决定的，配错了编译能过、DMA 一动不动 ——
 * 所以宁可只列确定知道的型号，遇到没列过的芯片就明确说「你自己在 CubeMX 里勾」，
 * 而不是猜一个 Stream 写进去。
 */
const F4_F7_RX_ROUTES: Record<string, DmaRoute> = {
  USART1: { streams: ['DMA2_Stream5', 'DMA2_Stream2'], channel: 'DMA_CHANNEL_4' },
  USART2: { streams: ['DMA1_Stream5'], channel: 'DMA_CHANNEL_4' },
  USART3: { streams: ['DMA1_Stream1'], channel: 'DMA_CHANNEL_4' },
  UART4: { streams: ['DMA1_Stream2'], channel: 'DMA_CHANNEL_4' },
  UART5: { streams: ['DMA1_Stream0'], channel: 'DMA_CHANNEL_4' },
  USART6: { streams: ['DMA2_Stream1', 'DMA2_Stream2'], channel: 'DMA_CHANNEL_5' },
  UART7: { streams: ['DMA1_Stream3'], channel: 'DMA_CHANNEL_5' },
  UART8: { streams: ['DMA1_Stream6'], channel: 'DMA_CHANNEL_5' }
}

function rxRoute(family: string | null, peripheral: string): DmaRoute | null {
  if (!family) return null
  // F4 和 F7 在这些串口上的 DMA 映射一致
  if (!/^STM32F(4|7)/i.test(family)) return null
  return F4_F7_RX_ROUTES[peripheral] ?? null
}

/** RX DMA 请求的字段（顺序即 RequestParameters 的顺序，不能乱） */
function rxDmaFields(stream: string, mode: 'circular' | 'normal'): Record<string, string> {
  return {
    Instance: stream,
    Direction: 'DMA_PERIPH_TO_MEMORY',
    PeriphInc: 'DMA_PINC_DISABLE',
    MemInc: 'DMA_MINC_ENABLE',
    PeriphDataAlignment: 'DMA_PDATAALIGN_BYTE',
    MemDataAlignment: 'DMA_MDATAALIGN_BYTE',
    /*
     * CIRCULAR：DMA 地址指针自己回卷，空闲中断里按「上次偏移 → 本次偏移」取值，
     *   两次命令之间没有空窗，921600 也不丢字节。固件就是按这个写的。
     * NORMAL：一次空闲事件后 DMA 停下，固件必须在回调里重新挂 ——
     *   重挂本身要几个微秒，波特率很高时正好撞上下一帧的开头就会丢字节。
     */
    Mode: mode === 'circular' ? 'DMA_CIRCULAR' : 'DMA_NORMAL',
    Priority: 'DMA_PRIORITY_MEDIUM',
    FIFOMode: 'DMA_FIFOMODE_DISABLE'
  }
}

/** `.ioc` 里的 Mode 值 → 我们能理解的两个词 */
function modeOf(value: string | null | undefined): 'circular' | 'normal' | null {
  if (!value) return null
  if (/CIRCULAR/i.test(value)) return 'circular'
  if (/NORMAL/i.test(value)) return 'normal'
  return null
}

/** 界面上怎么说这两个模式 */
export function modeLabel(mode: 'circular' | 'normal'): string {
  return mode === 'circular' ? '循环（CIRCULAR）' : '单次（NORMAL）'
}

/**
 * 从 `.ioc` 里读出某个串口 RX DMA 的真实模式。
 *
 * 这个信息**源码里读不出来**：`hdma_usart1_rx` 在 NORMAL 和 CIRCULAR 下
 * 名字一模一样，只有 `.ioc` 和 `Src/usart.c` 里的 `hdma.Init.Mode` 知道。
 * 界面要显示「循环 / 单次」，就得从这里拿。
 */
export function readRxDmaMode(root: string, peripheral: string): 'circular' | 'normal' | null {
  const iocPath = findIocFile(root)
  if (!iocPath) return null
  let text: string
  try {
    text = readFileSync(iocPath, 'utf8')
  } catch {
    return null
  }
  const ident = `${peripheral}_RX`
  const re = new RegExp(`^Dma\\.${ident}\\.(\\d+)\\.Mode=(.+)$`, 'm')
  return modeOf(re.exec(text)?.[2] ?? null)
}

// --------------------------------------------------------------------------
// NVIC 值
// --------------------------------------------------------------------------

/**
 * NVIC 的值是一串**用 `\:` 分隔**的字段（`.ioc` 格式要求转义冒号）。
 *
 * 字段含义 CubeMX 没有公开文档，这里是**实测**出来的：
 *   第 1 位 使能 / 第 2 位 抢占优先级 / 第 3 位 子优先级 / **第 4 位 = 生成中断函数**
 *
 * 第 4 位特别关键：它是 `false` 时 CubeMX 只写 `HAL_NVIC_EnableIRQ()`（在 dma.c 里），
 * **但不会生成 `DMA2_Stream5_IRQHandler`**。NVIC 开着、函数没有 → 中断一来就掉进
 * `Default_Handler` 的死循环，板子直接卡死。
 *
 * 对照数据（同一个工程里）：
 *   DMA2_Stream1/6/7 = true\:5\:0\:true\:false\:true\:true\:false\:true\:true  → 有 handler
 *   DMA1_Stream1/7   = true\:5\:0\:true\:false\:false\:true\:false\:…        → 没有 handler
 * 拿这两组跑 CubeMX 对比确认过（改成 true 后 it.c 里就多出了 handler）。
 *
 * 已有这一行时只改优先级、其余位原样保留。
 */
function nvicWithPriority(existing: string | null, priority: number, fallback: string): string {
  if (!existing) return fallback.replaceAll('{p}', String(priority))
  const parts = existing.split('\\:')
  if (parts.length < 2) return fallback.replaceAll('{p}', String(priority))
  parts[1] = String(priority)
  return parts.join('\\:')
}

/**
 * 新加一个 DMA Stream 中断时的值。
 *
 * 第 4 位必须是 `true`（要 CubeMX 生成中断函数）—— 见上面的实测说明。
 */
const NVIC_DMA_WITH_HANDLER = 'true\\:{p}\\:0\\:true\\:false\\:true\\:true\\:false\\:true\\:true'

// --------------------------------------------------------------------------
// 主入口：算出新的 .ioc 文本
// --------------------------------------------------------------------------

export function planUartIoc(root: string, params: IocUartParams): IocUartPlan {
  const empty = (error: string): IocUartPlan => ({
    ok: false,
    iocPath: null,
    relPath: null,
    before: null,
    after: null,
    changes: [],
    notes: [],
    warnings: [],
    error,
    watch: [],
    handle: params.uart,
    enabled: false
  })

  const iocPath = findIocFile(root)
  if (!iocPath) return empty('工程根没有 .ioc 文件，改不了外设配置（可以手动在 CubeMX 里配）')

  const peripheral = peripheralOf(params.uart)
  if (!peripheral) return empty(`认不出串口名 ${params.uart}（期望 huart1 这种）`)

  let editor: IocEditor
  try {
    editor = new IocEditor(iocPath)
  } catch (err) {
    return empty(`读 .ioc 失败：${err instanceof Error ? err.message : String(err)}`)
  }

  const before = editor.toString()
  const info = parseIoc(iocPath)
  const changes: IocUartChange[] = []
  const notes: string[] = []
  const warnings: string[] = []

  const push = (key: string, value: string): void => {
    const prev = editor.get(key)
    const kind = editor.set(key, value)
    if (kind !== 'unchanged') changes.push({ key, before: prev, after: value })
  }

  // ---- ① 这个串口启用了没有 ----
  //
  // 只在 .ioc 里写 `USARTx.BaudRate` 而不给它分配引脚，CubeMX 会当作
  // 「一个没启用的外设的残留配置」，生成时直接忽略 —— 用户会以为改了、其实没改。
  const vmKey = `${peripheral}.VirtualMode`
  const enabled = editor.has(vmKey)
  if (!enabled) {
    return {
      ok: false,
      iocPath,
      relPath: relative(root, iocPath).split(sep).join('/'),
      before,
      after: before,
      changes,
      notes,
      warnings,
      error:
        `.ioc 里没有 ${vmKey} —— 这个串口在 CubeMX 里还没启用（引脚没分配）。` +
        `先在 CubeMX 里把它开成 Asynchronous，再回来改波特率 / DMA`,
      watch: [],
      handle: params.uart,
      enabled: false
    }
  }

  // ---- ② 异步模式 ----
  const vm = editor.get(vmKey)
  if (vm !== 'VM_ASYNC') {
    push(vmKey, 'VM_ASYNC')
    notes.push(`${peripheral}.VirtualMode: ${vm ?? '（空）'} → VM_ASYNC（vofa 用串口异步模式）`)
  }

  // ---- ③ 波特率 ----
  //
  // 这是这次最主要的诉求。`.ioc` 里没有 BaudRate 键时表示「默认 115200」，
  // 要写进去才会出现在生成的 usart.c 里。
  const baud = Math.round(params.baud)
  if (!Number.isFinite(baud) || baud <= 0) {
    return {
      ...empty(`波特率 ${params.baud} 不合法`),
      iocPath,
      relPath: relative(root, iocPath).split(sep).join('/')
    }
  }
  /*
   * 只在**真的不一样**时才写。
   *
   * `.ioc` 里没有 BaudRate 键 = CubeMX 用默认值 115200。所以用户本来就在
   * 115200 时，写一个 `BaudRate=115200` 出来没有意义 —— 但它会让清单里多出
   * 一条改动，进而触发一次两分钟的 CubeMX 重新生成。这种「什么都没变却跑了
   * 一遍」最消耗信任。
   */
  const baudKey = `${peripheral}.BaudRate`
  const baudRaw = editor.get(baudKey)
  const effective = baudRaw && /^\d+$/.test(baudRaw.trim()) ? Number(baudRaw.trim()) : 115200
  if (effective !== baud) {
    push(baudKey, String(baud))
    notes.push(`${baudKey}: ${baudRaw ?? '（未写，默认 ' + effective + '）'} → ${baud}`)

    // ---- ④ IPParameters 必须列出改过的参数 ----
    //
    // CubeMX 只认 `IPParameters` 里列出来的键，没列的**即使值是对的也会被忽略**。
    // 这里只**追加**，不重写已有项 —— 重写会把 WordLength / Parity 这类
    // 工程本来就有的配置从列表里抹掉，生成出来就退回默认值了。
    const ipKey = `${peripheral}.IPParameters`
    const ipRaw = editor.get(ipKey)
    const ipList = (ipRaw ?? '')
      .split(',')
      .map((s) => s.trim())
      .filter(Boolean)
    const want = ['VirtualMode', 'BaudRate']
    const missing = want.filter((w) => !ipList.includes(w))
    if (missing.length) {
      const next = [...ipList, ...missing].join(',')
      push(ipKey, next)
      notes.push(`${ipKey}: 补上 ${missing.join('、')}（CubeMX 只认这个列表里的键）`)
    }
  } else {
    notes.push(`${baudKey} 已经是 ${baud}，不动`)
  }

  // ---- ⑤ RX DMA ----
  const wantDma = params.rxMode === 'dma'
  const wantMode = params.dmaMode === 'normal' ? 'normal' : 'circular'
  const ident = `${peripheral}_RX`
  const rxSlot = dmaSlotOf(editor, ident)
  const hasRxDma = rxSlot !== null
  let usedStream: string | null = null

  if (wantDma && hasRxDma) {
    /*
     * 已经有 RX DMA 时，以前这里直接 `continue` —— 于是「工程本来就配了 DMA，
     * 但模式是单次，我想改成循环」变成**点了没反应**。现在只改 Mode 一个字段：
     * Stream / Channel / 优先级是用户（或硬件）定的，乱覆盖只会把已经能跑的配置改坏。
     */
    usedStream = dmaStreamOf(editor, ident)
    const modeKey = `Dma.${ident}.${rxSlot}.Mode`
    const prevMode = modeOf(editor.get(modeKey))
    if (prevMode !== wantMode) {
      push(modeKey, wantMode === 'circular' ? 'DMA_CIRCULAR' : 'DMA_NORMAL')
      notes.push(
        `${ident} 模式：${prevMode === null ? '（没写，CubeMX 默认单次）' : modeLabel(prevMode)} → ${modeLabel(wantMode)}`
      )
    } else {
      notes.push(`${ident} 已经是 ${modeLabel(wantMode)}（${usedStream ?? '未知 Stream'}），不动`)
    }
  } else if (wantDma) {
    const route = rxRoute(info?.family ?? null, peripheral)
    if (!route) {
      warnings.push(
        `不知道 ${info?.family ?? '这颗芯片'} 上 ${peripheral}_RX 能挂哪个 DMA Stream，` +
          `没有替你加。请在 CubeMX 里手动给 ${params.uart} 勾一个 RX DMA（参考手册的 DMA 请求映射表）`
      )
    } else {
      for (const stream of route.streams) {
        const occupied = editor.findStreamConflict(stream, ident)
        if (occupied) {
          warnings.push(`${stream} 已被 ${occupied} 占用，换下一个候选`)
          continue
        }
        usedStream = stream
        const { edits } = editor.ensureDmaRequest(ident, rxDmaFields(stream, wantMode))
        for (const e of edits) {
          changes.push({ key: e.key, before: e.before ?? null, after: e.after })
        }
        notes.push(
          `${ident} → ${stream}（Channel ${route.channel} 由芯片连线决定，CubeMX 自己补；${modeLabel(wantMode)}）`
        )
        /*
         * DMA 的「传输完成」回调走 Stream 中断：不使能 NVIC 就永远不回调。
         * 而且**必须让 CubeMX 生成中断函数**（第 4 位 = true）——
         * 只使能 NVIC 不生成函数的话，中断一来就跳 Default_Handler 死循环。
         */
        const irqKey = `NVIC.${stream}_IRQn`
        const prev = editor.get(irqKey)
        push(irqKey, nvicWithPriority(prev, params.irqPriority, NVIC_DMA_WITH_HANDLER))
        break
      }
      if (!usedStream) {
        warnings.push(`${ident} 的候选 Stream 全被占用了，没有加 DMA —— 去 CubeMX 里手动挑一个空的`)
      }
    }
  } else if (hasRxDma) {
    // 选了逐字节中断，但工程里本来就有 RX DMA：不动它，只说清楚现状。
    // 删掉反而危险 —— 那个 Stream 可能还有别的代码在用（比如同一工程的其它串口）。
    usedStream = dmaStreamOf(editor, ident)
    notes.push(
      `${ident} 工程里本来就有（${usedStream ?? '未知 Stream'}，` +
        `${modeLabel(modeOf(editor.get(`Dma.${ident}.${rxSlot}.Mode`)) ?? 'normal')}），` +
        `接收方式选了逐字节中断，DMA 保留不动`
    )
  }

  // ---- ⑥ 串口中断：**故意不碰** ----
  //
  // 这条路必须两边都不写：
  //   · builtinIrq = 开 → 模块运行时自己 HAL_NVIC_EnableIRQ，并且自带 IRQHandler
  //   · builtinIrq = 关 → 说明工程里本来就有这个中断入口（bsp / application 里定义），
  //     使能也是那边在做
  // 如果我们这时再往 .ioc 里写 NVIC.USARTx_IRQn，配上一个「要生成中断函数」的值，
  // CubeMX 会往 stm32f4xx_it.c 塞一个 USART1_IRQHandler —— 和工程里那个
  // 同名函数在链接期直接重复定义。这个工程里 USART3/USART6 的入口就在
  // `remote_control.c` / `referee_usart_task.c` 里，正属于这种情况。
  notes.push(
    params.builtinIrq
      ? '串口中断由模块运行时自己使能（builtinIrq=开），.ioc 的 NVIC 不动'
      : '串口中断交给工程自己的入口（builtinIrq=关），.ioc 的 NVIC 不动'
  )

  // ---- ⑦ 关掉版本迁移弹窗 ----
  //
  // CubeMX 发现 .ioc 的 MxCube.Version 和本机不一致时会弹「迁移」对话框，
  // 无头运行时这个框会把流程卡到超时。VT13 那条路也是这么处理的。
  //
  // 只在**这一趟真有改动**时才写：否则「什么都没变」的工程也会被改出一个
  // 差异，白白触发一次 CubeMX。
  if (changes.length > 0) push('ProjectManager.AskForMigrate', 'false')

  const after = editor.toString()
  const watch = [
    'Src/usart.c',
    'Src/dma.c',
    'Src/main.c',
    `Src/${itFileName(info?.family ?? null)}`
  ]

  return {
    ok: true,
    iocPath,
    relPath: relative(root, iocPath).split(sep).join('/'),
    before,
    after: after === before ? before : after,
    changes,
    notes,
    warnings,
    // CubeMX 还没跑，产物里的波特率还是旧的
    error: undefined,
    watch,
    handle: params.uart,
    enabled: true
  }
}

/** `Dma.Request<n>=<ident>` 里的 n；没有这个请求返回 null */
function dmaSlotOf(editor: IocEditor, ident: string): string | null {
  for (const line of editor.toString().split(/\r?\n/)) {
    const m = /^Dma\.Request(\d+)=(.+)$/.exec(line)
    if (m && m[2].trim() === ident) return m[1]
  }
  return null
}

function dmaStreamOf(editor: IocEditor, ident: string): string | null {
  const slot = dmaSlotOf(editor, ident)
  return slot ? editor.get(`Dma.${ident}.${slot}.Instance`) : null
}

/** `stm32f4xx_it.c` / `stm32f7xx_it.c` … */
function itFileName(family: string | null): string {
  const m = /^STM32([A-Z])(\d)/i.exec(family ?? '')
  if (!m) return 'stm32xx_it.c'
  return `stm32${m[1].toLowerCase()}${m[2]}xx_it.c`
}

// --------------------------------------------------------------------------
// 事后核对：CubeMX 到底有没有把波特率写进代码
// --------------------------------------------------------------------------

export interface BaudCheck {
  /** 代码里的实际波特率，读不到就是 null */
  actual: number | null
  /** 和期望值一致 */
  match: boolean
  detail: string
}

/**
 * 从 `Src/usart.c` 里读出这个串口实际的波特率。
 *
 * 这条核对很关键：`.ioc` 写对了但没跑 CubeMX，代码里还是旧波特率 ——
 * 上位机连着、波形也在发，但**收发全是乱码**，而且不会有任何报错。
 */
export function checkBaudInCode(root: string, handle: string, expected: number): BaudCheck {
  const file = join(root, 'Src', 'usart.c')
  if (!existsSync(file)) {
    return { actual: null, match: false, detail: '找不到 Src/usart.c，没法核对波特率' }
  }
  let text = ''
  try {
    text = readFileSync(file, 'utf8')
  } catch (err) {
    return {
      actual: null,
      match: false,
      detail: `读 Src/usart.c 失败：${err instanceof Error ? err.message : String(err)}`
    }
  }
  const m = new RegExp(`${handle}\\.Init\\.BaudRate\\s*=\\s*(\\d+)`).exec(text)
  if (!m) {
    return { actual: null, match: false, detail: `Src/usart.c 里找不到 ${handle}.Init.BaudRate` }
  }
  const actual = Number(m[1])
  return actual === expected
    ? { actual, match: true, detail: `${handle}.Init.BaudRate = ${actual}，和设置的一致` }
    : {
        actual,
        match: false,
        detail:
          `代码里 ${handle}.Init.BaudRate = ${actual}，但设置的是 ${expected} —— ` +
          `.ioc 改了、代码还没重新生成。在 CubeMX 里点一次「Generate Code」，` +
          `或者重新点「写入工程」并勾上「跑 CubeMX」`
      }
}
