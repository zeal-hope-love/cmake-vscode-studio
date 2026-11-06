/**
 * STM32 芯片型号 → OpenOCD target 映射。
 *
 * 放在 shared 是因为主进程（生成 OpenOCD 配置）和渲染进程（工具页给出建议值）
 * 都要用同一张表，不能各写一份。
 */

/** 键是「家族字母 + 第一位数字」，例如 F1 / F4 / H7 / WB */
export const SERIES_TO_TARGET: Record<string, string> = {
  C0: 'stm32c0x.cfg',
  F0: 'stm32f0x.cfg',
  F1: 'stm32f1x.cfg',
  F2: 'stm32f2x.cfg',
  F3: 'stm32f3x.cfg',
  F4: 'stm32f4x.cfg',
  F7: 'stm32f7x.cfg',
  G0: 'stm32g0x.cfg',
  G4: 'stm32g4x.cfg',
  H5: 'stm32h5x.cfg',
  H7: 'stm32h7x.cfg',
  L0: 'stm32l0.cfg',
  L1: 'stm32l1.cfg',
  L4: 'stm32l4x.cfg',
  L5: 'stm32l5x.cfg',
  U0: 'stm32u0x.cfg',
  U3: 'stm32u3x.cfg',
  U5: 'stm32u5x.cfg',
  WB: 'stm32wbx.cfg',
  WL: 'stm32wlx.cfg'
}

/** 从型号里取出 F1 / H7 / WB 这样的系列代号 */
export function guessChipFamily(device: string | null | undefined): string | null {
  if (!device) return null
  const m = /^STM32([A-Za-z])(\d)/i.exec(device.trim())
  if (!m) return null
  return `${m[1].toUpperCase()}${m[2]}`
}

export function mapOpenocdTarget(device: string | null | undefined): string | null {
  const family = guessChipFamily(device)
  if (!family) return null
  return SERIES_TO_TARGET[family] ?? null
}

/** 常见芯片的候选列表，给界面下拉用 */
export function targetCfgOptions(): Array<{ value: string; label: string }> {
  const seen = new Set<string>()
  const options: Array<{ value: string; label: string }> = []
  for (const [series, cfg] of Object.entries(SERIES_TO_TARGET)) {
    if (seen.has(cfg)) continue
    seen.add(cfg)
    options.push({ value: cfg, label: `STM32${series}  →  target/${cfg}` })
  }
  return options
}

/** OpenOCD 接线配置的文件名，例如 openocd-stm32f1x-cmsis-dap.cfg */
export function openocdCfgFileName(targetCfg: string, probeKey: string): string {
  const stem = targetCfg.replace(/\.cfg$/i, '')
  return `openocd-${stem}-${probeKey}.cfg`
}

// --------------------------------------------------------------------------
// 内核名
// --------------------------------------------------------------------------

/**
 * 系列 → Cortex 内核名。
 *
 * 干什么用的：ST 官方扩展的 `stlinkgdbtarget` / `jlinkgdbtarget` 配置里
 * `deviceCore` 是**必填**的，缺了适配器会直接抛
 * `Core not found: … verify "deviceCore" attribute`，连 GDB 都起不来。
 *
 * 写法和 ST 扩展内部一致：`Cortex-M4`、`Cortex-M0+` 这种（它自己的代码里
 * 就是按这几个字符串 switch 的），不要写成 CM4。
 */
export const CORE_BY_FAMILY: Record<string, string> = {
  C0: 'Cortex-M0+',
  F0: 'Cortex-M0',
  F1: 'Cortex-M3',
  F2: 'Cortex-M3',
  F3: 'Cortex-M4',
  F4: 'Cortex-M4',
  F7: 'Cortex-M7',
  G0: 'Cortex-M0+',
  G4: 'Cortex-M4',
  H5: 'Cortex-M33',
  H7: 'Cortex-M7',
  L0: 'Cortex-M0+',
  L1: 'Cortex-M3',
  L4: 'Cortex-M4',
  L5: 'Cortex-M33',
  U0: 'Cortex-M0+',
  U3: 'Cortex-M33',
  U5: 'Cortex-M33',
  WB: 'Cortex-M4',
  WL: 'Cortex-M4'
}

/**
 * 从型号猜内核名，猜不出返回 null（调用方就不要写这个字段，
 * 让用户在界面里自己填，而不是瞎填一个错的）。
 *
 * 两个特例：
 *   · STM32WBA** 是 Cortex-M33，但系列字母只取到 "WB"，会误判成 M4
 *   · STM32H7 双核（M7 + M4），调试入口在主核 M7 上
 */
export function guessDeviceCore(device: string | null | undefined): string | null {
  if (!device) return null
  const upper = device.trim().toUpperCase()
  if (!upper.startsWith('STM32')) return null
  // WBA / WBA5 这类新系列先单独判掉，避免落到 WB 的 M4
  if (/^STM32WBA/.test(upper)) return 'Cortex-M33'
  const family = guessChipFamily(upper)
  if (!family) return null
  return CORE_BY_FAMILY[family] ?? null
}
