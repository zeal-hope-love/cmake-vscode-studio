/**
 * **这个包能不能装到这个工程上**，以及要替用户适配什么。
 *
 * 输入是 `facts.ts` 探到的事实，输出是 PackCompatReport：
 * 阻塞项 / 警告 / 推测出来的参数默认值。
 */

import type { PackCheck, PackCompatReport, PackManifest } from '@shared/packTypes'
import { findIocFile, readIocKey } from '../ioc/index'
import { peripheralOf } from '../ioc/uart'
import type { ProjectFacts } from './facts'
import { inspectProject } from './facts'

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
    const preferred = f.uarts.find((u) => u.name === wanted)
    // 默认串口不存在时自动挑一个没被占用的 —— 不能只报错，
    // 否则界面上那个下拉还是空的，用户没有任何办法改成工程里真实存在的串口。
    const uart = preferred ?? f.uarts.find((u) => u.usedBy.length === 0) ?? f.uarts[0]

    if (!uart) {
      checks.push({
        level: 'err',
        label: '串口',
        detail: '在 usart.h / usart.c 里没找到任何 UART 句柄'
      })
    } else {
      if (!preferred) {
        checks.push({
          level: 'info',
          label: `串口 ${wanted}`,
          detail: `工程里没有 ${wanted}，自动改用 ${uart.name}`,
          adapted: `uart = ${uart.name}`
        })
      }
      checks.push({
        level: 'ok',
        label: `串口 ${uart.name}`,
        detail: `TX DMA ${uart.txDma ?? '无'} · RX DMA ${uart.rxDma ?? '无'}${
          uart.usedBy.length ? ` · 可能被 ${uart.usedBy.join('、')} 占用` : ''
        }`
      })

      if (!uart.txDma) {
        checks.push({
          level: 'warn',
          label: 'TX DMA',
          detail: `${uart.name} 没有配 TX DMA，波形发送会占用 CPU`
        })
      }

      // ---- 接收方式 ----
      // 默认有 RX DMA 就走 DMA；但 HAL 回调是全局符号，工程里已经定义过
      // HAL_UARTEx_RxEventCallback / HAL_UART_RxCpltCallback 时再定义就会重复。
      const hasRxEvent = f.symbols.has('HAL_UARTEx_RxEventCallback')
      const hasRxCplt = f.symbols.has('HAL_UART_RxCpltCallback')
      let mode: 'dma' | 'it' = uart.rxDma ? 'dma' : 'it'

      if (mode === 'dma' && hasRxEvent) {
        mode = 'it'
        checks.push({
          level: 'warn',
          label: 'RX 回调',
          detail: '工程里已经有 HAL_UARTEx_RxEventCallback，自动改用逐字节中断，避免链接重复定义',
          adapted: 'rxMode = it'
        })
      }
      if (mode === 'it' && hasRxCplt) {
        if (uart.rxDma && !hasRxEvent) {
          mode = 'dma'
          checks.push({
            level: 'warn',
            label: 'RX 回调',
            detail: '工程里已经有 HAL_UART_RxCpltCallback，自动改用 DMA 空闲中断',
            adapted: 'rxMode = dma'
          })
        } else {
          checks.push({
            level: 'err',
            label: 'RX 回调冲突',
            detail:
              '工程里已经有 HAL_UART_RxCpltCallback，且没有可切换的 DMA 接收。请手动合并回调，或换一个串口'
          })
        }
      }
      if (mode === 'dma' && hasRxEvent) {
        checks.push({
          level: 'err',
          label: 'RX 回调冲突',
          detail: 'HAL_UARTEx_RxEventCallback 已被工程定义，不能再生成一份'
        })
      }

      derived.rxMode = mode
      // 工程里已经有 RX DMA 时，把它现在的模式也报出来 —— 用户最想知道的就是这句
      const dmaNow = uart.rxDmaMode
      checks.push({
        level: 'ok',
        label: '命令接收方式',
        detail:
          mode === 'dma'
            ? `${uart.name} 走 DMA + 空闲中断；当前 RX DMA ${
                uart.rxDma ? `已配（${dmaNow ? (dmaNow === 'circular' ? '循环' : '单次') : '模式未知'}）` : '还没配'
              }`
            : `${uart.name} 走逐字节中断 —— ${
                uart.rxDma ? '工程里配了 RX DMA，这次不用它' : '工程里也没配 RX DMA'
              }。想改成 DMA 接收，就在参数区把「命令接收方式」选成 dma（模式一起写进 .ioc）`,
        adapted: `rxMode = ${mode}`
      })

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
          detail: `工程里没有 ${uart.handler}。模块会自己在运行时使能 NVIC 并自带中断入口 —— 中断这部分不用动 CubeMX`,
          adapted: 'builtinIrq = true'
        })
      }

      derived.uart = uart.name
      derived.uartHeader = f.headers.get('usart.h') ?? 'usart.h'
      derived.irq = uart.irq
      derived.irqHandler = uart.handler
      derived.txDma = uart.txDma ?? `hdma_usart${uart.name.replace('huart', '')}_tx`

      // ---- 波特率 ----
      //
      // 从 .ioc 里读当前值当作默认，而不是硬写 115200：
      // 用户工程本来跑 921600 的话，工具默认给人改成 115200 就是灾难 ——
      // 遥控/裁判系统那几路都是有固定波特率的。
      const periph = peripheralOf(uart.name)
      const iocPath = findIocFile(root)
      const baudRaw = iocPath && periph ? readIocKey(iocPath, `${periph}.BaudRate`) : null
      const baud = baudRaw && /^\d+$/.test(baudRaw.trim()) ? Number(baudRaw.trim()) : 115200
      derived.baud = baud
      checks.push({
        level: 'ok',
        label: '波特率',
        detail: baudRaw
          ? `.ioc 里 ${periph}.BaudRate = ${baud}`
          : `.ioc 里没写 ${periph}.BaudRate（CubeMX 默认 115200），按 115200 处理`,
        adapted: `baud = ${baud}`
      })
    }

    // CMSIS-OS v2 的任务创建 API 和 v1 不同，当前模块只生成 v1 代码
    if (f.hasCmsisV2) {
      checks.push({
        level: 'err',
        label: 'CMSIS-OS 版本',
        detail:
          '工程用的是 CMSIS-OS v2（osThreadNew），当前 vofa 模块只生成 v1 的 osThreadDef/osThreadCreate。请手动适配任务创建代码'
      })
    }

    // TX 发送函数：默认找一个工程里现成的
    const txDefault = String(
      pack.params.find((p) => p.key === 'txFn')?.default ?? 'usart1_tx_dma_enable'
    )
    derived.txFn = txDefault
    if (!f.symbolHeaders.has(txDefault) && !f.symbols.has(txDefault)) {
      checks.push({
        level: 'warn',
        label: 'TX 发送函数',
        detail: `没找到 ${txDefault} 的声明；可在参数里把「TX 发送函数」改成工程里现成的那个（例如 bsp_usart_tx_dma）`
      })
    } else {
      const h = f.symbolHeaders.get(txDefault)
      if (h) derived.txHeader = h
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
    existingModule: existing.length > 0,
    uarts: f.uarts
  }
}

/** 缺了某个可选头文件时，我们做了什么替代 */
function adaptNote(packId: string, header: string): string {
  if (packId !== 'vofa') return '可选'
  if (header === 'struct_typedef.h') return '改用 <stdint.h>/<stdbool.h> 定义 fp32 / bool_t'
  if (header === 'bsp_usart.h') return '需要把 TX 发送函数指到工程里现成的那个'
  return '可选'
}