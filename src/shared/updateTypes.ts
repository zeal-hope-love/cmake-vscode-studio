/**
 * 更新检测相关的类型。
 *
 * 单独放一个文件，是因为主进程、preload、渲染进程三边都要用，
 * 塞进 `types.ts` 会让那个本来就很大的文件更难读。
 *
 * 这里**只有类型**，没有实现 —— 渲染进程能安全地 import。
 */

export interface UpdateAsset {
  /** 文件名，比如 CmakeVscodeStudio-2.0.0-setup.exe */
  name: string
  /** 字节数 */
  size: number
  /** 下载地址 */
  url: string
}

export interface UpdateInfo {
  /** 当前装着的版本 */
  currentVersion: string
  /** 远端最新版本（去掉开头的 v）；出错时为空 */
  latestVersion: string
  /** 有没有新版本 */
  hasUpdate: boolean
  /** Release 页面地址 */
  releaseUrl: string
  /** Release 标题 */
  releaseName: string
  /** 发布说明（Markdown 原文） */
  notes: string
  /** 发布时间（ISO 8601） */
  publishedAt: string
  /** 可下载的文件 */
  assets: UpdateAsset[]

  /**
   * 检查状态：
   *   ok       —— 拿到结果了（含「没有新版本」和「还没发布过」）
   *   error    —— 网络 / API 出错，detail 里有原因
   *   disabled —— 用户关掉了自动检查
   */
  status: 'ok' | 'error' | 'disabled'

  /** 出错时的说明 */
  detail?: string

  /** 这次结果是缓存来的（6 小时内查过） */
  cached?: boolean
}