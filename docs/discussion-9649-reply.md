独立复现确认 + 补两条原帖没覆盖的证据

我这台机器（Windows 11 10.0.26200，DSH 桌面端）独立复现了同一现象，报告里额外补充三点：**源码级定位**、**exe 被降级反而削弱了沙箱安全性**、**一个原帖没记的删除失败**。

一、源码级定位（可省去维护者从现象反推）

工作区根上看到的随机 SID `S-1-4-275285986-556314953` 不是我们的，是 DSH 自己生成的：

| 观测值 | 源码 |
| --- | --- |
| `S-1-4-275285986-556314953` | `packages/sandbox/sandbox-windows-acl/src/workspace-sid.ts` 生成 `S-1-4-${a}-${b}` |
| `Everyone:(CI)(DENY)(DC)` | 设计 note：`FILE_DELETE_CHILD` 拒绝 + `CONTAINER_INHERIT_ACE` |
| `Low Mandatory Level:(OI)(CI)(NW)` | 设计 note：`S-1-16-4096` + `SYSTEM_MANDATORY_LABEL_NO_WRITE_UP` + `OI\|CI` |

设计 note（`2026-09-19-windows-acl-mandatory-integrity-confinement.zh.md`）里写明：

> 标签在工作区根上常驻……按会话回收会导致每次供给都重新传播整棵树

`OI|CI` 就是病根，它让标签落到工作区里**每一个文件对象**上，包括编译产物和可执行文件。

二、补充证据：把 exe 标成 Low 是净负收益（这点设计 note 没有覆盖）

建议团队评估一个反向问题——**当前策略在安全性上是减分项**：

- exe 若保持 `Medium`：Low 完整性的沙箱子进程受 `NO_WRITE_UP` 约束，**写不了**工作区里的二进制
- 现在 exe 被继承标成 `Low`：沙箱子进程**可以**改写它
- 而用户之后会以 `Medium` 身份运行这个二进制（双击、`npm run dev`、打包）

即沙箱子进程获得了改写「用户稍后以 Medium 运行的可执行文件」的能力。**排除了 exe 还能顺带解决你说的可用性问题，对安全和可用性都是正向的。**

三、补充证据：授权根内目录删除被拒（原帖未记录，可解释一类打包/清理失败）

对授权根内的子目录做 `GENERIC_ALL` 打开被拒，导致回收站操作失败（`genie-trash: Some operations were aborted`）、`electron-builder` 清理旧产物失败。这与 `Everyone:(CI)(DENY)(DC)` 那条 ACE 对得上。

四、我的复现数据（对照实验）

同一份 `node.exe`，同一时刻，同一 Medium 父进程，只换目录：

```
<workspace-root>\proj\.tmp   LOW(4096)       ← 工作区树内
...\DSH_Workspace                           LOW(4096)       ← 工作区根
...\<other-dir>                              Medium(8192)    ← 工作区外
...\AppData\Local\Temp                      Medium(8192)    ← 工作区外
```

工作区树下实测 **40 个 exe 全部为 Low**，无一例外。真实后果：Electron 项目 `npm run dev` 启动的主进程写自身 `%APPDATA%` 配置、写目标工程目录全部 `EPERM`；而打包安装版（装在 `%LOCALAPPDATA%\Programs\`）完全正常——同一份代码，差异只在 exe 的完整性标签。

五、关于「设计如此 / README 已记录」

README 第 177 行确实写了：

> 诊断保留完整性标签——它无法修复 Low 标签的可执行文件影响用户在 DSH 外启动程序的问题

但这句话承认的是「**无法修复**」，不是「**无需修复**」。一个用户完全无法察觉（`Get-Acl` 和「属性→安全」都看不出来）、无法自助恢复、且会让整个开发工具链静默失效的副作用，**至少应该提供一个 release 命令**。README 也指出手工 `icacls` 清 `S-1-4-*` 会因 `ERROR_NONE_MAPPED`(1332) 失败，官方命令是必要的逃生口。

我的三条建议（与原帖方向一致，按收益排序）：

1. **排除可执行文件不继承标签**（`*.exe` / `*.dll` / `*.node`）——同时解决可用性和上面第二节的安全问题
2. **提供 `dsh sandbox release --workspace <dir>`** 显式回收标签 + `S-1-4-*` ACE + `Everyone` 删除拒绝
3. 供给时若检测到工作区内有 exe，UI 上明确提示，并扩展已有的 `diagnose-windows-sandbox-acl` 诊断技能去发现这些 exe

用户侧临时规避（已在本机验证有效，会被下次供给重新施加）：

```powershell
icacls "<工作区>" /setintegritylevel (OI)(CI)Medium
icacls "<工作区>" /remove:d Everyone
```

完整记录（含 P/Invoke 读完整性级别的完整脚本）我已整理在本地；需要的话可以贴出来。

+1 @namoshizun 的反馈——这不是个别环境问题，**只要工作区里编译出 exe 就会中招**，影响面是「所有在 Windows 上用 DSH 做开发的人」。