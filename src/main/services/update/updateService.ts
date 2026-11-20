/**
 * 更新流程的**唯一状态持有者**：检查 → 自动下载 → 提示重启安装。
 *
 * ## 为什么状态放主进程
 *
 * 以前「检查更新」是渲染进程自己发起的：进「关于」页查一次、顶部横幅再查一次，
 * 下载进度用一条专用通道推给**当时那个窗口**。加「自动下载」之后这套撑不住了：
 *
 *   · 用户在下载途中切页、重载窗口（F5）甚至关掉窗口再打开，进度就断了；
 *   · 「下好了没有」「能不能重启装」是这台机器上的**客观事实**，不是界面状态，
 *     不该跟着某个组件卸载而消失。
 *
 * 所以现在：主进程跑流程、维护 `UpdateState`、每次变化整份推给所有窗口；
 * 渲染进程只负责显示。窗口晚一点挂载也没关系 —— 先 `getUpdateState()` 拉一次即可。
 *
 * ## 自动下载的取舍
 *
 * 装好就自动下、下完只提示一句「重启更新」，是用户明确要的体验：
 * 更新包 100 多 MB，让人守着进度条毫无意义。
 *
 * 但**下载不等于安装** —— 没签名证书，静默安装会被 UAC / SmartScreen 拦，
 * 所以最后一步必须用户点一下（标题栏芯片或设置页里的「重启更新」）。
 * 这也顺带避免了「干着活突然被重启」。
 */

import { app, BrowserWindow, Notification } from 'electron'
import { readdirSync, statSync } from 'node:fs'
import { join } from 'node:path'
import { IPC } from '@shared/types'
import type { DownloadProgress, UpdateInfo, UpdateState } from '@shared/updateTypes'
import { checkForUpdate } from './updateChecker'
import { cancelDownload, downloadInstaller, runInstaller } from './updateDownloader'
import { getSettings } from '../data/settingsStore'
import { userDataPath } from '../data/store'

/** 启动后等多久再查（先让界面出来，别在启动瞬间跟主进程抢网络和 CPU） */
const START_DELAY_MS = 4000

/** 一个会话里反复查的间隔。6 小时和 updateChecker 的缓存时长对齐，查了也走缓存 */
const RECHECK_MS = 6 * 60 * 60 * 1000

/** 只认大于 1MB 的 exe 当作「已经下好的安装包」——半截文件不能拿来装 */
const MIN_INSTALLER_BYTES = 1024 * 1024

let state: UpdateState = {
  phase: 'idle',
  info: null,
  progress: null,
  filePath: null,
  readyVersion: null,
  canInstall: false
}

/** 正在跑的检查/下载，用来防并发（自动检查 + 用户手点会撞车） */
let inFlight: Promise<UpdateState> | null = null

/** 安装器已启动，正在退出 —— 阻止重复触发 */
let installing = false

// --------------------------------------------------------------------------
// 状态读写与广播
// --------------------------------------------------------------------------

function broadcast(): void {
  for (const win of BrowserWindow.getAllWindows()) {
    if (win.isDestroyed()) continue
    win.webContents.send(IPC.updateState, state)
  }
}

function patch(next: Partial<UpdateState>): void {
  state = { ...state, ...next }
  broadcast()
}

export function getUpdateState(): UpdateState {
  return state
}

// --------------------------------------------------------------------------
// 选哪个安装包
// --------------------------------------------------------------------------

interface PickResult {
  name: string
  url: string
  size: number
  /** 自绘安装器可以「重启更新」一键装；免安装版只能自己替换 exe */
  canInstall: boolean
}

/**
 * 从 Release 的附件里挑一个。
 *
 * 优先 `*-setup.exe`（自绘安装器）—— 它是唯一能被「重启更新」直接拉起来的。
 * 只有免安装版时也照样下载（用户拿到手替换掉就行），但界面文案要说清楚
 * 不能自动装，不然点了「重启更新」什么都不发生，比不提示更糟。
 */
function pickInstaller(info: UpdateInfo): PickResult | null {
  const exes = info.assets.filter((a) => /\.exe$/i.test(a.name))
  if (exes.length === 0) return null

  const setup = exes.find((a) => /setup/i.test(a.name))
  const chosen = setup ?? exes.find((a) => /portable/i.test(a.name)) ?? exes[0]

  return {
    name: chosen.name,
    url: chosen.url,
    size: chosen.size,
    canInstall: /setup/i.test(chosen.name)
  }
}

/**
 * 之前是不是已经下过这个版本了。
 *
 * 有这一步，用户「下完没装、第二天再打开」时不用重下一遍 100 MB ——
 * 直接就是「可重启更新」。判据是文件名里带版本号 + 大小正常
 * （`downloadInstaller` 写的是 `<name>-<version>-setup.exe` 这类名字）。
 */
function findDownloaded(version: string): string | null {
  if (!version) return null
  const dir = userDataPath('downloads')
  let names: string[]
  try {
    names = readdirSync(dir)
  } catch {
    return null
  }

  const hits = names.filter((n) => {
    if (!/\.exe$/i.test(n)) return false
    if (!n.toLowerCase().includes(version.toLowerCase())) return false
    try {
      return statSync(join(dir, n)).size > MIN_INSTALLER_BYTES
    } catch {
      return false
    }
  })
  if (hits.length === 0) return null

  // 有 setup 就优先用它（能一键装）
  const setup = hits.find((n) => /setup/i.test(n))
  return join(dir, setup ?? hits[0])
}

// --------------------------------------------------------------------------
// 检查 + 自动下载
// --------------------------------------------------------------------------

/**
 * 查一次，并按设置自动下载。
 *
 * @param force      忽略 6 小时缓存（用户点「检查更新」）
 * @param autoDownload 是否允许这次自动下载（启动时的自动检查传 true；
 *                     用户手点检查时也传 true —— 他既然点了，就别再多问一次）
 */
export async function runCheck(force = false, autoDownload = true): Promise<UpdateState> {
  if (inFlight) return inFlight

  const settings = getSettings()

  // 关掉自动检查 = 也不自动下载，但用户手点「检查更新」仍然要能查
  if (settings.checkUpdates === false && !force) {
    patch({ phase: 'disabled', info: state.info, progress: null })
    return state
  }

  inFlight = (async () => {
    patch({ phase: 'checking', error: undefined })
    const info = await checkForUpdate(force)

    if (info.status === 'disabled') {
      patch({ phase: 'disabled', info })
      return state
    }
    if (info.status === 'error') {
      patch({ phase: 'error', info, error: info.detail ?? '检查失败' })
      return state
    }
    if (!info.hasUpdate) {
      patch({
        phase: 'up-to-date',
        info,
        progress: null,
        filePath: null,
        readyVersion: null,
        canInstall: false
      })
      return state
    }

    // ---- 有新版本 ----
    const pick = pickInstaller(info)
    if (!pick) {
      // Release 里没有 exe（只有源码包之类）：只能让用户去发布页看
      patch({ phase: 'available', info, canInstall: false, progress: null })
      return state
    }

    const existing = findDownloaded(info.latestVersion)
    if (existing) {
      patch({
        phase: 'ready',
        info,
        progress: null,
        filePath: existing,
        readyVersion: info.latestVersion,
        canInstall: /setup/i.test(existing)
      })
      return state
    }

    if (!autoDownload || settings.autoDownloadUpdates === false) {
      patch({ phase: 'available', info, canInstall: pick.canInstall, progress: null })
      return state
    }

    await download(info, pick)
    return state
  })()

  try {
    return await inFlight
  } finally {
    inFlight = null
  }
}

/** 真正下载（runCheck 与用户手点「下载」共用） */
async function download(info: UpdateInfo, pick: PickResult): Promise<void> {
  patch({
    phase: 'downloading',
    info,
    canInstall: pick.canInstall,
    filePath: null,
    readyVersion: null,
    error: undefined,
    progress: { received: 0, total: pick.size, percent: -1, speed: 0 }
  })

  const result = await downloadInstaller(pick.url, pick.name, (p: DownloadProgress) => {
    // downloader 已经限流到 ~200ms 一次，这里直接转推
    patch({ progress: p })
  })

  if (result.ok && result.path) {
    patch({
      phase: 'ready',
      progress: null,
      filePath: result.path,
      readyVersion: info.latestVersion,
      canInstall: pick.canInstall
    })
    notifyReady(info.latestVersion, pick.canInstall)
    return
  }

  if (result.cancelled) {
    // 用户主动取消：退回「有新版本」，不报错
    patch({ phase: 'available', progress: null, error: undefined })
    return
  }

  patch({ phase: 'error', progress: null, error: result.error ?? '下载失败' })
}

/**
 * 下载完成的系统通知。
 *
 * 窗口被最小化时，标题栏那个芯片根本看不见 —— 而「下好了可以重启更新了」
 * 正是最需要被看见的一条。用系统通知补上，比弹一个必须点掉的模态框温和。
 */
function notifyReady(version: string, canInstall: boolean): void {
  if (!Notification.isSupported()) return
  try {
    const n = new Notification({
      title: `CV Studio v${version} 已下载完成`,
      body: canInstall
        ? '点这里或应用标题栏的「重启更新」即可完成安装'
        : '免安装版已下载，到设置页可以看出所在文件夹并替换',
      silent: false
    })
    n.on('click', () => {
      const win = BrowserWindow.getAllWindows()[0]
      if (!win) return
      if (win.isMinimized()) win.restore()
      win.show()
      win.focus()
    })
    n.show()
  } catch {
    /* 通知发不出去不影响流程 */
  }
}

// --------------------------------------------------------------------------
// 对外动作
// --------------------------------------------------------------------------

/** 用户手点「下载 / 重试」 */
export async function downloadNow(): Promise<UpdateState> {
  if (state.phase === 'downloading' || inFlight) return state

  const info = state.info
  if (!info?.hasUpdate) {
    // 没查到有更新就先查一次（比如上次检查失败了）
    return runCheck(true, true)
  }

  const pick = pickInstaller(info)
  if (!pick) {
    patch({ phase: 'error', error: '这次发布里没有可下载的安装包' })
    return state
  }

  inFlight = (async () => {
    await download(info, pick)
    return state
  })()
  try {
    return await inFlight
  } finally {
    inFlight = null
  }
}

export function cancelNow(): void {
  if (state.phase !== 'downloading') return
  cancelDownload()
}

/**
 * 启动安装器并退出应用。
 *
 * 必须先退出：安装器要把 payload 覆盖到安装目录，exe 还开着的话写不进去
 * （Windows 上会直接 EBUSY / 拒绝访问）。安装器是 detached 独立进程，
 * 我们退出不会把它带走。
 */
export async function installNow(): Promise<{ ok: boolean; error?: string }> {
  if (installing) return { ok: false, error: '安装程序已经在启动中' }
  if (!state.filePath) return { ok: false, error: '安装包还没下载好' }

  const result = await runInstaller(state.filePath)
  if (!result.ok) return { ok: false, error: result.error ?? '启动安装程序失败' }

  installing = true
  /*
   * 留 600ms 再退：安装器这时正在解压自己（Electron 应用启动要几百毫秒），
   * 立刻 quit 会在它的窗口出现之前把父进程收走 —— 实测偶尔会看到
   * 「点完什么都没发生」。这点延迟足够它起来，又不会让用户觉得卡住。
   */
  setTimeout(() => app.quit(), 600)
  return { ok: true }
}

// --------------------------------------------------------------------------
// 启动
// --------------------------------------------------------------------------

/**
 * 调试用：伪造一份更新状态（**只在设了环境变量时生效**，正常使用完全不受影响）。
 *
 *   CFGSTUDIO_FAKE_UPDATE=ready|downloading|available|error
 *
 * 为什么需要：更新芯片的版式只有在「真有新版本」时才看得见，而仓库还没发新版时
 * 本地根本复现不出来 —— 没法截图核对它有没有压到窗口按钮、面板会不会超出屏幕。
 * 这里不联网、不下载，只往状态里塞一份假的，让界面照常渲染。
 */
function initFakeState(): boolean {
  const raw = process.env['CFGSTUDIO_FAKE_UPDATE']
  if (!raw) return false

  const allowed = ['available', 'downloading', 'ready', 'error'] as const
  type FakePhase = (typeof allowed)[number]
  const phase: FakePhase = (allowed as readonly string[]).includes(raw) ? (raw as FakePhase) : 'ready'
  const current = app.getVersion()
  const latest = '9.9.9'

  state = {
    phase,
    info: {
      currentVersion: current,
      latestVersion: latest,
      hasUpdate: true,
      releaseUrl: `https://github.com/zeal-hope-love/cmake-vscode-studio/releases/tag/v${latest}`,
      releaseName: `v${latest}（调试假数据）`,
      notes:
        '- 标题栏新增更新快捷入口\n- 检测到新版本自动后台下载，下完提示重启\n- 主题、更新、关于合并到设置页',
      publishedAt: new Date().toISOString(),
      assets: [
        {
          name: `CmakeVscodeStudio-${latest}-setup.exe`,
          size: 118 * 1024 * 1024,
          url: 'https://example.invalid/fake-setup.exe'
        }
      ],
      status: 'ok'
    },
    progress: phase === 'downloading' ? { received: 52e6, total: 118e6, percent: 44, speed: 3.4e6 } : null,
    filePath: phase === 'ready' ? 'C:\\fake\\downloads\\setup.exe' : null,
    readyVersion: phase === 'ready' ? latest : null,
    canInstall: true,
    error: phase === 'error' ? '网络连接中断（调试假数据）' : undefined
  }
  broadcast()
  return true
}

/**
 * 启动时接上：延迟查一次（带自动下载），之后每 6 小时再看一眼。
 *
 * 只在这个进程里跑一次 —— 主进程入口调用即可。
 */
export function initUpdateService(): void {
  if (initFakeState()) return

  const settings = getSettings()
  if (settings.checkUpdates === false) {
    patch({ phase: 'disabled' })
    return
  }

  const timer = setTimeout(() => void runCheck(false, true), START_DELAY_MS)
  // 窗口关掉时进程要能退（Node 的 setTimeout 本身不阻止退出，但显式一点更清楚）
  if (typeof timer.unref === 'function') timer.unref()

  const interval = setInterval(() => void runCheck(false, true), RECHECK_MS)
  if (typeof interval.unref === 'function') interval.unref()
}
