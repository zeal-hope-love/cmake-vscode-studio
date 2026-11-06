/**
 * 应用级：版本信息、配置模板、清理构建产物、写入历史。
 *
 * 这些都不属于某个具体工程，但会跨工程使用 —— 模板和历史尤其明显。
 */

import type { ProbeKey, ConfigBundle } from './debug'
import type { GenOptions } from './generate'

export interface AppInfo {
  name: string
  version: string
  electron: string
  chrome: string
  node: string
  v8: string
  platform: string
  isPackaged: boolean
  userData: string
  /** 版本号来自哪个 package.json，排查「版本对不上」时有用 */
  packagePath: string
}

/** 模板管理的四份文件 */
export type TemplateFileKey = 'launch.json' | 'tasks.json' | 'settings.json' | 'c_cpp_properties.json'

export const TEMPLATE_FILE_KEYS: TemplateFileKey[] = [
  'launch.json',
  'tasks.json',
  'settings.json',
  'c_cpp_properties.json'
]

/**
 * 模板的**层级一：这套配置面向什么**。
 *
 * 这一层刻意做得「少而稳」：以后要支持 CLion / CMake 之外的构建系统，
 * 往联合类型里加成员即可，不用动下面两层。
 */
export interface TemplateTarget {
  /** 目标编辑器；目前只有 VSCode，留成联合类型方便以后扩 */
  editor: 'vscode'
  /** 构建系统怎么接：走 CMakePresets 还是直接给构建目录 */
  buildSystem: 'preset' | 'dir'
  /** 调试探针 —— 决定 interface/target 配置与烧录命令 */
  probe: ProbeKey
}

export interface ConfigTemplate {
  id: string
  name: string
  note: string
  createdAt: number
  updatedAt: number
  /** 内置模板：不可删除、不可覆盖 */
  builtin?: boolean

  /** 层级一：面向什么（编辑器 / 构建系统 / 探针） */
  target: TemplateTarget

  /**
   * 层级二：生成参数，只存「用户的选择」。
   * 固件名、芯片、构建目录这些从工程推导的字段留空，套用时按目标工程重算。
   */
  options: Partial<GenOptions>

  /**
   * 层级三：四份文件的内容。
   *
   * · 有值 = 按这份内容写（其中的 `${elfName}` 等占位符按目标工程替换）
   * · 没值 = 按 options 自动生成（老模板和内置模板走这条）
   */
  files?: Partial<Record<TemplateFileKey, string>>

  /** 旧版遗留字段：保存当时的完整生成结果，只用于「看 JSON」 */
  bundle?: ConfigBundle
}

/** 清理构建目录里的陈旧产物（本工具唯一会删工程内文件的操作） */
export interface CleanArtifactsResult {
  /** 真正删掉的文件（相对工程根） */
  removed: string[]
  errors: string[]
  freedBytes: number
}

// ==========================================================================
// 历史记录
// ==========================================================================

export type HistoryKind =
  | 'project-load'
  | 'write'
  | 'clear'
  | 'restore'
  | 'template-save'
  | 'template-delete'
  | 'template-apply'
  | 'batch'
  | 'run'

/** 历史条目上可以直接点的「再来一次」 */
export interface HistoryAction {
  kind:
    | 'reconfigure'
    | 'preview'
    | 'open-in-vscode'
    | 'open-in-explorer'
    | 'restore-snapshot'
    | 'open-template'
    /** 上一次写入有文件失败时，按同样的参数再写一遍 */
    | 'retry-write'
  label: string
  projectRoot?: string
  snapshotId?: string
  templateId?: string
}

export interface HistoryEntry {
  id: string
  at: number
  kind: HistoryKind
  title: string
  detail: string
  ok: boolean
  projectRoot?: string
  templateId?: string
  actions: HistoryAction[]
}

// ==========================================================================
// 应用设置
// ==========================================================================
