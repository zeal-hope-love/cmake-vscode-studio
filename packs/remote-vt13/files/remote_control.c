/**
  ****************************(C) COPYRIGHT 2019 DJI****************************
  * @file       remote_control.c/h
  * @brief      遥控器处理，遥控器是通过类似SBUS的协议传输，利用DMA传输方式节约CPU
  *             资源，利用串口空闲中断来拉起处理函数，同时提供一些掉线重启DMA，串口
  *             的方式保证热插拔的稳定性。
  * @note       该任务是通过串口中断启动，不是freeRTOS任务
  * @history
  *  Version    Date            Author          Modification
  *  V1.0.0     Dec-26-2018     RM              1. done
  *  V1.0.0     Nov-11-2019     RM              1. support development board tpye c
  *
  @verbatim
  ==============================================================================

  ==============================================================================
  @endverbatim
  ****************************(C) COPYRIGHT 2019 DJI****************************
  */

#include "remote_control.h"
#include "main.h"
#include "bsp_usart.h"
#include "string.h"
#include "detect_task.h"
#include "CRC8_CRC16.h"



//遥控器出错数据上限
#define RC_CHANNAL_ERROR_VALUE 700

extern UART_HandleTypeDef huart1;
extern DMA_HandleTypeDef hdma_usart1_rx;


//取正函数
static int16_t RC_abs(int16_t value);
/**
  * @brief          remote control protocol resolution
  * @param[in]      sbus_buf: raw data point
  * @param[out]     rc_ctrl: remote control data struct point
  * @retval         none
  */
/**
  * @brief          遥控器协议解析
  * @param[in]      sbus_buf: 原生数据指针
  * @param[out]     rc_ctrl: 遥控器数据指
  * @retval         none
  */
static void sbus_to_rc(volatile const uint8_t *sbus_buf, remote_data_t *rc_ctrl);

//remote control data 
//遥控器控制变量
remote_data_t rc_ctrl;
//接收原始数据，为21个字节，给了42个字节长度，防止DMA传输越界
static uint8_t sbus_rx_buf[2][SBUS_RX_BUF_NUM];


/**
  * @brief          remote control init
  * @param[in]      none
  * @retval         none
  */
/**
  * @brief          遥控器初始化
  * @param[in]      none
  * @retval         none
  */
void remote_control_init(void)
{
    RC_Init(sbus_rx_buf[0], sbus_rx_buf[1], SBUS_RX_BUF_NUM);
}
/**
  * @brief          get remote control data point
  * @param[in]      none
  * @retval         remote control data point
  */
/**
  * @brief          获取遥控器数据指针
  * @param[in]      none
  * @retval         遥控器数据指针
  */
const remote_data_t *get_remote_control_point(void)
{
    return &rc_ctrl;
}

//判断遥控器数据是否出错，
uint8_t RC_data_is_error(void)
{
    //使用了go to语句 方便出错统一处理遥控器变量数据归零
    if (RC_abs(rc_ctrl.Right_x) > RC_CHANNAL_ERROR_VALUE)
    {
        goto error;
    }
    if (RC_abs(rc_ctrl.Right_y) > RC_CHANNAL_ERROR_VALUE)
    {
        goto error;
    }
    if (RC_abs(rc_ctrl.Left_y) > RC_CHANNAL_ERROR_VALUE)
    {
        goto error;
    }
    if (RC_abs(rc_ctrl.Left_x) > RC_CHANNAL_ERROR_VALUE)
    {
        goto error;
    }
    return 0;

error:
    rc_ctrl.Right_x = 0;
    rc_ctrl.Right_y = 0;
    rc_ctrl.Left_y = 0;
    rc_ctrl.Left_x = 0;
    rc_ctrl.mode_sw = 0;
    rc_ctrl.mouse_x = 0;
    rc_ctrl.mouse_y = 0;
    rc_ctrl.mouse_z = 0;
    rc_ctrl.mouse_left = 0;
    rc_ctrl.mouse_right = 0;
		rc_ctrl.mouse_middle = 0;
    rc_ctrl.key = 0;
    return 1;
}

void slove_RC_lost(void)
{
    RC_restart(SBUS_RX_BUF_NUM);
}
void slove_data_error(void)
{
    RC_restart(SBUS_RX_BUF_NUM);
}

//串口中断 -> DT7
//void USART3_IRQHandler(void)
//{
//    if(huart3.Instance->SR & UART_FLAG_RXNE)//接收到数据
//    {
//        __HAL_UART_CLEAR_PEFLAG(&huart3);
//    }
//    else if(USART3->SR & UART_FLAG_IDLE)
//    {
//        static uint16_t this_time_rx_len = 0;

//        __HAL_UART_CLEAR_PEFLAG(&huart3);

//        if ((hdma_usart3_rx.Instance->CR & DMA_SxCR_CT) == RESET)
//        {
//            /* Current memory buffer used is Memory 0 */

//            //disable DMA
//            //失效DMA
//            __HAL_DMA_DISABLE(&hdma_usart3_rx);

//            //get receive data length, length = set_data_length - remain_length
//            //获取接收数据长度,长度 = 设定长度 - 剩余长度
//            this_time_rx_len = SBUS_RX_BUF_NUM - hdma_usart3_rx.Instance->NDTR;

//            //reset set_data_lenght
//            //重新设定数据长度
//            hdma_usart3_rx.Instance->NDTR = SBUS_RX_BUF_NUM;

//            //set memory buffer 1
//            //设定缓冲区1
//            hdma_usart3_rx.Instance->CR |= DMA_SxCR_CT;
//            
//            //enable DMA
//            //使能DMA
//            __HAL_DMA_ENABLE(&hdma_usart3_rx);

//            if(this_time_rx_len == RC_FRAME_LENGTH)
//            {
//                sbus_to_rc(sbus_rx_buf[0], &rc_ctrl);
//                //记录数据接收时间
//                detect_hook(DBUS_TOE);
//                sbus_to_usart1(sbus_rx_buf[0]);
//            }
//        }
//        else
//        {
//            /* Current memory buffer used is Memory 1 */
//            //disable DMA
//            //失效DMA
//            __HAL_DMA_DISABLE(&hdma_usart3_rx);

//            //get receive data length, length = set_data_length - remain_length
//            //获取接收数据长度,长度 = 设定长度 - 剩余长度
//            this_time_rx_len = SBUS_RX_BUF_NUM - hdma_usart3_rx.Instance->NDTR;

//            //reset set_data_lenght
//            //重新设定数据长度
//            hdma_usart3_rx.Instance->NDTR = SBUS_RX_BUF_NUM;

//            //set memory buffer 0
//            //设定缓冲区0
//            hdma_usart1_rx.Instance->CR &= ~(DMA_SxCR_CT);
//            
//            //enable DMA
//            //使能DMA
//            __HAL_DMA_ENABLE(&hdma_usart3_rx);

//            if(this_time_rx_len == RC_FRAME_LENGTH)
//            {
//                //处理遥控器数据
//                sbus_to_rc(sbus_rx_buf[1], &rc_ctrl);
//                //记录数据接收时间
//                detect_hook(DBUS_TOE);
//                sbus_to_usart1(sbus_rx_buf[1]);
//            }
//        }
//    }

//}

//串口中断 -> VT13
void USART1_IRQHandler(void)
{
    if(huart1.Instance->SR & UART_FLAG_RXNE)//接收到数据
    {
        __HAL_UART_CLEAR_PEFLAG(&huart1);
    }
    else if(USART1->SR & UART_FLAG_IDLE)
    {
        static uint16_t this_time_rx_len = 0;

        __HAL_UART_CLEAR_PEFLAG(&huart1);

        if ((hdma_usart1_rx.Instance->CR & DMA_SxCR_CT) == RESET)
        {
            /* Current memory buffer used is Memory 0 */

            //disable DMA
            //失效DMA
            __HAL_DMA_DISABLE(&hdma_usart1_rx);

            //get receive data length, length = set_data_length - remain_length
            //获取接收数据长度,长度 = 设定长度 - 剩余长度
            this_time_rx_len = SBUS_RX_BUF_NUM - hdma_usart1_rx.Instance->NDTR;

            //reset set_data_lenght
            //重新设定数据长度
            hdma_usart1_rx.Instance->NDTR = SBUS_RX_BUF_NUM;

            //set memory buffer 1
            //设定缓冲区1
            hdma_usart1_rx.Instance->CR |= DMA_SxCR_CT;
            
            //enable DMA
            //使能DMA
            __HAL_DMA_ENABLE(&hdma_usart1_rx);

            if((this_time_rx_len == RC_FRAME_LENGTH) && (sbus_rx_buf[0][0] == RC_frame_header1) && (sbus_rx_buf[0][1] == RC_frame_header2))
            {
                if (verify_CRC16_check_sum((uint8_t *)sbus_rx_buf[0], RC_FRAME_LENGTH))
								{
									sbus_to_rc(sbus_rx_buf[0], &rc_ctrl);
									//记录数据接收时间
									detect_hook(DBUS_TOE);
//									sbus_to_usart1(sbus_rx_buf[0]);
								}
								
            }
        }
        else
        {
            /* Current memory buffer used is Memory 1 */
            //disable DMA
            //失效DMA
            __HAL_DMA_DISABLE(&hdma_usart1_rx);

            //get receive data length, length = set_data_length - remain_length
            //获取接收数据长度,长度 = 设定长度 - 剩余长度
            this_time_rx_len = SBUS_RX_BUF_NUM - hdma_usart1_rx.Instance->NDTR;

            //reset set_data_lenght
            //重新设定数据长度
            hdma_usart1_rx.Instance->NDTR = SBUS_RX_BUF_NUM;

            //set memory buffer 0
            //设定缓冲区0
            hdma_usart1_rx.Instance->CR &= ~(DMA_SxCR_CT);
            
            //enable DMA
            //使能DMA
            __HAL_DMA_ENABLE(&hdma_usart1_rx);

            if((this_time_rx_len == RC_FRAME_LENGTH) && (sbus_rx_buf[1][0] == RC_frame_header1) && (sbus_rx_buf[1][1] == RC_frame_header2))
            {
								if (verify_CRC16_check_sum((uint8_t *)sbus_rx_buf[1], RC_FRAME_LENGTH))
								{
									//处理遥控器数据
									sbus_to_rc(sbus_rx_buf[1], &rc_ctrl);
									//记录数据接收时间
									detect_hook(DBUS_TOE);
//									sbus_to_usart1(sbus_rx_buf[1]);
								}
            }
        }
    }

}
//void USART3_IRQHandler(void)
//{
//    if(USART3->SR & UART_FLAG_IDLE)          // ① 先处理 IDLE
//    {
//        static uint16_t this_time_rx_len = 0;

//        __HAL_UART_CLEAR_PEFLAG(&huart3);    // 清 IDLE + 错误标志

//        if ((hdma_usart3_rx.Instance->CR & DMA_SxCR_CT) == RESET)
//        {
//            /* 当前缓冲区 Memory 0 */
//            __HAL_DMA_DISABLE(&hdma_usart3_rx);
//            this_time_rx_len = SBUS_RX_BUF_NUM - hdma_usart3_rx.Instance->NDTR;
//            hdma_usart3_rx.Instance->NDTR = SBUS_RX_BUF_NUM;
//            hdma_usart3_rx.Instance->CR |= DMA_SxCR_CT;     // 切到 Memory 1
//            __HAL_DMA_ENABLE(&hdma_usart3_rx);

//            if(this_time_rx_len == RC_FRAME_LENGTH &&
//               sbus_rx_buf[0][0] == frame_header1 &&
//               sbus_rx_buf[0][1] == frame_header2)
//            {
//                sbus_to_rc(sbus_rx_buf[0], &rc_ctrl);
//                detect_hook(DBUS_TOE);
//                sbus_to_usart1(sbus_rx_buf[0]);
//            }
//        }
//        else
//        {
//            /* 当前缓冲区 Memory 1 */
//            __HAL_DMA_DISABLE(&hdma_usart3_rx);
//            this_time_rx_len = SBUS_RX_BUF_NUM - hdma_usart3_rx.Instance->NDTR;
//            hdma_usart3_rx.Instance->NDTR = SBUS_RX_BUF_NUM;
//            hdma_usart3_rx.Instance->CR &= ~(DMA_SxCR_CT);   // 切回 Memory 0
//            __HAL_DMA_ENABLE(&hdma_usart3_rx);

//            if(this_time_rx_len == RC_FRAME_LENGTH &&
//               sbus_rx_buf[1][0] == frame_header1 &&
//               sbus_rx_buf[1][1] == frame_header2)
//            {
//                sbus_to_rc(sbus_rx_buf[1], &rc_ctrl);
//                detect_hook(DBUS_TOE);
//                sbus_to_usart1(sbus_rx_buf[1]);
//            }
//        }
//    }
//    else if(huart3.Instance->SR & UART_FLAG_RXNE)   // ② 仅当无 IDLE 时
//    {
//        __HAL_UART_CLEAR_PEFLAG(&huart3);
//    }
//}

//取正函数
static int16_t RC_abs(int16_t value)
{
    if (value > 0)
    {
        return value;
    }
    else
    {
        return -value;
    }
}
/**
  * @brief          remote control protocol resolution
  * @param[in]      sbus_buf: raw data point
  * @param[out]     rc_ctrl: remote control data struct point
  * @retval         none
  */
/**
  * @brief          遥控器协议解析
  * @param[in]      sbus_buf: 原生数据指针
  * @param[out]     rc_ctrl: 遥控器数据指
  * @retval         none
  */
static void sbus_to_rc(volatile const uint8_t *sbus_buf, remote_data_t *rc_ctrl)
{
    if (sbus_buf == NULL || rc_ctrl == NULL)
    {
        return;
    }

		rc_ctrl->sof_1 = sbus_buf[0];
		rc_ctrl->sof_2 = sbus_buf[1];
		
    rc_ctrl->Right_x = ((sbus_buf[2] | (sbus_buf[3] << 8)) & 0x07ff) - RC_CH_VALUE_OFFSET; //!< Channel 0, -1024~1023
    rc_ctrl->Right_y = (((sbus_buf[3] >> 3) | (sbus_buf[4] << 5)) & 0x07ff) - RC_CH_VALUE_OFFSET; //!< Channel 1
    rc_ctrl->Left_y = (((sbus_buf[4] >> 6) | (sbus_buf[5] << 2) | (sbus_buf[6] << 10)) & 0x07ff) - RC_CH_VALUE_OFFSET; //!< Channel 2
    rc_ctrl->Left_x = (((sbus_buf[6] >> 1) | (sbus_buf[7] << 7)) & 0x07ff) - RC_CH_VALUE_OFFSET; //!< Channel 3
		
    rc_ctrl->mode_sw = (sbus_buf[7] >> 4) & 0x0003;                  //!< Switch
    rc_ctrl->pause = ((sbus_buf[7] >> 4) & 0x0004) >> 2;                       //!< pause key
		rc_ctrl->fn_1 = ((sbus_buf[7] >> 4) & 0x0008) >> 3;                       //!< fn_left
		rc_ctrl->fn_2 = sbus_buf[8] & 0x0001;                       //!< fn_right
		rc_ctrl->wheel = ((sbus_buf[8] >> 1) | (sbus_buf[9] << 7)) & 0x07ff;                       //!< wheel
		rc_ctrl->trigger = (sbus_buf[9] >> 4) & 0x0001;                       //!< trigger key
		
    rc_ctrl->mouse_x = sbus_buf[10] | (sbus_buf[11] << 8);                    //!< Mouse X axis
    rc_ctrl->mouse_y = sbus_buf[12] | (sbus_buf[13] << 8);                    //!< Mouse Y axis
    rc_ctrl->mouse_z = sbus_buf[14] | (sbus_buf[15] << 8);                 	 //!< Mouse Z axis
    rc_ctrl->mouse_left = sbus_buf[16] & 0x0003;                                  //!< Mouse Left Is Press
    rc_ctrl->mouse_right = (sbus_buf[16] >> 2) & 0x0003;                                  //!< Mouse Right Is Press
		rc_ctrl->mouse_middle = (sbus_buf[16] >> 4) & 0x0003;                                  //!< Mouse Middle Is Press
    rc_ctrl->key = (sbus_buf[17] | (sbus_buf[18] << 8)) & 0xffff;                   //!< KeyBoard value
    
		rc_ctrl->crc16 = (sbus_buf[19] | (sbus_buf[20] << 8)) & 0xffff;                 //crc16
		}

/**
  * @brief          send sbus data by usart1, called in usart3_IRQHandle
  * @param[in]      sbus: sbus data, 18 bytes
  * @retval         none
  */
/**
  * @brief          通过usart1发送sbus数据,在usart3_IRQHandle调用
  * @param[in]      sbus: sbus数据, 18字节
  * @retval         none
  */
void sbus_to_usart1(uint8_t *sbus)
{
//    static uint8_t usart_tx_buf[20];
//    static uint8_t i =0;
//    usart_tx_buf[0] = 0xA6;
//    memcpy(usart_tx_buf + 1, sbus, 18);
//    for(i = 0, usart_tx_buf[19] = 0; i < 19; i++)
//    {
//        usart_tx_buf[19] += usart_tx_buf[i];
//    }
//    usart1_tx_dma_enable(usart_tx_buf, 20);
}

