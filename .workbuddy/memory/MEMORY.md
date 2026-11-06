# CV Studio 项目长期记忆

## ⚠️ 反复出现的问题：写入全部 EPERM

**根因**：工程所在目录 `C:\Users\PoXia\Desktop\DSH_Workspace` 被打上了
`Mandatory Label\Low Mandatory Level:(OI)(CI)(NW)`。该目录下所有 exe 继承 Low 标签，
而从 Low 标签文件启动的进程会被 Windows 降为 Low IL，无法写任何 Medium 位置
（Desktop / %APPDATA% / Program Files），报错映射为 **EPERM**。

**打标者已确认为 DeepSeek Harness** 的 `packages/sandbox/sandbox-windows-acl`
（`workspace-sid.ts` 生成 `S-1-4-x-y`、`token.ts` 降令牌、设计文档写明
`S-1-16-4096` + `NO_WRITE_UP` + `OI|CI`）。三条痕迹与源码一一对应。
完整上游报告见 `docs/UPSTREAM-dsh-sandbox-lowil.md`。

**复现时先跑这个**（不要重头试环境变量/杀软）：
```powershell
.\tools\check-integrity.ps1          # 有 -Fix 参数可直接修
```
或 `icacls "C:\Users\PoXia\Desktop\DSH_Workspace" | Select-String Mandatory`

**修复**：
```powershell
icacls "C:\Users\PoXia\Desktop\DSH_Workspace" /setintegritylevel (OI)(CI)Medium
icacls "C:\Users\PoXia\Desktop\DSH_Workspace" /remove:d Everyone
```
改完**必须重启调试会话**，旧进程仍是 Low IL。

**排查要点（已踩过的坑）**：
- `Get-Acl` **看不到**完整性标签，只能 `icacls` 或读 SACL
- 改名 / 复制 / 改哈希 / 换父进程启动 **都无效**（标签在文件上）
- 关沙箱开关、停 Codex 沙箱服务 **无效**（标签已固化）
- 判据：同一个 exe 放 A 目录 Medium、放 B 目录 Low → 就是目录标签问题
- 完整记录见 `docs/TROUBLESHOOTING.md`

## 环境注意事项

- **构建必须指定临时目录**，否则火绒拦 `%TEMP%` 清理报 Access denied：
  `TMPDIR=<项目>/.tmp/build TMP=... TEMP=... npm run build`
- `release\win-unpacked` 里的 `app.asar` 可能被句柄占用且桌面在 OneDrive 下回收站不可用，
  打包会失败 → 用 `-c.directories.output=release-new` 换输出目录
- 桌面被 OneDrive 重定向成 reparse point，但**不影响写入**
- Bash 工具里嵌引号的 Windows 命令容易被转义打坏，用 PowerShell 工具更稳；
  本环境禁止从 Bash 调 powershell

## 代码约定

- 写文件统一走 `src/main/services/fileWrite.ts` 的 `writeFileWithRetry`
  （退避重试 + 清只读位；失败时 `dirError` 单独带出根因）
- 历史记录必须包含失败项：`buildWriteRecord()` 生成，失败时 `actions[0] = 'retry-write'`；
  `history.json` 写入失败时进 `pending` 内存队列下次补写
- `historyStore.ts` 曾无故回退过一次，改完先 `git diff --stat` 核对
- 单实例锁只在打包版启用（`app.isPackaged`），开发模式靠 `CFGSTUDIO_ALLOW_MULTI=1`

## 符号扫描（VOFA 调参）的边界 —— 别再让用户手写 extern

`scanSymbols()` 认两种来源：
1. 头文件里的 `extern` 声明（带 include）
2. **.c 里文件作用域的变量定义**（`parseTopLevelVars`，深度 0 按 `;` 切语句）

第二种在生成时由 `renderBind` 往 `vofa_bind.c` 顶部补 `extern <类型> <名字>;`
（模板占位符 `${EXTERN_DECLS}`）。**非 static 的全局变量用户零改动就能绑**
—— 别再说「必须写 extern」，那是旧版限制。

只有 `static` 真无解：链接期是 local symbol，跨编译单元取不到地址。
这类进 `SymbolScanResult.statics`，界面单独折叠展示并说明。

新增顶层变量解析时的注意点：
- 预处理行必须先用 `blankPreprocessor()` 抹成等长空格，否则 `#include`
  会和下一条语句黏住（偏移不变，行号才准）
- 行号要用 `lineAt(stops, stmtStart + seg.trimStart() 的偏移)`，
  直接用 `stmtStart` 会把行号报成上一句结尾的行
- 过滤 `^(_|arm_|__)`：链接脚本符号和 CMSIS-DSP 常量表是噪音
- `dirRank()` 排序 application > components > bsp > Src > 其他，
  否则字母序把库符号排最前，看起来像没扫到
