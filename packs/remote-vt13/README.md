# 遥控模块 VT13

把工程的遥控从**旧 SBUS**（18 字节、USART3）换成 **VT13 新协议**（21 字节 + CRC16、USART1 + DMA 双缓冲）。

## 这个包会动哪些东西

| 步骤 | 动什么 | 能不能撤销 |
|---|---|---|
| ① 改 `.ioc` | USART1 波特率 / NVIC / DMA 请求 | 快照 |
| ② 调 CubeMX | **覆盖 `Src/`、`Inc/`** | 快照 |
| ③ 屏蔽 IRQ | `stm32f4xx_it.c` 里包 `#if 0` | 快照 |
| ④ 替换 3 个文件 | `remote_control.c/h`、`bsp_rc.c` | 快照 |
| ⑤ 改造业务文件 | 11 个文件的字段替换 + `shoot.c` 状态机 | 快照 |

**工具在动任何文件之前会先存快照**，用「系统 → 历史与恢复」可以整体还原。

## 协议差异

| | 旧 SBUS | VT13 |
|---|---|---|
| 帧长 | 18 字节 | **21 字节**（含 CRC16） |
| 串口 | USART3 | **USART1** |
| DMA | DMA2_Stream1/2 | **DMA2_Stream5**（或 Stream2） |
| 通道访问 | `rc.ch[0..4]` 数组 | **`Right_x` / `Right_y` / `Left_x` / `Left_y` 位域** |
| 开关 | `rc.s[0]` / `rc.s[1]` 两档独立 | **`mode_sw`** 单字段（LEFT/MID/RIGHT） |
| 扳机 | 无 | **`trigger`** |
| 功能键 | 无 | **`fn_1` / `fn_2`** |
| 摇轮 | 无 | **`wheel`** |
| 暂停键 | 无 | **`pause`** |
| 键盘 | `key.v` | **`key`**（去掉 `.v`） |

## 字段映射（工具自动做）

| 旧写法 | 新写法 | 注意 |
|---|---|---|
| `rc.ch[0]` | `Right_y` | **前后，不是 Right_x** |
| `rc.ch[1]` | `Right_x` | 横移 |
| `rc.ch[2]` | `Left_y` | 云台 pitch |
| `rc.ch[3]` | `Left_x` | 云台 yaw |
| `rc.s[X]` | `mode_sw` | 三档开关 |
| `key.v` | `key` | |
| `mouse.x/y/z` | `mouse_x/y/z` | |
| `mouse.press_l/r` | `mouse_left/right` | |
| `RC_ctrl_t` | `remote_data_t` | |
| `switch_is_up(x)` | `switch_is_right(x)` | 上档 → 右档 |
| `switch_is_down(x)` | `switch_is_left(x)` | 下档 → 左档 |

## `shoot.c` 状态机变化

旧逻辑用「发射模式通道」`rc.s[1]` 的三档：

```
上档 = 开摩擦轮
中档 = 键盘 Q/E 控制
下档 = 单发（拨一下打一发）
```

新逻辑重新映射到 `mode_sw` + `fn_1` + `trigger`：

```
mode_sw 中/右 + fn_1 上升沿  → 开摩擦轮
mode_sw 左   或 再按 fn_1    → 关摩擦轮
mode_sw 中/右 + 键盘 Q       → 开摩擦轮
mode_sw 中/右 + 键盘 E       → 关摩擦轮
trigger 上升沿（或鼠标左键）  → 打一发
继续按住 trigger             → 连发
```

状态变量从单个 `last_s` 拆成 `last_sw` + `last_fn_1` + `last_trigger`。

## 硬件连接

VT13 接收机的 **SBUS 口** → 开发板丝印 **UART2**（= STM32 的 USART1）。

## 验收（工具自动跑 6 项）

1. 旧写法零残留（**全工程扫描** 146 个源文件）
2. CubeMX 产物正确（波特率 921600 / DMA2_Stream5 / Channel 4）
3. `USART1_IRQHandler` 不冲突
4. `.ioc` 里 DMA 是 `DMA_NORMAL` 不是 `CIRCULAR`
5. `USART1_IRQHandler` 只有 1 个有效定义
6. 幂等：再跑一次不产生新改动

## 实测结果

在 `20.standard_robot_vscode` 副本上完整跑通：

```
流水线     ✓ 预检 → .ioc(15项) → CubeMX(39秒/关2个弹窗) → 屏蔽 → 替换 → 改造(13文件) → 验收
验收       ✓ 6/6
编译       ✓ 114/114，链接出 standard_robot.elf（2231 KB）
符号       ✓ USART1_IRQHandler 只有 1 个（080174f4 T）
幂等       ✓ 147 个文件重复执行零改动
```

## 已知限制

- **只支持 USART1** —— 代码里写死了 `huart1` / `hdma_usart1_rx`。要换串口需要改 `remote_control.c`。
- **`shoot.c` 状态机改造是尽力而为** —— 各队写法差异大，匹配不到时会跳过并提示，不会硬改坏。
- **CubeMX 版本差异** —— 这个模板工程的 CubeMX 没生成 `USART1_IRQHandler`，所以屏蔽步骤是空操作；别的工程如果生成了，会自动包 `#if 0`。
