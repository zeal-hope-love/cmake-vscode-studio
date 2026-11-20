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
/** 下载进度（主进程 → 渲染进程，约每 200ms 一次） */
export interface DownloadProgress {
  /** 已下载字节 */
  received: number
  /** 总字节；服务端没给 Content-Length 时是 0 */
  total: number
  /** 百分比 0-100；total 为 0 时是 -1（表示未知，界面用不确定进度条） */
  percent: number
  /** 估算速度（字节/秒） */
  speed: number
}

/**
 * 更新流程的阶段。
 *
 * 这套阶段由**主进程**维护（见 services/update/updateService.ts），
 * 渲染进程只是订阅 —— 因为它描述的是「这台机器上真实的更新状态」：
 * 文件下到哪了、能不能一键重启安装。放在渲染进程里的话，
 * 窗口一重载（F5 / 崩溃恢复）就全丢了，界面上会莫名其妙回到「一切正常」。
 */
export type UpdatePhase =
  /** 还没查过 */
  | 'idle'
  /** 正在请求 GitHub */
  | 'checking'
  /** 查过了，已是最新 */
  | 'up-to-date'
  /** 有新版本，但还没下载（自动下载关了，或上次下载失败/被取消） */
  | 'available'
  /** 正在下载安装包 */
  | 'downloading'
  /** 安装包已就位，等用户重启安装 */
  | 'ready'
  /** 检查或下载失败 */
  | 'error'
  /** 用户在设置里关了自动检查 */
  | 'disabled'

/** 主进程维护的完整更新状态，界面所有地方都读这一份 */
export interface UpdateState {
  phase: UpdatePhase
  /** 上一次检测结果（没查过时是 null） */
  info: UpdateInfo | null
  /** 下载进度（只在 phase = downloading 时有值） */
  progress: DownloadProgress | null
  /** 已下载（或上次已下好）的安装包绝对路径 */
  filePath: string | null
  /** 安装包对应的版本号 —— 「重启更新到 vX」的文案用它 */
  readyVersion: string | null
  /**
   * 能不能一键「重启安装」。
   *
   * 只有自绘安装器（*-setup.exe）能这么干；Release 里只有免安装版时
   * 下下来也只能提示用户自己去替换，所以这里要区分开。
   */
  canInstall: boolean
  /** 出错原因（phase = error 时有值） */
  error?: string
}
