/**
 * 调试配置页的**常量与读写小工具**。
 *
 * 这些和 React 无关：把 launch.json 里的值当字符串读、把空值当「删这个键」、
 * 下拉选项表。抽出来是为了让页面只关心「怎么显示」。
 */

/** VSCode 工作区变量，生成的配置里统一用它 */
export const WS = '${workspaceFolder}'

/** 「其它」是个哨兵值：选中它时用输入框自由填写 type */
export const OTHER = '其它'

export const TYPE_OPTIONS = ['cortex-debug', 'cppdbg', 'cppvsdbg', 'node']
export const REQUEST_OPTIONS = ['launch', 'attach']
export const SERVERTYPE_OPTIONS = ['openocd', 'jlink', 'stlink', 'pyocd', 'bmp', 'external']
export const MIMODE_OPTIONS = ['gdb', 'lldb']
export const INTERFACE_OPTIONS = ['SWD', 'JTAG']

export type TemplateId = 'flash' | 'debugOnly' | 'attach' | 'native' | 'blank' | 'dual' | 'custom'

export const TEMPLATES: Array<{ id: TemplateId; label: string }> = [
  { id: 'dual', label: '嵌入式：DAP-Link + ST-Link 双探针（推荐）' },
  { id: 'custom', label: '自定义：自己勾选要哪几个调试器…' },
  { id: 'flash', label: '嵌入式：DAP-Link 烧录并调试' },
  { id: 'debugOnly', label: '嵌入式：仅调试（不重新烧录）' },
  { id: 'attach', label: '嵌入式：附加到运行中的目标' },
  { id: 'native', label: '本机：gdb 调试' },
  { id: 'blank', label: '空白配置' }
]

export type TabKey = 'form' | 'raw'

// --------------------------------------------------------------------------
// 读写小工具
// --------------------------------------------------------------------------

/** 把配置里的任意值读成字符串 */
export function text(value: unknown): string {
  if (typeof value === 'string') return value
  if (typeof value === 'number' || typeof value === 'boolean') return String(value)
  return ''
}

/** 把字符串数组读成多行文本 */
export function lines(value: unknown): string {
  return Array.isArray(value) ? value.map((v) => String(v)).join('\n') : ''
}

/** 多行文本 → 字符串数组（空行忽略） */
export function splitLines(input: string): string[] {
  return input
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean)
}

/** 写一个字段；空值（undefined / null / 空串）表示删除该键，让 JSON 保持干净 */
export function setKey<T extends Record<string, unknown>>(obj: T, key: string, value: unknown): T {
  const draft: Record<string, unknown> = { ...obj }
  if (value === undefined || value === null || value === '') delete draft[key]
  else draft[key] = value
  return draft as T
}

/** 写一个数组字段；空数组同样删除该键 */
export function setList<T extends Record<string, unknown>>(obj: T, key: string, list: unknown[]): T {
  return list.length ? setKey(obj, key, list) : setKey(obj, key, undefined)
}

/** 基础下拉项；当前值不在表里时补一项，避免下拉框显示空白 */
export function withCurrent(base: string[], current: string): Array<{ value: string; label: string }> {
  const options = base.map((v) => ({ value: v, label: v }))
  if (current && !base.includes(current)) options.push({ value: current, label: `其它（${current}）` })
  return options
}
