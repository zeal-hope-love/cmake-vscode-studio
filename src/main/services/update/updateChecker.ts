/**
 * 版本更新检测。
 *
 * 数据源是 GitHub Releases 的公开 API：
 *
 *     GET https://api.github.com/repos/<owner>/<repo>/releases/latest
 *
 * 选它而不是自己搭服务，理由很直接：发布流程本来就走 `gh release create`，
 * Release 一出来这里就能读到，不用额外维护任何东西。
 *
 * ## 几个必须处理的现实问题
 *
 * 1. **不能拖慢启动**。网络请求放在窗口显示之后、异步跑，失败就算了。
 *    用户打开工具是为了干活，不是为了等更新检查。
 *
 * 2. **离线 / 被墙 / 限流都要能安静处理**。「检查更新失败」不该弹窗打扰人，
 *    只在「关于」页里显示一个失败状态就够。
 *
 * 3. **GitHub API 未认证限流 60 次/小时**。一个人正常用完全够，
 *    但不能每次切页都请求 —— 结果缓存 6 小时。
 *
 * 4. **版本号比较不能按字符串比**。'2.0.10' > '2.0.9' 字符串比是错的，
 *    要按数字逐段比。
 */

import { app, net } from 'electron'
import type { UpdateInfo } from '@shared/updateTypes'
import { compareVersion } from '@shared/versionCompare'
import { getSettings, saveSettings } from '../data/settingsStore'

export type { UpdateInfo, UpdateAsset } from '@shared/updateTypes'
export { compareVersion } from '@shared/versionCompare'

/** GitHub 仓库坐标 —— 和 package.json 的 repository 保持一致 */
const REPO_OWNER = 'zeal-hope-love'
const REPO_NAME = 'cmake-vscode-studio'

/** 缓存多久（毫秒）。6 小时内重复检查直接返回上次结果 */
const CACHE_MS = 6 * 60 * 60 * 1000

/** 请求超时 —— 超时就当检查失败，不重试 */
const TIMEOUT_MS = 8000

/** 内存里的上次结果，避免同一会话反复请求 */
let cached: { at: number; info: UpdateInfo } | null = null

/**
 * 检查更新。
 *
 * @param force 忽略缓存强制重新请求（用户点「检查更新」按钮时）
 */
export async function checkForUpdate(force = false): Promise<UpdateInfo> {
  const currentVersion = app.getVersion()

  const settings = getSettings()
  if (settings.checkUpdates === false) {
    return {
      currentVersion,
      latestVersion: currentVersion,
      hasUpdate: false,
      releaseUrl: '',
      releaseName: '',
      notes: '',
      publishedAt: '',
      assets: [],
      status: 'disabled'
    }
  }

  // 缓存命中
  if (!force && cached && Date.now() - cached.at < CACHE_MS) {
    return { ...cached.info, cached: true }
  }

  const url = `https://api.github.com/repos/${REPO_OWNER}/${REPO_NAME}/releases/latest`
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), TIMEOUT_MS)

  try {
    /*
     * 用 Electron 的 `net.fetch` 而不是全局 `fetch`。
     *
     * 实测过：在装了抓包/代理类软件（Clash、火绒之类）的机器上，
     * Node 自带的 fetch 会报
     *     UNABLE_TO_VERIFY_LEAF_SIGNATURE
     * —— 因为它只信任 Node 内置的那套根证书，不读系统证书库。
     * 而 Electron 的 net 模块走 Chromium 的网络栈，用的是**系统证书和代理设置**，
     * 用户浏览器能访问的它就能访问。
     *
     * 这个区别很容易踩：本地测试通了，用户那边全失败。
     */
    const res = await net.fetch(url, {
      signal: controller.signal,
      headers: {
        Accept: 'application/vnd.github+json',
        // GitHub 要求带 User-Agent，否则直接 403
        'User-Agent': `CV-Studio/${currentVersion}`,
        'X-GitHub-Api-Version': '2022-11-28'
      }
    })

    if (!res.ok) {
      // 404 表示还没有发布任何 Release —— 对早期开发是正常的，不算错误
      if (res.status === 404) {
        const info: UpdateInfo = {
          currentVersion,
          latestVersion: currentVersion,
          hasUpdate: false,
          releaseUrl: '',
          releaseName: '',
          notes: '',
          publishedAt: '',
          assets: [],
          status: 'ok'
        }
        cached = { at: Date.now(), info }
        return info
      }
      throw new Error(`GitHub 返回 ${res.status}${res.status === 403 ? '（可能是访问太频繁）' : ''}`)
    }

    const data = (await res.json()) as {
      tag_name?: string
      name?: string
      body?: string
      html_url?: string
      published_at?: string
      assets?: Array<{ name?: string; size?: number; browser_download_url?: string }>
    }

    const latestVersion = (data.tag_name ?? '').replace(/^v/i, '') || currentVersion
    const info: UpdateInfo = {
      currentVersion,
      latestVersion,
      hasUpdate: compareVersion(latestVersion, currentVersion) > 0,
      releaseUrl: data.html_url ?? '',
      releaseName: data.name ?? '',
      notes: data.body ?? '',
      publishedAt: data.published_at ?? '',
      assets: (data.assets ?? [])
        .filter((a) => a.name && a.browser_download_url)
        .map((a) => ({
          name: a.name!,
          size: a.size ?? 0,
          url: a.browser_download_url!
        })),
      status: 'ok'
    }

    cached = { at: Date.now(), info }
    return info
  } catch (err) {
    const msg =
      err instanceof Error
        ? err.name === 'AbortError'
          ? '请求超时'
          : err.message
        : String(err)

    /*
     * 失败不写缓存 —— 这次网络不好，下次说不定就好了。
     * 但也别让界面看起来像「检查过了没问题」。
     */
    return {
      currentVersion,
      latestVersion: '',
      hasUpdate: false,
      releaseUrl: '',
      releaseName: '',
      notes: '',
      publishedAt: '',
      assets: [],
      status: 'error',
      detail: msg
    }
  } finally {
    clearTimeout(timer)
  }
}

/** 用户切换「启动时自动检查」开关 */
export function setAutoCheckUpdates(enabled: boolean): void {
  saveSettings({ checkUpdates: enabled })
  if (!enabled) cached = null
}