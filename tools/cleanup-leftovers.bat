@echo off
chcp 65001 >nul
setlocal

rem ===========================================================================
rem  清理打包残留：release-203 / release-portable / win-unpacked 之类的空壳目录
rem
rem  为什么要单独弄个脚本：
rem    这些目录里的 app.asar 被文件监视/索引服务 mmap 住，普通删除会报
rem    "Device or resource busy" 或 "另一个程序正在使用此文件"，连改名都不行。
rem    脚本会先停掉 Windows 搜索索引，再删一轮；还删不掉就说明是别的监视器，
rem    退出 WorkBuddy / VSCode 这类占着工作区的程序后再跑一次，或者重启后直接跑。
rem
rem  用法：双击（会弹 UAC），删完自己停住让你看结果。
rem ===========================================================================

net session >nul 2>&1
if errorlevel 1 (
  echo 需要管理员权限，正在申请...
  powershell -NoProfile -Command "Start-Process -FilePath '%~f0' -Verb RunAs"
  exit /b
)

cd /d "%~dp0.."
echo 当前目录: %CD%
echo.

echo [1/3] 停止 Windows 搜索索引（WSearch）...
sc stop WSearch >nul 2>&1
timeout /t 3 /nobreak >nul

echo [2/3] 删除残留目录...
set FAILED=0
for %%D in (
  "release-203"
  "release-portable"
  "release\win-unpacked"
  "release\win-unpacked.tmp"
  ".tmp\stage-r4"
  ".tmp\stmp"
) do (
  if exist "%%~D" (
    rmdir /s /q "%%~D" 2>nul
    if exist "%%~D" (
      echo     [失败] %%~D
      set FAILED=1
    ) else (
      echo     [已删] %%~D
    )
  )
)

echo [3/3] 恢复 Windows 搜索索引...
sc start WSearch >nul 2>&1

echo.
if "%FAILED%"=="1" (
  echo 有目录没删掉。它们现在都是 0 字节空壳，不占空间。
  echo 试试：关掉 WorkBuddy / VSCode / 资源管理器预览窗格，再跑一次本脚本；
  echo 或者重启电脑后**先别打开这些程序**，直接跑本脚本。
) else (
  echo 全部清理完成。
)
echo.
pause
