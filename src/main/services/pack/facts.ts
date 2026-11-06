/**
 * 目标工程的**事实探测**：往里走一圈，把「有什么」记下来。
 *
 * 刻意不含任何判断：不问「这个包能不能装」，只回答「有没有 usart.h、
 * huart1 有没有 RX DMA、工程用的是 CMSIS-OS v1 还是 v2」。
 * 判断都在 `compat.ts` 里，于是加新包不用改探测逻辑。
 */

import { readdirSync, readFileSync } from 'node:fs'
import { join, posix, sep } from 'node:path'
import { peripheralOf, readRxDmaMode } from '../ioc/uart'

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
  /** `.ioc` 里 RX DMA 的模式；没配 DMA 或读不到就是 null */
  rxDmaMode: 'circular' | 'normal' | null
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
  /** 工程用的是 CMSIS-OS v2（osThreadNew）—— 当前 vofa 模块只生成 v1 代码 */
  hasCmsisV2: boolean
  /** 工程里已经有 application/vofa 之类的目录 */
  existingVofa: string[]
  /** 参与扫描的源文件数 */
  scannedFiles: number
}

/** 这些目录不参与内容扫描（太大且和业务无关），但仍然会按文件名索引头文件 */
export const SKIP_CONTENT =
  /(^|[\\/])(Drivers|Middlewares|build|out|node_modules|\.git|\.vscode|\.idea|CMakeFiles)([\\/]|$)/i
export const SKIP_DIR = new Set([
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

/** 绝对路径 → 相对工程根的 posix 路径（界面和 diff 里统一用 /） */
export function rel(root: string, abs: string): string {
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
    hasCmsisV2: false,
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

      // CMSIS-OS 版本：v2 用 osThreadNew，v1 用 osThreadDef/osThreadCreate。
      // cmsis_os.h 在 Middlewares 下，内容扫描会跳过，所以这里单独读。
      if (lower === 'cmsis_os.h') {
        try {
          if (/\bosThreadNew\s*\(/.test(readFileSync(full, 'utf8'))) facts.hasCmsisV2 = true
        } catch {
          /* ignore */
        }
      }

      if (SKIP_CONTENT.test(full)) continue

      facts.scannedFiles += 1
      let text: string
      try {
        text = readFileSync(full, 'utf8')
      } catch {
        continue
      }
      // 本工具自己生成的文件不算「工程已有」，否则重装时会把 vofa 自己
      // 定义的 HAL 回调当成冲突。
      const ownVofaFile = /(^|[\\/])application[\\/]vofa[\\/]/i.test(full)
      for (const sym of [
        'usart1_tx_dma_enable',
        'HAL_UARTEx_ReceiveToIdle_DMA',
        'HAL_UART_Receive_IT',
        'HAL_UARTEx_RxEventCallback',
        'HAL_UART_RxCpltCallback',
        'get_remote_control_point',
        'get_yaw_motor_point',
        'get_pitch_motor_point'
      ]) {
        if (ownVofaFile) continue
        if (text.includes(sym) && !facts.symbols.has(sym)) facts.symbols.set(sym, r)
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
      } else if (
        /\.(c|h)$/i.test(e.name) &&
        !SKIP_CONTENT.test(full) &&
        /*
         * 跳过本工具自己生成的模块目录。
         *
         * 踩过的坑：`vofa_config.h` 里有 `#define VOFA_RX_DMA_HANDLE hdma_usart1_rx`，
         * 下一轮扫描就凭这个字符串认定「这个工程配了 RX DMA」，于是把接收方式
         * 推成 DMA —— 而工程里根本没那个句柄。自己生成的文本不能当证据。
         */
        !/[\\/]application[\\/]vofa[\\/]/i.test(full)
      ) {
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
    // huart4/5/7/8 在芯片里叫 UART4…，拼成 USART4_IRQn 这个名字根本不存在
    const periph = peripheralOf(name) ?? `USART${n}`
    facts.uarts.push({
      name,
      irq: `${periph}_IRQn`,
      handler: `${periph}_IRQHandler`,
      txDma: new RegExp(`\\bhdma_usart${n}_tx\\b`).test(joined) ? `hdma_usart${n}_tx` : null,
      rxDma: new RegExp(`\\bhdma_usart${n}_rx\\b`).test(joined) ? `hdma_usart${n}_rx` : null,
      // 源码里 NORMAL / CIRCULAR 长得一模一样，只有 .ioc 说实话
      rxDmaMode: readRxDmaMode(root, periph),
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