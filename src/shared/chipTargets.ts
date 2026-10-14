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
