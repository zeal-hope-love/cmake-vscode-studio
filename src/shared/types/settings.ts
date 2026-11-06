/**
 * 应用设置 + 默认值。
 *
 * `DEFAULT_SETTINGS` 是**值**不是类型，自检和首次启动都依赖它；
 * 加字段时别忘了在这里补默认值，否则老配置文件读出来是 undefined。
 */

import type { ProbeKey, DebugTargetKey } from './debug'

export interface AppSettings {
  /** 'system' = 跟随操作系统的深浅色设置 */
  theme: 'dark' | 'light' | 'system'
  /** 用户手动指定的工具路径：ToolKey -> 绝对路径 */
  tools: Record<string, string>
  recentProjects: string[]
  lastProject: string | null
  /** 上次用的探针与烧录参数 */
  probeKey: ProbeKey
  /**
   * launch.json 默认生成哪几条调试配置（见 DebugTargetKey）。
   *
   * 默认只生成「当前探针」一条 —— 老用户的设置里没有这个字段，
   * 读出来是 undefined，生成器会按 ['probe'] 处理，行为和以前完全一致。
   */
  debugTargets: DebugTargetKey[]
  adapterSpeed: number
  targetCfgOverride: string
  backupBeforeWrite: boolean
  autoDetectOnStart: boolean
  /** 首次启动的新手向导是否已经看过（跳过也算看过） */
  onboardingDone: boolean
  /** 界面上可拖动区域的宽度：'nav' / 'split' 等 → 像素 */
  uiWidths: Record<string, number>
  /**
   * 启动时检查 GitHub Releases 有没有新版本。
   *
   * 默认开 —— 检查是静默的（只发一个 GET，失败不打扰），
   * 有新版本才在界面上提示一次。
   */
  checkUpdates: boolean
  /**
   * Live Watch 的默认值（跨工程记忆）。
   * 这是「用户习惯」而不是「工程属性」，所以放设置里。
   *
   * **默认开启** —— 用户要求默认开。代价很小（launch.json 里多一个对象、
   * 调试时每秒读几次变量），收益是不用每次新工程都去点一下开关。
   * 探针不是 openocd/stlink/jlink 时会自动跳过，不会写出无效字段。
   */
  liveWatch: boolean
  liveWatchSamplesPerSecond: number
  liveWatchRefreshRate: number
}

export const DEFAULT_SETTINGS: AppSettings = {
  theme: 'system',
  tools: {},
  recentProjects: [],
  lastProject: null,
  probeKey: 'cmsis-dap',
  // 与 shared/debugTargets.ts 的 DEFAULT_DEBUG_TARGETS 保持一致
  debugTargets: ['probe'],
  adapterSpeed: 1000,
  targetCfgOverride: '',
  backupBeforeWrite: false,
  autoDetectOnStart: true,
  onboardingDone: false,
  uiWidths: {},
  // Live Watch 默认开启（用户要求）：新装即生效，不用每次手动勾
  liveWatch: true,
  liveWatchSamplesPerSecond: 4,
  liveWatchRefreshRate: 300,
  checkUpdates: true
}

// ==========================================================================
// IPC 通道名
// ==========================================================================
