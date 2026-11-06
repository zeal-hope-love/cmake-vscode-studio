/**
 * 内置模板。
 *
 * 模板列表一开始是空的，用户第一次打开「模板与配置」只能看到一片空白 ——
 * 这里给一份默认的，既是「列表里总得有个东西」，也是一个可以直接用的起点。
 *
 * 内置模板只写「用户的选择」那几个字段；固件名、芯片、构建目录、工具路径
 * 全部留空，套用时按目标工程重新推导（见 shared/templateAdapt.ts）。
 * 所以它对任何工程都是安全的，不会把 A 工程的固件名带到 B 工程。
 *
 * 注意：内置模板**不带 files**，也就是「四份文件按参数自动生成」。
 * 带 files 的是用户新建的模板（内容里用占位符标记工程相关值）。
 */

import type { ConfigTemplate } from './types/index'

/** 内置模板的 id 前缀；`templateStore` 用这个判断能不能删 */
export const BUILTIN_TEMPLATE_PREFIX = 'builtin:'

export function isBuiltinTemplateId(id: string): boolean {
  return id.startsWith(BUILTIN_TEMPLATE_PREFIX)
}

export const BUILTIN_TEMPLATES: ConfigTemplate[] = [
  {
    id: `${BUILTIN_TEMPLATE_PREFIX}standard-cmsis-dap`,
    name: '样板：DAP-Link + 1 MHz',
    note:
      '内置样板，主要用途是「复制一份改成自己的」—— 光看空列表不容易想象模板长什么样。' +
      '它只钉了两个值：探针 CMSIS-DAP、适配器速度 1 MHz；' +
      '固件名、芯片、构建目录、工具路径全部留空，套用时按目标工程推导。' +
      '注意：如果你的探针和速度本来就是这两个值，套用它和选「默认」的结果是一样的。',
    createdAt: 0,
    updatedAt: 0,
    builtin: true,
    target: { editor: 'vscode', buildSystem: 'preset', probe: 'cmsis-dap' },
    options: {
      probeKey: 'cmsis-dap',
      adapterSpeed: 1000,
      // 空字符串 = 让芯片→target 的映射表自己决定该用哪个 cfg
      targetCfg: ''
      // 其余字段刻意留空：按目标工程推导
    }
  },

  /**
   * 双调试器样板。
   *
   * 背景：工程里一旦有 .vscode/launch.json，VSCode 就不再显示 STM32 扩展自带的
   * 「ST-Link GDB server / J-Link GDB server」两项 —— 被 launch.json 完全取代。
   * 很多人两块板子换着用（平时 DAP-Link、量产板 ST-Link），每次手改很烦，
   * 所以给一份「一次写两条」的样板：跑调试时在下拉里插哪个选哪条。
   *
   * 和上一条的区别只有 debugTargets 一项：探针仍是 CMSIS-DAP，
   * 也就是说 OpenOCD 那套接线（.vscode/openocd-*.cfg）照旧，只是多挂一条 ST 的。
   */
  {
    id: `${BUILTIN_TEMPLATE_PREFIX}dap-link-plus-stlink`,
    name: '样板：DAP-Link + ST-Link 双调试器',
    note:
      '一次生成两条调试配置：当前探针（cortex-debug + OpenOCD，吃 .vscode/openocd-*.cfg）' +
      '和 ST-Link（ST 官方 stlinkgdbtarget）。' +
      '两块板子换着用时不用改文件，VSCode「运行和调试」下拉里插哪个选哪条。' +
      '第二条依赖 STM32 VS Code Extension；没装的话它会在下拉里显示成未知类型。',
    createdAt: 0,
    updatedAt: 0,
    builtin: true,
    target: { editor: 'vscode', buildSystem: 'preset', probe: 'cmsis-dap' },
    options: {
      probeKey: 'cmsis-dap',
      adapterSpeed: 1000,
      targetCfg: '',
      debugTargets: ['probe', 'stlink-gdbserver']
    }
  }
]
