@echo off
setlocal
title CV Studio - cleanup build leftovers

rem ===========================================================================
rem  Remove leftover build folders (release-20x, release-portable,
rem  release\win-unpacked ...) that Explorer and cmd refuse to delete.
rem
rem  Why they cannot be deleted normally:
rem    the app.asar inside them is mmap-ed by a file watcher or the Windows
rem    Search indexer, so del reports "file in use" and renaming reports
rem    "Device or resource busy". Renaming the folder does not help either.
rem    This script stops the indexer, deletes the files recursively, removes
rem    the folders, then starts the indexer again.
rem
rem  Keep this file ASCII-only with CRLF line endings.
rem  A UTF-8 batch file with Chinese comments gets garbled by cmd: cmd parses
rem  the file in the OEM codepage, and multibyte characters can swallow the
rem  line breaks, so several commands get glued into one broken line.
rem
rem  Usage:
rem    double click this file        -> asks for UAC, cleans, waits at the end
rem    cleanup-leftovers.bat --dry   -> only prints what would be deleted
rem ===========================================================================

set "DRY=0"
if /I "%~1"=="--dry" set "DRY=1"

rem  Targets are relative to the project root (this file lives in tools\).
set "TARGETS=release-portable release\win-unpacked release\win-unpacked.tmp .installer-build .installer-build2 .installer-build3 .installer-build4 .tmp\build .tmp\stage-r4"

cd /d "%~dp0.."

if "%DRY%"=="1" goto dryrun

net session >nul 2>&1
if errorlevel 1 (
    echo [i] Administrator rights required, asking Windows for them...
    powershell -NoProfile -Command "Start-Process -FilePath '%~f0' -Verb RunAs"
    exit /b
)

echo Working directory: %CD%
echo.

echo [1/3] Stopping Windows Search indexer...
sc query WSearch >nul 2>&1
if errorlevel 1 (
    echo       WSearch service not found, skipped.
) else (
    sc stop WSearch >nul 2>&1
    timeout /t 3 /nobreak >nul
)

echo [2/3] Deleting leftover folders...
set "FAILED=0"
for %%D in (%TARGETS%) do call :nuke "%%D"

echo [3/3] Starting Windows Search indexer again...
sc query WSearch >nul 2>&1
if not errorlevel 1 sc start WSearch >nul 2>&1

echo.
if "%FAILED%"=="1" (
    echo   Some folders are still locked. They are empty shells holding
    echo   0-byte files, so they waste no disk space.
    echo   Close WorkBuddy / your IDE / the Explorer preview pane and run this
    echo   again, or run it right after a reboot before opening those programs.
    echo   If it still fails, the antivirus is probably memory-mapping the js
    echo   files inside: add this project folder to its trust list, or exit it,
    echo   then run this script again.
) else (
    echo   All cleaned.
)
echo.
pause
exit /b

:dryrun
echo [dry run] working directory: %CD%
echo [dry run] targets:
for %%D in (%TARGETS%) do call :nuke "%%D"
echo.
exit /b

rem ---------------------------------------------------------------------------
rem  :nuke <relative path>
rem  Handle one target. Never aborts the script - reports per target instead.
rem ---------------------------------------------------------------------------
:nuke
set "T=%~1"
if not exist "%T%" (
    echo       [skip ] %T%  - not found
    goto :eof
)
if "%DRY%"=="1" (
    echo       [would] %T%
    goto :eof
)
if exist "%T%\" (
    del /f /s /q "%T%\*" >nul 2>&1
    rmdir /s /q "%T%" >nul 2>&1
) else (
    del /f /q "%T%" >nul 2>&1
)
if exist "%T%" (
    echo       [FAIL ] %T%
    set "FAILED=1"
) else (
    echo       [ OK  ] %T%
)
goto :eof
