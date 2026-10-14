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

import type { ConfigTemplate } from './types'

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
  }
]
