@echo off
chcp 65001 >nul
setlocal
cd /d "%~dp0"

rem 有些 Electron 应用会把 ELECTRON_RUN_AS_NODE 传给子进程，
rem 留着它 electron.exe 会被当成纯 Node 跑，界面起不来。
set "ELECTRON_RUN_AS_NODE="

title CMake / VSCode 工程配置器

rem ---------------------------------------------------------------------------
rem 优先启动已经打包好的 exe —— 这条路径不需要 Node.js，也不需要批处理做别的事
rem ---------------------------------------------------------------------------
set "PACKED=release\win-unpacked\CMake-VSCode-Configurator.exe"
if exist "%PACKED%" goto :runpacked

for %%F in ("release\*portable*.exe") do (
  if exist "%%~fF" (
    set "PORTABLE=%%~fF"
    goto :runportable
  )
)

rem ---------------------------------------------------------------------------
rem 没有打包产物，才走开发模式（需要 Node.js）
rem ---------------------------------------------------------------------------
echo.
echo   没有找到打包好的 exe，改用开发模式启动。
echo   想得到真正的独立 exe，请双击「打包成exe.bat」先打包一次。
echo.

where node >nul 2>nul
if errorlevel 1 (
  echo   [错误] 没有找到 Node.js，无法以开发模式启动。
  echo   请先安装 Node.js 18+： https://nodejs.org/
  echo   或者双击「打包成exe.bat」在一台装了 Node 的机器上打包后再拷过来。
  echo.
  pause
  exit /b 1
)

if not exist "node_modules\electron\dist\electron.exe" (
  echo   正在安装依赖（首次运行需要 1~2 分钟，Electron 运行时约 370MB）...
  echo.
  call npm install
  if errorlevel 1 (
    echo.
    echo   [错误] 依赖安装失败，请检查网络后重试。
    echo.
    pause
    exit /b 1
  )
)

echo   正在启动（开发模式）...
echo.
call npm run dev
set "CODE=%ERRORLEVEL%"
if not "%CODE%"=="0" (
  echo.
  echo   程序退出，代码 %CODE%。
  pause
)
exit /b %CODE%

:runpacked
echo   正在启动打包版：%PACKED%
start "" "%PACKED%"
exit /b 0

:runportable
echo   正在启动绿色版：%PORTABLE%
start "" "%PORTABLE%"
exit /b 0
