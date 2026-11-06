/**
  ******************************************************************************
  * @file       vofa_task.c
  * @brief      VOFA+ 上位机调参模块（通用部分）
  *
  * 这个文件由「CMake / VSCode 工程配置器」的 vofa 模块包提供，**不要手改** ——
  * 想改串口/频率改 vofa_config.h，想改调哪个变量改 vofa_bind.c，两个都是工具生成的。
  *
 * 数据通路:
 *   上行(波形): 地址槽 + 注册通道表 -> JustFloat 打包(帧尾 00 00 80 7F) -> 串口 TX DMA
 *   下行(命令): RX DMA(Circular/NORMAL 都支持) + 空闲中断 -> HAL_UARTEx_RxEventCallback 入 SPSC 环形缓冲
 *               -> 任务侧逐字节解析 "set <名字> <值>" / "get <名字>" / "list"
 *               -> 查注册表拿到 float* 指针直写, 立即生效, 文本回显
 *
 * 两种「看什么」的方式, 可同时用:
 *   ① 注册表(名字): vofa_bind.c 里 vofa_reg_channel("名", &变量) —— 编译期定死
 *   ② 地址槽(地址): 上位机下发 "am <槽号> <地址> <类型>" —— **不用改源码、不用重编**
 *
 * ② 的意义: 上位机从 build 出来的 .elf 符号表里读到「变量名 -> 地址」,
 * 直接把地址发下来。连 static 变量都能看(符号表里是 LOCAL 符号), 因为这里
 * 按地址读写, 不需要链接期可见。代价是地址必须和**正在跑的固件**一致 ——
 * 改了代码没重新烧录, 读到的就是别的变量, 而且不会报错。
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

/*
 * RX DMA 模式（1=循环 0=单次）。新生成的 vofa_config.h 一定带着这一项；
 * 老工程的 vofa_config.h 没有，兜底按「单次」处理 —— 老版本的 .ioc 就是写单次，
 * 按单次走至少会重挂，能收；按循环走则永远不会重挂。
 */
#ifndef VOFA_RX_DMA_CIRCULAR
#define VOFA_RX_DMA_CIRCULAR    0
#endif

//注册表容量
#define VOFA_PARAM_MAX          64u
#define VOFA_CHANNEL_MAX        24u
#define VOFA_NAME_LEN           24u

//地址槽容量(上位机按地址看的通道), 和注册通道共用一帧
#define VOFA_ADDR_SLOT_MAX      16u

//RX: DMA 循环缓冲 与 任务侧环形缓冲
#define VOFA_RX_DMA_BUF_SIZE    128u
#define VOFA_RX_RING_SIZE       256u
//单条命令最大长度。要装得下一整批地址槽:
//  "ac;am 15 0x20001a3c i16;" 约 24 字节 x 16 = 384, 留点余量
#define VOFA_CMD_LEN_MAX        448u

//回显文本最大长度(单次)
#define VOFA_ECHO_BUF_SIZE      64u

//地址合法性检查(默认开)。关掉它, 任何地址都会被写/读 —— 填错就 HardFault
#ifndef VOFA_MEM_CHECK
#define VOFA_MEM_CHECK          1
#endif

//---------------------------- 存储布局 ----------------------------
//数据类型: 决定按几字节、按有符号还是浮点去解地址上的值
typedef enum
{
    VOFA_T_F32 = 0,
    VOFA_T_U8,
    VOFA_T_I8,
    VOFA_T_U16,
    VOFA_T_I16,
    VOFA_T_U32,
    VOFA_T_I32
} vofa_type_t;

//注册表条目: 名字拷贝存储(防止调用方传栈上临时串) + 数据指针
typedef struct
{
    char    name[VOFA_NAME_LEN];
    fp32   *addr;
    uint8_t type;
} vofa_entry_t;

//地址槽: 上位机下发的裸地址, 没有名字(名字在上位机侧)
typedef struct
{
    uint32_t addr;
    uint8_t  type;
    uint8_t  used;
} vofa_mem_slot_t;

static vofa_entry_t vofa_param_table[VOFA_PARAM_MAX];     //可被 set 命令修改的参数
static uint8_t      vofa_param_count = 0;
static vofa_entry_t vofa_channel_table[VOFA_CHANNEL_MAX]; //只读监看通道
static uint8_t      vofa_channel_count = 0;
static vofa_mem_slot_t vofa_mem_slots[VOFA_ADDR_SLOT_MAX];//按地址监看的槽
static uint8_t      vofa_mem_count = 0;                   //已启用的最高槽号 + 1

//RX: DMA 硬件循环缓冲(中断写) + SPSC 环形缓冲(中断写头/任务写尾, 无锁)
#if VOFA_RX_MODE == 1
static uint8_t           vofa_rx_dma_buf[VOFA_RX_DMA_BUF_SIZE];
static volatile uint16_t vofa_rx_dma_last = 0;  //回调上次处理到的 DMA 偏移
#endif
static uint8_t           vofa_rx_ring[VOFA_RX_RING_SIZE];
static volatile uint16_t vofa_rx_head = 0;      //中断写
static volatile uint16_t vofa_rx_tail = 0;      //任务写

//TX: 波形帧缓冲 与 文本回显缓冲(DMA normal 模式发送期间内存不能动, 各用独立缓冲)
static uint8_t vofa_tx_wave_buf[(VOFA_ADDR_SLOT_MAX + VOFA_CHANNEL_MAX) * 4u + 4u];
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

//---------------------------- 按类型读写内存 ----------------------------
//一律走 memcpy: 不假设对齐。上位机给的地址是 ELF 里的符号地址, 理论上对齐,
//但 i16 的成员地址完全可能落在奇数上, 用指针直读会 HardFault。
static uint32_t vofa_type_size(uint8_t type)
{
    switch (type)
    {
    case VOFA_T_U8:
    case VOFA_T_I8:
        return 1u;
    case VOFA_T_U16:
    case VOFA_T_I16:
        return 2u;
    case VOFA_T_U32:
    case VOFA_T_I32:
    case VOFA_T_F32:
    default:
        return 4u;
    }
}

static bool_t vofa_type_parse(const char *s, uint8_t *out)
{
    if (strcmp(s, "f") == 0)   { *out = VOFA_T_F32; return true; }
    if (strcmp(s, "u8") == 0)  { *out = VOFA_T_U8;  return true; }
    if (strcmp(s, "i8") == 0)  { *out = VOFA_T_I8;  return true; }
    if (strcmp(s, "u16") == 0) { *out = VOFA_T_U16; return true; }
    if (strcmp(s, "i16") == 0) { *out = VOFA_T_I16; return true; }
    if (strcmp(s, "u32") == 0) { *out = VOFA_T_U32; return true; }
    if (strcmp(s, "i32") == 0) { *out = VOFA_T_I32; return true; }
    return false;
}

static fp32 vofa_load(const void *p, uint8_t type)
{
    switch (type)
    {
    case VOFA_T_U8:  { uint8_t  t; memcpy(&t, p, 1); return (fp32)t; }
    case VOFA_T_I8:  { int8_t   t; memcpy(&t, p, 1); return (fp32)t; }
    case VOFA_T_U16: { uint16_t t; memcpy(&t, p, 2); return (fp32)t; }
    case VOFA_T_I16: { int16_t  t; memcpy(&t, p, 2); return (fp32)t; }
    case VOFA_T_U32: { uint32_t t; memcpy(&t, p, 4); return (fp32)t; }
    case VOFA_T_I32: { int32_t  t; memcpy(&t, p, 4); return (fp32)t; }
    case VOFA_T_F32:
    default:         { fp32     t; memcpy(&t, p, 4); return t; }
    }
}

static void vofa_store(void *p, uint8_t type, fp32 v)
{
    switch (type)
    {
    case VOFA_T_U8:  { uint8_t  t = (uint8_t)v;  memcpy(p, &t, 1); break; }
    case VOFA_T_I8:  { int8_t   t = (int8_t)v;   memcpy(p, &t, 1); break; }
    case VOFA_T_U16: { uint16_t t = (uint16_t)v; memcpy(p, &t, 2); break; }
    case VOFA_T_I16: { int16_t  t = (int16_t)v;  memcpy(p, &t, 2); break; }
    case VOFA_T_U32: { uint32_t t = (uint32_t)v; memcpy(p, &t, 4); break; }
    case VOFA_T_I32: { int32_t  t = (int32_t)v;  memcpy(p, &t, 4); break; }
    case VOFA_T_F32:
    default:         { fp32     t = v;           memcpy(p, &t, 4); break; }
    }
}

/**
  * @brief  地址合不合法 —— 越界地址会让 MCU 直接 HardFault, 必须在读之前挡掉
  *
  * 上界用链接脚本给的 `_estack`(初始 SP, 就是 RAM 顶端), 这样不同芯片、
  * 不同 RAM 大小都不用改配置。CCM/DTCM 在 F4/F7 上是独立一段地址, 单独放行。
  */
extern uint32_t _estack;

static bool_t vofa_mem_ok(uint32_t addr, uint8_t type)
{
    uint32_t w = vofa_type_size(type);

    if ((addr & (w - 1u)) != 0u)            // 不对齐: 2/4 字节类型直接拒
    {
        return false;
    }
    if (addr + w < addr)                    // 回绕(0xFFFFFFFF 附近)
    {
        return false;
    }
#if VOFA_MEM_CHECK
    if (addr >= 0x20000000u && (addr + w) <= (uint32_t)&_estack)
    {
        return true;
    }
    if (addr >= 0x10000000u && (addr + w) <= 0x10020000u)   // CCMRAM(F4) / DTCM(F7)
    {
        return true;
    }
    return false;
#else
    return true;
#endif
}

//---------------------------- TX 层 ----------------------------
//TX DMA 是否忙(normal 模式: EN 位为 1 表示正在发)
static inline bool_t vofa_tx_busy(void)
{
    return (VOFA_TX_DMA_HANDLE.Instance->CR & DMA_SxCR_EN) != 0u;
}

//发送 JustFloat 波形帧: 打包全部地址槽 + 注册通道 + 帧尾, 忙则整帧丢弃(不阻塞任务)
//
//顺序: 地址槽在前(按槽号 0..N-1), 注册通道接在后面。
//上位机侧必须按同样的顺序解释 —— 地址槽没启用时, 通道仍然从 ch0 开始,
//所以只用注册表的老工程行为完全不变。
static void vofa_send_wave(void)
{
    if (vofa_mem_count == 0u && vofa_channel_count == 0u)
    {
        return;
    }
    if (vofa_tx_busy())
    {
        return; //上帧未发完(蓝牙慢), 丢帧不堆积
    }

    uint16_t n = 0;
    for (uint8_t i = 0; i < vofa_mem_count; i++)
    {
        if (!vofa_mem_slots[i].used)
        {
            continue;
        }
        fp32 v = vofa_load((const void *)vofa_mem_slots[i].addr, vofa_mem_slots[i].type);
        memcpy(&vofa_tx_wave_buf[n * 4u], &v, 4u);
        n++;
    }
    for (uint16_t i = 0; i < vofa_channel_count; i++)
    {
        fp32 v = vofa_load((const void *)vofa_channel_table[i].addr, vofa_channel_table[i].type);
        memcpy(&vofa_tx_wave_buf[n * 4u], &v, 4u); //小端 float, 与 JustFloat 一致
        n++;
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
    //注册表收的一律是 fp32*(这是它的接口约定, 类型不对的要先做镜像);
    //按类型解析只发生在地址槽那条路上。
    e->type = VOFA_T_F32;
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

//---------------------------- 地址槽 ----------------------------
static void vofa_mem_clear(void)
{
    for (uint8_t i = 0; i < VOFA_ADDR_SLOT_MAX; i++)
    {
        vofa_mem_slots[i].used = 0u;
    }
    vofa_mem_count = 0u;
}

static bool_t vofa_mem_set(uint8_t idx, uint32_t addr, uint8_t type)
{
    if (idx >= VOFA_ADDR_SLOT_MAX || !vofa_mem_ok(addr, type))
    {
        return false;
    }
    vofa_mem_slots[idx].addr = addr;
    vofa_mem_slots[idx].type = type;
    vofa_mem_slots[idx].used = 1u;
    if ((uint16_t)idx + 1u > vofa_mem_count)
    {
        vofa_mem_count = (uint8_t)(idx + 1u);
    }
    return true;
}

//任务上下文执行, 收到完整一行(已去 \n)后调用
static void vofa_cmd_one(char *line)
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

    //---- 地址槽: am <槽号> <地址> <类型> ----
    //一条线可以带上全部槽, 例如:
    //  ac;am 0 0x20001A3C f;am 1 0x20001B04 i16
    if (strcmp(cmd, "am") == 0)
    {
        char *si = vofa_next_token(&p);
        char *sa = vofa_next_token(&p);
        char *st = vofa_next_token(&p);
        uint8_t type;

        if (si == NULL || sa == NULL || st == NULL || !vofa_type_parse(st, &type))
        {
            vofa_send_text("ERR usage: am <slot> <addr> <f|u8|i8|u16|i16|u32|i32>\r\n");
            return;
        }
        if (!vofa_mem_set((uint8_t)strtoul(si, NULL, 0), (uint32_t)strtoul(sa, NULL, 0), type))
        {
            vofa_send_text("ERR bad slot or addr\r\n");
            return;
        }
        vofa_send_text("OK\r\n");
        return;
    }

    //---- 清空所有地址槽 ----
    if (strcmp(cmd, "ac") == 0)
    {
        vofa_mem_clear();
        vofa_send_text("OK clear\r\n");
        return;
    }

    //---- 列出已启用的地址槽: 槽号 地址 类型 ----
    if (strcmp(cmd, "al") == 0)
    {
        char line_buf[32];
        for (uint8_t i = 0; i < VOFA_ADDR_SLOT_MAX; i++)
        {
            if (!vofa_mem_slots[i].used)
            {
                continue;
            }
            snprintf(line_buf, sizeof(line_buf), "%u 0x%08lX %u\r\n",
                     (unsigned)i, (unsigned long)vofa_mem_slots[i].addr,
                     (unsigned)vofa_mem_slots[i].type);
            vofa_send_text(line_buf);
        }
        vofa_send_text("al end\r\n");
        return;
    }

    //---- 读一个地址: rd <地址> <类型> ----
    if (strcmp(cmd, "rd") == 0)
    {
        char *sa = vofa_next_token(&p);
        char *st = vofa_next_token(&p);
        uint8_t type;

        if (sa == NULL || st == NULL || !vofa_type_parse(st, &type))
        {
            vofa_send_text("ERR usage: rd <addr> <type>\r\n");
            return;
        }
        uint32_t addr = (uint32_t)strtoul(sa, NULL, 0);
        if (!vofa_mem_ok(addr, type))
        {
            vofa_send_text("ERR bad addr\r\n");
            return;
        }
        char vbuf[16];
        char line_buf[32];
        vofa_ftoa(vbuf, sizeof(vbuf), vofa_load((const void *)addr, type));
        snprintf(line_buf, sizeof(line_buf), "0x%08lX=%s\r\n", (unsigned long)addr, vbuf);
        vofa_send_text(line_buf);
        return;
    }

    //---- 写一个地址: wr <地址> <类型> <值> ----
    if (strcmp(cmd, "wr") == 0)
    {
        char *sa = vofa_next_token(&p);
        char *st = vofa_next_token(&p);
        char *sv = vofa_next_token(&p);
        uint8_t type;

        if (sa == NULL || st == NULL || sv == NULL || !vofa_type_parse(st, &type))
        {
            vofa_send_text("ERR usage: wr <addr> <type> <value>\r\n");
            return;
        }
        uint32_t addr = (uint32_t)strtoul(sa, NULL, 0);
        if (!vofa_mem_ok(addr, type))
        {
            vofa_send_text("ERR bad addr\r\n");
            return;
        }
        vofa_store((void *)addr, type, (fp32)strtof(sv, NULL)); //下一拍控制周期生效
        char vbuf[16];
        char line_buf[32];
        vofa_ftoa(vbuf, sizeof(vbuf), vofa_load((const void *)addr, type));
        snprintf(line_buf, sizeof(line_buf), "OK 0x%08lX=%s\r\n", (unsigned long)addr, vbuf);
        vofa_send_text(line_buf);
        return;
    }

    vofa_send_text("ERR cmd: set/get/list/am/ac/al/rd/wr\r\n");
}

/**
  * @brief  一行里可以带多条命令, 用 `;` 隔开
  *
  * 为什么要批: 16 个地址槽如果一条一条发, 在 VOFA+ 的命令框里要敲 16 次回车。
  * 上位机生成一整串一次发完, 才能算「点一下就配好」。
  */
static void vofa_cmd_exec(char *line)
{
    char *seg = line;

    for (;;)
    {
        char *semi = strchr(seg, ';');
        if (semi != NULL)
        {
            *semi = '\0';
        }
        vofa_cmd_one(seg);
        if (semi == NULL)
        {
            break;
        }
        seg = semi + 1;
    }
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
  * @brief  RX DMA + 空闲中断（CubeMX 里给这个串口配了 RX DMA 时用）
  *         Size 是"从缓冲起点到当前写入位置"的字节数，用与上次的差值取出新数据
  * @note   只搬字节，解析在任务上下文
  *
  * ## 两种 DMA 模式都在这里处理
  *
  * CIRCULAR（默认）：地址指针自己回卷，DMA 从不停，本函数只读偏移取增量 ——
  *   两次命令之间没有空窗，921600 也不会丢字节。
  *
  * NORMAL：一块缓冲收满（Size == VOFA_RX_DMA_BUF_SIZE）DMA 就停了，
  *   或者某些 HAL 版本在空闲事件里就把 DMA 关了（EN 位归零）。
  *   两种情况都必须重新挂一帧，否则「第一条命令能收到、之后全没反应」。
  *   这个判断放在这里而不是任务里：任务循环是 1/SEND_HZ 秒一拍，
  *   20ms 的空窗足以丢掉下一条命令的开头。
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

#if !VOFA_RX_DMA_CIRCULAR
    //NORMAL: 缓冲收满 或 DMA 已经停了 -> 停干净(状态回 READY)再从头挂一帧
    if (Size >= VOFA_RX_DMA_BUF_SIZE ||
        (VOFA_RX_DMA_HANDLE.Instance->CR & DMA_SxCR_EN) == 0u)
    {
        (void)HAL_UART_DMAStop(&VOFA_UART);
        vofa_rx_dma_last = 0u;
        (void)HAL_UARTEx_ReceiveToIdle_DMA(&VOFA_UART, vofa_rx_dma_buf, VOFA_RX_DMA_BUF_SIZE);
    }
#endif
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
    //DMA + 空闲/半满/全满事件 -> HAL_UARTEx_RxEventCallback
    //Circular 时这一句就够了, DMA 自己回卷; NORMAL 时回调里会自己重挂
    (void)HAL_UARTEx_ReceiveToIdle_DMA(&VOFA_UART, vofa_rx_dma_buf, VOFA_RX_DMA_BUF_SIZE);
#else
    (void)HAL_UART_Receive_IT(&VOFA_UART, &vofa_rx_it_byte, 1u);
#endif

    //2. 注册观测通道与可调参数 —— 实现在 vofa_bind.c（工具生成，对应界面上勾的东西）
    vofa_bind_all();

    vofa_send_text("vofa ready, cmd: set/get/list | am/ac/al/rd/wr\r\n");

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
