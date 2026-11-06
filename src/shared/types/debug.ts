/**
 * 生成 .vscode 配置所需的形状：launch.json / tasks.json / c_cpp_properties.json。
 *
 * 这里的类型直接对应文件里的 JSON 结构，改字段名等于改生成结果 ——
 * 顺手改名会让已有工程里的配置和生成器对不上。
 */


export type ProbeKey = 'cmsis-dap' | 'stlink' | 'jlink' | 'jlink-native' | 'stlink-native' | 'pyocd'

export interface ProbeOption {
  key: ProbeKey
  label: string
  interfaceCfg: string
  resetConfig: string
  servertype: string
  /** 是否需要 OpenOCD（原生 jlink/stlink/pyocd 不需要写 openocd-*.cfg） */
  needsOpenocdCfg: boolean
}

/**
 * launch.json 里要生成哪几条调试配置。
 *
 * - `probe`             当前探针那一条（cortex-debug + OpenOCD，老行为）
 * - `stlink-gdbserver`  ST 官方扩展的 ST-Link GDB server（type=stlinkgdbtarget）
 * - `jlink-gdbserver`   ST 官方扩展的 J-Link GDB server（type=jlinkgdbtarget）
 *
 * 之所以不只按 probeKey 生成一条：工程里一旦有 launch.json，
 * VSCode 就不再显示 ST 扩展自带的两个默认调试项，而用户往往
 * DAP-Link 和 ST-Link 都要能插上就用。
 */
export type DebugTargetKey = 'probe' | 'stlink-gdbserver' | 'jlink-gdbserver'

// ==========================================================================
// 生成的配置内容
// ==========================================================================

export interface LaunchFile {
  version: string
  configurations: LaunchConfig[]
}

export interface LaunchConfig {
  name: string
  type: string
  request: string
  [key: string]: unknown
}

export interface TaskDef {
  label: string
  type: string
  command: string
  args?: string[]
  options?: { cwd?: string; env?: Record<string, string> }
  group?: string | { kind: string; isDefault?: boolean }
  problemMatcher?: unknown[]
  dependsOn?: string[]
  detail?: string
  [key: string]: unknown
}

export interface TasksFile {
  version: string
  tasks: TaskDef[]
}

export interface CppConfiguration {
  name: string
  compileCommands?: string
  includePath?: string[]
  defines?: string[]
  cStandard?: string
  cppStandard?: string
  intelliSenseMode?: string
  forcedInclude?: string[]
  [key: string]: unknown
}

export interface CppPropertiesFile {
  version: number
  configurations: CppConfiguration[]
}

export type SettingsFile = Record<string, unknown>

export interface ConfigBundle {
  launch: LaunchFile
  tasks: TasksFile
  settings: SettingsFile
  cpp: CppPropertiesFile
  /** openocd 接线配置；探针不需要时为 null */
  openocdCfg: { fileName: string; content: string } | null
}

