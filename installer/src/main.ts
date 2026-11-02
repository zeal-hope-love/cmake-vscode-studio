/**
 * CV Studio 安装器 —— 主进程。
 *
 * ## 为什么自己写安装器
 *
 * electron-builder 默认出的是 NSIS 安装包。NSIS 是**老式 Win32 对话框**：
 * 字体是点阵渲染的（中文尤其糊）、不支持高 DPI 缩放、界面元素位置写死。
 * 用户反馈「字像素低、图标图片清晰度低」说的就是这个 —— 那是 NSIS 的
 * 固有限制，调配置改不了。
 *
 * Electron 应用本身就是 Chromium，用它渲染安装界面就是完整的高清网页：
 * 任意字体、任意图片、任意布局，还能实时显示复制进度。
 *
 * ## 工作方式
 *
 *   1. 打包阶段把 win-unpacked/ 整个塞进本安装器（放在 app/ 里）
 *   2. 用户运行安装器 → Electron 起来 → 显示界面
 *   3. 选好目录点安装 → 本进程把 app/payload/ 里的文件逐个复制过去
 *   4. 建快捷方式、写卸载信息、可选立即启动
 *
 * 复制是流式的：每个文件复制完就回调一次，所以进度条是真的按字节走的，
 * 不是假动画。
 */

import { app, BrowserWindow, dialog, ipcMain, shell, Menu } from 'electron'
import { execFile } from 'node:child_process'
import {
  copyFileSync,
  existsSync,
  mkdirSync,
  readdirSync,
  rmSync,
  statSync,
  writeFileSync
} from 'node:fs'
import { dirname, join, relative } from 'node:path'

/** 安装器自己的窗口，不是主程序 */
let win: BrowserWindow | null = null

/** 打包时塞进来的应用本体（含 CV Studio.exe 的那份完整目录） */
function payloadDir(): string {
  // 开发时可以直接指向 release/win-unpacked，方便调试界面
  if (process.env['CVSTUDIO_PAYLOAD']) return process.env['CVSTUDIO_PAYLOAD']

  /*
   * 打包后 payload 在 `resources/payload/`（extraResources 放的），
   * **不在 asar 里** —— 265 MB 塞进 asar 会让窗口黑屏好几秒。
   * 开发态（没打包）时退回 asar 内的路径。
   */
  const outside = join(process.resourcesPath, 'payload')
  if (existsSync(outside)) return outside
  return join(app.getAppPath(), 'payload')
}

/** 读打包时写下的元信息（版本号等） */
interface Meta {
  version: string
  productName: string
  executableName: string
}
function readMeta(): Meta {
  try {
    const p = join(app.getAppPath(), 'meta.json')
    // eslint-disable-next-line @typescript-eslint/no-var-requires
    return require(p) as Meta
  } catch {
    return { version: '0.0.0', productName: 'CV Studio', executableName: 'CV Studio.exe' }
  }
}

const meta = readMeta()

/**
 * 默认装到「当前用户的 LocalAppData\Programs\<产品名>」。
 *
 * 不装 Program Files：那种位置要管理员权限，而这是个开发者工具，
 * 装到用户目录下次升级不用再弹 UAC。
 */
function defaultDir(): string {
  const local = process.env['LOCALAPPDATA'] ?? join(app.getPath('home'), 'AppData', 'Local')
  return join(local, 'Programs', meta.productName)
}

/** 递归收集要复制的文件，返回绝对路径列表 */
function collectFiles(root: string): string[] {
  const out: string[] = []
  const walk = (dir: string): void => {
    for (const name of readdirSync(dir)) {
      const abs = join(dir, name)
      const st = statSync(abs)
      if (st.isDirectory()) walk(abs)
      else out.push(abs)
    }
  }
  if (existsSync(root)) walk(root)
  return out
}

/**
 * 建一个 .lnk 快捷方式。
 *
 * 用 PowerShell 的 WScript.Shell COM 对象 —— 这是 Windows 上不装额外依赖
 * 就能建快捷方式的标准做法。参数字符串要转义单引号（PS 里 ' 是字符串定界符）。
 */
function createShortcutAsync(
  lnkPath: string,
  target: string,
  workDir: string,
  icon?: string
): Promise<void> {
  const ps = [
    '$ErrorActionPreference = "Stop"',
    '$ws = New-Object -ComObject WScript.Shell',
    `$s = $ws.CreateShortcut('${lnkPath.replace(/'/g, "''")}')`,
    `$s.TargetPath = '${target.replace(/'/g, "''")}'`,
    `$s.WorkingDirectory = '${workDir.replace(/'/g, "''")}'`,
    icon ? `$s.IconLocation = '${icon.replace(/'/g, "''")}'` : '',
    '$s.Save()'
  ]
    .filter(Boolean)
    .join('; ')

  return new Promise<void>((resolve, reject) => {
    execFile(
      'powershell.exe',
      ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-Command', ps],
      { windowsHide: true },
      (err) => (err ? reject(err) : resolve())
    )
  })
}

/**
 * 写卸载注册表项（「应用和功能」里能看到）。
 *
 * 用 reg.exe 而不是 native 模块：为了一处写注册表引入编译型依赖不值得，
 * 而且 reg.exe 在每台 Windows 上都有。
 */
async function writeUninstallEntry(installDir: string, uninstaller: string): Promise<void> {
  const key = `HKCU\\Software\\Microsoft\\Windows\\CurrentVersion\\Uninstall\\${meta.productName}`
  const values: Array<[string, string]> = [
    ['DisplayName', meta.productName],
    ['DisplayVersion', meta.version],
    ['InstallLocation', installDir],
    ['UninstallString', `"${uninstaller}"`],
    ['Publisher', 'zeal-hope-love'],
    ['NoModify', '1'],
    ['NoRepair', '1']
  ]

  for (const [name, value] of values) {
    await new Promise<void>((resolve) => {
      execFile(
        'reg.exe',
        ['add', key, '/v', name, '/t', 'REG_SZ', '/d', value, '/f'],
        { windowsHide: true },
        () => resolve()
      )
    })
  }
}

/** 卸载器：一个同样由本安装器复制的 .bat，见 writeUninstaller */
function buildUninstaller(installDir: string): void {
  const bat = `@echo off
chcp 65001 >nul
echo 正在卸载 ${meta.productName}...
taskkill /f /im "${meta.executableName}" >nul 2>&1
timeout /t 1 /nobreak >nul
reg delete "HKCU\\Software\\Microsoft\\Windows\\CurrentVersion\\Uninstall\\${meta.productName}" /f >nul 2>&1
del /f /q "%USERPROFILE%\\Desktop\\${meta.productName}.lnk" >nul 2>&1
del /f /q "%APPDATA%\\Microsoft\\Windows\\Start Menu\\Programs\\${meta.productName}.lnk" >nul 2>&1
cd /d "%TEMP%"
rmdir /s /q "${installDir}"
echo 已卸载。
timeout /t 2 >nul
`
  writeFileSync(join(installDir, 'Uninstall.bat'), bat, 'utf8')
}

// --------------------------------------------------------------------------
// IPC：渲染进程发指令，主进程干活并回报进度
// --------------------------------------------------------------------------

interface InstallOptions {
  dir: string
  desktopShortcut: boolean
  startMenuShortcut: boolean
}

ipcMain.handle('installer:defaults', () => ({
  dir: defaultDir(),
  version: meta.version,
  productName: meta.productName,
  payloadFiles: collectFiles(payloadDir()).length
}))

ipcMain.handle('installer:pickDir', async () => {
  const r = await dialog.showOpenDialog(win!, {
    title: '选择安装位置',
    defaultPath: defaultDir(),
    properties: ['openDirectory', 'createDirectory']
  })
  return r.canceled ? null : r.filePaths[0]
})

// --------------------------------------------------------------------------
// 两种安装方式
// --------------------------------------------------------------------------

type Send = (p: {
  stage: string
  percent: number
  current: string
  done: number
  total: number
  bytesDone: number
  bytesTotal: number
}) => void

/**
 * 从明文目录复制（体积大、速度快）。
 *
 * 每个文件复制完就推一次进度，但**每 40ms 限一次** ——
 * 一个 Electron 应用有几十个文件，每条都走 IPC 会把渲染进程压死，
 * 进度反而卡顿。
 */
async function installFromDirectory(src: string, dest: string, send: Send): Promise<void> {
  const files = collectFiles(src)
  const sizes = files.map((f) => statSync(f).size)
  const bytesTotal = sizes.reduce((a, b) => a + b, 0)

  send({
    stage: '复制文件',
    percent: 0,
    current: '',
    done: 0,
    total: files.length,
    bytesDone: 0,
    bytesTotal
  })

  let bytesDone = 0
  let lastPush = 0
  for (let i = 0; i < files.length; i++) {
    const abs = files[i]
    const rel = relative(src, abs)
    const target = join(dest, rel)
    mkdirSync(dirname(target), { recursive: true })
    copyFileSync(abs, target)
    bytesDone += sizes[i]

    const now = Date.now()
    if (now - lastPush > 40 || i === files.length - 1) {
      lastPush = now
      send({
        stage: '复制文件',
        percent: Math.floor((bytesDone / bytesTotal) * 100),
        current: rel,
        done: i + 1,
        total: files.length,
        bytesDone,
        bytesTotal
      })
    }
  }
}

ipcMain.handle('installer:install', async (_e, opts: InstallOptions) => {
  const t0 = Date.now()
  const dest = opts.dir
  const src = payloadDir()

  if (!existsSync(src)) {
    return { ok: false, error: `安装包内容缺失：${src}` }
  }
  if (!statSync(src).isDirectory()) {
    return { ok: false, error: `安装包内容不是目录：${src}` }
  }

  /** 每个文件复制完就推一次 —— 进度条按真实字节数走 */
  const send = (payload: {
    stage: string
    percent: number
    current: string
    done: number
    total: number
    bytesDone: number
    bytesTotal: number
  }): void => {
    if (win && !win.isDestroyed()) win.webContents.send('installer:progress', payload)
  }

  try {
    send({ stage: '准备中', percent: 0, current: '', done: 0, total: 0, bytesDone: 0, bytesTotal: 0 })

    // 目标目录里如果有旧版本，先清掉 —— 否则残留的旧文件会让主程序加载到混合版本
    if (existsSync(dest)) {
      send({ stage: '清理旧版本', percent: 0, current: dest, done: 0, total: 0, bytesDone: 0, bytesTotal: 0 })
      /*
       * 目标路径必须是目录。如果它是个同名文件（用户手滑，或者上一版装坏了），
       * 直接 readdirSync 会抛 ENOTDIR —— 那就先删掉它。
       */
      const st = statSync(dest)
      if (!st.isDirectory()) {
        rmSync(dest, { force: true })
      } else {
        for (const name of readdirSync(dest)) {
          rmSync(join(dest, name), { recursive: true, force: true })
        }
      }
    }
    mkdirSync(dest, { recursive: true })

    await installFromDirectory(src, dest, send)


    // ---- 快捷方式 ----
    send({ stage: '创建快捷方式', percent: 100, current: '', done: 0, total: 0, bytesDone: 0, bytesTotal: 0 })
    const exe = join(dest, meta.executableName)
    const iconLoc = `${exe},0`

    if (opts.desktopShortcut) {
      await createShortcutAsync(
        join(app.getPath('desktop'), `${meta.productName}.lnk`),
        exe,
        dest,
        iconLoc
      )
    }
    if (opts.startMenuShortcut) {
      const smDir = join(app.getPath('appData'), 'Microsoft', 'Windows', 'Start Menu', 'Programs')
      mkdirSync(smDir, { recursive: true })
      await createShortcutAsync(join(smDir, `${meta.productName}.lnk`), exe, dest, iconLoc)
    }

    // ---- 卸载器 + 注册表 ----
    send({ stage: '登记卸载信息', percent: 100, current: '', done: 0, total: 0, bytesDone: 0, bytesTotal: 0 })
    buildUninstaller(dest)
    await writeUninstallEntry(dest, join(dest, 'Uninstall.bat'))

    send({ stage: '完成', percent: 100, current: '', done: 0, total: 0, bytesDone: 0, bytesTotal: 0 })

    return {
      ok: true,
      dir: dest,
      exe,
      seconds: Math.round((Date.now() - t0) / 100) / 10
    }
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err)
    const code = (err as NodeJS.ErrnoException).code ?? ''
    // 把出错的位置也带上 —— 只说 ENOTDIR 谁都不知道是哪个路径
    const where = (err as NodeJS.ErrnoException).path ?? ''
    return {
      ok: false,
      error: `安装失败：${msg}${code ? `（${code}）` : ''}${where ? `\n路径：${where}` : ''}\n目标：${dest}`
    }
  }
})

ipcMain.handle('installer:launch', (_e, exe: string) => {
  shell.openPath(exe)
  app.quit()
})
ipcMain.handle('installer:quit', () => app.quit())

// --------------------------------------------------------------------------

function createWindow(): void {
  win = new BrowserWindow({
    width: 620,
    height: 560,
    resizable: false,
    maximizable: false,
    /*
     * 无边框 + 自绘标题栏。
     *
     * 用系统标题栏的话，浅色界面顶上会多一条深色条，和下面的内容割裂；
     * 而且窗口本身固定大小，系统那三个按钮也没什么用。
     * 自绘之后整个窗口是一体的，也能贴一条细的边框阴影。
     */
    frame: false,
    titleBarStyle: 'hidden',
    title: `${meta.productName} 安装程序`,
    backgroundColor: '#f3f3f3',
    icon: join(app.getAppPath(), 'icon.png'),
    show: false,
    webPreferences: {
      preload: join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false
    }
  })

  // 等页面画完再显示，避免先闪一下白屏
  win.once('ready-to-show', () => win?.show())

  Menu.setApplicationMenu(null)
  /*
   * `__dirname` 就是 asar 里的 `app/` 目录 —— 界面在它的 `renderer/` 子目录下。
   *
   * 早先这里写成 `join(__dirname, '..', 'renderer', 'index.html')`，
   * 多退了一层、指向 asar 根下的 renderer（不存在）→ 窗口一片全黑。
   */
  win.loadFile(join(__dirname, 'renderer', 'index.html'))

  // 加载失败时把原因打出来，别再让人对着黑窗口猜
  win.webContents.on('did-fail-load', (_e, code, desc, url) => {
    console.error('[installer] 界面加载失败', code, desc, url)
  })
  win.webContents.on('console-message', (_e, _level, message) => {
    console.log('[renderer]', message)
  })
  win.on('closed', () => {
    win = null
  })
}

app.whenReady().then(() => {
  createWindow()
})

app.on('window-all-closed', () => app.quit())