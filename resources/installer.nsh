;
; 安装器自定义脚本（electron-builder 的 nsis.include）
;
; 解决两件事。
;
; ── 一、明明没开应用，却弹「无法关闭，请手动关闭它」──
;
; electron-builder 判定「应用在运行」的实现是（allowOnlyOneInstallerInstance.nsh）：
;
;   Get-CimInstance Win32_Process |
;     ? { $_.Path -and $_.Path.StartsWith('$INSTDIR') }   → 有就算在运行
;
; 两个致命点：
;   1. 它只**检查**，随后按**映像名**去杀。万一「路径在 $INSTDIR 下」的进程不是应用本体，
;      或者那一刻 $INSTDIR 还没定下来（StartsWith('') 对任何进程都成立），
;      就会进入「判定在运行 → 按名字杀不到 → 再判定还在运行」的死循环，最后弹这个框。
;   2. 用户根本没开应用，于是完全无从下手，只能取消。
;
; 官方模板留了覆盖入口（`!ifmacrodef customCheckAppRunning`），这里按它自己的判定口径
; **真的去杀**：先按映像名精确杀，再按「可执行文件路径在 $INSTDIR 下」兜底。
;
; ── 二、安装过程看不到细节 ──
;
; electron-builder 在 common.nsh 里写死了 `ShowInstDetails nevershow`，
; 而且自定义 include 是在它之前注入的，改不动那个编译期开关。
; 但 NSIS 有**运行时**版本 `SetDetailsView`，在 customInit 里调用即可让详情面板显示出来，
; 配合 `SetDetailsPrint both` 就能看到正在释放哪些文件、执行到哪一步。
;

!macro customCheckAppRunning
  DetailPrint "正在关闭可能还在运行的旧版本…"

  ; ① 按映像名精确结束（/IM 是全名匹配，不是通配符 —— 不会误杀安装器自己）
  nsExec::ExecToLog 'taskkill /F /IM "${APP_EXECUTABLE_FILENAME}"'
  Pop $0

  ; ② 兜底：把「可执行文件路径在安装目录下」的进程全部结束。
  ;    这正是 electron-builder 用来判定「在运行」的条件，但它只查不杀，
  ;    所以才会出现「说关不掉、其实根本没在跑」的死循环。这里真的杀。
  nsExec::ExecToLog '"$PowerShellPath" -NoProfile -Command "Get-CimInstance Win32_Process | Where-Object { $$_.ExecutablePath -and $$_.ExecutablePath.StartsWith(''$INSTDIR'', ''CurrentCultureIgnoreCase'') } | ForEach-Object { Stop-Process -Id $$_.ProcessId -Force -ErrorAction SilentlyContinue }"'
  Pop $0

  ; 给文件句柄一点释放时间，避免紧接着覆盖文件报「正在使用」
  Sleep 800
!macroend

!macro customInit
  ; 安装详情面板：运行时打开，并把 DetailPrint 同时输出到面板
  SetDetailsView show
  SetDetailsPrint both

  DetailPrint "CMake / VSCode 工程配置器 —— 开始安装"
  DetailPrint "安装目录：$INSTDIR"

  ; 再保险一次：安装最开始就把旧进程清掉
  ; （customCheckAppRunning 只在特定时机被调用，不是每次都跑）
  nsExec::ExecToLog 'taskkill /F /IM "${APP_EXECUTABLE_FILENAME}"'
  Pop $0
!macroend
