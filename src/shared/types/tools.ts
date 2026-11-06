/**
 * 工具链：编译器/GDB/OpenOCD/Ninja 的路径与版本。
 *
 * 路径的来源有三个（设置里手填 > 环境变量 > 常见安装位置），
 * 所以 `ToolItem` 要带 `source` —— 排查「为什么用的不是我想的那个」全靠它。
 */


export type ToolKey =
  'openocd' | 'arm_gcc' | 'arm_gdb' | 'cmake' | 'ninja' | 'make' | 'gdb' | 'clangd' | 'jlink' | 'stlink'

export interface ToolItem {
  key: string
  path: string | null
  source: string
  version: string | null
  found: boolean
}

/** 一个被识别的工具链环境变量（例如 STM32CLT_PATH） */
export interface EnvRoot {
  name: string
  label: string
  value: string
  /** 变量存在但目录不存在时为 false，界面上要标出来 */
  exists: boolean
}

export interface ToolPaths {
  items: Record<string, ToolItem>
  openocdScripts: string | null
  openocdScriptsNote: string
  toolchainDir: string | null
  /** 识别到的工具链安装根环境变量 */
  envRoots: EnvRoot[]
  /** SVD 文件目录（STM32CubeCLT 自带一份），用于自动填 svdFile */
  svdDir: string | null
}

// ==========================================================================
// VSCode 已打开 / 最近工程
// ==========================================================================

export interface ProjectCandidate {
  folder: string
  root: string | null
  source: string
  /** 正在打开的窗口 / 最近打开过的；界面按这个分组显示 */
  kind: 'open' | 'recent'
  lastUsed: number
  chip: string | null
  label: string
  detail: string
}

// ==========================================================================
// 调试探针
// ==========================================================================
