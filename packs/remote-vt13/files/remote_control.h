/**
  ****************************(C) COPYRIGHT 2016 DJI****************************
  * @file       remote_control.c/h
  * @brief      遥控器处理，遥控器是通过类似SBUS的协议传输，利用DMA传输方式节约CPU
  *             资源，利用串口空闲中断来拉起处理函数，同时提供一些掉线重启DMA，串口
  *             的方式保证热插拔的稳定性。
  * @note       
  * @history
  *  Version    Date            Author          Modification
  *  V1.0.0     Dec-26-2018     RM              1. done
  *  V1.0.0     Nov-11-2019     RM              1. support development board tpye c
  *
  @verbatim
  ==============================================================================

  ==============================================================================
  @endverbatim
  ****************************(C) COPYRIGHT 2016 DJI****************************
  */

/**************************** 2026.8 已改为VT13遥控 ****************************/
	
#ifndef REMOTE_CONTROL_H
#define REMOTE_CONTROL_H
#include "struct_typedef.h"
#include "bsp_rc.h"

#define RC_frame_header1 0xA9
#define RC_frame_header2 0x53

#define SBUS_RX_BUF_NUM 42u

#define RC_FRAME_LENGTH 21u

#define RC_CH_VALUE_MIN         ((uint16_t)364)
#define RC_CH_VALUE_OFFSET      ((uint16_t)1024)
#define RC_CH_VALUE_MAX         ((uint16_t)1684)

/* ----------------------- RC Switch Definition----------------------------- */
#define RC_SW_LEFT                ((uint16_t)0)
#define RC_SW_MID                 ((uint16_t)1)
#define RC_SW_RIGHT               ((uint16_t)2)
#define switch_is_left(s)         (s == RC_SW_LEFT)
#define switch_is_mid(s)          (s == RC_SW_MID)
#define switch_is_right(s)        (s == RC_SW_RIGHT)
/* ----------------------- PC Key Definition-------------------------------- */
#define KEY_PRESSED_OFFSET_W            ((uint16_t)1 << 0)
#define KEY_PRESSED_OFFSET_S            ((uint16_t)1 << 1)
#define KEY_PRESSED_OFFSET_A            ((uint16_t)1 << 2)
#define KEY_PRESSED_OFFSET_D            ((uint16_t)1 << 3)
#define KEY_PRESSED_OFFSET_SHIFT        ((uint16_t)1 << 4)
#define KEY_PRESSED_OFFSET_CTRL         ((uint16_t)1 << 5)
#define KEY_PRESSED_OFFSET_Q            ((uint16_t)1 << 6)
#define KEY_PRESSED_OFFSET_E            ((uint16_t)1 << 7)
#define KEY_PRESSED_OFFSET_R            ((uint16_t)1 << 8)
#define KEY_PRESSED_OFFSET_F            ((uint16_t)1 << 9)
#define KEY_PRESSED_OFFSET_G            ((uint16_t)1 << 10)
#define KEY_PRESSED_OFFSET_Z            ((uint16_t)1 << 11)
#define KEY_PRESSED_OFFSET_X            ((uint16_t)1 << 12)
#define KEY_PRESSED_OFFSET_C            ((uint16_t)1 << 13)
#define KEY_PRESSED_OFFSET_V            ((uint16_t)1 << 14)
#define KEY_PRESSED_OFFSET_B            ((uint16_t)1 << 15)
/* ----------------------- Data Struct ------------------------------------- */
//typedef struct __attribute__((packed))
//{
//        struct __attribute__((packed))
//        {
//                int16_t ch[5];
//                char s[2];
//        } rc;
//        struct __attribute__((packed))
//        {
//                int16_t x;
//                int16_t y;
//                int16_t z;
//                uint8_t press_l;
//                uint8_t press_r;
//        } mouse;
//        struct __attribute__((packed))
//        {
//                uint16_t v;
//        } key;

//} RC_ctrl_t;

typedef struct __attribute__((packed))
{
    uint8_t sof_1;
    uint8_t sof_2;
    int64_t Right_x:11;     /* 存偏移后的通道值 -1024~1023（sbus_to_rc 中先减 1024 再存入） */
    int64_t Right_y:11;
    int64_t Left_y:11;
    int64_t Left_x:11;
    uint64_t mode_sw:2;     /* 0/1/2 = 左/中/右档，必须无符号否则右档 2 回绕成 -2 */
    uint64_t pause:1;
    uint64_t fn_1:1;
    uint64_t fn_2:1;
    uint64_t wheel:11;      /* raw 0~2047，未减偏移，无符号 */
    uint64_t trigger:1;

    int16_t mouse_x;
    int16_t mouse_y;
    int16_t mouse_z;
    uint8_t mouse_left:2;
    uint8_t mouse_right:2;
    uint8_t mouse_middle:2;
    uint16_t key;
    uint16_t crc16;
}remote_data_t;

/* ----------------------- Internal Data ----------------------------------- */

extern void remote_control_init(void);
extern const remote_data_t *get_remote_control_point(void);
extern uint8_t RC_data_is_error(void);
extern void slove_RC_lost(void);
extern void slove_data_error(void);
extern void sbus_to_usart1(uint8_t *sbus);
#endif
