# 故障排查手册

按症状查，每条都给出「先跑什么命令」和「根因原理」，避免再从环境变量、杀软、沙箱开关一个个试。

---

## 一、写入全部失败，报 `EPERM` / `EACCES`

### 症状

点「写入配置」后所有文件都失败：

```
EPERM: operation not permitted, open 'D:\...\.vscode\launch.json'
```

或者界面显示「已重试 10 次」仍然失败。**关键特征：连 `%APPDATA%\CV Studio\history.json` 都写不进去**（历史记录不更新），因为这不只是目标目录的问题，而是进程根本没有写入权限。

### 30 秒定位

```powershell
.\tools\check-integrity.ps1
```

输出里看 `工程目录` 那一行：

| 输出 | 含义 |
| --- | --- |
| `Medium` | 正常，不是完整性问题，往下看「其它原因」 |
| `Low` | **就是这个**，跳到「修复」 |

手工判断也可以，一条命令：

```powershell
icacls "C:\Users\PoXia\Desktop\DSH_Workspace" | Select-String "Mandatory"
```

```
Mandatory Label\Low Mandatory Level:(OI)(CI)(NW)       ← 有问题
Mandatory Label\Medium Mandatory Level:(OI)(CI)(NW)    ← 正常
```

### 原理

Windows 除了 ACL（谁能读写）之外，还有一层独立的**强制完整性控制（MIC）**：

1. 每个进程和每个文件都有一个完整性级别：Low(0x1000) / Medium(0x2000) / High(0x3000)
2. 进程**默认只能写「同级或更低」的对象**，这叫 deny write-up
3. **从被标记为 Low 的可执行文件启动的进程，自身也会被降为 Low**

所以当 `C:\...\DSH_Workspace` 目录被打上 `Low` 标签并强制继承（`(OI)(CI)`）后：

```
目录 Low  →  目录下所有文件继承 Low（包括 node_modules\electron\dist\electron.exe）
                     ↓
              从 electron.exe 启动的主进程 = Low IL 进程
                     ↓
        Low IL 进程写 Desktop / %APPDATA% / Program Files = 拒绝访问
                     ↓
              Windows 错误 5 → Node.js 映射成 EPERM
```

**注意 EPERM 的误导性**：Node 在 Windows 上把 `ERROR_ACCESS_DENIED` 映射成 `EPERM`，所以看到 EPERM 直觉会以为是"文件被占用/只读"，实际是权限被拒绝。

### 修复

```powershell
# 递归改回 Medium（node_modules 文件多，约 30~60 秒）
icacls "C:\Users\PoXia\Desktop\DSH_Workspace" /setintegritylevel (OI)(CI)Medium

# 顺手清掉沙箱加的防误删 ACE（它会让回收站和 electron-builder 清理失败）
icacls "C:\Users\PoXia\Desktop\DSH_Workspace" /remove:d Everyone
```

或者：

```powershell
.\tools\check-integrity.ps1 -Fix
```

**改完必须重启调试会话** —— 已经跑起来的进程还是旧令牌，改文件标签不会追溯生效。端口 5858 被旧进程占着时也要一起清掉：

```powershell
Get-CimInstance Win32_Process |
  Where-Object { $_.Name -eq 'electron.exe' -and $_.CommandLine -like '*CMakeVSCodeStudio*' -and $_.CommandLine -notlike '*--type=*' } |
  ForEach-Object { taskkill /PID $_.ProcessId /T /F }
```

### 为什么会变成 Low（2026-11-04 的结论）

**这是工具沙箱留下的，不是 Windows 自动行为，也不是用户设置的。** 判断依据：

`DSH_Workspace` 目录上同时存在三条 Windows 绝不会自己写的 ACE：

```
Everyone:(CI)(DENY)(DC)                     ← 拒绝删除子项，防误删
S-1-4-275285986-556314953:(OI)(CI)(W,D,DC)  ← 随机 SID 的写权限
Mandatory Label\Low Mandatory Level:(OI)(CI)(NW)
```

`S-1-4-*` 是「非唯一权威」SID 段，任何人可以随意生成，是沙箱给临时账户开权限的典型做法。这三条组合起来就是「把一个目录改造成沙箱隔离区」的标准配方。

**推断的动机**：沙箱要保证「AI 只能改工作区、改不了外面」。用完整性的实现方式就是——把工作区标成 Low，沙箱进程也是 Low，于是它天然只能写工作区内的 Low 对象，写外面（Medium）被系统拒绝。这比在应用层逐个判断路径要可靠得多。

**副作用**：工作区里的 `electron.exe` 继承了 Low 标签，于是**开发者自己的调试进程**也被套进了同一个限制里。这是一个「隔离手段泄漏到宿主工具」的问题。

同机的对照证明这不是系统级设置：

| 位置 | 标签 |
| --- | --- |
| `Desktop\DSH_Workspace`（工具工作区） | **Low** |
| `Desktop\RM`（用户手动加白名单的目录） | Medium |
| `Desktop` | Medium |
| `%TEMP%` | Medium |
| `C:\Program Files\nodejs\node.exe` | Medium |

**为什么之前反复遇到**：工具每次重新初始化工作区都可能重新打标。所以这不是一次性故障，是**会复发**的。

> 诚实说明：没法 100% 确认是哪个进程写的（Windows 不默认审计 SACL 变更），但「三条 ACE 同时出现 + 只会发生在工作区树里 + 关闭沙箱开关无效（标签已固化到文件）」这三条能唯一指向沙箱的工作区初始化逻辑。

### 排查时容易走错的路

这些都在 2026-11-04 那次实际踩过，写下来避免重复：

| 走过的弯路 | 为什么错 |
| --- | --- |
| 比对文件夹 ACL | **`Get-Acl` 看不到完整性标签**。ACL 里 `PoXia: FullControl` 一直是正常的，两层是独立的 |
| 怀疑环境变量污染 | 查了注册表 `HKCU\Environment`、`HKLM`、`AppInit_DLLs`、IFEO，全部干净；目标进程 `NODE_OPTIONS`、`LSBOX_*` 都是 null |
| 怀疑杀软 | Defender 受控文件夹访问为 0；火绒进程在跑但不影响 `%TEMP%` 下的同样测试 |
| 换 exe 名字 / 复制到别处 | 无效 —— 标签是**从目录继承到文件**的，改名不改标签 |
| 改哈希 / 追加字节 | 无效，同上 |
| 用 Medium 的父进程启动 | 无效 —— 降级由**映像文件的标签**决定，不看父进程 |
| 关沙箱总开关、停 Codex 沙箱服务 | 无效 —— 标签已经落在文件上，跟服务是否运行无关 |
| 以为是 Electron 特有 | 无效 —— 把 `node.exe` 复制到该目录下启动，一样变 Low |

**一句话判据**：只要「同一份 exe，放在 A 目录是 Medium、放在 B 目录是 Low」，就是目录标签问题。

### 其它原因（确认不是 Low 之后再看）

1. **目标文件只读位**：`fileWrite.ts` 的 `writeFileWithRetry` 已经会 `chmodSync` 清只读位后重试
2. **被杀软拦截**：把 `CV Studio.exe` 加入杀软信任区；火绒会拦 `%TEMP%` 清理，构建时用 `TMPDIR=<项目>/.tmp/build` 绕开
3. **目标文件被占用**：`EBUSY` / `EPERM`，关掉占用它的程序
4. **父目录创建失败**：看 `WriteResult.dirError`，`writer.ts` 的 `hintForDirCode()` 会单独提示

### 预防

1. **推荐：把工程移出工具的工作区目录**。放到 `C:\Projects\...` 这类不归沙箱管的路径，从根上避免被打标。
2. 每次开工前跑一次 `.\tools\check-integrity.ps1`（或者放进 npm script）。
3. 出现同类症状先跑脚本，别再从头试环境变量和杀软。

---

## 二、`npm run dev` 起来就退出，退出码 0

**原因**：单实例锁。早期版本无条件调用 `requestSingleInstanceLock()`，开发模式下第二个实例拿不到锁就直接 quit，且不打印原因。

**现在**：锁只在打包版启用（`app.isPackaged`），开发模式可以用 `CFGSTUDIO_ALLOW_MULTI=1` 强制多开。开发模式拿不到锁时会打日志而不是静默退出。

如果还退出，检查是否有残留的 hang 住的 electron 进程（任务管理器里 PID 可能是几天前的），结束掉。

---

## 三、`electron-builder` 打包在 `win-unpacked` 阶段失败

**症状**：

```
⨯ [safe-delete][SAFE_DELETE_BULK_CONFIRM_REQUIRED] count 95
⨯ [safe-delete][SAFE_DELETE_FAIL_CLOSED] reason=trash-failed
The process cannot access the file 'app.asar' because it is being used by another process
```

**原因**：把旧的 `release\win-unpacked` 挪进回收站失败。这里有两个叠加因素：

- 桌面被 OneDrive 重定向后，**回收站在这个路径下不可用**
- 目录上如果还有 `Everyone:(CI)(DENY)(DC)`，删子项直接被拒

**解决**：换输出目录，绕开那块删不掉的残留。

```powershell
npx electron-builder --win -c.directories.output=release-new
```

残留目录等重启后（占用句柄释放）再手动删。

---

## 四、构建时报 `Access denied`（火绒）

electron-builder 清理 `%TEMP%` 时被拦截。把临时目录指到项目内：

```powershell
$env:TMPDIR = "$PWD\.tmp\build"
$env:TMP  = "$PWD\.tmp\build"
$env:TEMP = "$PWD\.tmp\build"
npm run build
```
