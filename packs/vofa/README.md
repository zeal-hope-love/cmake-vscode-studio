# vofa 模块包

**VOFA+ 在线调参**：把工程里挑出来的变量周期发到 VOFA+ 画波形，并支持用文本命令在线改参数。
调 PID 不用改代码、不用重烧、不用回 CubeMX。

## 装了之后工程里多了什么

```
application/vofa/
  vofa_task.c      模块本体（通用，不要手改）
  vofa_task.h      对外接口（不要手改）
  vofa_types.h     fp32/bool_t 来源适配（不要手改）
  vofa_config.h    ← 工具生成：串口 / 频率 / 开关
  vofa_bind.c      ← 工具生成：调哪些变量（就是你在界面上勾的那些）
```

**分工**：模块本体一次装好就不动了。以后想换调参目标，只重新生成 `vofa_bind.c` 一个文件 ——
`CMakeLists.txt`、`freertos.c`、`vofa_task.c` 都不用再碰。

## 怎么用

1. VOFA+ 打开串口，协议选 **JustFloat**
2. 发 `list` 看有哪些可调参数，`get 名字` 读，`set 名字 值` 改（立即生效）
3. 波形通道就是 `vofa_bind.c` 里注册的顺序，对应 VOFA+ 的 ch0、ch1…

> 在线改的值**不落盘**，断电就回到源码里的初值。调好记得写回源码。

## 关于串口

- **TX（波形上行）**：用工程里现成的「一次性 DMA 发送」函数（`usart1_tx_dma_enable` 这类）
- **RX（命令下行）**：默认走**逐字节中断**，只需要串口全局中断

**不用回 CubeMX 的原因**：`VOFA_USE_BUILTIN_IRQ=1` 时模块会在运行时自己开 NVIC，
并自带 `USART1_IRQHandler`（弱符号；工程的 `stm32f4xx_it.c` 里没有它，不会重复定义）。

如果你更希望由 CubeMX 管：在 CubeMX 里勾上该串口的全局中断，然后把
`VOFA_USE_BUILTIN_IRQ` 改成 0，两边不打架。

如果已经在 CubeMX 里配了 RX DMA，把 `VOFA_RX_MODE` 改成 1 走 DMA 版本。

## 依赖

| 需要 | 说明 |
| --- | --- |
| FreeRTOS / CMSIS-OS | 用 `osThreadCreate` 起任务 |
| 一个空闲串口 | 别和 DBUS（通常 USART3）、裁判系统（通常 USART6）冲突 |
| `struct_typedef.h` | 可选。没有的话模块自己用 `<stdint.h>`/`<stdbool.h>` 定义 fp32/bool_t |

## 常见问题

**收了命令没反应？** 先确认 `VOFA_USE_BUILTIN_IRQ` 是否为 1（或者 CubeMX 里勾了串口中断），
再用 `list` 看有没有回显 —— 有回显说明链路通了。

**波形卡顿/丢数据？** 通道太多 × 频率太高把带宽吃满了。调低 `VOFA_SEND_HZ`，
或减少监看通道。蓝牙透传空中吞吐只有几 KB/s。

**`set` 之后波形没变？** 检查这个参数是不是真的被注册成了**可调参数**（`get` 能读到就说明注册了）。
