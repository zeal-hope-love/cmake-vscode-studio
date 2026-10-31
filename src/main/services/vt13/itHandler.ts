/**
 * `stm32f4xx_it.c` 里 `USART1_IRQHandler` 的幂等屏蔽。
 *
 * ## 为什么需要这一步
 *
 * CubeMX 在 `NVIC.USART1_IRQn` 使能后会生成：
 *   void USART1_IRQHandler(void) { HAL_UART_IRQHandler(&huart1); }
 *
 * 而 VT13 的接收逻辑（双缓冲 + 帧头校验 + CRC16）在 `remote_control.c` 里
 * **自己实现了一个同名函数**。两个同名符号 → 链接期 duplicate symbol。
 *
 * ## 为什么是「每次生成后重做」而不是一次性改好
 *
 * 只要用户再点一次 CubeMX 的 Generate Code，这个文件就会被整个覆盖回原样。
 * 所以工具每次跑完 CubeMX 都要重新加一次 —— 这就是「幂等」的意义：
 * **重复执行不能产生第二层 `#if 0`**，否则代码会越来越乱。
 */

export interface CommentOutResult {
  text: string
  /** 做了改动吗；已经屏蔽过会返回 false */
  changed: boolean
  /** 发生了什么，给用户看 */
  reason: 'wrapped' | 'already-wrapped' | 'no-handler'
}

/**
 * 把 `void USART1_IRQHandler(void) {...}` 包进 `#if 0 / #endif`。
 *
 * 匹配策略（文档 §8.4）：从 `void USART1_IRQHandler(void)` 开始，
 * 到其后第一个**顶格的** `}` 结束。不用括号配平，因为 HAL 生成的函数体
 * 缩进规整、里层 `}` 一定带缩进。
 *
 * @param text    文件内容
 * @param handler 函数名，默认 USART1_IRQHandler（保留参数是为了将来支持别的串口）
 */
export function commentOutUsartHandler(
  text: string,
  handler = 'USART1_IRQHandler'
): CommentOutResult {
  const eol = text.includes('\r\n') ? '\r\n' : '\n'
  const lines = text.split(/\r?\n/)

  // 找函数签名
  const sigIdx = lines.findIndex((ln) =>
    new RegExp(`^\\s*void\\s+${handler}\\s*\\(\\s*void\\s*\\)`).test(ln)
  )
  if (sigIdx < 0) return { text, changed: false, reason: 'no-handler' }

  // 已经屏蔽过了？往前看几行有没有 #if 0
  for (let i = Math.max(0, sigIdx - 6); i < sigIdx; i++) {
    if (/^\s*#\s*if\s+0\b/.test(lines[i])) {
      return { text, changed: false, reason: 'already-wrapped' }
    }
  }

  // 找第一个顶格的 } —— 函数体结束
  let endIdx = -1
  for (let i = sigIdx; i < lines.length; i++) {
    if (/^\}/.test(lines[i])) {
      endIdx = i
      break
    }
  }
  if (endIdx < 0) return { text, changed: false, reason: 'no-handler' }

  const indent = (lines[sigIdx].match(/^\s*/) ?? [''])[0]
  const note = [
    `${indent}/*`,
    `${indent} * 这个函数被 CV Studio 屏蔽了（#if 0）。`,
    `${indent} *`,
    `${indent} * 原因：application/remote_control.c 里提供了自己的 ${handler}，`,
    `${indent} * 用 DMA 双缓冲接 VT13 遥控数据。两个同名符号会链接失败。`,
    `${indent} *`,
    `${indent} * ⚠️ CubeMX 每次 Generate Code 都会把这个函数生成回来 ——`,
    `${indent} *    重新跑一次「遥控模块 VT13」的移植流程即可自动重新屏蔽。`,
    `${indent} */`,
    `${indent}#if 0`
  ]
  const tail = [`${indent}#endif`]

  const next = [
    ...lines.slice(0, sigIdx),
    ...note,
    ...lines.slice(sigIdx, endIdx + 1),
    ...tail,
    ...lines.slice(endIdx + 1)
  ]

  return { text: next.join(eol), changed: true, reason: 'wrapped' }
}

/** 检查是否已经被屏蔽（只读判断，验收项 [3] 用） */
export function isHandlerCommentedOut(text: string, handler = 'USART1_IRQHandler'): boolean {
  const lines = text.split(/\r?\n/)
  const sigIdx = lines.findIndex((ln) =>
    new RegExp(`^\\s*void\\s+${handler}\\s*\\(\\s*void\\s*\\)`).test(ln)
  )
  if (sigIdx < 0) return true // 压根没有这个函数，等价于「不会冲突」
  for (let i = Math.max(0, sigIdx - 10); i < sigIdx; i++) {
    if (/^\s*#\s*if\s+0\b/.test(lines[i])) return true
  }
  return false
}

/** 统计某个符号在源码里出现了几次（验收项 [5]：符号必须唯一） */
export function countDefinition(text: string, symbol: string): number {
  const re = new RegExp(`^\\s*(?:void|int|uint\\w+)\\s+${symbol}\\s*\\(`, 'gm')
  return (text.match(re) ?? []).length
}