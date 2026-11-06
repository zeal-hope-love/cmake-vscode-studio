# CV Studio 项目交接文档

> 最后更新：2026-11-04 · v2.0.1
> 这份文档记录「为什么这么做」和「踩过什么坑」，代码的「怎么做」看源码注释。
> 故障排查（写入全部 EPERM / 调试起不来 / 打包失败）见 [TROUBLESHOOTING.md](./TROUBLESHOOTING.md)。

---

## 一、项目是什么

**CV Studio** — Windows 下的 STM32 / CMake 工程配置与调试文件生成器。

- **技术栈**：Electron 44 + electron-vite + React 19 + TypeScript + zustand
- **定位**：给 RoboMaster 战队用的开发辅助工具，读工程 → 生成 `.vscode` 配置 → 一键调试
- **杀手功能**：VT13 遥控模块移植（把旧 SBUS 协议工程自动迁到 VT13 新协议）

### 仓库

| 仓库 | 用途 |
|---|---|
| `zeal-hope-love/cmake-vscode-studio` | 源码 + 通用发布（更新检测读这个） |
| `CUST-CVIR-RM/ECU_Remote-control-transplant` | 团队工程仓库（私有）+ 配套工具发布 |

---

## 二、核心架构

```
src/
├── main/                     主进程（不依赖任何渲染进程代码）
│   ├── index.ts              应用入口：窗口、单实例锁、生命周期
│   ├── ipc/                  IPC 通道注册，按域一个文件（共 57 个通道）
│   │   ├── index.ts            registerIpc：装配 + 快照目录初始化
│   │   ├── common.ts           唯一的 ProcessRunner 实例 + 三个小工具
│   │   ├── app.ts              应用信息 / 设置 / 系统对话框
│   │   ├── project.ts          扫描载入 / 生成配置 / 快照 / 清理
│   │   ├── cmake.ts            构建目标与源文件、改工程名
│   │   ├── pack.ts             模块包与移植包、参数预设
│   │   ├── template.ts         配置模板（含批量套用）
│   │   ├── history.ts          写入历史
│   │   ├── update.ts           版本更新
│   │   └── run.ts              启动/取消构建进程
│   └── services/
│       ├── cmake/            【解析】cmakeParser(读) / cmakeModel(位置感知) / cmakeEdit(改)
│       ├── project/          【读工程】scanner / sourceScanner / symbolScanner /
│       │                     elfSymbols / workspaceFinder / toolDetector / projectRename
│       ├── data/             【持久化】store(JSON 底座) + settings/template/preset/
│       │                     snapshot/history/vofaMap/addrTable 七个 Store
│       │                     commit.ts = 写盘两道闸（存快照 / 记历史）
│       ├── generate/         【产出】generators(生成 .vscode 内容) / writer(落盘) / vscodeOwnership
│       ├── util/             【零依赖小件】jsonc / paths / fileWrite(退避重试)
│       ├── update/           【网络】updateChecker / updateDownloader
│       ├── cubeMx/           【平台】跑 CubeMX：找→跑→核对产物
│       ├── ioc/              【平台】.ioc 读(index) / 写(edit) / 算(uart)
│       ├── pack/             【常规包】声明式包的安装流水线
│       │   ├── index.ts        render / patches / plan / apply / postApply 的门面
│       │   ├── render.ts       模板 + 参数 + 工程事实 → 全文（可能 throw）
│       │   │                   渲染器由 pack.json 的 generated[].render 声明，不猜
│       │   ├── patches.ts      往已有文件插东西（CMake/freertos/宏）
│       │   ├── plan.ts         算改动清单，不写盘
│       │   ├── apply.ts        快照 → 写 → 记历史
│       │   ├── postApply.ts    跑 CubeMX + 读回真实波特率
│       │   ├── catalog.ts      packs 目录定位 + pack.json 装载
│       │   ├── facts.ts        探工程里有什么（不判断、不看包）
│       │   ├── compat.ts       拿事实判断能不能装、要适配什么
│       │   ├── pidScan.ts      扫 PID 结构体，给界面填默认值
│       │   ├── packStore.ts    ↑ 四个的门面（对外 import 路径不变）
│       │   └── packPortInstaller.ts  移植包编排（快照 + 流水线 + 历史）
│       ├── vt13/             【专用】VT13 移植：iocSpec / itHandler / codeTransform /
│       │                     postCubeMxCheck / portRunner
│       └── runner.ts         【运行】构建/烧录进程，逐行解 GBK+UTF-8
├── preload/index.ts          IPC 白名单桥（**加通道必须同步改这里**）
├── renderer/                 React 界面
│   ├── pages/                一屏一个
│   │   ├── LaunchPage.tsx      只留布局；launch/meta.ts 常量、launch/build.ts 造配置
│   │   ├── TemplatesPage.tsx   只留渲染；templates/useTemplatesPage.ts 状态与动作
│   │   └── …
│   ├── components/           复用件（ui.tsx / icons.tsx / Resizable / …）
│   └── state/                zustand
│       ├── store.ts            门面：状态初始值 + 拼装 slice
│       ├── storeTypes.ts       StudioState 形状 + set/get 类型
│       ├── slices/             按域切：core / project / write / onboarding /
│       │                       run / templates / packs / history（共 51 个动作）
│       └── helpers.ts          纯函数（bundle → 文件、主题、canonicalJson…）
└── shared/                   三端共用：类型 + 纯函数
    ├── types/                按域拆的 IPC 契约（project/tools/debug/generate/
    │                         runtime/app/settings/cmake/ipc/pack + index 门面）
    ├── packTypes.ts          模块包清单类型
    ├── templateFormat.ts     模板文件格式
    └── versionCompare.ts     版本号比较（纯函数，自检能跑）

installer/                    自定义 Electron 安装器
packs/                        模块包（remote-vt13、vofa）
tools/
├── selftest.ts               379 项自检（重构的安全网）
└── run-ts.mjs                把任意 TS 打包后直接跑（自检靠它）
```

### 2.1 目录归属规则

放文件之前先问一句「谁会用它」：

| 层 | 判据 | 允许 import |
|---|---|---|
| `services/util/` | 零业务知识的小工具 | 只依赖 node |
| `services/cubeMx/`、`services/ioc/` | **平台能力**，任何包都会用 | util + 自己 |
| `services/cmake/`、`project/`、`generate/`、`data/` | 一条业务主线 | 上面两层 |
| `services/pack/`、`services/vt13/` | **只服务某个包** | 以上全部 |
| `shared/` | 三端都要用的类型和纯函数 | 不 import main、不碰 fs |
| `renderer/pages/` | 路由级页面，一屏一个 | components / state |

四条硬规则，都是为了「加第三个包时不用改老代码」：

1. **专用层可以依赖通用层，反过来不行。** `ioc/uart` 不会 import `vt13/*` ——
   那是方向反了，加别的包就会互相缠住。
2. **通用层不 import 任何 installer。** `cubeMx/` 不知道「包」是什么，
   它只负责「把 .ioc 变成新代码」。谁调用、为什么调用，不关它事。
3. **同一个能力只有一份实现。** `cubeMx/` 同时被常规包和移植包用，就是这条的产物。
4. **能写盘的文件要少。** `pack/` 里只有 `apply.ts` / `postApply.ts` 会动磁盘，
    看 import 就能判断「这个调用会不会改我的工程」。
5. **生成文件用哪个渲染器，由 `pack.json` 的 `generated[].render` 声明。**
    代码里**不猜**模板名 —— 以前是 `template.includes('config')` 猜的，
    模板一改名就静默走错分支，把变量表塞进绑定模板，写出一份编译不过的 .c。
    现在缺 `render` 直接判清单错误、一个文件都不写。
6. **写盘前的快照只有 `data/commit.ts` 一个入口**（`openSnapshot` / `recordInstall`）。
    这条承诺原本抄在五个地方，其中两处**没判返回值** —— 存快照失败照样写、
    照样把文件丢进回收站。别在业务代码里再手写一遍 try/catch。

`vt13/` 保留项目代号，因为它**只服务 VT13 遥控移植这一个包**；
将来再加一个协议迁移包，应该是同级的 `xxx/`，而不是往 `vt13/` 里塞。

### 2.2 一次安装的通用骨架

两个 installer 长得不一样，但骨架是同一套。改一个的时候对照着看另一个：

```
① 算计划（纯函数，不落盘）  →  给用户看 diff
② 快照（要动的文件全存一份）  →  唯一的还原退路
③ 落盘（fileWrite 退避重试）
④ 外部副作用（CubeMX）      →  只有 .ioc 真变了才跑
⑤ 核对（读回真实值）        →  「改了」和「生效了」是两件事
⑥ 记历史（含失败项）
```

第 ⑤ 步是最容易被省掉、也最容易被用户骂的一步：`.ioc` 改成 921600、
`Src/usart.c` 还是 115200 时，波形照发、命令收不到，**不报任何错**。

② 和 ⑥ 现在都收在 `data/commit.ts`（`openSnapshot` / `recordInstall`）：
快照存不下就**一个文件都不写**，并且把原因原样带出来 —— 打包版里 stderr 看不到，
界面上那句「快照存不下」是用户唯一的线索。

### 2.3 加一个 IPC 通道要改三处

1. `shared/types/ipc.ts` 的 `IPC` 常量里加名字
2. `preload/index.ts` 的桥里加一行 —— **最容易漏**，漏了运行时报「不是函数」
3. `main/ipc/` 里对应域的文件加 `ipcMain.handle`

新域才需要在 `ipc/index.ts` 里多一行装配。通道名与 handler 是 1:1 的，
拆分后总数仍是 57（改完用 `grep -c ipcMain.handle src/main/ipc/*.ts` 对一下）。

### 2.4 这次拆分的结果

| 文件 | 拆前 | 拆后 |
|---|---|---|
| `ipc.ts` | 942 行 / 57 通道 | `ipc/` 10 个文件，最大 207 行 |
| `packInstaller.ts` | 1010 行 / 4 件事 | `pack/` 5 个文件，最大 304 行 |
| `shared/types.ts` | 1216 行 / 三端 import | `types/` 10 个文件，最大 371 行 |
| `services/` | 30 个文件平铺 | 10 个目录 + 1 个 `runner.ts` |
| `vt13/` | 混装平台能力 | 只剩 VT13 专用 |
| `pack/packStore.ts` | 722 行 / 4 件事 | `catalog` + `facts` + `compat` + `pidScan`，门面 20 行 |
| 写盘快照 | 5 处各写一遍（2 处漏判） | `data/commit.ts` 两个函数 |
| `state/store.ts` | 1184 行 / 51 动作 | `storeTypes` + 8 个 slice + `helpers`，门面 142 行 |
| `LaunchPage.tsx` | 945 行 | 741 行 + `launch/meta.ts` + `launch/build.ts` |
| `TemplatesPage.tsx` | 923 行 | 625 行 + `templates/useTemplatesPage.ts` |

验证方式固定三步：`npm run typecheck` → `npm run selftest`（379 项）→ `npm run build`。
三步全绿才算拆对；任一步挂了就回 `refs/backup/*` 的还原点。

**页面拆分的边界**：只把「和 React 无关的」搬出去（常量、纯函数、状态与动作），
JSX 一行不动。理由是 props 超过 8 个的「组件化」只是把复杂度换了个地方，
反而更难读。`LaunchPage` 的表单区（237 行）就故意留着了。

### 两条安装路径（容易混）

| | 常规包（vofa） | 移植包（VT13） |
|---|---|---|
| 入口 | `packPlan` → 用户看 diff → `packApply` | `packPortInstall` |
| 逻辑 | 算清楚每个文件改前改后 | 调外部程序（CubeMX），没法预先算 diff |
| 保底 | 用户确认 | 自动快照 + 可还原 |
| 界面 | ⑥ 改动清单 → 写入工程 | 进入移植流程（独立面板） |

判定方式：`isPortPack = Boolean(pack.iocChanges || pack.stateMachine)`

---

## 三、VT13 移植：核心差异

| 项 | 旧（3.27 SBUS） | 新（9.1 VT13） |
|---|---|---|
| 协议 | 18 字节 | 21 字节 + CRC16 |
| 串口 | USART3 | USART1 |
| DMA | DMA2_Stream1/2 | DMA1_Stream0/1 |
| 数据体 | `RC_ctrl_t` | `remote_data_t` |
| 通道访问 | `rc.ch[0]` 数组 | `rc.wheel` 命名字段 |
| 开关 | `rc.s[0]` / `rc.s[1]` 两值 | `rc.mode_sw` 单字段 |
| 按键 | `key.v` | `key` |
| 新增 | — | `wheel`、`trigger`、`fn_1/fn_2`、`pause` |

**关键认知**：这不是「装个库」，而是**协议 + 数据结构双换**。所以独立 `.c/.h` 只能承载协议解析，**11 个业务文件必须逐个改**（`chassis_behaviour`、`gimbal_behaviour`、`shoot`、`servo_task`、`usb_task` 等）。

**新旧是替换不是共存**，回退靠快照（「系统 → 历史与恢复」）。

---

## 四、踩过的坑（重点看这里）

### 4.1 CDC_Receive_FS 的 static 冲突 ⭐

**现象**
```
error: static declaration of 'CDC_Receive_FS' follows non-static declaration
```

**根因**

| 位置 | 状态 |
|---|---|
| `usbd_cdc_if.c:132/266` | `static`（CubeMX 生成，**在 USER CODE 区外面**，每次生成都会改回去） |
| `usbd_cdc_if.h:113` | 非 `static`（用户加的，在 USER CODE 区） |

两处矛盾 → 编译不过。

**错误解法**（试过，治标不治本）：CubeMX 生成后自动删掉 `.c` 里的 `static`。用户手动点 CubeMX 生成时又坏。

**正确解法**：**业务代码不调那个函数**，改用标准 API。

```c
// application/usb_task.c —— CubeMX 不碰这个文件
extern USBD_HandleTypeDef hUsbDeviceFS;   // 需要自己声明，头文件没暴露

// 原来： CDC_Receive_FS(usb_rx_buf, &len);
// 改成（这两行就是 CDC_Receive_FS 的全部内部实现）：
USBD_CDC_SetRxBuffer(&hUsbDeviceFS, usb_rx_buf);
USBD_CDC_ReceivePacket(&hUsbDeviceFS);
```

再把 `usbd_cdc_if.h` 里那行冲突声明删掉。**`usbd_cdc_if.c` 一个字都不改。**

**实测**：跑完整 CubeMX 生成（56 秒）后直接编译 → `Linking C executable Hero_9.1.elf`，退出码 0，零手工修复。

---

### 4.2 布局问题：一直是同一个坑 ⭐

**症状**：文字叠在一起 / 卡片被压扁 / 徽标被截断。**连续 5 次没修好。**

**根因链**

```
.main__content 没有 flex-direction（默认 row）
  → 页面每个直接子元素成为「并排的 flex 项」
  → 宽度按内容算
  → .workflow 内容一宽就撑开容器
  → 内部的 flex-wrap 永远不触发
  → 元素重叠
```

我一直在调 `.workflow` / `.workflow__probe` **自己**的 flex 属性，**没往下看**。

中间还犯了第二个错：给 `.main__content` 加 `display:flex; flex-direction:column` 修好了宽度，但**纵向 flex 里子元素默认 `flex-shrink:1`**，卡片全被压成一条。

**最终解法**
```css
.main__content { display: block; }   /* 普通块级容器，宽度天然确定 */
.main__content > * { width: 100%; box-sizing: border-box; }
```

**教训：布局问题从最外层容器往下查，别盯着出问题的元素本身。**

---

### 4.3 改全局类去实现局部效果

为了让检查列表的符号「好看点」，给 `.badge` 加了 `border-radius: 50%`。

`.badge` 是**全局通用类**，探针名、芯片型号、模板标签都用它 → **所有标签全变成圆圈**。

**教训：不要改全局类去实现局部效果。拆出新类（如 `.mark`）。**

---

### 4.4 手画图标

安装器窗口里手画了个 SVG「圆环 + C」，但真实图标是「蓝色圆角方块 + 带缺口的字母 C」。`resources/icon.png` 明明就在那儿。

**教训：有唯一正确参考的东西（图标、logo），直接用现成资源，别凭印象重画。**

---

### 4.5 环境差异：Node fetch 证书失败 ⭐

**症状**：更新检测在开发机通，用户机器上 `UNABLE_TO_VERIFY_LEAF_SIGNATURE`。

**根因**：Node 的 `fetch` **只信任 Node 内置根证书，不读系统证书库**。装了代理/抓包软件的机器上必然失败。

**解法**：用 Electron 的 `net.fetch`（走 Chromium 网络栈，读系统证书和代理设置）。

```ts
import { net } from 'electron'
const res = await net.fetch(url, { headers: { 'User-Agent': '...' } })
```

**这条对任何联网功能都适用。**

---

### 4.6 其他 Windows 坑

| 现象 | 根因 | 解法 |
|---|---|---|
| 写文件 EPERM | 文件被占用 | 退避重试 + 降级到 4 个备选位置 |
| 删目录 EBUSY | **程序正在运行，exe 被锁** | 安装前 `tasklist` 检查 + `taskkill /F /T` |
| PowerShell 读中文乱码 | 无 BOM 的 UTF-8 被当 GBK | 脚本带 BOM 或纯 ASCII |
| esbuild 报 Access denied | `%TEMP%` 清理失败 | `TMP`/`TEMP` 指向工作区内 |
| CubeMX 静默转发 | 有残留 `javaw` 时新调用直接 exit 0 | 启动前 `Stop-Process javaw` |

---

## 五、发布流程

```bash
# 1. 升版本
npm version patch           # 2.0.1 → 2.0.2

# 2. 构建（两个命令都要跑）
npm run dist:installer      # NSIS + portable
npm run dist:setup          # 自定义 Electron 安装器

# 3. 打 tag 并推送
git add -A && git commit -m "chore: 版本升到 X.Y.Z"
git tag -a vX.Y.Z -m "..."
git push origin main vX.Y.Z

# 4. 发布
gh release create vX.Y.Z --notes-file notes.md release/*X.Y.Z*.exe
```

**环境**
- `gh` CLI 在 `C:\Program Files\GitHub CLI\`，已登录 `zeal-hope-love`（`repo` 权限）
- 团队仓库另发一次：`gh release create vX.Y.Z -R CUST-CVIR-RM/ECU_Remote-control-transplant ...`

---

## 六、已知限制

| 限制 | 说明 |
|---|---|
| **没有代码签名** | 安装时 Windows 提示「未知发布者」，点「仍要运行」即可。正规证书约 2000-4000/年 |
| **更新检测指向公开仓库** | 私有仓库 API 要 token，普通用户拿不到 |
| **GUI 无法自动化测试** | 界面改动靠 Chrome 静态渲染 + 人工实测 |
| **CubeMX 需要单独安装** | CubeCLT 不含它，路径 `%LOCALAPPDATA%\Programs\STM32CubeMX` |

---

## 七、习惯约定

- **回复用中文**
- **提交信息写清楚「为什么」，不只是「改了什么」** —— 看 `git log` 能快速理解上下文
- **改完要验证**：纯逻辑写自检（现在 260 项），界面用 Chrome headless 截静态 HTML
- **不要为了「好看」改全局类**
- **布局问题从外往里查**

---

## 八、下一步可以做

1. **VT13 移植加实机验收** —— 现在是静态检查，加烧录后读遥控数据的验证
2. **清理 `.bak` 残留** —— 工程里有 `remote_control.c.bak` 这类文件，做进工具的清理流程
3. **代码签名** —— 解决「未知发布者」，也能上真静默更新
4. **模板导入导出的 UI 入口** —— 功能有了，入口还比较隐蔽