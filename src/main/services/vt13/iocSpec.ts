/**
 * VT13 移植需要改的 `.ioc` 配置（声明式）。
 *
 * 文档 §6.2 列了 16 处改动。这里把「哪些键、什么值、为什么」集中成一堆常量，
 * 而不是散在流程代码里 —— 将来支持别的芯片（比如 F1 系用 DMA1）时，
 * 只需要换一份配置，不用改流程。
 *
 * ## 芯片相关的部分
 *
 * `USART1_RX` 在 STM32F407 上**只能**用 DMA2_Stream2 或 DMA2_Stream5，
 * 且必须是 Channel 4。这是硬件连线决定的，配错了编译能过、DMA 不动 ——
 * 所以这里保留可选项但加注释说明。
 */

/** 目标波特率：VT13 协议固定 921600 */
export const VT13_BAUD = 921600

/** 目标串口。VT13 接收机接开发板丝印 UART2 口 = STM32 的 USART1 */
export const VT13_USART = 'USART1'

/** F407 上 USART1_RX 可用的 DMA Stream（顺序即默认优先级） */
export const USART1_RX_STREAMS = ['DMA2_Stream5', 'DMA2_Stream2'] as const

export type Usart1RxStream = (typeof USART1_RX_STREAMS)[number]

/**
 * NVIC 的值。
 *
 * 格式是 `使能\:优先级\:子优先级\:...`，注意**冒号要转义成 `\:`** ——
 * 这是 `.ioc` 文件格式规定的，写成普通冒号 CubeMX 读不出来。
 *
 * 对照模板工程已有的 USART3：
 *   NVIC.USART3_IRQn=true\:4\:0\:true\:false\:false\:false\:true\:true\:true
 * USART1 沿用同样的优先级 4，避免抢占关系变化。
 */
export const VT13_NVIC_USART1 =
  'true\\:4\\:0\\:true\\:false\\:false\\:false\\:true\\:true\\:true'

/** DMA 请求的字段（顺序即 RequestParameters 的顺序，不能乱） */
export function usart1RxDmaFields(
  stream: Usart1RxStream
): Record<string, string> {
  return {
    Instance: stream,
    Direction: 'DMA_PERIPH_TO_MEMORY',
    PeriphInc: 'DMA_PINC_DISABLE',
    MemInc: 'DMA_MINC_ENABLE',
    PeriphDataAlignment: 'DMA_PDATAALIGN_BYTE',
    MemDataAlignment: 'DMA_MDATAALIGN_BYTE',
    /*
     * ⚠️ 是 NORMAL，不是 CIRCULAR。
     *
     * 文档 §2.1 的实测结论：`bsp_rc.c` 用了 M0AR/M1AR/DBM 双缓冲，
     * `remote_control.c` 用 DMA_SxCR_CT 切换缓冲并手动重置 NDTR ——
     * 这些**只在 NORMAL 模式下有效**。配成 CIRCULAR 时它们全都不起作用，
     * 表现为遥控数据时有时无，而且极难查。
     */
    Mode: 'DMA_NORMAL',
    Priority: 'DMA_PRIORITY_HIGH',
    FIFOMode: 'DMA_FIFOMODE_DISABLE'
  }
}

/** USART1 虚拟模式 */
export const USART1_VM = 'VM_ASYNC'

/** `USART1.IPParameters` 里必须列出的参数（少了 CubeMX 会忽略对应配置） */
export const USART1_IP_PARAMETERS = 'VirtualMode,BaudRate'

/**
 * 移植前要检查的 `.ioc` 关键键。
 * 这些不是要改的，是要**读出来给用户看**的（预检报告用）。
 */
export const IOC_INSPECT_KEYS = [
  'MxCube.Version',
  'MxDb.Version',
  'ProjectManager.FirmwarePackage',
  'ProjectManager.AskForMigrate',
  'USART1.IPParameters',
  'USART1.VirtualMode',
  'USART1.BaudRate',
  'Dma.RequestsNb',
  'NVIC.USART1_IRQn'
] as const