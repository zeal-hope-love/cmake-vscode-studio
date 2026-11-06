# 上游报告：DSH Windows 沙箱的常驻 Low 完整性标签会污染宿主工具链

> 记录时间：2026-11-04
> 目标仓库：`deepseek-ai/deepseek-harness`
> 涉及模块：`packages/sandbox/sandbox-windows-acl`
> 提交渠道：GitHub **Discussions**（该仓库 `has_issues: false`，只能发 Discussion）

---

## 一句话

`workspace-write` 模式给工作区根加的是 **可继承**（`OI|CI`）的 Low 完整性标签。由于
Windows 规定「从 Low 完整性文件启动的进程，自身也被降为 Low」，工作区里所有 `.exe`
变成 Low 文件后，**用户在 DSH 之外启动自己的开发工具，进程就被降权了**，写工作区外的
任何普通位置都返回 `ACCESS_DENIED`（Node 映射为 `EPERM`），报错完全指不到真正原因。

---

## 环境

| 项 | 值 |
| --- | --- |
| OS | Windows 11 10.0.26200 |
| 工作区 | `<workspace-root>` |
| 触发方式 | 用 DSH 以该目录为工作区执行过写操作 |
| 受影响项目 | Electron 44 应用（`node_modules\electron\dist\electron.exe`） |

---

## 复现步骤

### 1. 触发供给（让 DSH 给工作区授权一次）

用 DSH 打开任意工作区目录，执行一条需要写权限的命令，例如：

```powershell
echo test > "$PWD\write-probe.txt"
```

### 2. 退出 DSH，检查工作区根的安全描述符

```powershell
icacls "<workspace-root>"
```

实际观测（DSH 退出后仍存在）：

```
Everyone:(CI)(DENY)(DC)
S-1-4-275285986-556314953:(OI)(CI)(W,D,DC)
NT AUTHORITY\SYSTEM:(I)(OI)(CI)(F)
BUILTIN\Administrators:(I)(OI)(CI)(F)
WYFJ\<user>:(I)(OI)(CI)(F)
Mandatory Label\Low Mandatory Level:(OI)(CI)(NW)     ← 关键
```

对照：同机的 `<other-dir>`、`%TEMP%`、`Desktop` 都是 `Medium Mandatory Level`。

### 3. 检查工作区里的可执行文件

```powershell
icacls "<workspace-root>\<project>\node_modules\electron\dist\electron.exe"
```

```
Mandatory Label\Low Mandatory Level:(I)(NW)     ← (I) 表示从目录继承而来
```

本机实测：该目录树下 **40 个 exe 全部**是 `Low`，无一例外。

### 4. 验证进程被降权（决定性实验）

把同一个 `node.exe` 复制到不同目录启动，读取进程令牌的完整性级别：

```powershell
# 读取进程完整性级别（P/Invoke）
$src = @'
using System;
using System.Runtime.InteropServices;
public class Il {
    [DllImport("kernel32.dll", SetLastError=true)] public static extern IntPtr OpenProcess(uint a, bool i, int pid);
    [DllImport("advapi32.dll", SetLastError=true)] public static extern bool OpenProcessToken(IntPtr h, uint a, out IntPtr t);
    [DllImport("advapi32.dll", SetLastError=true)] public static extern bool GetTokenInformation(IntPtr t, int c, IntPtr i, int l, out int r);
    [DllImport("kernel32.dll")] public static extern bool CloseHandle(IntPtr h);
    public static string Get(int pid) {
        IntPtr h = OpenProcess(0x1000, false, pid);
        if (h == IntPtr.Zero) return "OPEN_FAIL(" + Marshal.GetLastWin32Error() + ")";
        IntPtr tok;
        if (!OpenProcessToken(h, 0x0008, out tok)) { CloseHandle(h); return "TOKEN_FAIL"; }
        int len; GetTokenInformation(tok, 25, IntPtr.Zero, 0, out len);
        IntPtr buf = Marshal.AllocHGlobal(len); string res = "UNKNOWN";
        if (GetTokenInformation(tok, 25, buf, len, out len)) {
            IntPtr sid = Marshal.ReadIntPtr(buf);
            byte n = Marshal.ReadByte(sid, 1);
            int last = Marshal.ReadInt32(sid, 8 + (n - 1) * 4);
            res = last >= 0x4000 ? "System" : last >= 0x3000 ? "High" : last >= 0x2000 ? "Medium" : last >= 0x1000 ? "LOW" : "Untrusted";
            res += "(" + last + ")";
        }
        Marshal.FreeHGlobal(buf); CloseHandle(tok); CloseHandle(h); return res;
    }
}
'@
Add-Type -TypeDefinition $src

$node = 'C:\Program Files\nodejs\node.exe'
foreach ($dir in @(
    '<workspace-root>\<project>\.tmp',   # 工作区树内
    '<workspace-root>',                          # 工作区根
    'C:\Users\<user>\<other-dir>',                                     # 工作区外
    $env:TEMP                                                         # 工作区外
)) {
    $t = Join-Path $dir 'ilprobe.exe'
    Copy-Item $node $t -Force
    $p = Start-Process $t -ArgumentList '-e','setTimeout(()=>{},9000)' -PassThru -WindowStyle Hidden
    Start-Sleep -Milliseconds 1300
    Write-Output ("{0,-55} {1}" -f $dir, [Il]::Get($p.Id))
    Stop-Process -Id $p.Id -Force -ErrorAction SilentlyContinue
    Remove-Item $t -Force -ErrorAction SilentlyContinue
}
```

实测结果：

```
<workspace-root>\proj\.tmp     LOW(4096)        ← 工作区树内
...\DSH_Workspace                             LOW(4096)        ← 工作区根
...\<other-dir>                                Medium(8192)     ← 工作区外
...\AppData\Local\Temp                        Medium(8192)     ← 工作区外
```

**同一份二进制、同一个父进程（Medium 的 PowerShell）、同一时刻，只有放在工作区树内启动会被降为 Low。**
改名、改哈希、复制到别的路径都无效，因为标签在文件对象上。

### 5. 观察实际后果

在被降权的进程里写工作区外的路径：

```js
fs.writeFileSync('C:\\Users\\<user>\\AppData\\Roaming\\<app>\\probe.txt', 'x')
// EPERM: operation not permitted, open 'C:\Users\<user>\AppData\Roaming\<app>\probe.txt'
```

真实场景：Electron 开发时 `npm run dev` 启动的主进程写自身 `%APPDATA%` 配置、
写目标工程目录全部失败；而打包安装版（装在 `%LOCALAPPDATA%\Programs\`）完全正常。

---

## 根因（源码定位）

| 源码 | 内容 |
| --- | --- |
| `packages/sandbox/sandbox-windows-acl/src/workspace-sid.ts` | 生成 `S-1-4-${first}-${second}`，对应观测到的 `S-1-4-275285986-556314953` |
| `packages/sandbox/sandbox-windows-acl/src/token.ts` | `SetTokenInformation(TokenIntegrityLevel)` 把受限令牌降到 Low |
| `.agents/notes/.../2026-09-19-windows-acl-mandatory-integrity-confinement.zh.md` | 「Low 完整性强制标签（`S-1-16-4096`、`SYSTEM_MANDATORY_LABEL_NO_WRITE_UP`、`OI\|CI`）」 |
| 同上 | 「**标签在工作区根上常驻**……按会话回收会导致每次供给都重新传播整棵树」 |

`OI|CI` 是问题核心：它让标签继承到工作区里的**每一个文件对象**，包括编译产物和可执行文件。

---

## DSH 自己的文档已经承认了部分代价

`packages/sandbox/sandbox-windows-acl/README.zh.md` 第 131 行：

> 常驻 Low 标签的生命期长于 DSH，并会向其他 Low 完整性的进程放宽该目录树……任何以同一用户身份运行在 Low 完整性的其他进程都能写入与删除工作区内的内容。

**注意这句描述的方向是「放宽」——即安全性下降。它没有覆盖本报告的现象：**

> 反过来，**Medium 进程被强制降级**，宿主工具链失去写入能力。

第 177 行更直接：

> 诊断保留完整性标签——**它无法修复 Low 标签的可执行文件影响用户在 DSH 外启动程序的问题**。

**说明团队已经知道这个副作用存在，但当前没有修复方案，也没有对用户暴露任何提示或回收手段。**

---

## 影响

1. **宿主工具链静默失效**：工作区内任何 exe 启动即降权，开发、调试、打包全部受限，且错误码是 `EPERM`——直觉会误判为「文件被占用」或「只读」，实际是完整性级别问题。
2. **不可见**：`Get-Acl` 看不到完整性标签，用户按常规「右键→属性→安全」检查一切正常，无从发现。
3. **不可逆（对用户而言）**：会话结束、DSH 卸载后标签仍在；README 明确说手工 `icacls` 清理在该平台会报 `ERROR_NONE_MAPPED`(1332)。
4. **目录删除被拒**：授权根内目录的 `GENERIC_ALL` 打开被拒绝，导致回收站操作失败（实测 `genie-trash: Some operations were aborted`）、`electron-builder` 无法清理旧产物。

### 另一个方向的安全问题（供评估）

给工作区内的可执行文件打 Low 标签，**并没有带来安全收益，反而削弱了保护**：

- 若 exe 保持 `Medium`：Low 的沙箱子进程受 deny-write-up 限制，**无法替换**工作区里的二进制
- 现在 exe 被标成 `Low`：沙箱子进程**可以**写入它

也就是说，当前策略让沙箱子进程获得了「改写工作区内可执行文件」的能力，而用户之后会以 Medium 身份运行这个二进制。这个方向值得团队评估——**排除可执行文件类型不加标签，对安全和可用性都是正向的**。

---

## 建议

### 方案 A（推荐）：inode 级排除可执行文件

供给时（`SetNamedSecurityInfoW` 之后）对工作区内的 `*.exe` / `*.dll` / `*.node` 重置为
`Medium`，或在继承后批量纠正。理由：

- 沙箱的安全目标是「限制写入范围」，而 exe 本来就在授权范围内，纠正标签不缩小功能
- 反而恢复「Low 进程不能改写 Medium 可执行文件」这层保护
- 宿主工具链不再被污染

代价：构建产生的新 exe 需要再次纠正，可用目录监视或在下一次供给时全量扫描。

### 方案 B：提供显式回收命令

增加 `dsh sandbox release --workspace <dir>` / `dsh sandbox unlabel`，一次性清除
标签、`S-1-4-*` ACE 与 `Everyone` 删除拒绝。README 已指出手工 `icacls` 会因为
`ERROR_NONE_MAPPED` 失败，所以官方命令是必要的逃生口。

### 方案 C：至少让副作用可见

- 供给工作区时检测是否含有 `.exe`，在 UI 上提示「该工作区内的可执行文件会被降为 Low 完整性」
- 已有 `assets/diagnose-windows-sandbox-acl/` 诊断技能，建议扩展为能检测「受影响的 exe」并给出修复

---

## 附：用户侧临时规避（已验证有效）

```powershell
icacls "<工作区>" /setintegritylevel (OI)(CI)Medium
icacls "<工作区>" /remove:d Everyone
```

或在 PowerShell 里精确移除随机 SID（`icacls /remove:g` 对 `S-1-4-*` 匹配不到）：

```powershell
$acl = Get-Acl "<工作区>"
$acl.Access | Where-Object { $_.IdentityReference.Value -like 'S-1-4-*' } |
    ForEach-Object { [void]$acl.RemoveAccessRuleSpecific($_) }
Set-Acl "<工作区>" -AclObject $acl
```

注意：这些改动会在 DSH 下次供给该工作区时被重新施加。
