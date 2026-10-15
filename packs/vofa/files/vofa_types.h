/**
  ******************************************************************************
  * @file       vofa_types.h
  * @brief      fp32 / bool_t 的来源适配
  *
  * 不同的 RM 工程对这两个类型的定义方式不一样：有的有 struct_typedef.h，
  * 有的直接 <stdint.h> + <stdbool.h>。由 vofa_config.h 里的
  * VOFA_HAS_STRUCT_TYPEDEF 决定走哪条，模块本身不关心。
  ******************************************************************************
  */
#ifndef VOFA_TYPES_H
#define VOFA_TYPES_H

#include <stdint.h>
#include <stdbool.h>

#include "vofa_config.h"

#if VOFA_HAS_STRUCT_TYPEDEF
#include "struct_typedef.h"
#else
typedef float fp32;
typedef double fp64;
typedef unsigned char bool_t;
#endif

#endif /* VOFA_TYPES_H */
