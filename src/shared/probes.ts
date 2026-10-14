/**
 * 调试探针方案表。
 *
 * 放在 shared 是因为渲染进程要拿它渲染下拉框、主进程要用它决定生成哪种
 * OpenOCD interface 配置，两边必须完全一致。
 */

import type { ProbeKey, ProbeOption } from './types'

export const PROBE_OPTIONS: ProbeOption[] = [
  {
    key: 'cmsis-dap',
    label: 'CMSIS-DAP / DAP-Link',
    interfaceCfg: 'interface/cmsis-dap.cfg',
    resetConfig: 'reset_config none',
    servertype: 'openocd',
    needsOpenocdCfg: true
  },
  {
    key: 'stlink',
    label: 'ST-Link（走 OpenOCD）',
    interfaceCfg: 'interface/stlink.cfg',
    resetConfig: '',
    servertype: 'openocd',
    needsOpenocdCfg: true
  },
  {
    key: 'jlink',
    label: 'J-Link（走 OpenOCD）',
    interfaceCfg: 'interface/jlink.cfg',
    resetConfig: '',
    servertype: 'openocd',
    needsOpenocdCfg: true
  },
  {
    key: 'jlink-native',
    label: 'J-Link（cortex-debug 原生）',
    interfaceCfg: '',
    resetConfig: '',
    servertype: 'jlink',
    needsOpenocdCfg: false
  },
  {
    key: 'stlink-native',
    label: 'ST-Link（cortex-debug 原生 st-util）',
    interfaceCfg: '',
    resetConfig: '',
    servertype: 'stlink',
    needsOpenocdCfg: false
  },
  {
    key: 'pyocd',
    label: 'PyOCD',
    interfaceCfg: '',
    resetConfig: '',
    servertype: 'pyocd',
    needsOpenocdCfg: false
  }
]

export function probeByKey(key: string): ProbeOption {
  return PROBE_OPTIONS.find((p) => p.key === key) ?? PROBE_OPTIONS[0]
}

export function isProbeKey(key: string): key is ProbeKey {
  return PROBE_OPTIONS.some((p) => p.key === key)
}
