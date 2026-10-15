/**
  ******************************************************************************
  * @file       vofa_task.h
  * @brief      VOFA+ 上位机调参模块对外接口
  *
  * 这个文件由「CMake / VSCode 工程配置器」的 vofa 模块包提供，**不要手改**。
  *
  * 对外只有两个注册 API + 一个任务入口：
  *   vofa_reg_channel(name, &变量)  -> 该变量按 VOFA_SEND_HZ 发到 VOFA 画波形（只读）
  *   vofa_reg_param(name, &变量)    -> 可被 VOFA 命令 "set 名字 值" 在线修改
  *
  * 注册的均为**指针**，set 命令直接写内存，立即生效。
  *
  * 「注册哪些变量」不在这里，在 **vofa_bind.c** —— 那是工具按你在界面上勾选的
  * 结果生成的，改调参目标只需要重新生成那一个文件。
  ******************************************************************************
  */
#ifndef VOFA_TASK_H
#define VOFA_TASK_H

#include "vofa_types.h"

/**
  * @brief  vofa 任务入口，在 freertos.c 里用 osThreadCreate 创建
  *         内部完成：串口中断使能与启动 / 调用 vofa_bind_all() / 周期发波形 / 解析命令
  */
extern void vofa_task(void const *argument);

/**
  * @brief          注册一个可在线修改的浮点参数
  * @param[in]      name: 参数名（命令里用），例如 "yaw_spd_kp"
  * @param[in]      addr: 变量地址。建议直接给结构体成员取地址（&pid.Kp），指针直写立即生效
  * @retval         true 成功 / false 表满或重名
  * @note           只在调度器启动前（vofa_bind_all 里）调用
  */
extern bool_t vofa_reg_param(const char *name, fp32 *addr);

/**
  * @brief          注册一个监看通道（只读）
  * @param[in]      name: 通道名（仅回显用；JustFloat 不传名字，VOFA 里显示为 ch0..N）
  * @param[in]      addr: 变量地址
  * @retval         true 成功 / false 表满
  * @note           注册顺序 = VOFA 波形通道顺序，先注册的是 ch0
  */
extern bool_t vofa_reg_channel(const char *name, const fp32 *addr);

/**
  * @brief  注册全部观测通道与可调参数
  *
  * **由 vofa_bind.c 实现**（工具生成）。
  * vofa_task 启动时调一次；想换调参目标就重新生成 vofa_bind.c，本模块不用动。
  */
extern void vofa_bind_all(void);

#endif /* VOFA_TASK_H */
