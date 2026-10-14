# 开发、调试与签名

这份文档回答三个问题：这类开发用什么工具、怎么调试、怎么给 exe 签名。
所有命令都针对本项目，可以直接照抄。

---

## 一、用什么软件开发

### 结论：就是 VS Code

Electron 应用不是什么"另一种语言"，它就是 **Node.js + 一个 Chromium 窗口**：

- 主进程 / 预加载 = Node.js 程序 → 用 Node 那一套工具
- 渲染进程 = 网页 → 用前端那一套工具

所以生态里**不存在"Electron 专用 IDE"**，主流就是 VS Code。原生 Windows 桌面开发会选 Visual Studio，跨平台桌面（Qt / GTK）各有各的 IDE，但 Electron 走的完全是 Web 前端的工作流。

### 本项目的工具链

| 用途 | 工具 | 状态 |
| --- | --- | --- |
| 编辑器 / IDE | VS Code | 已配好 `.vscode/`（调试配置 + 任务） |
| 构建 | `electron-vite`（内部是 Vite 7 + esbuild） | 已装 |
| 类型检查 | `tsc` 5.9 | 已装 |
| 界面框架 | React 19 | 已装 |
| 状态管理 | zustand | 已装 |
| 打包 | `electron-builder` 26 | 已装 |
| 运行时调试 | Chrome DevTools（Electron 内置） | 开箱可用，按 F12 |
| 主进程调试 | Node V8 Inspector | `npm run dev:inspect`，已实测 |

### 那 WebStorm / IDEA 呢？

一句话：**WebStorm 换不换都行，IDEA Ultimate 是错的选择，CLion 完全不行。**

| IDE | 适合写这个项目吗 | 说明 |
| --- | --- | --- |
| **VS Code** | ✅ 首选 | 生态一等公民；本项目 `.vscode/` 已配好，打开按 F5 就能调试 |
| **WebStorm** | ✅ 也很好 | 对 React + TS 的重构、类型推导提示确实更强。**非商业用途免费**（JetBrains 2024-10 起），只在商业用途才要付费 |
| IntelliJ IDEA Ultimate | ❌ 不划算 | Java/Kotlin 定位；Web 能力和 WebStorm 重叠但更重，为这个项目买它没意义 |
| **CLion**（你已装） | ❌ 不能用 | C/C++ IDE，对 TS/JS 基本只有文本编辑：没有 TS 语言服务、没有 JSX。**它是用来调你的 STM32 工程的，不是写这个工具的** |
| DevEco Studio | ❌ 不合适 | IntelliJ 平台但为鸿蒙准备，挂了一堆 HarmonyOS 插件 |

**WebStorm 用户**：项目里已经放好了 `.idea/runConfigurations/`，打开就能用，不用自己建：

| 配置名 | 干什么 |
| --- | --- |
| 启动（开发模式） | 等价 `npm run dev` |
| 启动（主进程可调试） | 等价 `npm run dev:inspect`，起 5858 端口 |
| 附加到主进程（5858） | attach 主进程下断点 |
| 附加到渲染进程（9222） | attach 渲染进程下断点 |

如果 XML 没被识别（版本差异），在 GUI 里手动建也一样：**Run → Edit Configurations → + → Attach to Node.js/Chrome**，Host `localhost`，Port 填 **5858**（主进程）或 **9222**（渲染进程）。这个对话框的字段说明见 [JetBrains 官方文档](https://www.jetbrains.com/help/webstorm/run-debug-configuration-node-js-remote-debug.html)。

> 关于授权：
> - **非商业用途**：WebStorm 自 2024-10 起免费（[官方公告](https://blog.jetbrains.com/blog/2024/10/24/webstorm-and-rider-are-now-free-for-non-commercial-use/)）。如果这个工具只自用，免费授权就够了。
> - **学生 / 教师**：JetBrains 学生包免费，包含 **IntelliJ IDEA Ultimate、WebStorm、CLion 等全部产品**，按年续期（[官方说明](https://sales.jetbrains.com/hc/en-gb/articles/207241195-Do-you-offer-free-educational-licenses-for-students-and-teachers)）。**限制是不能用于商业目的**，毕业后有 40% 折扣、有效期 2 年。
> - 这个工具一旦用于商业目的，就需要付费许可。
> - 别用破解版：免费授权已经覆盖个人场景，而破解版 IDE 被植入后门是真实存在的攻击手法——一个能读你全部源码和凭据的程序不值得冒这个险。

### ⚠️ 本项目正被配置的工程：用 CLion

注意区分两个东西：

| | 用什么 |
| --- | --- |
| **写这个配置器工具**（Node + React + TS） | VS Code 或 WebStorm |
| **被这个工具配置的 STM32 工程**（C + 汇编 + 链接脚本） | CLion 或 VS Code + cortex-debug |

CLion 对 C/C++ 和嵌入式（CMake、OpenOCD、GDB）的支持是 JetBrains 里最强的，你机器上已经装了 2026.2.2。写这个工具时**不要**开 CLion，它没有 TS 语言服务。

### 代码风格：先配好，再动手

**动手改代码之前先花 1 分钟把格式化规则确认一下**，否则 WebStorm 里按一次 `Ctrl+Alt+L`（Reformat Code）就会把整个代码库改成另一套风格 —— WebStorm 的默认是 **4 空格 + 分号 + 双引号**，而本项目是 **2 空格、无分号、单引号**。

项目里已经放好了三个文件，两个 IDE 都会自动读取：

| 文件 | 作用 |
| --- | --- |
| `.editorconfig` | 缩进 2 空格、LF 换行、UTF-8、去行尾空格（`.bat` 例外，必须 CRLF） |
| `.prettierrc.json` | `semi: false` / `singleQuote: true` / `printWidth: 104` / `trailingComma: none` |
| `.prettierignore` | 排除 `out/` `release/` 截图和 Markdown |

命令行统一格式：

```powershell
npm run format         # 格式化 src/ 和 tools/
npm run format:check   # 只检查，不修改（CI 用）
```

**VS Code**：`.vscode/settings.json` 里已经设成 Prettier 格式化 + 保存时自动格式化，装好推荐扩展就生效。

**WebStorm**：
1. Settings → Languages & Frameworks → JavaScript → **Prettier**，勾选 *Automatic Prettier configuration*（它会自动找到项目的 `.prettierrc.json` 和本地 prettier）
2. 勾上 **Run on save**（保存时自动格式化）
3. 想去掉"整个文件都不符合格式"的波浪线提示：Settings → Editor → Inspections → 把 Prettier 的检查级别调低

> 本项目已经全量跑过一次 `npm run format`，所以现在整个代码库都是 Prettier-clean 的 —— 你随便改哪个文件，保存时都只会有你自己的改动，不会突然冒出几百行格式差异。

### 建议装的 VS Code 扩展

```
dbaeumer.vscode-eslint          # 如果你后面加 ESLint
esbenp.prettier-vscode          # 格式化（本项目目前没启用 formatOnSave）
usernamehw.errorlens            # 行内显示错误
antfu.iconify / PKief.material-icon-theme   # 可选，纯观感
```

### 辅助工具

- **Electron Fiddle**（`npm i -g electron-fiddle`）—— 想快速验证某个 Electron API 的行为时，开一个空白工程试，不用污染本项目。
- **React DevTools** —— 排查组件状态。Electron 里装它有两种方式：
  ```bash
  npm i -D electron-devtools-installer
  ```
  然后在主进程 dev 分支里 `installExtension(REACT_DEVELOPER_TOOLS)`。本项目目前没装，因为状态都集中在 `src/renderer/src/state/store.ts`，直接读 store 更快。

---

## 二、怎么调试

Electron 有三层，调试方式各不相同：

```
主进程 (src/main)       ← Node 环境，改完要重启
  └─ 预加载 (src/preload) ← 桥接层，跟主进程一起调试
渲染进程 (src/renderer)  ← Chromium 环境，支持热更新
```

### 1. 渲染进程（界面）—— 最简单，日常主力

```powershell
npm run dev
```

窗口起来后按 **F12**（本项目已在 `src/main/index.ts` 里绑定了这个快捷键），或者 `Ctrl+Shift+I`。

能做：
- Elements 面板查样式（我们的 class 全在 `src/renderer/src/styles/global.css`）
- Console 里直接 `window.api.getSettings()` 调 IPC 看返回
- ~~Sources 打断点~~ —— 更推荐改代码，Vite 会热更新

**想用 IDE 的断点器调渲染进程**（VS Code 的「调试渲染进程（attach 9222）」或 WebStorm 的同名配置）：
开发模式下主进程会自动开放 **9222** 端口（`--remote-debugging-port`，只绑 127.0.0.1，打包版不执行）。
实测确认：

```
9222 : 监听中 ✓
type=page  title=CMake / VSCode 工程配置器  url=http://localhost:5173/
```

**热更新边界**：改 `src/renderer/**` 立即生效；改 `src/main/**` 或 `src/preload/**` 会自动重启 Electron（electron-vite 的行为）。

### 2. 主进程（文件系统 / 进程操作）—— 用 IDE 断点

```powershell
npm run dev:inspect      # 相当于 electron-vite dev --inspect --sourcemap
```

它会在 **5858** 端口起一个 Node V8 Inspector。已实测：

```
端口 5858 是否在监听: True
V8 Inspector 响应: { "Browser": "node.js/v24.21.0", "Protocol-Version": "1.1" }
```

然后在 IDE 里附加：
- **VS Code**：按 F5，选「调试主进程（attach 5858）」（配置在 `.vscode/launch.json`）
- **WebStorm**：选「附加到主进程（5858）」（配置在 `.idea/runConfigurations/`）

现在你可以在 `src/main/services/generators.ts` 之类的文件里直接下断点，走到时源码是对得上的（靠 `--sourcemap`）。

想在最开始就停住、不错过启动阶段的代码：

```powershell
npm run dev:brk          # --inspectBrk，第一行就断
```

**预加载脚本**（`src/preload/index.ts`）跟主进程一起调试，不用单独配。

### 3. 不开图形界面时的调试 —— 本项目的杀手锏

主进程的业务逻辑（解析 CMake、生成配置、写文件）**完全不依赖 Electron**，所以可以直接跑：

```powershell
npm run selftest         # 86 项端到端检查
```

它用 esbuild 把 `tools/selftest.ts` 打成 CJS 再跑，覆盖：
工具探测与环境变量优先级 → 真实工程检测 → 合成工程全链路（生成/预览/写入/幂等）→ 备份与越界防护 → 固件名以 CMake 声明为准 → 快照与还原 → 工程发现 → 真的启动一次 OpenOCD。

改完主进程逻辑先跑这个，比开界面点半天快得多。加断言就是在 `tools/selftest.ts` 里加一行 `check(...)`。

**排查「为什么工具显示的是 X 而不是 Y」** —— 用命令行版的检测：

```powershell
npm run scan -- "C:\Users\someone\proj\my-firmware"
```

它会直接打印：工程根、CMake 目标、固件名及其来源与可信度、芯片、各构建目录的产物、解析到的 include、警告与提示，以及**将要写入的内容摘要**（executable / device / compileCommands / svdFile / 接线配置名 / 任务数）。比在界面上翻页找快得多。

想跑别的 TS 脚本也行：

```powershell
node tools/run-ts.mjs tools/scan.ts <工程路径>
```

### 4. 打包后的 exe 怎么调试

`.vscode` 里的配置只对源码有效。打包后的 exe：

- **界面**：按 F12 一样能开 DevTools（`installScreenshotHook` 之外，DevTools 快捷键是无条件注册的）
- **无头自检**：本项目内置了截图钩子，可以确认某个 exe 到底能不能正常渲染：

  ```powershell
  $env:CFGSTUDIO_SHOT = "C:\temp\shot.png"
  $env:CFGSTUDIO_SHOT_DELAY = "8000"
  $env:CFGSTUDIO_SHOT_JS = "[...document.querySelectorAll('.navitem')].find(b=>b.textContent.includes('工具'))?.click()"
  .\release\win-unpacked\CMake-VSCode-Configurator.exe
  ```

  它会加载 → 执行 JS → 截图 → 自动退出。只有显式设置环境变量时才生效，正常使用不受影响。

### 5. 本项目的调试截图脚本

要一次把 8 个页面都截下来：

```powershell
pwsh -File tools/take-shots.ps1     # 输出到 .dsh_shots/
```

> ⚠️ 写这个脚本时踩过一个坑：**不要**把 Electron 的输出重定向到 `> $null` 或 `*> $null`，那样 Electron 会静默起不来（`$LASTEXITCODE` 为空、什么都不发生）。必须用管道，例如 `& $exe . 2>&1 | Set-Content run.log`。

### 6. 常见的调试坑

| 现象 | 原因 | 处理 |
| --- | --- | --- |
| 界面起不来、`require('electron')` 是 undefined | 环境里有 `ELECTRON_RUN_AS_NODE=1` | 清掉它（`启动配置器.bat` 已代劳） |
| 断点打在 `.ts` 上不生效 | 没生成 sourcemap | 用 `npm run dev:inspect`（带了 `--sourcemap`） |
| 打包后白屏 | 渲染层路径或 asar 问题 | 用第 4 节的截图钩子确认；本项目的 `loadFile` 路径在 `src/main/index.ts` |
| IPC 调不通 | 通道名拼错 | 通道名全部集中在 `src/shared/types.ts` 的 `IPC` 常量里，两边都引用它 |
| 改了主进程没反应 | 进程没重启 | electron-vite 会重启；如果卡住，手动关掉 `electron.exe` |

### 7. IPC 的调试思路

本项目所有跨进程调用都走 `preload` 暴露的白名单 API（`window.api.*`）。排查时在 DevTools Console 里直接调：

```js
await window.api.detectTools({ probeVersions: true })
await window.api.loadProject('C:\\Users\\someone\\Desktop\\STM32\\SBV')
```

要加新通道，改四处：`src/shared/types.ts`（通道常量 + `StudioApi` 接口）→ `src/main/ipc.ts`（处理器）→ `src/preload/index.ts`（暴露）→ 页面里调用。

### 8. 打包时会踩的坑（实测踩过）

**症状**：`electron-builder` 在最后一步卡住不退出，日志停在

```
• output file is locked for writing (maybe by virus scanner) => waiting for unlock...
```

**真实原因不一定是杀毒软件。** 实测下来最常见的是**上一次运行`portable.exe` 留下的进程没退干净**，一直占着 `release\*.portable.exe`。连锁反应很难查：

1. 进程占着文件 → `Remove-Item release -Recurse -Force` **静默失败**（`-ErrorAction SilentlyContinue` 把报错吞了）
2. 旧产物残留 → electron-builder 覆盖时被锁 → 报 "waiting for unlock" 或直接失败
3. 如果你这时候手动 Ctrl+C，`release/` 里可能留下**旧版本的 exe**，而你以为它是刚打的

**排查与处理**：

```powershell
# 1. 先看有没有残留进程
Get-Process -Name "CMake-VSCode-Configurator","electron" -ErrorAction SilentlyContinue

# 2. 杀掉
Get-Process -Name "CMake-VSCode-Configurator","electron" -ErrorAction SilentlyContinue | Stop-Process -Force

# 3. 清空 %TEMP% 里的便携版解压目录
Get-ChildItem $env:TEMP -Directory |
  Where-Object { Test-Path (Join-Path $_.FullName 'CMake-VSCode-Configurator.exe') } |
  Remove-Item -Recurse -Force

# 4. 删 release 并【验证真的删掉了】
Remove-Item release -Recurse -Force
Test-Path release      # 必须是 False，否则有东西还占着
```

**打包后一定要验证产物是不是最新的**（尤其是你中途打断过）：

```powershell
Get-ChildItem release -File | Select-Object LastWriteTime, Name
```

时间戳不对就说明是残留的旧文件。

`tools/take-shots.ps1` 之类的脚本跑完记得清理进程 —— 它们会启动真实的 Electron 实例。

---

## 三、怎么给 exe 签名

### 为什么必须签

不签名的 exe：

- Windows SmartScreen 弹「**已保护你的电脑**，未知发布者」——用户第一次运行会被吓到
- 部分企业安全策略直接拦截
- 杀毒软件误报率明显更高

### 关键前提：2023 年 6 月起，证书私钥必须在硬件里

CA/Browser Forum 的强制要求：OV / EV 代码签名证书的私钥**不能再以 `.pfx` 文件形式交付**，必须放在 USB 硬件令牌或云 HSM 里。

这意味着：**你不能再把 `cert.pfx` 塞进 CI 的 secrets 里签名了。** 这是很多人踩的坑。

### 三种证书的取舍

| 方案 | 价格（量级） | SmartScreen 信誉 | 适合 |
| --- | --- | --- | --- |
| **OV 证书** | $200~400 / 年 | 要慢慢积累，前期仍弹警告 | 有一定下载量的产品 |
| **EV 证书** | $400~700 / 年 | **立即生效，不弹警告** | 商业产品、面向陌生用户 |
| **Azure Trusted Signing**（原 Azure Code Signing） | 约 $10 / 月 | 与 OV 相当 | **个人 / 小团队首选** |
| 自签名证书 | 免费 | 无任何帮助 | 内网分发、自己测试 |

> 价格和具体政策请以 CA 官网为准，这里只给量级。

**给个人开发者的建议：Azure Trusted Signing。** 不需要买硬件令牌、不需要处理 token 驱动，身份验证通过后在云端签名，成本比买证书低一个数量级。electron-builder 26 **原生支持**（我确认过 schema 里有 `win.azureSignOptions`）。

### 落地配置（按本项目实际支持的选项）

#### 方案 A：Azure Trusted Signing（推荐）

1. 注册 Azure，创建 **Trusted Signing Account** + **Certificate Profile**
2. 完成身份验证（个人 3~5 个工作日，需要身份证件 / 营业执照）
3. 在 `electron-builder.yml` 里加：

```yaml
win:
  azureSignOptions:
    endpoint: https://weu.codesigning.azure.net          # 区域要和账户一致
    codeSigningAccountName: your-signing-account
    certificateProfileName: your-profile
    publisherName: PoXia                                  # 必须和证书上的完全一致
```

4. 认证走 `DefaultAzureCredential`，给这些环境变量即可（本地 `az login` 也行）：

```
AZURE_TENANT_ID
AZURE_CLIENT_ID
AZURE_CLIENT_SECRET
```

> `azureSignOptions` 和 `signtoolOptions` **互斥**，同时配会以 Azure 为准。

#### 方案 B：传统证书 + Windows 证书存储（EV/OV，硬件令牌）

证书装进系统证书存储（令牌驱动会自动做），然后：

```yaml
win:
  signtoolOptions:
    certificateSubjectName: "你的公司名称"        # 证书上的 "颁发给"
    publisherName: PoXia
    rfc3161TimeStampServer: http://timestamp.digicert.com
```

`certificateSubjectName` 就是给 EV 证书用的 —— 当证书在存储里、私钥不可导出时靠它定位。

#### 方案 C：有 `.pfx` 文件的情况（老证书或自签名）

```yaml
win:
  signtoolOptions:
    certificateFile: C:\path\to\cert.pfx
    certificatePassword: ${env.CSC_KEY_PASSWORD}
    publisherName: PoXia
    rfc3161TimeStampServer: http://timestamp.digicert.com
```

更推荐走环境变量而不是写进配置文件：

```powershell
$env:CSC_LINK = "C:\path\to\cert.pfx"
$env:CSC_KEY_PASSWORD = "密码"
npm run dist:installer
```

#### 方案 D：完全不想买证书

至少做两件事：

1. 在 `electron-builder.yml` 里设 `win.signAndEditExecutable: true`（默认就是），让 exe 带上正确的版本信息和图标 —— 这不会消除 SmartScreen 警告，但会让"属性"里看起来正规
2. 给用户一份「首次运行请点『更多信息』→『仍要运行』」的说明

本项目当前就是这种情况（没有证书），所以你第一次双击安装包会看到 SmartScreen 警告。

### 验证签名是否成功

```powershell
# 看状态
Get-AuthenticodeSignature .\release\CMake-VSCode-Configurator-1.0.0-x64.exe |
  Format-List Status, SignerCertificate, TimeStamperCertificate

# Status 应该是 Valid；有 TimeStamperCertificate 才说明时间戳生效
# 用 signtool 详细验证
signtool verify /pa /v .\release\CMake-VSCode-Configurator-1.0.0-x64.exe
```

**时间戳一定要配**（`rfc3161TimeStampServer`）。否则证书过期后，已经发出去的 exe 签名会全部失效。

### 强制签名（可选但推荐）

```yaml
win:
  forceCodeSigning: true    # 没签名就直接让打包失败，避免误发布未签名版本
```

CI 上尤其建议开，防止"配置漏了但打包成功"。

---

## 四、在 WebStorm 里用图形界面打包与签名

**先说结论：签名不是单独一步。** electron-builder 在打包过程中读 `electron-builder.yml`
里的 `win.azureSignOptions` / `win.signtoolOptions` 自动签名。所以「签名」= 「带着凭据跑打包」，
界面上没有也不需要「签名」按钮。

### 1. 打开 npm 工具窗口

- 左侧竖排按钮里的 **npm** 图标（View → Tool Windows → npm），或
- 项目树里右键 `package.json` → **Show npm Scripts**

双击脚本即运行，输出在 Run 工具窗口。

| 双击这个 | 作用 |
| --- | --- |
| `dev` | 开发模式启动（渲染进程热重载） |
| `dev:inspect` | 开发模式 + 主进程断点（5858 端口） |
| `selftest` | 92 项端到端自检，不启动界面 |
| `typecheck` | 类型检查 |
| `dist` | 打包成免安装目录 `release\win-unpacked\` |
| `dist:installer` | 打包成安装包 + 绿色版单文件 |
| `verify:signature` | 检查 release 下每个 exe 的签名与时间戳 |
| `open:release` | 打开 release 目录 |

另外 `.idea/runConfigurations/` 里已经放好了几个运行配置，右上角下拉框直接选：

| 配置名 | 作用 |
| --- | --- |
| 启动（开发模式） | = `dev` |
| 启动（主进程可调试） | = `dev:inspect` |
| 附加到主进程（5858） / 附加到渲染进程（9222） | 断点调试 |
| 打包：安装包 + 绿色版 | = `dist:installer` |
| 打包：免安装目录 | = `dist` |
| **打包：带签名（先填凭据）** | 同上，但带签名用的环境变量 |
| 验证 exe 签名 | = `verify:signature` |

### 2. 签名凭据用图形界面填

1. 右上角运行配置下拉框 → **Edit Configurations…**
2. 左侧 **npm** 分类里选 **「打包：带签名（先填凭据）」**
3. 在 **Environment variables** 一栏填：

   | 变量 | 从哪来 |
   | --- | --- |
   | `AZURE_TENANT_ID` | Azure 门户 → Microsoft Entra ID → 概览 |
   | `AZURE_CLIENT_ID` | 注册的应用（服务主体）的应用程序 ID |
   | `AZURE_CLIENT_SECRET` | 同上的客户端密码 |

   > 值会明文存在 `.idea/` 下，别把带密码的配置提交到公开仓库。

4. 把 `electron-builder.yml` 里 `win.azureSignOptions` 的注释打开并填上账号信息：

   ```yaml
   win:
     azureSignOptions:
       endpoint: https://weu.codesigning.azure.net
       codeSigningAccountName: your-signing-account
       certificateProfileName: your-profile
       publisherName: PoXia
   ```

5. 点 **Run**。控制台会打印 `signing with ...` 说明签名真的执行了。

用传统证书（EV 硬件令牌 / `.pfx`）同理：放开 `signtoolOptions` 那段，
凭据用 **`CSC_LINK`** / **`CSC_KEY_PASSWORD`** 填在同一个位置。

### 3. 验证签名

双击 **`verify:signature`**，会列出每个 exe 的签名状态、签名者、**有没有打时间戳**。

- `Status: Valid` 才算签成功
- 没打时间戳的话，证书过期后已经发出去的 exe 签名会一起失效

### 4. 首次打包的注意事项

- 会从 npmmirror 下载 nsis / winCodeSign 等附加组件（约 20MB），已配好镜像
- 如果卡在 `output file is locked (maybe by virus scanner) => waiting for unlock`，
  通常是**上一次运行留下的进程还占着 `release\*.exe`**，见本文档第 8 节

### 5. 版本号怎么改

**版本号只有一个来源：项目根 `package.json` 的 `version` 字段。** 其它地方都是引用它：

| 显示在哪 | 取值来源 |
| --- | --- |
| 标题栏的小徽章 `v1.0.0` | `app.getVersion()` |
| 「?」→ 最后一步「关于与版本」 | 同上，另附 Electron / Chromium / Node 版本 |
| exe 属性 → 文件版本 / 产品版本 | 打包时 electron-builder 读同一个字段 |
| 打包产物文件名 `...-1.0.0-x64.exe` | `artifactName` 模板里的 `${version}` |

改版本号有两种方式：

**图形界面（WebStorm，推荐）**：npm 工具窗口里双击

| 双击这个 | 效果 |
| --- | --- |
| `version:patch` | 1.0.0 → 1.0.1（修 bug） |
| `version:minor` | 1.0.0 → 1.1.0（加功能） |
| `version:major` | 1.0.0 → 2.0.0（不兼容改动） |

**命令行**：

```powershell
npm version --no-git-tag-version patch
```

> 加 `--no-git-tag-version` 是因为这个项目不是 git 仓库；如果哪天变成 git 仓库，
> 去掉它就能顺便打 tag。

⚠️ **改完版本号必须重新打包**（`dist:installer`），否则 exe 属性里还是旧版本 ——
开发模式跑的是源码，不会去改已经打好的 exe。

### 6. 关于「产品名称」和内部名字

现在两边是一致的：

| 显示在哪 | 值 | 来源 |
| --- | --- | --- |
| exe 属性的「产品名称」 | `CMake-VSCode-Configurator` | `electron-builder.yml` 的 `productName`（也同步到了 `package.json`） |
| 应用内「关于」的应用名称 | 同上 | `app.getName()` |
| 应用数据目录 | `%APPDATA%\CMake-VSCode-Configurator` | 同上 |

> 早期 `package.json` 只有 `name: cmake-vscode-studio`，数据都存在 `%APPDATA%\cmake-vscode-studio`。
> 补上 `productName` 之后数据目录会变，所以 `src/main/services/store.ts` 里做了一次**一次性迁移**：
> 把老目录里的 `settings.json` / `templates.json` / `snapshots` 搬到新目录；万一搬不动就继续用老目录，
> 宁可不一致也不让你丢设置。

### 7. 想检查打包后的 asar 里到底装了什么

⚠️ **`npx asar extract-file` 会把文件写到「当前工作目录」** —— 在项目根目录直接跑
`npx asar extract-file xxx.asar package.json` 会**覆盖你源码的 package.json**（踩过这个坑）。
先切到临时目录再执行：

```powershell
New-Item -ItemType Directory -Force -Path .asarcheck | Out-Null
Push-Location .asarcheck
npx asar extract-file "..\release\win-unpacked\resources\app.asar" package.json
Pop-Location
```

只想确认某个字符串在不在 asar 里的话，用 Node 直接搜二进制更快，也不会写文件：

```powershell
node -e "const b=require('fs').readFileSync('release/win-unpacked/resources/app.asar'); console.log(b.includes(Buffer.from('欢迎使用','utf8')))"
```

---

## 五、一句话总结

- **用什么**：VS Code + electron-vite + React。Electron 没有专用 IDE，前端工具链就是它的工具链。
- **怎么调**：界面按 F12；主进程 `npm run dev:inspect` + VS Code attach 5858；业务逻辑用 `npm run selftest` 无头跑。
- **怎么签**：个人/小团队上 **Azure Trusted Signing**（约 $10/月，不到买证书的零头）；要立即不弹警告就买 **EV 证书**（硬件令牌，贵）；千万别想着往 CI 里塞 `.pfx` —— 2023 年之后这条路在正规 CA 那里已经堵死了。
