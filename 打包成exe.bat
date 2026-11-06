@echo off
chcp 65001 >nul
setlocal
cd /d "%~dp0"
set "ELECTRON_RUN_AS_NODE="

title 打包 CV Studio

echo.
echo   1) 只生成免安装目录（release\win-unpacked）
echo   2) 生成安装包（自绘界面，release\CmakeVscodeStudio-*-setup.exe）  ^<^< 常用
echo   3) 生成 electron-builder 的 NSIS 安装包 + 绿色版（release\*.exe）
echo.
set /p CHOICE="请输入 1 / 2 / 3（直接回车 = 2）: "
if "%CHOICE%"=="" set CHOICE=2

if "%CHOICE%"=="1" (
  call npm run dist
) else if "%CHOICE%"=="3" (
  call npm run dist:installer
) else (
  rem 自绘安装器：先把应用本体打到 release\win-unpacked，
  rem 再套一层 Electron 外壳并打成单文件 exe（tools\build-installer.mjs）。
  call npm run dist:setup
)

if errorlevel 1 (
  echo.
  echo   [错误] 打包失败。首次打包需要下载 electron-builder 的附加组件（走 npmmirror 镜像）。
  echo   如果提示文件被占用，先关掉正在运行的 CV Studio 再重试。
  echo.
  pause
  exit /b 1
)

echo.
echo   打包完成，产物在 release\ 目录下。
echo.
start "" "%~dp0release"
pause
