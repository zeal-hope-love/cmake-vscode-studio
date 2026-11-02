/**
 * CubeMX 重新生成之后的「补救」。
 *
 * ## 为什么需要这个
 *
 * VT13 移植流程会调 CubeMX 的 `project generate` 重新生成工程。
 * CubeMX 是**不受控的**：它会把生成的源文件整个重写，只保留
 * `/* USER CODE BEGIN xxx *\/` 和 `/* USER CODE END xxx *\/` 之间的内容。
 *
 * 于是有两个真实后果：
 *
 *   1. **static 冲突**（会直接导致构建失败）
 *      `usbd_cdc_if.c` 里 `CDC_Receive_FS` 的原型/定义在
 *      `PRIVATE_FUNCTIONS_DECLARATION` 区**外面**，CubeMX 每次生成
 *      都会写回 `static` 版本。而这个工程的 `usb_task.c` 要直接调用它，
 *      `usbd_cdc_if.h` 里也声明成了非 static —— gcc 报
 *      "static declaration follows non-static declaration"。
 *
 *   2. **用户手改的东西被覆盖**
 *      用户为了编译通过，手工去掉过 static；一次重新生成又回去了。
 *
 * ## 做法
 *
 * 生成之后跑一遍 `restoreAfterCubeMx()`，把这些已知的、必须保留的
 * 改动重新施加一次。是**幂等**的 —— 已经是对的就不动。
 *
 * 为什么不把这行放进 USER CODE 区：
 * 那需要改 CubeMX 的模板（.ioc 里的 ProjectManager 配置），
 * 影响面太大；而且模板是 CubeMX 自己的格式，版本间有差异。
 * 生成后打补丁更可控，也更容易解释给用户看。
 */

import { existsSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'

export interface RestoreResult {
  /** 做了什么（给人看的） */
  changed: string[]
  /** 检查过了没问题 */
  unchanged: string[]
  /** 想做但失败了 */
  errors: string[]
}

/**
 * 读文件（自动识别换行），改完按原样写回。
 *
 * 必须保留原来的换行风格 —— 混用 CRLF/LF 会让 diff 变得没法看，
 * 而且 CubeMX 自己写的是 CRLF。
 */
function readText(p: string): string | null {
  if (!existsSync(p)) return null
  try {
    return readFileSync(p, 'utf8')
  } catch {
    return null
  }
}

/**
 * 去掉 `usbd_cdc_if.c` 里 `CDC_Receive_FS` 的 static。
 *
 * 只改这一处（原型 + 定义），其它函数保持 CubeMX 原样 ——
 * 改多了会掩盖真正的问题。
 */
function fixCdcReceiveStatic(root: string): { changed: boolean; reason: string } {
  const p = join(root, 'Src', 'usbd_cdc_if.c')
  const text = readText(p)
  if (text === null) return { changed: false, reason: '没有 usbd_cdc_if.c（工程没开 USB CDC）' }

  /*
   * 匹配 `static int8_t CDC_Receive_FS(...)`。
   *
   * 只匹配「行首可能带空白 + static + int8_t + CDC_Receive_FS」，
   * 不碰函数体里可能出现的其它引用。
   */
  const re = /^(\s*)static(\s+int8_t\s+CDC_Receive_FS\s*\()/gm
  if (!re.test(text)) {
    return { changed: false, reason: '已经是非 static' }
  }

  const out = text.replace(re, '$1int8_t CDC_Receive_FS(')

  /*
   * 写回前做一次自检：改完之后文件里**不应该**再有
   * `static int8_t CDC_Receive_FS`。数量对不上说明正则误伤了，
   * 宁可不写。
   */
  if (/^\s*static\s+int8_t\s+CDC_Receive_FS\s*\(/m.test(out)) {
    return { changed: false, reason: '替换后仍有 static，未写回' }
  }

  writeFileSync(p, out, 'utf8')
  return { changed: true, reason: '去掉了 CDC_Receive_FS 的 static' }
}

/**
 * 确认头文件里 `CDC_Receive_FS` 的声明是非 static 的。
 *
 * 头文件不是 CubeMX 管的（它是 .h 里的 USER CODE 区外，但 CubeMX
 * 通常不改已有声明），这里只检查、不修改 —— 如果它被改成了 static，
 * 说明情况超出预期，报出来让人看。
 */
function checkCdcHeader(root: string): { ok: boolean; detail: string } {
  const p = join(root, 'Inc', 'usbd_cdc_if.h')
  const text = readText(p)
  if (text === null) return { ok: true, detail: '没有 usbd_cdc_if.h，跳过' }

  const hasDecl = /int8_t\s+CDC_Receive_FS\s*\(/.test(text)
  const isStatic = /static\s+int8_t\s+CDC_Receive_FS\s*\(/.test(text)

  if (!hasDecl) return { ok: true, detail: '头文件里没有这个声明' }
  if (isStatic) {
    return {
      ok: false,
      detail: 'usbd_cdc_if.h 里 CDC_Receive_FS 被声明成了 static，需要人工确认'
    }
  }
  return { ok: true, detail: '头文件声明正确' }
}

/**
 * CubeMX 生成后跑一次。
 *
 * 目前只处理 `CDC_Receive_FS` 的 static —— 这是实际踩过的坑。
 * 将来遇到别的「CubeMX 会覆盖掉、但必须保留」的改动，往这里加。
 */
export function restoreAfterCubeMx(root: string): RestoreResult {
  const result: RestoreResult = { changed: [], unchanged: [], errors: [] }

  const cdc = fixCdcReceiveStatic(root)
  if (cdc.changed) result.changed.push(`usbd_cdc_if.c：${cdc.reason}`)
  else result.unchanged.push(`usbd_cdc_if.c：${cdc.reason}`)

  const header = checkCdcHeader(root)
  if (!header.ok) result.errors.push(header.detail)

  return result
}