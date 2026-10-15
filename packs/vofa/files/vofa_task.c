/**
  ******************************************************************************
  * @file       vofa_task.c
  * @brief      VOFA+ 上位机调参模块（通用部分）
  *
  * 这个文件由「CMake / VSCode 工程配置器」的 vofa 模块包提供，**不要手改** ——
  * 想改串口/频率改 vofa_config.h，想改调哪个变量改 vofa_bind.c，两个都是工具生成的。
  *
  * 数据通路:
  *   上行(波形): 注册通道表 -> JustFloat 打包(帧尾 00 00 80 7F) -> 串口 TX DMA
  *   下行(命令): RX DMA Circular + 空闲中断 -> HAL_UARTEx_RxEventCallback 入 SPSC 环形缓冲
  *               -> 任务侧逐字节解析 "set <名字> <值>" / "get <名字>" / "list"
  *               -> 查注册表拿到 float* 指针直写, 立即生效, 文本回显
  ******************************************************************************
  */
#include "vofa_task.h"

#include <string.h>
#include <stdio.h>
#include <stdlib.h>
#include <stdbool.h>

#include "vofa_config.h"        // <- 工具生成：串口 / 频率 / 各种开关

#include "cmsis_os.h"

#include VOFA_UART_HEADER        // huart1（或项目实际用的那个串口）
#include VOFA_TX_HEADER          // TX 一次性 DMA 发送函数

//DMA 句柄定义在 usart.c (usart.h 未导出, 这里 extern)
extern DMA_HandleTypeDef VOFA_TX_DMA_HANDLE;
extern DMA_HandleTypeDef VOFA_RX_DMA_HANDLE;

//---------------------------- 可调宏 ----------------------------
//频率等默认值由 vofa_config.h 给，这里只兜底（也方便单独编译本文件）
#ifndef VOFA_SEND_HZ
#define VOFA_SEND_HZ            50u
#endif

//注册表容量
#define VOFA_PARAM_MAX          64u
#define VOFA_CHANNEL_MAX        24u
#define VOFA_NAME_LEN           24u

//RX: DMA 循环缓冲 与 任务侧环形缓冲
#define VOFA_RX_DMA_BUF_SIZE    128u
#define VOFA_RX_RING_SIZE       256u
//单条命令最大长度
#define VOFA_CMD_LEN_MAX        64u

//回显文本最大长度(单次)
#define VOFA_ECHO_BUF_SIZE      64u

//---------------------------- 存储布局 ----------------------------
//注册表条目: 名字拷贝存储(防止调用方传栈上临时串) + 数据指针
typedef struct
{
    char  name[VOFA_NAME_LEN];
    fp32 *addr;
} vofa_entry_t;

static vofa_entry_t vofa_param_table[VOFA_PARAM_MAX];     //可被 set 命令修改的参数
static uint8_t      vofa_param_count = 0;
static vofa_entry_t vofa_channel_table[VOFA_CHANNEL_MAX]; //只读监看通道
static uint8_t      vofa_channel_count = 0;

//RX: DMA 硬件循环缓冲(中断写) + SPSC 环形缓冲(中断写头/任务写尾, 无锁)
#if VOFA_RX_MODE == 1
static uint8_t           vofa_rx_dma_buf[VOFA_RX_DMA_BUF_SIZE];
static volatile uint16_t vofa_rx_dma_last = 0;  //回调上次处理到的 DMA 偏移
#endif
static uint8_t           vofa_rx_ring[VOFA_RX_RING_SIZE];
static volatile uint16_t vofa_rx_head = 0;      //中断写
static volatile uint16_t vofa_rx_tail = 0;      //任务写

//TX: 波形帧缓冲 与 文本回显缓冲(DMA normal 模式发送期间内存不能动, 各用独立缓冲)
static uint8_t vofa_tx_wave_buf[VOFA_CHANNEL_MAX * 4u + 4u];
static uint8_t vofa_tx_echo_buf[VOFA_ECHO_BUF_SIZE];

//命令行缓冲(任务上下文独占, 无需保护)
static char    vofa_cmd_buf[VOFA_CMD_LEN_MAX];
static uint8_t vofa_cmd_len = 0;

//---------------------------- 工具: fp32 -> 字符串 ----------------------------
//newlib-nano 默认 printf 不支持 %f/%g(需 -u _printf_float), 手写转换避免链接依赖
//固定 3 位小数, 参数整定精度足够
static void vofa_ftoa(char *buf, uint16_t size, fp32 v)
{
    int32_t ipart = (int32_t)v;
    fp32 frac = v - (fp32)ipart;
    if (frac < 0.0f)
    {
        frac = -frac;
    }
    int32_t fpart = (int32_t)(frac * 1000.0f + 0.5f);
    if (fpart >= 1000)
    {
        fpart -= 1000;
        ipart += (v >= 0.0f) ? 1 : -1;
    }
    if (v < 0.0f && ipart == 0)
    {
        snprintf(buf, (size_t)size, "-0.%03d", (int)fpart);
    }
    else
    {
        snprintf(buf, (size_t)size, "%d.%03d", (int)ipart, (int)fpart);
    }
}

//---------------------------- TX 层 ----------------------------
//TX DMA 是否忙(normal 模式: EN 位为 1 表示正在发)
static inline bool_t vofa_tx_busy(void)
{
    return (VOFA_TX_DMA_HANDLE.Instance->CR & DMA_SxCR_EN) != 0u;
}

//发送 JustFloat 波形帧: 打包全部监看通道 + 帧尾, 忙则整帧丢弃(不阻塞任务)
static void vofa_send_wave(void)
{
    uint16_t n = vofa_channel_count;
    if (n == 0u)
    {
        return;
    }
    if (vofa_tx_busy())
    {
        return; //上帧未发完(蓝牙慢), 丢帧不堆积
    }

    for (uint16_t i = 0; i < n; i++)
    {
        fp32 v = *vofa_channel_table[i].addr;
        memcpy(&vofa_tx_wave_buf[i * 4u], &v, 4u); //小端 float, 与 JustFloat 一致
    }
    vofa_tx_wave_buf[n * 4u + 0u] = 0x00u;         //帧尾 00 00 80 7F (float 1.0f 的字节序)
    vofa_tx_wave_buf[n * 4u + 1u] = 0x00u;
    vofa_tx_wave_buf[n * 4u + 2u] = 0x80u;
    vofa_tx_wave_buf[n * 4u + 3u] = 0x7Fu;

    VOFA_TX_FN(vofa_tx_wave_buf, (uint16_t)(n * 4u + 4u));
}

//发送文本回显: 任务上下文, 忙则等待(文本低频, 阻塞自身不影响其他任务)
static void vofa_send_text(const char *text)
{
    uint16_t len = (uint16_t)strlen(text);
    if (len > VOFA_ECHO_BUF_SIZE)
    {
        len = VOFA_ECHO_BUF_SIZE;
    }
    memcpy(vofa_tx_echo_buf, text, len);

    while (vofa_tx_busy())
    {
        osDelay(2);
    }
    VOFA_TX_FN(vofa_tx_echo_buf, len);
    osDelay(2); //给 DMA 一点启动时间, 避免连续回显时第二轮判断失误
}

//---------------------------- 注册表层 ----------------------------
static fp32 *vofa_param_find(const char *name)
{
    for (uint8_t i = 0; i < vofa_param_count; i++)
    {
        if (strcmp(vofa_param_table[i].name, name) == 0)
        {
            return vofa_param_table[i].addr;
        }
    }
    return NULL;
}

static bool_t vofa_entry_add(vofa_entry_t *table, uint8_t *count, uint8_t max,
                             const char *name, fp32 *addr)
{
    if (*count >= max || name == NULL || addr == NULL || strlen(name) >= VOFA_NAME_LEN)
    {
        return false;
    }
    vofa_entry_t *e = &table[*count];
    strncpy(e->name, name, VOFA_NAME_LEN - 1u);
    e->name[VOFA_NAME_LEN - 1u] = '\0';
    e->addr = addr;
    (*count)++;
    return true;
}

bool_t vofa_reg_param(const char *name, fp32 *addr)
{
    if (vofa_param_find(name) != NULL)
    {
        return false; //重名
    }
    return vofa_entry_add(vofa_param_table, &vofa_param_count, VOFA_PARAM_MAX, name, addr);
}

bool_t vofa_reg_channel(const char *name, const fp32 *addr)
{
    return vofa_entry_add(vofa_channel_table, &vofa_channel_count, VOFA_CHANNEL_MAX,
                          name, (fp32 *)addr);
}

/*
 * vofa_reg_pid() 搬去了 vofa_bind.c —— 它要 cast 项目的 pid_type_def / gimbal_PID_t，
 * 属于「跟具体工程绑定」的东西；留在这里这个文件就不通用了。
 */

/**
  * @brief  由 vofa_bind.c 实现，每个发送周期调一次
  *
  * 存在的理由：有些想监看的东西**类型不是 fp32**，注册不了 ——
  * 最典型的是遥控器（`int16_t ch[5]`）。这种要先拷进一个 static 的 fp32 镜像，
  * 再注册镜像的地址；镜像的刷新就放在这个回调里。
  */
extern void vofa_bind_tick(void);
//---------------------------- 命令解析层 ----------------------------
//简易分词: 空格/Tab 分隔, 返回当前 token 并推进 p
static char *vofa_next_token(char **p)
{
    char *s = *p;
    while (*s == ' ' || *s == '\t')
    {
        s++;
    }
    if (*s == '\0')
    {
        *p = s;
        return NULL;
    }
    char *tok = s;
    while (*s != '\0' && *s != ' ' && *s != '\t')
    {
        s++;
    }
    if (*s != '\0')
    {
        *s = '\0';
        s++;
    }
    *p = s;
    return tok;
}

//任务上下文执行, 收到完整一行(已去 \n)后调用
static void vofa_cmd_exec(char *line)
{
    char *p = line;
    char *cmd = vofa_next_token(&p);

    if (cmd == NULL)
    {
        return;
    }

    if (strcmp(cmd, "list") == 0)
    {
        char line_buf[VOFA_NAME_LEN + 24u];
        for (uint8_t i = 0; i < vofa_param_count; i++)
        {
            char vbuf[16];
            vofa_ftoa(vbuf, sizeof(vbuf), *vofa_param_table[i].addr);
            snprintf(line_buf, sizeof(line_buf), "%s=%s\r\n",
                     vofa_param_table[i].name, vbuf);
            vofa_send_text(line_buf);
        }
        vofa_send_text("list end\r\n");
        return;
    }

    if (strcmp(cmd, "get") == 0)
    {
        char *name = vofa_next_token(&p);
        if (name == NULL)
        {
            vofa_send_text("ERR usage: get <name>\r\n");
            return;
        }
        fp32 *addr = vofa_param_find(name);
        if (addr == NULL)
        {
            vofa_send_text("ERR no param\r\n");
            return;
        }
        char vbuf[16];
        vofa_ftoa(vbuf, sizeof(vbuf), *addr);
        char line_buf[VOFA_NAME_LEN + 24u];
        snprintf(line_buf, sizeof(line_buf), "%s=%s\r\n", name, vbuf);
        vofa_send_text(line_buf);
        return;
    }

    if (strcmp(cmd, "set") == 0)
    {
        char *name = vofa_next_token(&p);
        char *val = vofa_next_token(&p);
        if (name == NULL || val == NULL)
        {
            vofa_send_text("ERR usage: set <name> <val>\r\n");
            return;
        }
        fp32 *addr = vofa_param_find(name);
        if (addr == NULL)
        {
            vofa_send_text("ERR no param\r\n");
            return;
        }
        *addr = (fp32)strtof(val, NULL); //指针直写, 下一拍控制周期生效
        char vbuf[16];
        vofa_ftoa(vbuf, sizeof(vbuf), *addr);
        char line_buf[VOFA_NAME_LEN + 24u];
        snprintf(line_buf, sizeof(line_buf), "OK %s=%s\r\n", name, vbuf);
        vofa_send_text(line_buf);
        return;
    }

    vofa_send_text("ERR cmd, use: set/get/list\r\n");
}

//逐字节喂入命令行状态机(任务上下文)
static void vofa_rx_byte(uint8_t byte)
{
    if (byte == '\n' || byte == '\r')
    {
        if (vofa_cmd_len > 0u)
        {
            vofa_cmd_buf[vofa_cmd_len] = '\0';
            vofa_cmd_exec(vofa_cmd_buf);
            vofa_cmd_len = 0;
        }
        return;
    }
    if (vofa_cmd_len < VOFA_CMD_LEN_MAX - 1u)
    {
        vofa_cmd_buf[vofa_cmd_len++] = (char)byte;
    }
    else
    {
        vofa_cmd_len = 0; //超长行, 整行丢弃防溢出
    }
}

//---------------------------- RX 层 ----------------------------
// 把一字节塞进 SPSC 环形缓冲（满则丢新数据 —— 调参命令频率极低，不会发生）
static void vofa_rx_push(uint8_t byte)
{
    uint16_t next = (uint16_t)((vofa_rx_head + 1u) % VOFA_RX_RING_SIZE);
    if (next == vofa_rx_tail)
    {
        return;
    }
    vofa_rx_ring[vofa_rx_head] = byte;
    vofa_rx_head = next;
}

#if VOFA_RX_MODE == 1

/**
  * @brief  RX DMA Circular + 空闲中断（CubeMX 里给这个串口配了 RX DMA 时用）
  *         Size 是"从缓冲起点到当前写入位置"的字节数，用与上次的差值取出新数据
  * @note   只搬字节，解析在任务上下文
  */
void HAL_UARTEx_RxEventCallback(UART_HandleTypeDef *huart, uint16_t Size)
{
    if (huart->Instance != VOFA_UART.Instance)
    {
        return;
    }

    uint16_t pos = vofa_rx_dma_last % VOFA_RX_DMA_BUF_SIZE;
    while (pos != Size)
    {
        vofa_rx_push(vofa_rx_dma_buf[pos]);
        pos = (uint16_t)((pos + 1u) % VOFA_RX_DMA_BUF_SIZE);
    }
    vofa_rx_dma_last = Size;
}

#else

/**
  * @brief  逐字节中断接收（**不需要在 CubeMX 里配 RX DMA**，只要使能串口全局中断）
  *
  * 为什么默认走这条：调参命令是人手敲的、一次几十字节，逐字节中断完全够用；
  * 而 CubeMX 里加 RX DMA 要动 .ioc 重新生成代码，门槛高得多。
  * 配合 VOFA_USE_BUILTIN_IRQ，运行时自己开 NVIC 并自带 IRQHandler，
  * 于是「装完就能用」，一行 CubeMX 都不用改。
  */
static uint8_t vofa_rx_it_byte;

void HAL_UART_RxCpltCallback(UART_HandleTypeDef *huart)
{
    if (huart->Instance != VOFA_UART.Instance)
    {
        return;
    }
    vofa_rx_push(vofa_rx_it_byte);
    //重新挂上，收下一字节
    (void)HAL_UART_Receive_IT(&VOFA_UART, &vofa_rx_it_byte, 1u);
}

#endif

#if VOFA_USE_BUILTIN_IRQ
/**
  * @brief  自己补上串口中断使能与中断入口
  *
  * CubeMX 里没勾「串口全局中断」时，中断根本不会进 HAL，收不到命令。
  * 这里在运行时打开 NVIC，并提供中断入口 ——
  * `USART1_IRQHandler` 是弱符号，工程自己的 stm32f4xx_it.c 里**没有**这个函数
  * （已经确认过），所以不会重复定义。等你哪天在 CubeMX 里勾上了，把
  * VOFA_USE_BUILTIN_IRQ 关掉即可，两边不会打架。
  */
void VOFA_IRQ_HANDLER(void)
{
    HAL_UART_IRQHandler(&VOFA_UART);
}

static void vofa_irq_init(void)
{
    HAL_NVIC_SetPriority(VOFA_IRQ_N, VOFA_IRQ_PRIORITY, 0u);
    HAL_NVIC_EnableIRQ(VOFA_IRQ_N);
}
#else
static void vofa_irq_init(void)
{
    //中断由 CubeMX 配好了，什么都不用做
}
#endif

//---------------------------- 任务入口 ----------------------------
void vofa_task(void const *argument)
{
    (void)argument;

    //1. 开串口中断（CubeMX 没配的话这里自己开）并启动接收
    vofa_irq_init();

#if VOFA_RX_MODE == 1
    //DMA Circular + 空闲/半满/全满事件 -> HAL_UARTEx_RxEventCallback
    (void)HAL_UARTEx_ReceiveToIdle_DMA(&VOFA_UART, vofa_rx_dma_buf, VOFA_RX_DMA_BUF_SIZE);
#else
    (void)HAL_UART_Receive_IT(&VOFA_UART, &vofa_rx_it_byte, 1u);
#endif

    //2. 注册观测通道与可调参数 —— 实现在 vofa_bind.c（工具生成，对应界面上勾的东西）
    vofa_bind_all();

    vofa_send_text("vofa ready, cmd: set/get/list\r\n");

    for (;;)
    {
        //3. 消费环形缓冲里的命令字节
        while (vofa_rx_tail != vofa_rx_head)
        {
            uint8_t b = vofa_rx_ring[vofa_rx_tail];
            vofa_rx_tail = (uint16_t)((vofa_rx_tail + 1u) % VOFA_RX_RING_SIZE);
            vofa_rx_byte(b);
        }

        //4. 刷新需要镜像的通道（遥控器那类非 fp32 的量）
        vofa_bind_tick();

        //5. 波形发送
        vofa_send_wave();

        osDelay(1000u / VOFA_SEND_HZ);
    }
}
