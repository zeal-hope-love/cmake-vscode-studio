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
import { execFile, spawn } from 'node:child_process'
import {
  copyFileSync,
  existsSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  renameSync,
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
  /*
   * `app.getAppPath()` 是 asar 的**根**，而我们的文件在 `app/` 子目录下
   * （electron-builder 把整个项目目录打进去）。
   *
   * 早先这里写成 `join(getAppPath(), 'meta.json')` —— 少了一层 `app/`，
   * require 抛异常、被 catch 吞掉，于是版本号永远显示 v0.0.0。
   *
   * 两个候选路径都试，兼容「打包」和「开发时直接跑」两种情况。
   */
  const candidates = [
    join(app.getAppPath(), 'app', 'meta.json'),
    join(app.getAppPath(), 'meta.json')
  ]
  for (const p of candidates) {
    try {
      // 用 readFileSync 而不是 require：require 会缓存，且对 asar 内的
      // JSON 支持不稳定（不同 Electron 版本行为不同）
      return JSON.parse(readFileSync(p, 'utf8')) as Meta
    } catch {
      /* 试下一个 */
    }
  }
  console.error('[installer] 读不到 meta.json，用过时默认值')
  return { version: '0.0.0', productName: 'CV Studio', executableName: 'CV Studio.exe' }
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
 * 递归建目录，**顺手清掉挡路的同名文件**。
 *
 * `mkdirSync(..., { recursive: true })` 遇到路径中间有一段是文件时
 * 会抛 ENOTDIR。安装器必须能从上一次失败的残留里恢复，
 * 所以这里自己逐段走：是文件就删掉，是目录就继续。
 */
function ensureDir(dir: string): void {
  const sep = dir.includes('/') && !dir.includes('\\') ? '/' : '\\'
  const parts = dir.split(/[\\/]/).filter(Boolean)
  let cur = parts[0] && parts[0].endsWith(':') ? parts[0] + sep : ''
  for (const part of parts) {
    if (part.endsWith(':')) continue
    cur = cur ? join(cur, part) : part
    if (existsSync(cur)) {
      if (!statSync(cur).isDirectory()) {
        // 同名文件挡在目录位置 → 删掉它
        rmSync(cur, { force: true })
        mkdirSync(cur, { recursive: true })
      }
    } else {
      mkdirSync(cur, { recursive: true })
    }
  }
}


/**
 * 把 src 里的文件**逐个覆盖**到 dst（不删除 dst 里多出来的文件）。
 *
 * 用在「目标目录被占用、没法整体替换」的兜底场景。
 * 遇到删不掉也写不进的文件时，把路径报上去 —— 用户才知道要先关程序。
 */
function copyTreeOverwrite(src: string, dst: string): void {
  for (const name of readdirSync(src)) {
    const from = join(src, name)
    const to = join(dst, name)
    if (statSync(from).isDirectory()) {
      ensureDir(to)
      copyTreeOverwrite(from, to)
      continue
    }
    try {
      copyFileSync(from, to)
    } catch (err) {
      const code = (err as NodeJS.ErrnoException).code ?? ''
      throw new Error(
        `覆盖 ${name} 失败（${code}）。\n` +
          `多半是上一版 CV Studio 还开着，请先关掉它再重试。`
      )
    }
  }
}


/** 进程表里的一行 —— 只要「PID + 映像名」就够 */
interface ProcEntry {
  pid: number
  name: string
}

/**
 * 列出系统里所有进程。
 *
 * 为什么不用 `tasklist`：它只能按映像名过滤、拿不到干净的 PID 列表，
 * 输出还是给人看的固定宽度表格，解析起来很脆。
 * 也不用 `wmic`：Win11 24H2 起已经被移除了，不能依赖。
 *
 * 查不到就返回空数组 —— 调用方会把「没有进程」当成「程序没在跑」，
 * 这时继续安装是安全的；真被占用，复制那一步会给出明确的错误。
 */
function listProcesses(): Promise<ProcEntry[]> {
  /*
   * 让 PowerShell 直接输出 `pid|name`。
   *
   * 不走 ConvertTo-Csv：CSV 还要处理引号和列顺序，而且进程名里带空格很常见
   * （"CV Studio.exe"），自己定分隔符最省心。这条命令是常量、不含用户输入，
   * 不涉及注入。
   */
  const ps = 'Get-CimInstance Win32_Process | ForEach-Object { "$($_.ProcessId)|$($_.Name)" }'

  return new Promise((resolve) => {
    execFile(
      'powershell.exe',
      ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-Command', ps],
      // 进程多的机器输出能到几 MB，默认 1MB 会截断
      { windowsHide: true, maxBuffer: 16 * 1024 * 1024 },
      (err, stdout) => {
        if (err || !stdout) {
          // 查不到就当没在跑：继续安装；真被占用会在复制那一步报明确的错
          console.error('[installer] 枚举进程失败：', err?.message ?? '空输出')
          return resolve([])
        }
        const out: ProcEntry[] = []
        for (const line of stdout.split(/\r?\n/)) {
          const parts = line.trim().split('|')
          if (parts.length < 2) continue
          const pid = Number(parts[0])
          // 进程名理论上不含 |，但真含了也别把名字截断
          const name = parts.slice(1).join('|')
          if (!Number.isFinite(pid) || !name) continue
          out.push({ pid, name })
        }
        resolve(out)
      }
    )
  })
}

/**
 * 找出「正在运行的 CV Studio」进程，**排除安装器自己**。
 *
 * ## 为什么不能再用 `taskkill /F /T /IM "CV Studio.exe"`
 *
 * 这个安装包最常见的启动方式是应用内更新：CV Studio 下载完 → spawn 安装器 →
 * 用户在安装器里点「自动关闭并继续」。
 *
 * `/T` 的含义是「连子进程一起杀」。而安装器正是 CV Studio 拉起来的**子进程**
 * ——`spawn(..., { detached: true })` 只让子进程不共享控制台，**不影响父子关系**。
 * 于是 taskkill 顺着树把自己也杀了：安装窗口凭空消失，用户以为安装失败。
 *
 * 现在改成按 PID 逐个结束，**不带 `/T`**：
 *   · Electron 的所有进程（主进程 / renderer / GPU / utility）映像名都相同，
 *     全都在这个列表里，所以不靠 `/T` 也能清干净；
 *   · 安装器自己的映像名是 `CV Studio Setup.exe`，本来就不匹配，
 *     再加上 PID 排除，双保险；
 *   · 父进程 CV Studio 被杀掉后，安装器是独立的 GUI 进程，不会跟着退出
 *     （Windows 没有「父死子亡」这回事，除非进程被放进 kill-on-close 的 Job）。
 *
 * 注意**不要**顺手把父进程也排除掉 —— 那正是要关掉的那个。
 */
async function appProcesses(): Promise<ProcEntry[]> {
  const all = await listProcesses()
  const target = meta.executableName.toLowerCase()
  return all.filter((p) => p.name.toLowerCase() === target && p.pid !== process.pid)
}

/** 结束单个进程。不带 `/T`，理由见上面 appProcesses 的注释 */
function killProcess(pid: number): Promise<void> {
  return new Promise((resolve) => {
    execFile('taskkill.exe', ['/F', '/PID', String(pid)], { windowsHide: true }, () => resolve())
  })
}

/**
 * 快速判断「还有没有在跑」—— 轮询用。
 *
 * 只为了知道「关干净了没有」，不需要 PID，所以用 tasklist（几十毫秒）
 * 而不是再拉一次 PowerShell（每次几百毫秒）。上面的 appProcesses 是
 * 「要杀谁」时才用的重量级查询。
 */
function quickIsRunning(): Promise<boolean> {
  return new Promise((resolve) => {
    execFile(
      'tasklist.exe',
      ['/FI', `IMAGENAME eq ${meta.executableName}`, '/NH'],
      { windowsHide: true },
      (err, stdout) => {
        if (err) return resolve(false)
        // 「没有运行的任务」时 tasklist 输出的是提示文字，不包含 exe 名
        resolve(stdout.toLowerCase().includes(meta.executableName.toLowerCase()))
      }
    )
  })
}

/**
 * 结束正在运行的 CV Studio。
 *
 * 为什么安装器要自己动手：Windows 上程序开着的时候 exe 被锁，
 * 覆盖安装必然失败（EPERM / EBUSY）。让用户自己去任务管理器找进程
 * 太麻烦 —— 而且这个应用有个托盘图标，很多人不知道要连托盘一起退。
 *
 * 会先弹窗确认，绝不静默杀进程：万一用户正在里面改配置，
 * 被杀掉会丢东西，得让他自己决定。
 *
 * @returns true 表示可以继续安装（本来就关着，或者成功关掉了）
 */
async function ensureAppStopped(): Promise<{ ok: boolean; reason?: string; cancelled?: boolean }> {
  // 先枚举一次：既判断「在不在跑」，也顺便拿到待会儿要逐个结束的 PID
  const running = await appProcesses()
  if (running.length === 0) return { ok: true }

  const choice = await dialog.showMessageBox(win!, {
    type: 'question',
    buttons: ['自动关闭并继续', '我自己关', '取消安装'],
    defaultId: 0,
    cancelId: 2,
    title: '程序正在运行',
    message: `${meta.productName} 正在运行`,
    detail:
      `安装需要覆盖程序文件，但 ${meta.productName} 还在运行，文件被占用。\n\n` +
      '点「自动关闭并继续」会结束它的所有进程（包括托盘里的），' +
      '如果你正在里面做没保存的操作，请选「我自己关」。\n\n' +
      '关掉的只有主程序 —— 当前这个安装窗口会留着，装完可以直接启动新版本。',
    noLink: true
  })

  if (choice.response === 2) return { ok: false, cancelled: true }
  if (choice.response === 1) {
    /*
     * 让用户自己去关，这边**必须等**。
     *
     * 原先查一次就返回，用户还没离开对话框呢，必然判定「还开着」——
     * 等于这个按钮根本没用。现在最多等 20 秒，中途关掉就立刻继续。
     */
    for (let i = 0; i < 40; i++) {
      await new Promise((r) => setTimeout(r, 500))
      if (!(await quickIsRunning())) return { ok: true }
    }
    return {
      ok: false,
      reason: `等了 20 秒，${meta.productName} 还在运行（记得连托盘图标一起退出），关掉后再点一次「安装」就行。`
    }
  }

  /*
   * 自动关闭：按 PID 逐个结束，**不带 `/T`**。
   *
   * `/T` 会顺着进程树往下杀，而这个安装器正是 CV Studio 的子进程
   * （应用内更新时由主进程 spawn），带 `/T` 就是把自己一起杀掉 ——
   * 用户看到的现象是「点了自动关闭，安装窗口凭空消失」。
   *
   * 倒序（PID 从大到小）结束：子进程通常后启动、PID 更大，
   * 先收拾子进程再收拾父进程，避免父进程先死留下短暂孤儿。
   */
  const ordered = [...running].sort((a, b) => b.pid - a.pid)
  for (const p of ordered) await killProcess(p.pid)

  /*
   * taskkill 返回不代表进程已经退干净 —— Electron 的 GPU / 网络进程
   * 可能还在收尾。等最多 3 秒，每 300ms 查一次。
   */
  for (let i = 0; i < 10; i++) {
    if (!(await quickIsRunning())) return { ok: true }
    await new Promise((r) => setTimeout(r, 300))
  }

  return {
    ok: false,
    reason: `${meta.productName} 没能自动关闭。请手动结束它（任务管理器里搜「${meta.productName}」），再点重试。`
  }
}

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
    /*
     * 逐文件报错要给足上下文。
     *
     * ENOTDIR 的意思是「路径上某一段是文件，不是目录」——
     * 只说 ENOTDIR 完全不知道是哪一段。常见于上一次装到一半失败，
     * 目标里留了个同名文件挡在目录位置。
     */
    try {
      ensureDir(dirname(target))
      copyFileSync(abs, target)
    } catch (err) {
      const code = (err as NodeJS.ErrnoException).code ?? ''
      throw new Error(`复制 ${rel} 失败（${code}）→ ${target}`)
    }
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
    /*
     * 先确认上一版没在运行。
     *
     * 这是 Windows 上最常见的安装失败原因：exe 还在跑，文件被锁，
     * 改名 EBUSY、删除 EPERM。与其让用户对着一串错误码发呆，
     * 不如弹窗问一句「要不要帮你关掉」—— 同意就直接 taskkill。
     */
    const stopped = await ensureAppStopped()
    if (!stopped.ok) {
      /*
       * 用户点「取消安装」是主动放弃，不是错误 —— 界面那边看到
       * cancelled 就退回表单页，不弹红框。
       * 选了「我自己关」但程序还开着，才需要给提示。
       */
      return { ok: false, cancelled: stopped.cancelled, error: stopped.reason ?? '' }
    }

    send({ stage: '准备中', percent: 0, current: '', done: 0, total: 0, bytesDone: 0, bytesTotal: 0 })

    /*
     * 先解到**旁边的临时目录**，全部成功后再整体替换。
     *
     * 为什么不直接往目标目录里写：
     * 上一次装一半失败会留下残缺的文件树，其中某个文件名正好占着
     * 这次要建的目录位置，`mkdirSync` 就抛 ENOTDIR（用户实测碰到过）。
     * 逐段检查太脆弱，不如换个顺序 —— 新内容先完整落在干净目录里，
     * 最后一步才动目标，要么完整替换要么原样不动。
     */
    const stamp = Date.now()
    const stage1 = `${dest}.new-${stamp}`
    const old1 = `${dest}.old-${stamp}`
    rmSync(stage1, { recursive: true, force: true })
    mkdirSync(stage1, { recursive: true })

    await installFromDirectory(src, stage1, send)

    // ---- 整体替换 ----
    send({ stage: '替换旧版本', percent: 100, current: dest, done: 0, total: 0, bytesDone: 0, bytesTotal: 0 })

    if (existsSync(dest)) {
      rmSync(old1, { recursive: true, force: true })

      /*
       * 旧目录可能**正被占用**（用户还开着上一版 CV Studio）。
       * Windows 上被占用的目录改名会 EBUSY、删除会 EPERM。
       *
       * 策略：
       *   1) 先试着改名挪走 —— 最快，且能保证「要么全换要么不动」
       *   2) 改名失败就逐项删（删不掉的跳过，最后再覆盖写）
       *   3) 都不行就明确告诉用户「请先关掉正在运行的程序」
       */
      let movedAway = false
      try {
        renameSync(dest, old1)
        movedAway = true
      } catch {
        // 挪不走，退而求其次：清空能删的
        try {
          for (const name of readdirSync(dest)) {
            try {
              rmSync(join(dest, name), { recursive: true, force: true })
            } catch {
              /* 删不掉的（多半是正在运行的 exe）留着，后面覆盖写 */
            }
          }
        } catch {
          /* 连列目录都不行 */
        }
      }

      if (movedAway) {
        renameSync(stage1, dest)
        rmSync(old1, { recursive: true, force: true })
      } else {
        /*
         * 没法整体替换：把新文件逐个覆盖进去。
         * 删不掉的老文件留在那儿 —— 覆盖写会把同名文件替换掉，
         * 真正棘手的是「正在运行的 exe」本身，那一步会抛错。
         */
        copyTreeOverwrite(stage1, dest)
        rmSync(stage1, { recursive: true, force: true })
      }
    } else {
      mkdirSync(dirname(dest), { recursive: true })
      renameSync(stage1, dest)
    }


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

ipcMain.handle('installer:launch', async (_e, exe: string) => {
  /*
   * 用 spawn 直接起进程，不用 shell.openPath。
   *
   * 踩过：`shell.openPath(exe)` 后面紧跟 `app.quit()` —— openPath 是异步的，
   * 安装器进程先退出了，子进程还没来得及真正启动，表现就是「点立即运行没反应」。
   *
   * 用 `spawn(detached, unref)` 让新进程完全独立于安装器：
   * 安装器退出不会带走它。
   */
  try {
    const child = spawn(exe, [], {
      detached: true,
      stdio: 'ignore',
      windowsHide: false
    })
    child.unref()
  } catch (err) {
    // 直接启动失败时退回 openPath（它会走系统默认关联）
    console.error('[installer] spawn 失败，改用 shell.openPath：', err)
    await shell.openPath(exe)
  }
  // 给新进程一点启动时间，再关掉安装器
  setTimeout(() => app.quit(), 800)
})
ipcMain.handle('installer:quit', () => app.quit())
/** 自绘标题栏没有系统按钮，最小化要自己接 */
ipcMain.handle('installer:minimize', () => win?.minimize())

// --------------------------------------------------------------------------

function createWindow(): void {
  win = new BrowserWindow({
    /*
     * 近正方形，对应界面的「一列居中」构图：
     * 标志、字标、一行说明、黑色按钮，上下各留一大块白。
     * 加宽只会让两侧多出空白，没有意义。
     */
    width: 560,
    height: 600,
    resizable: false,
    maximizable: false,
    /*
     * 无边框 + 自绘标题栏。
     *
     * 用系统标题栏的话，浅色界面顶上会多一条深色条，和下面的内容割裂；
     * 而且窗口本身固定大小，系统那三个按钮也没什么用。
     * 自绘之后整个窗口是一体的，右上角只留两个极轻的灰图标。
     */
    frame: false,
    titleBarStyle: 'hidden',
    title: `${meta.productName} 安装程序`,
    backgroundColor: '#ffffff',
    // 图标和 main.js 同级（asar 内 app/ 目录），不是 getAppPath 那一层
    icon: join(__dirname, 'icon.png'),
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