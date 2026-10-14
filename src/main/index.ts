/**
 * Electron 主进程入口。
 */

import { app, BrowserWindow, ipcMain, nativeTheme, shell } from 'electron'
import { writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { IPC, type AppSettings } from '@shared/types'
import { registerIpc, stopAllRuns } from './ipc'
import { getSettings, saveSettings } from './services/settingsStore'

const THEME_COLORS: Record<'dark' | 'light', { bg: string; fg: string }> = {
  dark: { bg: '#0f1216', fg: '#cbd5e1' },
  light: { bg: '#f4f6f9', fg: '#334155' }
}

let mainWindow: BrowserWindow | null = null

// 开发期开放渲染进程的调试端口，方便 Chrome DevTools / VS Code / WebStorm 附加。
// Chromium 的 --remote-debugging-port 默认只绑 127.0.0.1，且打包版不会执行这里。
if (!app.isPackaged) {
  app.commandLine.appendSwitch('remote-debugging-port', '9222')
}

/**
 * 真正生效的深浅色。
 *
 * `nativeTheme.themeSource` 一旦设成 'system'，Chromium 的
 * `prefers-color-scheme` 就会跟着操作系统走，渲染进程那边直接用 matchMedia 判断即可，
 * 不需要我们两边各维护一套。
 */
function resolvedTheme(): 'dark' | 'light' {
  return nativeTheme.shouldUseDarkColors ? 'dark' : 'light'
}

/** 把主题应用到窗口（标题栏覆盖层 + 背景色） */
function applyWindowTheme(theme: AppSettings['theme']): void {
  nativeTheme.themeSource = theme
  const colors = THEME_COLORS[resolvedTheme()]
  if (mainWindow && !mainWindow.isDestroyed()) {
    mainWindow.setBackgroundColor(colors.bg)
    try {
      mainWindow.setTitleBarOverlay({ color: colors.bg, symbolColor: colors.fg, height: 38 })
    } catch {
      /* 某些平台不支持标题栏覆盖层，忽略即可 */
    }
  }
}

function createWindow(): void {
  const colors = THEME_COLORS[resolvedTheme()]

  mainWindow = new BrowserWindow({
    width: 1440,
    height: 920,
    minWidth: 1120,
    minHeight: 700,
    show: false,
    title: 'CMake / VSCode 工程配置器',
    backgroundColor: colors.bg,
    autoHideMenuBar: true,
    titleBarStyle: 'hidden',
    titleBarOverlay: {
      color: colors.bg,
      symbolColor: colors.fg,
      height: 38
    },
    webPreferences: {
      preload: join(__dirname, '../preload/index.js'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: false
    }
  })

  mainWindow.on('ready-to-show', () => {
    mainWindow?.show()
  })

  mainWindow.on('closed', () => {
    mainWindow = null
  })

  // 界面里的外链一律用系统浏览器打开，不在应用内导航
  mainWindow.webContents.setWindowOpenHandler(({ url }) => {
    if (/^https?:/i.test(url)) void shell.openExternal(url)
    return { action: 'deny' }
  })

  const devUrl = process.env['ELECTRON_RENDERER_URL']
  if (!app.isPackaged && devUrl) {
    void mainWindow.loadURL(devUrl)
  } else {
    void mainWindow.loadFile(join(__dirname, '../renderer/index.html'))
  }

  // F12 打开开发者工具
  mainWindow.webContents.on('before-input-event', (_event, input) => {
    if (input.type === 'keyDown' && input.key === 'F12') {
      mainWindow?.webContents.toggleDevTools()
    }
  })

  installScreenshotHook(mainWindow)
}

/**
 * 截图钩子：只在显式设置了环境变量 CFGSTUDIO_SHOT 时生效，正常使用完全不受影响。
 * 开发时用来批量出界面截图，打包后也能用它自检「这个 exe 到底能不能正常渲染」。
 *
 *   CFGSTUDIO_SHOT=<输出 png 路径>
 *   CFGSTUDIO_SHOT_JS=<截图前在页面里执行的 JS>     可选
 *   CFGSTUDIO_SHOT_DELAY=<毫秒，默认 3500>          可选
 */
function installScreenshotHook(win: BrowserWindow): void {
  const shotPath = process.env['CFGSTUDIO_SHOT']
  if (!shotPath) return

  const delay = Number(process.env['CFGSTUDIO_SHOT_DELAY'] ?? 3500)
  const script = process.env['CFGSTUDIO_SHOT_JS']

  win.webContents.once('did-finish-load', () => {
    setTimeout(async () => {
      try {
        if (script) {
          const result = await win.webContents.executeJavaScript(script, true)
          console.log(`[screenshot] JS 执行结果: ${JSON.stringify(result)}`)
          await new Promise((r) => setTimeout(r, 900))
        }
        const image = await win.webContents.capturePage()
        writeFileSync(shotPath, image.toPNG())
        console.log(`[screenshot] 已保存: ${shotPath}`)
      } catch (err) {
        console.error('[screenshot] 失败:', err)
      } finally {
        app.quit()
      }
    }, delay)
  })
}

app.whenReady().then(() => {
  app.setAppUserModelId('com.poxia.cmake-vscode-studio')

  // 必须在建窗口之前设好，否则渲染进程第一次读 prefers-color-scheme 会拿到默认值
  nativeTheme.themeSource = getSettings().theme

  // 系统在深浅色之间切换时（或选择「跟随系统」时系统变了），窗口边框跟着变
  nativeTheme.on('updated', () => {
    applyWindowTheme(getSettings().theme)
  })

  registerIpc(() => mainWindow)

  ipcMain.handle(IPC.windowSetTheme, async (_e, theme: AppSettings['theme']): Promise<void> => {
    applyWindowTheme(theme)
    saveSettings({ theme })
  })

  createWindow()

  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow()
  })
})

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') app.quit()
})

app.on('before-quit', () => {
  stopAllRuns()
})
