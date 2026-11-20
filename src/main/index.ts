/**
 * Electron 主进程入口。
 */

import { app, BrowserWindow, desktopCapturer, ipcMain, nativeTheme, screen, shell } from 'electron'
import { writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { IPC, type AppSettings } from '@shared/types'
import { registerIpc, stopAllRuns } from './ipc/index'
import { getSettings, saveSettings } from './services/data/settingsStore'
import { initUpdateService } from './services/update/updateService'

/*
 * 窗口级配色，**必须和 global.css 的变量对齐**（这里是主进程，读不到 CSS）。
 *
 *   bg  —— --bg，窗口底色
 *   bar —— --bg-elevated，标题栏底色（.titlebar 的 background）
 *   fg  —— 最小化/最大化/关闭那三个图标符号的颜色
 *
 * 标题栏覆盖层（titleBarOverlay）一定要用 bar 而不是 bg：
 * 那三个原生按钮画在网页之上的一整块底色上，用 bg 会在标题栏右端
 * 露出一条比周围深一档的矩形 —— 就是「窗口按钮背后颜色不一样」的由来。
 */
const THEME_COLORS: Record<'dark' | 'light', { bg: string; bar: string; fg: string }> = {
  dark: { bg: '#0f1216', bar: '#161b22', fg: '#cbd5e1' },
  light: { bg: '#f4f6f9', bar: '#ffffff', fg: '#334155' }
}

let mainWindow: BrowserWindow | null = null

/*
 * 允许用环境变量改 userData 目录。
 *
 * 为什么需要：验证时经常要在「不碰用户真实数据」的前提下跑一遍 ——
 * 否则测试会污染 %APPDATA%\CV Studio（改主题、写历史、存快照）。
 *
 * ## 时机很讲究
 *
 * `app.setPath('userData', ...)` 必须在**任何东西读取 userData 之前**调用。
 * 实测：放在模块顶层不行 —— Electron 那时还没初始化完，setPath 被静默忽略，
 * 后面照样用默认目录（从 stderr 里看到还是 %APPDATA%\CV Studio 就说明没生效）。
 *
 * 放在 `app.on('ready')` 里也**太晚** —— Chromium 在 ready 之前就用 userData
 * 建好了缓存目录。
 *
 * 正确做法是 `app.whenReady()` 之前的**第一个 tick**：用一个立即执行函数
 * 把 setPath 放在最前面，确保它先于任何 getPath 调用。
 */
const userDataOverride = process.env['CFGSTUDIO_USER_DATA']
if (userDataOverride) {
  try {
    app.setPath('userData', userDataOverride)
  } catch {
    /* 极端情况下（Electron 还没就绪）忽略 —— 只是调试开关，不影响正常使用 */
  }
}

// 开发期开放渲染进程的调试端口，方便 Chrome DevTools / VS Code / WebStorm 附加。
// Chromium 的 --remote-debugging-port 默认只绑 127.0.0.1，且打包版不会执行这里。
if (!app.isPackaged) {
  app.commandLine.appendSwitch('remote-debugging-port', '9222')
}

/*
 * 单实例。
 *
 * ## 为什么必须加
 *
 * 设置 / 模板 / 快照 / 历史全在同一个 userData 目录里，而 `history.json` 是
 * 「读整份 → 改一条 → 写整份」。两个实例同时开着时，各自手里都有一份列表，
 * 后写的那个会把先写的记录**整段冲掉** —— 现场表现就是：
 *
 *   写入报了 EPERM，去「历史记录」里找，一条都没有。
 *
 * 不是没记，是被另一个实例的旧列表覆盖了。这类问题靠重试和加锁文件都治不住，
 * 唯一干净的办法是不让第二个实例起来。
 *
 * ## 锁的粒度
 *
 * 跟着 userData 目录走。所以用 CFGSTUDIO_USER_DATA 指到不同目录的两个实例
 * 互不影响 —— 调试时真想并行开，就用这个变量做隔离（也顺带隔离了数据）。
 *
 * ## 开发模式不加锁（踩过的坑）
 *
 * 第一版是无条件 `requestSingleInstanceLock()`，结果 WebStorm 里跑 `npm run dev`
 * 直接变成「进程已结束，退出代码为 0」—— 连窗口都不见，什么线索都没有。
 *
 * 原因：Chromium 建锁文件时会被拒绝（`process_singleton_win.cc:318] Lock file can
 * not be created: 拒绝访问 (0x5)`），只要本机有任何一个残留的 electron.exe 还拿着
 * 同一份 userData（哪怕它从两天前就挂死了），拿锁就失败 → 我们 `app.quit()` →
 * electron-vite 收到 0 → 安静退出。EDR / 杀毒软件拦截锁文件也会造成同样的结果。
 *
 * 这个锁本来是防「两个实例互相覆盖 history.json」的，那是**用户日常使用**才会遇到
 * 的问题；开发调试时为了它把启动打断，代价完全不成比例。所以：
 *   - 打包版：加锁（保护用户数据）
 *   - 开发版：不加锁（调试优先），要并行就用 CFGSTUDIO_USER_DATA 隔离数据
 *   - 打包版想临时多开：CFGSTUDIO_ALLOW_MULTI=1
 */
const allowMultipleInstances = process.env['CFGSTUDIO_ALLOW_MULTI'] === '1'
const takesSingleInstanceLock = app.isPackaged && !allowMultipleInstances

const hasSingleInstanceLock = takesSingleInstanceLock ? app.requestSingleInstanceLock() : true

if (!hasSingleInstanceLock) {
  // 这里必须打日志。以前是静默 quit，用户只看到「退出代码 0」，
  // 完全不知道是被另一个实例挡掉了。
  console.warn(
    '[bootstrap] 已经有一个 CV Studio 在运行，本次启动退出。' +
      `\n            数据目录：${app.getPath('userData')}` +
      '\n            想同时开多个实例：设 CFGSTUDIO_ALLOW_MULTI=1'
  )
  app.quit()
}

app.on('second-instance', () => {
  // 用户又点了一次图标：把已有的窗口叫到前面，而不是开第二个
  if (!mainWindow) return
  if (mainWindow.isMinimized()) mainWindow.restore()
  mainWindow.show()
  mainWindow.focus()
})

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
      mainWindow.setTitleBarOverlay({ color: colors.bar, symbolColor: colors.fg, height: 38 })
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
    title: 'CV Studio',
    /**
     * 窗口 / 任务栏图标。
     *
     * 打包后 exe 自带图标（electron-builder 从 resources/icon.ico 嵌进去），
     * 但**开发模式下用的是 Electron 的默认图标** —— 看着不像自己的应用，
     * 所以这里显式指一下。打包后走 extraResources 复制进来的那一份。
     */
    icon: app.isPackaged
      ? join(process.resourcesPath, 'icon.png')
      : join(__dirname, '../../resources/icon.png'),
    backgroundColor: colors.bg,
    autoHideMenuBar: true,
    titleBarStyle: 'hidden',
    titleBarOverlay: {
      color: colors.bar,
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
 *   CFGSTUDIO_SHOT_CHROME=<输出 png 路径>           可选
 *
 * 最后那个是拍**窗口标题栏右端**（最小化/最大化/关闭那三个原生按钮所在的一小块）。
 *
 * 为什么不能只靠 capturePage：那三个按钮属于窗口的非客户区，由系统画在网页之上，
 * `capturePage()` 里根本没有它们。而它们背后那块底色是 titleBarOverlay 给的原生色块，
 * 一旦跟网页里 .titlebar 的底色不一致，就会出现「按钮那块比旁边深一档」的接缝 ——
 * 这种问题只能拍真实桌面才看得见。
 */
function installScreenshotHook(win: BrowserWindow): void {
  const shotPath = process.env['CFGSTUDIO_SHOT']
  const chromePath = process.env['CFGSTUDIO_SHOT_CHROME']
  if (!shotPath && !chromePath) return

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
        if (shotPath) {
          const image = await win.webContents.capturePage()
          writeFileSync(shotPath, image.toPNG())
          console.log(`[screenshot] 已保存: ${shotPath}`)
        }
        if (chromePath) {
          writeFileSync(chromePath, (await captureChrome(win)).toPNG())
          console.log(`[screenshot] 已保存窗口按钮区: ${chromePath}`)
        }
      } catch (err) {
        console.error('[screenshot] 失败:', err)
      } finally {
        app.quit()
      }
    }, delay)
  })
}

/**
 * 截「标题栏右端 300px」那一小块真实屏幕内容（含系统画的三个窗口按钮）。
 *
 * 坐标要乘 scaleFactor：desktopCapturer 给的是物理像素，而窗口 bounds 是 DIP。
 * 窗口可能被拖到副屏，所以按窗口当前位置去挑屏幕，而不是死用主屏。
 */
async function captureChrome(win: BrowserWindow): Promise<Electron.NativeImage> {
  const bounds = win.getBounds()
  const display = screen.getDisplayMatching(bounds)
  const scale = display.scaleFactor
  const sources = await desktopCapturer.getSources({
    types: ['screen'],
    thumbnailSize: {
      width: Math.round(display.size.width * scale),
      height: Math.round(display.size.height * scale)
    }
  })
  const full = sources[0]?.thumbnail
  if (!full) throw new Error('拿不到屏幕画面')

  const stripW = Math.min(300, bounds.width)
  const stripH = 46
  // 屏幕图像的原点是整个虚拟桌面的左上角，所以要减掉这块屏幕自己的偏移
  const x = Math.round((bounds.x + bounds.width - stripW - display.bounds.x) * scale)
  const y = Math.round((bounds.y - display.bounds.y) * scale)
  return full.crop({
    x: Math.max(0, x),
    y: Math.max(0, y),
    width: Math.round(stripW * scale),
    height: Math.round(stripH * scale)
  })
}

app.whenReady().then(() => {
  // 没抢到单实例锁的那次启动：别建窗口、别注册 IPC，安静退出
  if (!hasSingleInstanceLock) return

  /*
   * 再设一次 userData —— 顶层那次不一定算数。
   *
   * 实测：`electron .` 启动时，顶层调用可能被 Electron 内部忽略（那时它还没
   * 初始化完），于是 CFGSTUDIO_USER_DATA 形同虚设，调试实例会悄悄写进真实
   * 数据目录（改掉用户的主题、往他的 history.json 里塞记录）。
   * 这里 Electron 已经就绪，再设一次一定生效。
   */
  if (userDataOverride) {
    try {
      app.setPath('userData', userDataOverride)
    } catch (err) {
      console.warn('[bootstrap] 没能切到指定的数据目录，继续用默认目录：', err)
    }
  }
  if (!app.isPackaged) {
    console.log('[bootstrap] 数据目录 =', app.getPath('userData'))
  }

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
    /*
     * 再落盘，**失败也不抛**。
     *
     * 这里是启动时必经之路（bootstrap 会调一次来同步标题栏配色），而启动瞬间
     * 恰好是 Electron 各子进程抢 settings.json 最凶的时候。让一个「配色偏好
     * 没存上」的小问题把整个启动流程打成红色报错，代价和收益完全不成比例。
     *
     * 用户主动在菜单里改主题时走的是渲染进程的 setTheme，那边会把失败
     * 用 toast 告诉他；这里只是启动同步，静默降级即可。
     */
    try {
      saveSettings({ theme })
    } catch (err) {
      console.warn('[theme] 配色偏好没存上（不影响使用）：', err instanceof Error ? err.message : err)
    }
  })

  createWindow()

  /*
   * 更新检查放到窗口建好之后 —— 它自己会再等 4 秒才发请求。
   *
   * 在这里启动（而不是渲染进程 useEffect 里）有两个好处：
   *   · 窗口重载 / 关掉再开都不会重复检查，也不会把下载进度搞丢；
   *   · 「下好了没装」的状态跨启动还在（安装包在 downloads/ 里）。
   */
  initUpdateService()

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
