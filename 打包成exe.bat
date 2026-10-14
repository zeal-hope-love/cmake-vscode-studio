@echo off
chcp 65001 >nul
setlocal
cd /d "%~dp0"
set "ELECTRON_RUN_AS_NODE="

title 打包 CMake / VSCode 工程配置器

echo.
echo   1) 只生成免安装目录（release\win-unpacked）
echo   2) 生成安装包 + 绿色版（release\*.exe）
echo.
set /p CHOICE="请输入 1 或 2（直接回车 = 2）: "
if "%CHOICE%"=="" set CHOICE=2

if "%CHOICE%"=="1" (
  call npm run dist
) else (
  call npm run dist:installer
)

if errorlevel 1 (
  echo.
  echo   [错误] 打包失败。首次打包需要下载 electron-builder 的附加组件（走 npmmirror 镜像）。
  echo.
  pause
  exit /b 1
)

echo.
echo   打包完成，产物在 release\ 目录下。
echo.
start "" "%~dp0release"
pause
