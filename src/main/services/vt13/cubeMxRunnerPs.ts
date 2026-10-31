/**
 * CubeMX 无界面调用的 PowerShell 实现。
 *
 * ## 为什么用 PowerShell 而不是 Node 直接 spawn
 *
 * 实测了 6 种方式，**只有这一种能稳定工作**：
 *
 * | 方式 | 结果 |
 * |---|---|
 * | `spawn` + stdio:pipe | 挂死 —— CubeMX 输出量大，管道 4KB 写满就阻塞 |
 * | `spawn` + stdio:文件 | launcher 25ms 退出，什么都没生成 |
 * | `Start-Process` 不等待 | 卡在弹窗上不往下走 |
 * | `Start-Process -Wait` | 起来了但窗口是「Untitled」，脚本没加载 |
 * | .NET `ProcessStartInfo` + 重定向 | 又挂死 |
 * | **`cmd /c "exe -q script > log 2>&1"` + 轮询** | **✓ 34 秒稳定生成** |
 *
 * ## 三个关键点
 *
 * ### ① 绝不等 `STM32CubeMX.exe` 退出
 *
 * 它是 **launcher**，把活交给 detached 的 `javaw.exe` 之后自己就死了（25ms）。
 * 等它 = 等到一个什么都没干的空壳。正确做法是**轮询 javaw 存活 + 检查日志**。
 *
 * ### ② 弹窗枚举不加 `IsWindowVisible`
 *
 * 这是最隐蔽的坑：**弹窗在后台时 `IsWindowVisible` 返回 False**。
 * 加了这层过滤，守卫就"看不见"弹窗，于是永远等在那里直到超时。
 *
 * ### ③ 脚本文件本身也不能带 BOM
 *
 * CubeMX 把 BOM 当成命令的一部分，首行 `config load ...` 直接失效 ——
 * 表现为窗口标题是「Untitled」、什么都不生成。
 */

/** PowerShell 脚本模板。用占位符替换，避免字符串拼接出错 */
const PS_TEMPLATE = String.raw`
param(
    [string]$IocPath,
    [string]$CubeMxExe,
    [string]$ScriptFile,
    [string]$LogFile,
    [int]$TimeoutSec
)
$ErrorActionPreference = "Stop"
$root = Split-Path $IocPath -Parent

# ---- 1. 清理残留实例（单实例陷阱）----
Get-Process javaw, STM32CubeMX -ErrorAction SilentlyContinue |
    Stop-Process -Force -ErrorAction SilentlyContinue
Start-Sleep -Milliseconds 900
if (Get-Process javaw -ErrorAction SilentlyContinue) {
    Write-Output "RESULT|FAIL|无法清理残留的 CubeMX 进程"
    exit 2
}

# ---- 2. 写脚本（正斜杠 + 无 BOM）----
$iocFwd = $IocPath -replace '\\', '/'
$nl = [string][char]13 + [string][char]10
$body = (@("config load $iocFwd", "project generate", "exit") -join $nl) + $nl
[System.IO.File]::WriteAllText($ScriptFile, $body, (New-Object Text.UTF8Encoding $false))

# ---- 3. 弹窗枚举类型 ----
if (-not ("CMXDlg" -as [type])) {
Add-Type @'
using System; using System.Text; using System.Runtime.InteropServices;
public class CMXDlg {
    public delegate bool CB(IntPtr h, IntPtr l);
    [DllImport("user32.dll")] public static extern bool EnumWindows(CB cb, IntPtr l);
    [DllImport("user32.dll")] public static extern int GetClassName(IntPtr h, StringBuilder s, int n);
    [DllImport("user32.dll")] public static extern int GetWindowText(IntPtr h, StringBuilder s, int n);
    [DllImport("user32.dll")] public static extern bool SetForegroundWindow(IntPtr h);
    [DllImport("user32.dll")] public static extern IntPtr PostMessage(IntPtr h, uint m, IntPtr w, IntPtr l);
}
'@
}
function Get-Dialogs {
    $script:dlgAcc = New-Object System.Collections.ArrayList
    $cb = [CMXDlg+CB]{
        param($h, $l)
        $c = New-Object Text.StringBuilder 128
        [CMXDlg]::GetClassName($h, $c, 128) | Out-Null
        if ($c.ToString() -like '*SunAwtDialog*') {
            $t = New-Object Text.StringBuilder 512
            [CMXDlg]::GetWindowText($h, $t, 512) | Out-Null
            # 空标题是 AWT 内部辅助窗口，不是真弹窗
            if ($t.Length -gt 0) {
                $null = $script:dlgAcc.Add([PSCustomObject]@{H=$h; T=$t.ToString()})
            }
        }
        # 注意：不判断 IsWindowVisible —— 后台弹窗会返回 False，导致漏判
        return $true
    }
    [CMXDlg]::EnumWindows($cb, [IntPtr]::Zero) | Out-Null
    return $script:dlgAcc
}

# ---- 4. cmd 文件重定向启动（避开管道阻塞）----
Remove-Item $LogFile -ErrorAction SilentlyContinue
$cmdArgs = '/c ""{0}" -q "{1}" > "{2}" 2>&1"' -f $CubeMxExe, $ScriptFile, $LogFile
Start-Process -FilePath "cmd.exe" -ArgumentList $cmdArgs -WindowStyle Hidden | Out-Null

# ---- 5. 轮询日志与进程，同时守卫弹窗 ----
$dismissed = New-Object System.Collections.ArrayList
$sw = [Diagnostics.Stopwatch]::StartNew()
$done = $false
while ($true) {
    if ($sw.Elapsed.TotalSeconds -gt $TimeoutSec) {
        Get-Process javaw -ErrorAction SilentlyContinue | Stop-Process -Force
        Write-Output ("RESULT|FAIL|CubeMX " + $TimeoutSec + " 秒未完成，已终止")
        exit 3
    }
    if (Test-Path $LogFile) {
        try {
            if ((Get-Content $LogFile -Raw -ErrorAction SilentlyContinue) -match 'Bye bye') { $done = $true; break }
        } catch { }
    }
    if (-not (Get-Process javaw -ErrorAction SilentlyContinue)) {
        Start-Sleep -Milliseconds 1500
        try {
            if ((Get-Content $LogFile -Raw -ErrorAction SilentlyContinue) -match 'Bye bye') { $done = $true; break }
        } catch { }
        if (-not (Get-Process javaw -ErrorAction SilentlyContinue)) {
            Write-Output "RESULT|FAIL|CubeMX 未完成就退出了"
            exit 4
        }
    }
    foreach ($d in (Get-Dialogs)) {
        if ($dismissed -contains $d.T) { continue }
        [CMXDlg]::SetForegroundWindow($d.H) | Out-Null
        Start-Sleep -Milliseconds 400
        [CMXDlg]::PostMessage($d.H, 0x100, [IntPtr]0x0D, [IntPtr]0x001C0001) | Out-Null
        Start-Sleep -Milliseconds 150
        [CMXDlg]::PostMessage($d.H, 0x101, [IntPtr]0x0D, [IntPtr]0xC01C0001) | Out-Null
        $null = $dismissed.Add($d.T)
        Write-Output ("DISMISSED|" + $d.T)
    }
    Start-Sleep -Milliseconds 600
}

# ---- 6. 等 javaw 收尾 ----
for ($i=0; $i -lt 20; $i++) {
    if (-not (Get-Process javaw -ErrorAction SilentlyContinue)) { break }
    Start-Sleep -Milliseconds 400
}
Start-Sleep -Milliseconds 600

Write-Output ("RESULT|OK|" + [int]$sw.Elapsed.TotalSeconds)
exit 0
`

export interface CubeMxPsOptions {
  cubeMxExe: string
  iocPath: string
  scriptFile: string
  logFile: string
  timeoutSec: number
}

/** 生成完整的 PowerShell 脚本内容 */
export function buildRunCubeMxPs(opts: CubeMxPsOptions): string {
  const q = (s: string): string => `'${s.replace(/'/g, "''")}'`
  return [
    `$IocPathArg = ${q(opts.iocPath)}`,
    `$CubeMxExeArg = ${q(opts.cubeMxExe)}`,
    `$ScriptFileArg = ${q(opts.scriptFile)}`,
    `$LogFileArg = ${q(opts.logFile)}`,
    `$TimeoutSecArg = ${opts.timeoutSec}`,
    '',
    // 模板里用 $IocPath 等参数名，这里转成同名变量
    '$IocPath = $IocPathArg',
    '$CubeMxExe = $CubeMxExeArg',
    '$ScriptFile = $ScriptFileArg',
    '$LogFile = $LogFileArg',
    '$TimeoutSec = $TimeoutSecArg',
    PS_TEMPLATE.trim()
  ].join('\n')
}