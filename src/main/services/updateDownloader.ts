/**
 * 应用内下载安装包。
 *
 * ## 为什么不用 electron-updater
 *
 * electron-updater 能做「完全静默更新」，但它要求安装包**有有效的代码签名**：
 * 没签名的话 Windows 在启动安装器时会弹 UAC +「未知发布者」，
 * 而且 `quitAndInstall()` 在某些情况下会直接失败。
 *
 * 这个项目没有签名证书，所以走**手动但好用**的路线：
 *
 *   应用内下载（带真实进度）→ 下载完 → 启动安装器 → 用户点下一步
 *
 * 体验上已经比「跳浏览器自己找下载按钮」好很多：不用离开应用，
 * 知道自己下了多少、放在哪，下完直接弹安装向导。
 *
 * ## 网络
 *
 * 用 Electron 的 `net.fetch`（Chromium 网络栈，读系统证书和代理），
 * 和 updateChecker 保持一致 —— Node 的 fetch 在装了抓包/代理的机器上
 * 会报 UNABLE_TO_VERIFY_LEAF_SIGNATURE。
 */

import { app, net } from 'electron'
import { createWriteStream, existsSync, mkdirSync, statSync, unlinkSync } from 'node:fs'
import { join } from 'node:path'
import { userDataPath } from './store'

export interface DownloadProgress {
  /** 已下载字节 */
  received: number
  /** 总字节（服务端没给 Content-Length 时为 0） */
  total: number
  /** 百分比（0-100，total 为 0 时是 -1 表示未知） */
  percent: number
  /** 速度（字节/秒，估算值） */
  speed: number
}

export interface DownloadResult {
  ok: boolean
  /** 下载好的文件路径 */
  path?: string
  /** 失败原因 */
  error?: string
  /** 用户取消 */
  cancelled?: boolean
}

/** 正在进行的下载，用来支持取消 / 防止并发下载多个 */
let current: {
  controller: AbortController
  filePath: string
} | null = null

/** 安装包放在 userData 下的 downloads/ 里 —— 卸载时跟着一起清掉 */
function downloadDir(): string {
  const dir = userDataPath('downloads')
  mkdirSync(dir, { recursive: true })
  return dir
}

/**
 * 下载文件到 `downloads/`。
 *
 * @param url       下载地址（GitHub Release asset）
 * @param fileName  希望保存的文件名
 * @param onProgress 进度回调，约每 200ms 一次 —— 太频繁会把渲染进程压死
 */
export async function downloadInstaller(
  url: string,
  fileName: string,
  onProgress: (p: DownloadProgress) => void
): Promise<DownloadResult> {
  if (current) {
    return { ok: false, error: '已经有一个下载在进行中' }
  }

  // 文件名做一次清洗：不允许路径分隔符，防止写到 downloads/ 外面去
  const safeName = fileName.replace(/[\\/:*?"<>|]/g, '_')
  if (!safeName || safeName.includes('..')) {
    return { ok: false, error: `文件名不合法：${fileName}` }
  }

  const filePath = join(downloadDir(), safeName)

  /*
   * 已经下过同名文件且大小看起来正常（> 1MB）就不重复下载 ——
   * 用户可能点了「重试」。直接复用，省时间也省流量。
   */
  if (existsSync(filePath) && statSync(filePath).size > 1024 * 1024) {
    onProgress({ received: statSync(filePath).size, total: statSync(filePath).size, percent: 100, speed: 0 })
    return { ok: true, path: filePath }
  }

  const controller = new AbortController()
  current = { controller, filePath }

  try {
    const res = await net.fetch(url, {
      signal: controller.signal,
      // GitHub 的下载链接会跳转到 CDN，net.fetch 默认跟随重定向
      headers: { 'User-Agent': `CV-Studio/${app.getVersion()}` }
    })

    if (!res.ok) {
      throw new Error(`HTTP ${res.status}`)
    }

    const total = Number(res.headers.get('content-length') ?? 0) || 0
    const body = res.body
    if (!body) throw new Error('响应没有内容')

    /*
     * 先删旧文件再写 —— `createWriteStream` 是覆盖模式，但残留的
     * 半截文件如果上次中断留下的，先清掉更保险。
     */
    if (existsSync(filePath)) unlinkSync(filePath)

    const out = createWriteStream(filePath)
    const reader = body.getReader()

    let received = 0
    const startedAt = Date.now()
    let lastPush = 0

    // eslint-disable-next-line no-constant-condition
    while (true) {
      const { done, value } = await reader.read()
      if (done) break
      if (!value) continue

      received += value.byteLength

      // 写不进去（磁盘满等）会在这里抛
      await new Promise<void>((resolve, reject) => {
        out.write(Buffer.from(value), (err) => (err ? reject(err) : resolve()))
      })

      const now = Date.now()
      if (now - lastPush > 200) {
        lastPush = now
        const elapsed = (now - startedAt) / 1000
        onProgress({
          received,
          total,
          percent: total > 0 ? Math.floor((received / total) * 100) : -1,
          speed: elapsed > 0 ? Math.round(received / elapsed) : 0
        })
      }
    }

    await new Promise<void>((resolve, reject) => {
      out.end((err?: Error | null) => (err ? reject(err) : resolve()))
    })

    /*
     * 校验大小。
     *
     * 服务端给了 Content-Length 的话，下载到的字节数必须对得上 ——
     * 对不上说明连接中途断了，写出来的是个坏文件。
     * 这种情况宁可报错让用户重下，也不要启动一个装不上的安装包。
     */
    const written = statSync(filePath).size
    if (total > 0 && written !== total) {
      throw new Error(`文件不完整：应为 ${total} 字节，实际 ${written} 字节`)
    }

    onProgress({ received: written, total: written, percent: 100, speed: 0 })
    return { ok: true, path: filePath }
  } catch (err) {
    // 取消是用户主动行为，不算错误
    const aborted = err instanceof Error && err.name === 'AbortError'
    // 清掉下了一半的文件
    try {
      if (existsSync(filePath)) unlinkSync(filePath)
    } catch {
      /* 删不掉就算了 */
    }
    if (aborted) return { ok: false, cancelled: true }
    return {
      ok: false,
      error: err instanceof Error ? err.message : String(err)
    }
  } finally {
    current = null
  }
}

/** 取消进行中的下载 */
export function cancelDownload(): void {
  current?.controller.abort()
}

/**
 * 启动下载好的安装包。
 *
 * 用 `spawn(detached)` 而不是 `shell.openPath`：这个安装包是
 * NSIS / 自定义安装器，会自己弹 UAC。detached 之后它和 CV Studio
 * 完全独立，用户装完重启应用就行。
 */
export async function runInstaller(filePath: string): Promise<{ ok: boolean; error?: string }> {
  if (!existsSync(filePath)) {
    return { ok: false, error: `安装包不见了：${filePath}` }
  }

  try {
    // eslint-disable-next-line @typescript-eslint/no-var-requires
    const { spawn } = require('node:child_process') as typeof import('node:child_process')
    const child = spawn(filePath, [], { detached: true, stdio: 'ignore' })
    child.unref()
    return { ok: true }
  } catch (err) {
    return { ok: false, error: err instanceof Error ? err.message : String(err) }
  }
}