/**
 * CubeMX 弹窗自动关闭（Windows 专用）。
 *
 * ## 为什么必须做这件事
 *
 * CubeMX 是 Java 程序，遇到「RTOS 时基警告」这类对话框会**一直等用户点击**。
 * 无界面模式下没人点，进程就永远不退出 —— 实测会挂满 180 秒超时。
 *
 * ## 怎么关
 *
 * 1. 用 Win32 `EnumWindows` 枚举所有顶层窗口
 * 2. 只看类名是 `SunAwtDialog` 的（Java AWT 的对话框类名）
 * 3. 核对窗口属于目标进程（`GetWindowThreadProcessId`）
 * 4. 发 `WM_KEYDOWN` + `WM_KEYUP` 的 `VK_RETURN`
 *
 * ## 为什么发回车是安全的
 *
 * 已知的两个弹窗（版本迁移、RTOS 时基）**默认按钮都是「继续」语义**
 * （Continue / Yes），回车等于点它。实测：回车后日志继续输出直到 `Bye bye`。
 *
 * 用 `PostMessage` 而不是 `SendKeys`：不会被输入法/焦点影响，也不需要窗口前置。
 */

import { execFile, execFileSync } from 'node:child_process'

/** 一个被关掉的弹窗 */export interface ClosedDialog {
  title: string
  hwnd: string
}

/**
 * PowerShell 脚本：枚举某个进程的 SunAwtDialog 并发回车。
 *
 * 为什么用 PowerShell 而不是 Node 原生：调 Win32 API 要么写 N-API 原生模块
 * （要编译、要分发），要么用 ffi（依赖重）。PowerShell 内嵌 C# 是零依赖方案，
 * 每次调用约 100ms —— 监控循环是 1 秒一次，完全可以接受。
 */
function buildPsScript(pid: number): string {
  return `
Add-Type @"
using System;
using System.Collections.Generic;
using System.Runtime.InteropServices;
using System.Text;
public class DlgProbe {
  [DllImport("user32.dll")] public static extern bool EnumWindows(EnumWindowsProc cb, IntPtr lParam);
  [DllImport("user32.dll")] public static extern bool IsWindowVisible(IntPtr hWnd);
  [DllImport("user32.dll", CharSet=CharSet.Unicode)] public static extern int GetClassNameW(IntPtr hWnd, StringBuilder sb, int max);
  [DllImport("user32.dll", CharSet=CharSet.Unicode)] public static extern int GetWindowTextW(IntPtr hWnd, StringBuilder sb, int max);
  [DllImport("user32.dll")] public static extern uint GetWindowThreadProcessId(IntPtr hWnd, out uint pid);
  [DllImport("user32.dll")] public static extern bool PostMessageW(IntPtr hWnd, uint msg, IntPtr wParam, IntPtr lParam);
  public delegate bool EnumWindowsProc(IntPtr hWnd, IntPtr lParam);

  public static List<string> FindAndPress(int targetPid) {
    var found = new List<string>();
    EnumWindows((h, l) => {
      var cls = new StringBuilder(256);
      GetClassNameW(h, cls, 256);
      if (!cls.ToString().Contains("SunAwtDialog")) return true;
      uint pid; GetWindowThreadProcessId(h, out pid);
      if (pid != (uint)targetPid) return true;
      var title = new StringBuilder(512);
      GetWindowTextW(h, title, 512);
      // 空的标题通常是 AWT 内部的辅助窗口，不是真弹窗
      if (title.Length == 0) return true;
      // WM_KEYDOWN / WM_KEYUP + VK_RETURN = 回车 = 默认按钮
      PostMessageW(h, 0x0100, (IntPtr)0x0D, (IntPtr)0x001C0001);
      System.Threading.Thread.Sleep(120);
      PostMessageW(h, 0x0101, (IntPtr)0x0D, (IntPtr)0xC01C0001);
      found.Add(h.ToString() + "|" + title.ToString());
      return true;
    }, IntPtr.Zero);
    return found;
  }
}
"@
try {
  $r = [DlgProbe]::FindAndPress(${pid})
  if ($r.Count -gt 0) { $r | ForEach-Object { Write-Output $_ } }
} catch { }
`
}

/**
 * 找到 CubeMX 真正的 Java 进程 pid。
 *
 * ## 为什么不能直接用 spawn 返回的 pid
 *
 * `STM32CubeMX.exe` 只是个 launcher，它拉起 `javaw.exe` 干活，然后自己退出。
 * 弹窗属于 **javaw**，用 launcher 的 pid 去枚举窗口永远是空。
 *
 * 实测踩过这个坑：弹窗监控代码本身是对的（手动传 javaw 的 pid 能关掉），
 * 但从 runCubeMx 里传 launcher pid，就一个都关不掉。
 *
 * @returns javaw 的 pid 列表
 */
export function findCubeMxJavaPids(): number[] {
  try {
    const out = execFileSync(
      'powershell.exe',
      [
        '-NoProfile',
        '-NonInteractive',
        '-Command',
        '(Get-Process javaw -ErrorAction SilentlyContinue).Id'
      ],
      { encoding: 'utf8', windowsHide: true, timeout: 8000 }
    )
    return out
      .split(/\r?\n/)
      .map((l) => Number(l.trim()))
      .filter((n) => Number.isFinite(n) && n > 0)
  } catch {
    return []
  }
}

/**
 * 扫描一次并关掉所有属于该进程的 Java 对话框。
 *
 * @returns 这一轮关掉的弹窗列表（空数组表示没有弹窗）
 */
export function closeCubeMxDialogs(pid: number): Promise<ClosedDialog[]> {
  return new Promise((resolve) => {
    execFile(
      'powershell.exe',
      ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-Command', buildPsScript(pid)],
      { timeout: 8000, windowsHide: true },
      (err, stdout) => {
        if (err || !stdout) {
          resolve([])
          return
        }
        const out = stdout
          .split(/\r?\n/)
          .map((l) => l.trim())
          .filter((l) => l.includes('|'))
          .map((l) => {
            const [hwnd, title] = l.split('|')
            return { hwnd, title: title || '(无标题)' }
          })
        resolve(out)
      }
    )
  })
}

export interface DialogWatcher {
  /** 累计关掉的弹窗 */
  closed: ClosedDialog[]
  /** 停止监控 */
  stop: () => void
}

/**
 * 启动一个后台监控，每隔 intervalMs 扫一次。
 *
 * **每一轮都重新查找 javaw 的 pid**，而不是固定用启动时拿到的那个 ——
 * CubeMX 的 javaw 可能晚几百毫秒才起来，也可能中途重启。
 *
 * 返回的 `closed` 数组是**同一个引用**，调用方可以随时读它的长度显示进度。
 */
export function startDialogWatcher(
  opts: { intervalMs?: number; onClosed?: (d: ClosedDialog) => void } = {}
): DialogWatcher {
  const intervalMs = opts.intervalMs ?? 1000
  const closed: ClosedDialog[] = []
  const seenHwnd = new Set<string>()
  let stopped = false

  const tick = async (): Promise<void> => {
    if (stopped) return
    const pids = findCubeMxJavaPids()
    for (const pid of pids) {
      const found = await closeCubeMxDialogs(pid)
      for (const d of found) {
        // 同一个弹窗不要重复记（PostMessage 之后窗口可能还在关闭动画里）
        if (seenHwnd.has(d.hwnd)) continue
        seenHwnd.add(d.hwnd)
        closed.push(d)
        opts.onClosed?.(d)
      }
    }
    if (!stopped) setTimeout(() => void tick(), intervalMs)
  }
  void tick()

  return {
    closed,
    stop: () => {
      stopped = true
    }
  }
}