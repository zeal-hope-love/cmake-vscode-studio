/**
 * CubeMX 重新生成**之后**的检查。
 *
 * ## 背景：一个反复踩的坑
 *
 * 这个工程的 `usb_task.c` 需要「重新开始收包」。早期的写法是直接调
 * CubeMX 生成的 `CDC_Receive_FS`，但那个函数在 `usbd_cdc_if.c` 里是
 * `static` 的，而 `usbd_cdc_if.h` 又声明成了非 static —— 编译器报：
 *
 *     error: static declaration of 'CDC_Receive_FS'
 *            follows non-static declaration
 *
 * 麻烦在于这个 `static` **写在 USER CODE 区外面**，每次 CubeMX
 * `project generate` 都会改回去。于是「修好 → 生成 → 又坏」循环。
 *
 * ## 现在的做法（见业务代码里的注释）
 *
 * 不再调 `CDC_Receive_FS`，改用 USB 库的标准接口：
 *
 *     USBD_CDC_SetRxBuffer(&hUsbDeviceFS, buf);
 *     USBD_CDC_ReceivePacket(&hUsbDeviceFS);
 *
 * 这两行和 `CDC_Receive_FS` 内部做的事一模一样，但都在业务文件
 * （`application/usb_task.c`）里 —— **CubeMX 不碰它**，所以
 * 怎么重新生成都不会坏。
 *
 * ## 这个模块的作用
 *
 * 生成之后**只检查、不修改**：
 *   · 如果发现头文件里还留着那句非 static 声明 → 报出来
 *     （说明是老工程，没按新写法改过）
 *   · 如果 `usb_task.c` 还在调 `CDC_Receive_FS` → 报出来
 *
 * 不自动改的原因：改业务代码的风险比改生成文件大得多，
 * 而且这两种情况都说明工程本身需要人工确认一次。
 */

import { existsSync, readFileSync } from 'node:fs'
import { join } from 'node:path'

export interface PostCubeMxCheck {
  /** 有问题需要人看 */
  problems: string[]
  /** 检查通过的信息（给界面显示用） */
  notes: string[]
}

function readText(p: string): string | null {
  if (!existsSync(p)) return null
  try {
    return readFileSync(p, 'utf8')
  } catch {
    return null
  }
}

/**
 * CubeMX 生成后跑一次。
 *
 * 只读，不改任何文件 —— 这个函数可以在流程里放心调用。
 */
export function checkAfterCubeMx(root: string): PostCubeMxCheck {
  const result: PostCubeMxCheck = { problems: [], notes: [] }

  // ---- ① 头文件里不该有非 static 的 CDC_Receive_FS 声明 ----
  const header = readText(join(root, 'Inc', 'usbd_cdc_if.h'))
  if (header !== null) {
    const hasConflict = /^\s*int8_t\s+CDC_Receive_FS\s*\(/m.test(header)
    if (hasConflict) {
      result.problems.push(
        'usbd_cdc_if.h 里还留着 `int8_t CDC_Receive_FS(...)` 的非 static 声明，' +
          '会和 .c 里的 static 冲突。' +
          '删掉那行、改成调 USBD_CDC_SetRxBuffer / USBD_CDC_ReceivePacket。'
      )
    } else {
      result.notes.push('usbd_cdc_if.h：没有冲突声明')
    }
  }

  // ---- ② 业务代码不该再直接调 CDC_Receive_FS ----
  const usbTask = readText(join(root, 'application', 'usb_task.c'))
  if (usbTask !== null) {
    /*
     * 只看「真正被调用的」——注释掉的那行不算。
     * 逐行判断：去掉行首的 `//` 之后还以 CDC_Receive_FS( 开头才算调用。
     */
    const stillCalls = usbTask
      .split(/\r?\n/)
      .some((line) => {
        const trimmed = line.trim()
        if (trimmed.startsWith('//') || trimmed.startsWith('*') || trimmed.startsWith('/*')) {
          return false
        }
        return /\bCDC_Receive_FS\s*\(/.test(trimmed) && !/^\s*(static|\/)/.test(trimmed)
      })

    if (stillCalls) {
      result.problems.push(
        'application/usb_task.c 还在直接调用 CDC_Receive_FS。' +
          '改成 USBD_CDC_SetRxBuffer(&hUsbDeviceFS, buf) + ' +
          'USBD_CDC_ReceivePacket(&hUsbDeviceFS)，就不会被 CubeMX 打回原形。'
      )
    } else {
      result.notes.push('usb_task.c：已改用标准 USB 接口')
    }
  }

  return result
}