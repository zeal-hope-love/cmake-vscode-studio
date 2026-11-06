<#
.SYNOPSIS
    诊断并修复「写入全部 EPERM」问题 —— 目录/文件被标成低完整性级别（Low IL）。

.DESCRIPTION
    Windows 的规则：从一个被标记为低完整性的可执行文件启动的进程，自身也会被降为
    低完整性进程。低完整性进程默认禁止向上写（deny write-up），因此写 Desktop、
    %APPDATA%、Program Files 等普通位置全部返回 ERROR_ACCESS_DENIED，
    Node.js 把它映射成 EPERM。

    这个脚本检查工程目录和 Electron 主进程的完整性级别，-Fix 时改回 Medium。

.PARAMETER Path
    要检查的目录，默认是本脚本所在仓库的根目录。

.PARAMETER Fix
    发现问题时直接修复（icacls /setintegritylevel (OI)(CI)Medium）。

.EXAMPLE
    .\tools\check-integrity.ps1
    .\tools\check-integrity.ps1 -Fix

.NOTES
    判据：icacls 输出里的 "Mandatory Label" 一行。
      Low Mandatory Level    → 有问题
      Medium Mandatory Level → 正常
    注意 Get-Acl 看不到完整性标签，只能用 icacls 或读 SACL。
#>
[CmdletBinding()]
param(
    [string]$Path = (Split-Path -Parent $PSScriptRoot),
    [switch]$Fix
)

$ErrorActionPreference = 'Stop'
$OutputEncoding = [System.Text.Encoding]::UTF8

function Get-MandatoryLabel {
    param([string]$Target)
    if (-not (Test-Path -LiteralPath $Target)) { return '<不存在>' }
    $line = icacls $Target 2>&1 | Select-String -Pattern 'Mandatory Label' | Select-Object -First 1
    if (-not $line) { return '<无标签>' }
    $text = $line.Line.Trim()
    if ($text -match 'Low Mandatory Level') { return 'Low' }
    if ($text -match 'Medium Mandatory Level') { return 'Medium' }
    if ($text -match 'High Mandatory Level') { return 'High' }
    if ($text -match 'System Mandatory Level') { return 'System' }
    return $text
}

Write-Host ''
Write-Host '=== 完整性级别诊断 ===' -ForegroundColor Cyan
Write-Host ("工程目录: " + $Path)

$dirLabel = Get-MandatoryLabel $Path
$electron = Join-Path $Path 'node_modules\electron\dist\electron.exe'
$exeLabel = Get-MandatoryLabel $electron

Write-Host ''
Write-Host ("  {0,-46} {1}" -f '工程目录', $dirLabel) -ForegroundColor $(if ($dirLabel -eq 'Low') { 'Red' } else { 'Green' })
Write-Host ("  {0,-46} {1}" -f 'node_modules\electron\dist\electron.exe', $exeLabel) -ForegroundColor $(if ($exeLabel -eq 'Low') { 'Red' } else { 'Green' })

# 附带检查：沙箱常会一起加的拒绝删除 ACE，它会让 electron-builder 清理旧产物失败
$denyAce = icacls $Path 2>&1 | Select-String -Pattern 'Everyone:.*\(DENY\)'
Write-Host ''
if ($denyAce) {
    Write-Host '  发现 Everyone 的 DENY ACE（沙箱防误删，会导致回收站/打包清理失败）:' -ForegroundColor Yellow
    Write-Host ("    " + $denyAce.Line.Trim()) -ForegroundColor Yellow
} else {
    Write-Host '  未发现 Everyone DENY ACE' -ForegroundColor Green
}

Write-Host ''
if ($dirLabel -ne 'Low' -and $exeLabel -ne 'Low') {
    Write-Host '结论：正常，不是低完整性问题。' -ForegroundColor Green
    Write-Host '如果仍然 EPERM，再依次排查：杀软拦截、目标目录只读位、目标文件被占用。'
    exit 0
}

Write-Host '结论：目录被标成了低完整性 —— 这就是「写入全部 EPERM」的根因。' -ForegroundColor Red
Write-Host '      从该目录启动的任何 exe（electron.exe、node.exe 副本……）都会变成 Low IL 进程，'
Write-Host '      而 Low IL 进程写不了 Desktop / %APPDATA% 等普通位置。'
Write-Host ''

$fixCmd = 'icacls "' + $Path + '" /setintegritylevel (OI)(CI)Medium'

if (-not $Fix) {
    Write-Host '修复命令（递归传播，node_modules 大时约 30~60 秒）:' -ForegroundColor Yellow
    Write-Host ('  ' + $fixCmd) -ForegroundColor Yellow
    Write-Host ''
    Write-Host '或者直接带 -Fix 运行本脚本。' -ForegroundColor Yellow
    exit 1
}

Write-Host '正在修复……' -ForegroundColor Cyan
$sw = [Diagnostics.Stopwatch]::StartNew()
& icacls $Path /setintegritylevel '(OI)(CI)Medium' | Out-Null
$sw.Stop()

$after = Get-MandatoryLabel $Path
$afterExe = Get-MandatoryLabel $electron
Write-Host ("  耗时 " + [int]$sw.Elapsed.TotalSeconds + " 秒") -ForegroundColor Gray
Write-Host ("  工程目录 -> " + $after) -ForegroundColor $(if ($after -eq 'Medium') { 'Green' } else { 'Red' })
Write-Host ("  electron.exe -> " + $afterExe) -ForegroundColor $(if ($afterExe -eq 'Medium') { 'Green' } else { 'Red' })

if ($denyAce) {
    Write-Host ''
    Write-Host '同时清理 Everyone 的 DENY ACE……' -ForegroundColor Cyan
    & icacls $Path /remove:d 'Everyone' | Out-Null
    Write-Host '  已移除' -ForegroundColor Green
}

Write-Host ''
if ($after -eq 'Medium') {
    Write-Host '修复完成。请重启 IDE 里的调试会话（旧的进程仍是 Low IL，必须重启才生效）。' -ForegroundColor Green
    exit 0
} else {
    Write-Host '仍未生效，检查当前账户是否有 WRITE_OWNER 权限（目录所有者），或以管理员身份重试。' -ForegroundColor Red
    exit 1
}
