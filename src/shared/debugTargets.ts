/**
 * 调试器方案表 —— 决定 launch.json 里放哪几条调试配置。
 *
 * 和 probes.ts 分工不同，别混：
 *   · probes.ts      回答「本工具怎么接线」：用哪份 OpenOCD interface cfg、要不要写 cfg 文件
 *   · debugTargets   回答「VSCode 下拉里给几条」：一个工程可以同时放好几条，
 *                    插 DAP-Link 就选 DAP 那条，插 ST-Link 就选 ST 那条，互不干扰。
 *
 * 背景：只要工程里存在 .vscode/launch.json，VSCode 就不再显示
 * STM32 VS Code Extension 自带的「ST-Link GDB server / J-Link GDB server」默认项
 * —— 它们被 launch.json 完全取代了。这个文件就是为了把那两条补回来。
 */

import type { DebugTargetKey } from './types/index'

export interface DebugTargetOption {
  key: DebugTargetKey
  label: string
  /**
   * 生成出来的配置名（兜底值）。
   *
   * 「当前探针」那一条实际用的是 `debugTargetConfigName('probe', 探针名)` ——
   * 名字里要带探针名（插 DAP-Link 就是「CMSIS-DAP / DAP-Link：烧录并调试」），
   * 所以这里的 `configName` 只是调用方拿不到探针名时的兜底。
   *
   * 不论哪种情况都**必须唯一且稳定**：主进程 generators 和渲染进程 LaunchPage
   * 都靠它，插入时还要按名字去重 —— 两边写不一致就会重复插入。
   */
  configName: string
  hint: string
}

export const DEBUG_TARGET_OPTIONS: DebugTargetOption[] = [
  {
    key: 'probe',
    label: '当前探针（OpenOCD）',
    configName: 'DAP-Link：烧录并调试',
    hint: 'cortex-debug + OpenOCD，用设置里选的探针和 .vscode/openocd-*.cfg'
  },
  {
    key: 'stlink-gdbserver',
    label: 'ST-Link（ST 官方 GDB server）',
    configName: 'ST-Link: 烧录并调试（ST 官方 GDB server）',
    hint: 'type=stlinkgdbtarget，需要 STM32 VS Code Extension（内含 ST-LINK_gdbserver.exe）'
  },
  {
    key: 'jlink-gdbserver',
    label: 'J-Link（ST 官方 GDB server）',
    configName: 'J-Link: 烧录并调试（ST 官方 GDB server）',
    hint: 'type=jlinkgdbtarget，需要 STM32 VS Code Extension 和 J-Link 驱动'
  }
]

/** 默认只生成「当前探针」一条，保持老工程/老设置的行为不变 */
export const DEFAULT_DEBUG_TARGETS: DebugTargetKey[] = ['probe']

const ALL_KEYS = DEBUG_TARGET_OPTIONS.map((t) => t.key)

export function isDebugTargetKey(key: string): key is DebugTargetKey {
  return (ALL_KEYS as string[]).includes(key)
}

export function debugTargetByKey(key: string): DebugTargetOption | null {
  return DEBUG_TARGET_OPTIONS.find((t) => t.key === key) ?? null
}

/**
 * 取某条调试配置该叫什么名字。
 *
 * 「当前探针」这条要**带上探针名**：VSCode 的「运行和调试」下拉里如果只有一条
 * 叫「Debug: 烧录并调试」的，插着 DAP-Link、ST-Link、J-Link 全混在一起分不清 ——
 * 尤其是同时生成了 ST-Link 那条之后，两条都叫「烧录并调试」，选错就是连不上。
 *
 * 探针名传不进来时退回 `DAP-Link：烧录并调试`（本工具最常见的用法）。
 */
export function debugTargetConfigName(key: DebugTargetKey, probeLabel?: string): string {
  if (key === 'probe' && probeLabel && probeLabel.trim()) {
    return `${probeLabel.trim()}：烧录并调试`
  }
  return debugTargetByKey(key)?.configName ?? key
}

/**
 * 清洗用户设置里存的方案列表：去掉非法值、去重、保序。
 *
 * 空数组（或全是垃圾值）时回落到默认单条 —— 否则生成出来的 launch.json
 * 会是 `configurations: []`，VSCode 会当成「没有任何调试配置」，
 * 用户看到的就是「我明明写了 launch.json 却点不了 F5」。
 */
export function normalizeDebugTargets(keys: unknown): DebugTargetKey[] {
  if (!Array.isArray(keys)) return [...DEFAULT_DEBUG_TARGETS]
  const seen = new Set<DebugTargetKey>()
  const out: DebugTargetKey[] = []
  for (const raw of keys) {
    if (typeof raw !== 'string' || !isDebugTargetKey(raw)) continue
    if (seen.has(raw)) continue
    seen.add(raw)
    out.push(raw)
  }
  return out.length ? out : [...DEFAULT_DEBUG_TARGETS]
}
