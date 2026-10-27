;
; 安装器自定义脚本（electron-builder 的 nsis.include）
;
; ── 为什么需要它 ──
;
; electron-builder 判定「应用在运行」的实现是（allowOnlyOneInstallerInstance.nsh）：
;
;   Get-CimInstance Win32_Process |
;     ? { $_.Path -and $_.Path.StartsWith('$INSTDIR') }   → 有就算在运行
;
; 它只**检查**，随后却按**映像名**去杀。两者对不上时（或那一刻 $INSTDIR 还没定下来，
; StartsWith('') 对任何进程都成立），就会进入
;   「判定在运行 → 按名字杀不到 → 再判定还在运行」
; 的死循环，最后弹「无法关闭，请手动关闭它」——而用户根本没开应用，完全无从下手。
;
; 这里用官方留的覆盖入口（`!ifmacrodef customCheckAppRunning`）换成**真去杀**的实现。
;
; ── 刻意只用 taskkill，不用 PowerShell ──
;
; 早先版本在这里加了一段 PowerShell（Get-CimInstance + Stop-Process）做兜底，
; 结果在开着 Defender 实时保护的机器上会明显拖慢甚至卡住 —— 进程枚举本身就要几秒，
; 安装器会一直停在「正在确认旧版本」那步。taskkill 是系统自带的小工具，毫秒级返回，
; 不会引入这个问题。杀不到的极端情况（应用被提升权限运行）让用户手动关，也比卡死好。
;
; ── 关于「安装过程显示细节」──
;
; 做不到，原因不是这段脚本：
;   · electron-builder 的 common.nsh 里**写死**了 `ShowInstDetails nevershow`，
;     这是编译期指令，执行后 NSIS 根本不创建详情列表控件；
;   · 自定义 include 是在 common.nsh **之前**注入的，改不动它；
;   · 运行时命令 `SetDetailsView show` 试过了 —— 控件不存在，调了也没效果。
;
; 要做只能整个替换 NSIS 模板（electron-builder 的 nsis.script），
; 代价是每次升级 electron-builder 都得同步模板，风险大于收益，所以这里不做。
;

!macro customCheckAppRunning
  DetailPrint "正在关闭可能还在运行的旧版本…"

  ; 按映像名精确结束。/IM 是全名匹配，不是通配符 ——
  ; 安装器自己的进程名是 `CMake-VSCode-Configurator-1.3.3-x64`，不会被误杀。
  nsExec::ExecToLog 'taskkill /F /IM "${APP_EXECUTABLE_FILENAME}"'
  Pop $0
  ; nsExec 的返回码：0 = 成功结束、128 = 没找到这个进程（也算正常）
  ${If} $0 == 128
    DetailPrint "没有旧版本在运行"
  ${EndIf}

  ; 给文件句柄一点释放时间，避免紧接着覆盖文件报「正在使用」
  Sleep 500
!macroend

!macro customInit
  ; DetailPrint 的内容同时写到安装日志（配合下面的 LogSet）
  SetDetailsPrint both

  DetailPrint "CMake / VSCode 工程配置器 —— 开始安装"
  DetailPrint "安装目录：$INSTDIR"

  ; 再保险一次：安装最开始就把旧进程清掉
  ;（customCheckAppRunning 只在特定时机被调用，不是每次都跑）
  nsExec::ExecToLog 'taskkill /F /IM "${APP_EXECUTABLE_FILENAME}"'
  Pop $0
!macroend
