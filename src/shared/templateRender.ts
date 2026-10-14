/**
 * 模板文件内容里的占位符。
 *
 * 模板要能「跨工程复用」，但四份文件里到处是工程专属的东西（固件名、构建目录、
 * 芯片…）。所以模板里不写死这些值，而是写占位符，套用时按目标工程替换。
 *
 * ⚠️ `${workspaceFolder}` 是 VSCode 自己的变量，**必须原样保留** ——
 * 这里的替换只认下面这张表里的名字，其它 `${...}` 一律不动。
 */

import { openocdCfgFileName } from './chipTargets'
import { probeByKey } from './probes'
import { TEMPLATE_FILE_KEYS, type GenOptions, type TemplateFileKey } from './types'

export interface TemplateVars {
  /** 固件名（不含扩展名），例如 test-01 */
  elfName: string
  /** cortex-debug 的 device 字段，例如 STM32F407IGH6 */
  device: string
  /** 调试构建目录（相对工程根），例如 build/Debug */
  debugDir: string
  /** 发布构建目录 */
  releaseDir: string
  /** 调试配置 preset 名 */
  debugPreset: string
  /** 发布配置 preset 名 */
  releasePreset: string
  /** OpenOCD 接线配置文件名，例如 openocd-stm32f4x-cmsis-dap.cfg */
  openocdCfg: string
  /** OpenOCD interface 配置，例如 interface/cmsis-dap.cfg */
  interfaceCfg: string
  /** OpenOCD target 配置 */
  targetCfg: string
  /** 适配器速度（kHz） */
  adapterSpeed: string
  /** SVD 文件路径 */
  svdFile: string
  /** 探针的显示名，例如 CMSIS-DAP / DAP-Link */
  probeLabel: string
  /** 工程根目录的绝对路径 */
  projectRoot: string
}

/** 模板编辑器里给用户看的占位符清单 */
export const TEMPLATE_VARIABLES: Array<{ token: string; desc: string }> = [
  { token: '${elfName}', desc: '固件名（不含扩展名）' },
  { token: '${device}', desc: 'cortex-debug 的 device 字段' },
  { token: '${debugDir}', desc: '调试构建目录，如 build/Debug' },
  { token: '${releaseDir}', desc: '发布构建目录' },
  { token: '${debugPreset}', desc: '调试用 CMake preset 名' },
  { token: '${releasePreset}', desc: '发布用 CMake preset 名' },
  { token: '${openocdCfg}', desc: 'OpenOCD 接线配置文件名' },
  { token: '${interfaceCfg}', desc: 'OpenOCD interface 配置' },
  { token: '${targetCfg}', desc: 'OpenOCD target 配置' },
  { token: '${adapterSpeed}', desc: '适配器速度（kHz）' },
  { token: '${svdFile}', desc: 'SVD 外设寄存器描述文件' },
  { token: '${probeLabel}', desc: '探针显示名（如 CMSIS-DAP / DAP-Link）' },
  { token: '${projectRoot}', desc: '工程根目录绝对路径' },
  { token: '${workspaceFolder}', desc: 'VSCode 变量，原样保留、不会被替换' }
]

/**
 * 把文本里的占位符换成实际值。
 *
 * 没提供的变量保持原样（而不是换成空串）—— 悄悄换成空串会让生成的配置
 * 看起来「正常」但其实是错的，宁可让它显眼地留在那儿。
 */
export function renderTemplateText(text: string, vars: Partial<TemplateVars>): string {
  return text.replace(/\$\{([A-Za-z_][A-Za-z0-9_]*)\}/g, (whole, name: string) => {
    if (!(name in vars)) return whole
    const value = vars[name as keyof TemplateVars]
    return typeof value === 'string' ? value : whole
  })
}

/** 这次替换里有哪些占位符没被解析（用于提示用户） */
export function findUnresolvedVariables(text: string, vars: Partial<TemplateVars>): string[] {
  const missing = new Set<string>()
  for (const match of text.matchAll(/\$\{([A-Za-z_][A-Za-z0-9_]*)\}/g)) {
    const name = match[1]
    if (name === 'workspaceFolder') continue
    if (!TEMPLATE_VARIABLES.some((v) => v.token === `\${${name}}`)) continue
    if (!(name in vars) || vars[name as keyof TemplateVars] === '') missing.add(name)
  }
  return [...missing]
}

/** 从目标工程的生成参数里取出占位符要用的值 */
export function templateVarsFromOptions(o: GenOptions, projectRoot: string): TemplateVars {
  const probe = probeByKey(o.probeKey)
  return {
    elfName: o.elfName,
    device: o.device,
    debugDir: o.debugDir,
    releaseDir: o.releaseDir,
    debugPreset: o.debugPreset,
    releasePreset: o.releasePreset,
    openocdCfg: openocdCfgFileName(o.probeKey, o.device),
    interfaceCfg: probe.interfaceCfg,
    targetCfg: o.targetCfg,
    adapterSpeed: String(o.adapterSpeed),
    svdFile: o.svdFile,
    probeLabel: probe.label,
    projectRoot
  }
}

/**
 * 把模板的四份文件渲染成可以直接写的内容。
 * 返回 `relativePath → 内容`（相对工程根，带 `.vscode/` 前缀）。
 */
export function renderTemplateFiles(
  files: Partial<Record<TemplateFileKey, string>>,
  vars: Partial<TemplateVars>
): Record<string, string> {
  const out: Record<string, string> = {}
  for (const key of TEMPLATE_FILE_KEYS) {
    const text = files[key]
    if (typeof text === 'string' && text.trim()) {
      out[`.vscode/${key}`] = renderTemplateText(text, vars)
    }
  }
  return out
}
