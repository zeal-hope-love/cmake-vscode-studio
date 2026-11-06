/**
 * 安装器的 preload：只暴露安装界面需要的几个方法。
 *
 * 保持最小面 —— 安装器会往用户磁盘写东西，不该给它多余的权限。
 */
import { contextBridge, ipcRenderer } from 'electron'

export interface InstallProgress {
  stage: string
  percent: number
  current: string
  done: number
  total: number
  bytesDone: number
  bytesTotal: number
}

export interface InstallerApi {
  defaults(): Promise<{ dir: string; version: string; productName: string; payloadFiles: number }>
  pickDir(): Promise<string | null>
  install(opts: {
    dir: string
    desktopShortcut: boolean
    startMenuShortcut: boolean
  }): Promise<{ ok: boolean; dir?: string; exe?: string; seconds?: number; error?: string }>
  onProgress(handler: (p: InstallProgress) => void): () => void
  launch(exe: string): void
  minimize(): void
  quit(): void
}

const api: InstallerApi = {
  defaults: () => ipcRenderer.invoke('installer:defaults'),
  pickDir: () => ipcRenderer.invoke('installer:pickDir'),
  install: (opts) => ipcRenderer.invoke('installer:install', opts),
  onProgress: (handler) => {
    // 包一层再注册，取消订阅时才能拿到同一个引用
    const wrapped = (_e: unknown, p: InstallProgress): void => handler(p)
    ipcRenderer.on('installer:progress', wrapped)
    return () => ipcRenderer.removeListener('installer:progress', wrapped)
  },
  launch: (exe) => void ipcRenderer.invoke('installer:launch', exe),
  minimize: () => void ipcRenderer.invoke('installer:minimize'),
  quit: () => void ipcRenderer.invoke('installer:quit')
}

contextBridge.exposeInMainWorld('installer', api)