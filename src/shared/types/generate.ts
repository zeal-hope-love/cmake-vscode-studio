/**
 * 生成与写入：生成选项、待写文件、写入结果、快照。
 *
 * 「计划（PlanRequest）」和「写入（WriteRequest）」是分开的两个类型，
 * 因为预览只算不写、写入要带备份开关 —— 混成一个会诱导调用方跳过预览。
 */

import type { ProbeKey, DebugTargetKey } from './debug'

export interface GenOptions {
  elfName: string
  device: string
  probeKey: ProbeKey
  /**
   * launch.json 里要生成哪几条调试配置（见 DebugTargetKey）。
   *
   * 缺省/非法时按 `['probe']` 处理 —— 保证生成出来永远至少有一条，
   * 否则 VSCode 里会出现「有 launch.json 但没有可调试配置」的死局。
   */
  debugTargets: DebugTargetKey[]
  interfaceCfg: string
  resetConfig: string
  targetCfg: string
  adapterSpeed: number
  openocdExe: string
  cmakeExe: string
  ninjaExe: string
  toolchainDir: string
  /** 相对工程根，例如 build/Debug */
  debugDir: string
  releaseDir: string
  debugPreset: string
  releasePreset: string
  hasBuildPresets: boolean
  configurePreset: string
  /** 相对工程根，例如 build/Debug/compile_commands.json */
  compileCommands: string
  svdFile: string
  generator: string
  /** IntelliSense 用的 include 路径（相对或绝对） */
  includeDirs: string[]
  defines: string[]
  cStandard: string
  cppStandard: string
  /**
   * Live Watch —— 不停机看全局变量（cortex-debug 的实验性功能，类似 Keil 的 Live Watch）。
   * 只对 openocd / stlink / jlink 三种 gdb-server 生效，PyOCD 不支持。
   */
  liveWatch: boolean
  /** 每秒采样几次（cortex-debug 限制 0~20，默认 4） */
  liveWatchSamplesPerSecond: number
  /** 面板重画间隔（毫秒），写进 settings.json 的 cortex-debug.liveWatchRefreshRate */
  liveWatchRefreshRate: number
}

// ==========================================================================
// 写入
// ==========================================================================

export interface FilePayload {
  /** 显示名，例如 launch.json */
  name: string
  /** 相对工程根的路径，例如 .vscode/launch.json */
  relativePath: string
  content: string
}

export interface PlanRequest {
  projectRoot: string
  files: FilePayload[]
}

export interface PlannedFile {
  name: string
  path: string
  relativePath: string
  content: string
  exists: boolean
  previous: string | null
}

export interface WriteRequest extends PlanRequest {
  backup: boolean
}

export interface WriteResult {
  written: string[]
  unchanged: string[]
  backups: string[]
  errors: string[]
  backupDir: string | null
  /** 本次写入前存下的快照 id，可用于还原；内容没有变化时为 null */
  snapshotId: string | null
  /**
   * 「所有文件都卡在同一个前置条件上」时的一句话说明。
   *
   * 典型场景：`.vscode` 目录建不出来（安全软件拦 mkdir / 目录只读），
   * 5 个文件会各自报一遍同样的错。逐行看是 5 条噪声，这里给一句
   * 「根因 + 怎么办」，界面上放在最前面。
   */
  blockedReason?: string
}

/** 写入过程中的逐文件进度 */
export interface WriteProgress {
  relativePath: string
  name: string
  index: number
  total: number
  status: 'writing' | 'written' | 'unchanged' | 'error'
  message?: string
}

// ==========================================================================
// 快照 / 还原
// ==========================================================================

export interface SnapshotMeta {
  id: string
  projectRoot: string
  createdAt: number
  /** 快照记录了几个文件 */
  fileCount: number
  /** 其中写入前并不存在的（还原时会被删掉） */
  newFileCount: number
}

export interface RestoreResult {
  /** 还原回旧内容的文件 */
  restored: string[]
  /** 被删除的文件（写入前本来就不存在） */
  removed: string[]
  errors: string[]
}

/** 清除本工具写入的 .vscode 配置的结果 */
export interface ClearResult {
  deleted: string[]
  errors: string[]
  /** 清除前也存了快照，所以这一步同样可以撤销 */
  snapshotId: string | null
}

// ==========================================================================
// 模板 / 批量
// ==========================================================================
