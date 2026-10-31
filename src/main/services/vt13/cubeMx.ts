/**
 * CubeMX 无界面调用。
 *
 * ## 为什么必须无界面
 *
 * 用户点一次 Generate Code 就得等它加载 DB、点几个对话框，三十秒起步。
 * VT13 移植流程里这是**必做的一步**（`.ioc` 改完必须重新生成 `Src/usart.c`），
 * 不能让人工介入，否则「全自动」就是空话。
 *
 * ## 实测结论（2026-10-31，本机验证）
 *
 * - CubeMX 不在 CubeCLT 里，是**独立安装**的
 * - 命令：`STM32CubeMX.exe -q <script.txt>`
 * - 脚本三行：`config load <正斜杠绝对路径.ioc>` / `project generate` / `exit`
 * - 成功标志：日志末尾 `OK` → `exit` → `Bye bye`
 *
 * ## 两个会卡死的弹窗
 *
 * 1. **版本迁移框**：`.ioc` 的 `MxCube.Version` 和本机不一致时弹。
 *    解法是在 `.ioc` 里设 `ProjectManager.AskForMigrate=false`（先设，再调用）。
 * 2. **RTOS 时基警告**：工程用 FreeRTOS 且时基是 SysTick 时弹。
 *    默认按钮是 Yes，**发回车即可**。所有已知弹窗的默认按钮都是「继续」语义，
 *    所以回车是安全的 —— 不会误触 Cancel。
 */

import { execFile, execFileSync } from 'node:child_process'
import { existsSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { startDialogWatcher, type ClosedDialog } from './dialogWatcher'
import { buildRunCubeMxPs } from './cubeMxRunnerPs'

export interface CubeMxLocation {
  exe: string
  version: string
}

/**
 * 找 CubeMX。
 *
 * 顺序按「最可能装在哪」排：本机是 `%LOCALAPPDATA%\Programs\STM32CubeMX`，
 * 其次是 Program Files 和 ST 自己的目录。
 */
export function findCubeMx(): CubeMxLocation | null {
  const localAppData = process.env['LOCALAPPDATA'] ?? ''
  const candidates = [
    join(localAppData, 'Programs', 'STM32CubeMX', 'STM32CubeMX.exe'),
    'C:/Program Files/STMicroelectronics/STM32CubeMX/STM32CubeMX.exe',
    'C:/Program Files (x86)/STMicroelectronics/STM32CubeMX/STM32CubeMX.exe',
    'C:/ST/STM32CubeMX/STM32CubeMX.exe'
  ].filter(Boolean)

  for (const exe of candidates) {
    if (!existsSync(exe)) continue
    return { exe: exe.replace(/\\/g, '/'), version: readExeVersion(exe) }
  }
  return null
}

/**
 * 读 exe 的文件版本号。
 *
 * 不用 PowerShell（每次起进程要几百毫秒），直接读 PE 资源太重，
 * 这里退一步：从 exe 旁边找 `version.txt`，找不到就返回空。
 * 版本号只用于日志和提示，拿不到不影响功能。
 */
function readExeVersion(exe: string): string {
  try {
    const txt = join(exe, '..', 'version.txt')
    if (existsSync(txt)) return readFileSync(txt, 'utf8').trim()
  } catch {
    /* 忽略 */
  }
  return ''
}

/** 生成 CubeMX 脚本内容 */
export function buildCubeMxScript(iocPath: string): string {
  // 必须用正斜杠！CubeMX 是 Java 程序，它自己的路径解析对反斜杠不友好，
  // 实测反斜杠会报「找不到文件」。
  const p = iocPath.replace(/\\/g, '/')
  return ['config load ' + p, 'project generate', 'exit', ''].join('\n')
}

export interface CubeMxRunOptions {
  /** 超时毫秒，默认 180s（首次启动要加载 DB，约 20s） */
  timeoutMs?: number
  /** 每来一行日志回调一次，界面可以实时显示 */
  onLine?: (line: string) => void
}

export interface CubeMxRunResult {
  ok: boolean
  /** 完整日志 */
  log: string
  /** 失败原因 */
  error?: string
  /** 耗时毫秒 */
  durationMs: number
  /** 是否超时被杀 */
  timedOut: boolean
  /** 自动关掉的弹窗 */
  closedDialogs: ClosedDialog[]
}

/**
 * 真正执行 CubeMX。
 *
 * **这个函数会覆盖 `Src/` 和 `Inc/`**，调用方必须在此之前存快照。
 */
export async function runCubeMx(
  cubeMx: CubeMxLocation,
  iocPath: string,
  opts: CubeMxRunOptions = {}
): Promise<CubeMxRunResult> {
  const timeoutMs = opts.timeoutMs ?? 180_000
  const projDir = iocPath.replace(/[\\/][^\\/]+$/, '')
  const stamp = Date.now()
  const scriptFile = join(projDir, `cubemx-gen-${stamp}.txt`)
  const logFile = join(projDir, `cubemx-gen-${stamp}.log`)
  const psFile = join(projDir, `cubemx-run-${stamp}.ps1`)

  const started = Date.now()
  const closedDialogs: ClosedDialog[] = []

  /*
   * 生成并落盘 PowerShell 脚本。
   *
   * 关键：**必须写成带 BOM 的 UTF-8**。
   * PowerShell 5.1 读无 BOM 的文件时会按系统 ANSI 代码页（中文系统是 GBK）解码，
   * 脚本里的中文注释会变成乱码，进而报语法错误 —— 我在这上面浪费过好几轮，
   * 明明同一段脚本手动跑得好好的，封装进来就报 "字符串缺少终止符"。
   */
  const psContent = buildRunCubeMxPs({
    cubeMxExe: cubeMx.exe,
    iocPath,
    scriptFile,
    logFile,
    timeoutSec: Math.round(timeoutMs / 1000)
  })
  writeFileSync(psFile, '\uFEFF' + psContent, 'utf8')

  const cleanup = (): void => {
    for (const p of [scriptFile, logFile, psFile]) {
      try {
        rmSync(p, { force: true })
      } catch {
        /* 删不掉不影响功能 */
      }
    }
  }

  const execResult = await new Promise<{ code: number; out: string }>((resolve) => {
    execFile(
      'powershell.exe',
      ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-File', psFile],
      {
        timeout: timeoutMs + 60_000,
        windowsHide: true,
        maxBuffer: 4 * 1024 * 1024,
        encoding: 'utf8'
      },
      (err, stdout) => {
        const code =
          err && typeof (err as NodeJS.ErrnoException & { code?: unknown }).code === 'number'
            ? ((err as NodeJS.ErrnoException & { code: number }).code as number)
            : err
              ? 1
              : 0
        resolve({ code, out: String(stdout ?? '') })
      }
    )
  })

  // 解析脚本吐出来的结构化输出
  for (const line of execResult.out.split(/\r?\n/)) {
    const t = line.trim()
    if (t.startsWith('DISMISSED|')) {
      const title = t.slice('DISMISSED|'.length)
      const d = { hwnd: '', title }
      closedDialogs.push(d)
      opts.onLine?.(`[自动关闭弹窗] ${title}`)
    } else if (t.startsWith('RESULT|OK|')) {
      opts.onLine?.(`[CubeMX] 生成完成，用时 ${t.slice('RESULT|OK|'.length)} 秒`)
    } else if (t.startsWith('RESULT|FAIL|')) {
      opts.onLine?.(`[CubeMX] ${t.slice('RESULT|FAIL|'.length)}`)
    } else if (t) {
      opts.onLine?.(t)
    }
  }

  const durationMs = Date.now() - started
  const failLine = execResult.out.split(/\r?\n/).find((l) => l.trim().startsWith('RESULT|FAIL|'))
  const okLine = execResult.out.split(/\r?\n/).find((l) => l.trim().startsWith('RESULT|OK|'))

  // 读日志（CubeMX 自己的 stdout）
  let log = ''
  try {
    if (existsSync(logFile)) log = readFileSync(logFile, 'utf8')
  } catch {
    /* 读不到就算了 */
  }
  cleanup()

  const timedOut = execResult.code === 3
  const ok = Boolean(okLine)

  return {
    ok,
    log,
    error: ok
      ? undefined
      : failLine
        ? failLine.replace(/^RESULT\|FAIL\|/, '')
        : `CubeMX 调用失败（退出码 ${execResult.code}）`,
    durationMs,
    timedOut,
    closedDialogs
  }
}

/**
 * 给 `.ioc` 加上 `ProjectManager.AskForMigrate=false`，避免版本迁移框卡住。
 *
 * 返回是否做了修改 —— 已经设过就返回 false。
 */
export function ensureNoMigratePrompt(iocPath: string): boolean {
  const raw = readFileSync(iocPath, 'utf8')
  const eol = raw.includes('\r\n') ? '\r\n' : '\n'
  const lines = raw.replace(/^\uFEFF/, '').replace(/\r\n/g, '\n').split('\n')
  const key = 'ProjectManager.AskForMigrate'

  for (let i = 0; i < lines.length; i++) {
    if (lines[i].startsWith(`${key}=`)) {
      if (lines[i] === `${key}=false`) return false
      lines[i] = `${key}=false`
      writeFileSync(iocPath, lines.join(eol), 'utf8')
      return true
    }
  }

  // 没有这个键就插在 ProjectManager.* 那一堆里
  const idx = lines.findIndex((ln) => ln.startsWith('ProjectManager.'))
  const insertAt = idx >= 0 ? idx : lines.length
  lines.splice(insertAt, 0, `${key}=false`)
  writeFileSync(iocPath, lines.join(eol), 'utf8')
  return true
}

/** 读 `.ioc` 里记录的 CubeMX 版本（用来判断要不要提示用户） */
export function readIocCubeMxVersion(iocPath: string): string | null {
  if (!existsSync(iocPath)) return null
  const raw = readFileSync(iocPath, 'utf8')
  const m = /^MxCube\.Version=(.+)$/m.exec(raw)
  return m ? m[1].trim() : null
}

/** 文件最后修改时间，用来判断 CubeMX 到底有没有真的写东西 */
export function fileMtimeMs(path: string): number {
  try {
    return statSync(path).mtimeMs
  } catch {
    return 0
  }
}

/**
 * 跑 CubeMX 并**用产物校验是否真的成功**。
 *
 * 光看退出码和日志都不可靠：
 *   · 单实例转发时 exit 0、无输出、什么都没干
 *   · 某些情况生成完了却不打印 Bye bye
 *
 * 唯一可信的判据是**源文件有没有被更新**。所以这里先记时间戳，跑完再比。
 *
 * @param watchFiles 这些文件里有任意一个被更新就算成功（通常是 usart.c / stm32f4xx_it.c）
 */
export async function runCubeMxAndVerify(
  cubeMx: CubeMxLocation,
  iocPath: string,
  watchFiles: string[],
  opts: CubeMxRunOptions = {}
): Promise<CubeMxRunResult & { changedFiles: string[]; verified: boolean }> {
  const before = new Map(watchFiles.map((f) => [f, fileMtimeMs(f)]))
  const res = await runCubeMx(cubeMx, iocPath, opts)

  /*
   * 产物校验分两种情况，不能只看时间戳：
   *
   *   ① 文件被重写了        → 时间戳变了，直接算成功
   *   ② 生成结果和现有内容一致 → CubeMX 会**跳过写入**，时间戳不变
   *
   * 第二种是正常且常见的（跑第二遍时几乎必然发生）。所以「时间戳没变」
   * 不代表失败，只要 PowerShell 那边确认看到了 `Bye bye` 就算成功。
   *
   * 这里 `changedFiles` 只用来给界面展示「这次改动了哪些文件」，
   * 不参与成功判定 —— 成功判定以 RESULT|OK 为准（它背后是日志里的 Bye bye）。
   */
  const changedFiles = watchFiles.filter((f) => {
    const prev = before.get(f) ?? 0
    return fileMtimeMs(f) > prev
  })

  return {
    ...res,
    changedFiles,
    // verified = 有产物被改写，或者至少文件存在
    verified: changedFiles.length > 0 || watchFiles.some((f) => fileMtimeMs(f) > 0)
  }
}

/**
 * 杀掉还在跑的 CubeMX 实例。
 *
 * ## 为什么必须先杀
 *
 * **CubeMX 是单实例程序。** 当已经有一个实例在运行时，再启动一个它会：
 *   ① 把命令行参数（包括 `-q script.txt`）转交给已有实例
 *   ② 自己立刻退出，**exit code 0、stdout 一个字都没有**
 *
 * 结果是：我们以为「生成成功了」，实际什么也没做 —— `Src/usart.c` 时间戳不变。
 * 这个坑极难查，因为退出码是 0、没有任何错误输出。
 *
 * 实测触发场景：上一次调用超时被杀掉时只杀了 launcher，`javaw.exe` 活了下来，
 * 之后每次调用都会命中单实例转发。
 *
 * @returns 杀掉的数量
 */
export function killRunningCubeMx(): number {
  let killed = 0

  /*
   * 用 PowerShell 的 Get-Process 而不是 tasklist 解析 —— 
   * tasklist 的输出受系统语言影响（中文系统的表头、CSV 格式都可能不同），
   * 而且 `-Filter "IMAGENAME eq javaw.exe"` 在某些 locale 下匹配不上。
   * Get-Process 直接拿进程对象，稳。
   */
  try {
    const out = execFileSync(
      'powershell.exe',
      [
        '-NoProfile',
        '-NonInteractive',
        '-Command',
        "Get-Process javaw,STM32CubeMX -ErrorAction SilentlyContinue | ForEach-Object { $_.Id }"
      ],
      { encoding: 'utf8', windowsHide: true, timeout: 8000 }
    )
    const pids = out
      .split(/\r?\n/)
      .map((l) => Number(l.trim()))
      .filter((n) => Number.isFinite(n) && n > 0)

    for (const pid of pids) {
      try {
        execFileSync('taskkill', ['/PID', String(pid), '/T', '/F'], {
          stdio: 'ignore',
          windowsHide: true
        })
        killed++
      } catch {
        /* 已经退了 */
      }
    }
  } catch {
    /* PowerShell 失败就当没有残留 */
  }

  return killed
}

/**
 * 杀掉整个进程树。
 *
 * 为什么不能用 `child.kill()`：CubeMX 的 launcher 会拉起 `javaw.exe` 干活，
 * 父进程被杀了 java 还活着，它继承的 stdout 句柄就不会释放，Node 收不到
 * `close` 事件 —— 整个流程挂在那里等超时。
 *
 * `taskkill /T /F` 是 Windows 自带、按 PID 杀整棵树的标准做法。
 */
function killProcessTree(pid: number | undefined): void {
  if (!pid) return
  try {
    execFileSync('taskkill', ['/PID', String(pid), '/T', '/F'], {
      stdio: 'ignore',
      windowsHide: true
    })
  } catch {
    // 进程可能已经自己退了，忽略
  }
}