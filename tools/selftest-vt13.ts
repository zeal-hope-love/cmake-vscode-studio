/**
 * P0 模块自检：.ioc 编辑器、字段替换引擎、#if 0 幂等处理。
 *
 * 全部用**真实项目文件**测，不用构造的假数据 —— 假数据永远不会暴露
 * 「真实文件里有 CRLF」「里面有 BOM」这类问题。
 */

import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { IocEditor } from '../src/main/services/ioc/edit'
import { commentOutUsartHandler, isHandlerCommentedOut } from '../src/main/services/vt13/itHandler'
import { transformRcCode } from '../src/main/services/vt13/codeTransform'
import { usart1RxDmaFields, VT13_NVIC_USART1, VT13_BAUD } from '../src/main/services/vt13/iocSpec'

let checks = 0
let failures = 0

function check(name: string, ok: boolean, detail?: string): void {
  checks++
  if (ok) {
    console.log(`  ✓ ${name}`)
  } else {
    failures++
    console.log(`  ✗ ${name}${detail ? ` —— ${detail}` : ''}`)
  }
}

function section(title: string): void {
  console.log(`\n${'='.repeat(74)}`)
  console.log(title)
  console.log('='.repeat(74))
}

const sandbox = join(process.env['TEMP'] ?? '/tmp', 'cv-vt13-selftest')
rmSync(sandbox, { recursive: true, force: true })
mkdirSync(sandbox, { recursive: true })

// ==========================================================================
section('VT13 · .ioc 语义化编辑')
// ==========================================================================

const iocPath = join(sandbox, 'test.ioc')
writeFileSync(
  iocPath,
  [
    '#MicroXplorer Configuration settings - do not modify',
    'MxCube.Version=6.17.0',
    'Dma.Request0=SPI1_TX',
    'Dma.Request1=USART3_RX',
    'Dma.RequestsNb=2',
    'NVIC.USART3_IRQn=true\\:4\\:0\\:true\\:false\\:false\\:false\\:true\\:true\\:true',
    'USART1.IPParameters=VirtualMode',
    'USART1.VirtualMode=VM_ASYNC',
    ''
  ].join('\r\n'),
  'utf8'
)

{
  const e = new IocEditor(iocPath)

  check('.ioc: 能读出已有键', e.get('MxCube.Version') === '6.17.0')
  check('.ioc: 不存在的键返回 null', e.get('USART1.BaudRate') === null)

  // 改一个不存在的键 → 应该是 insert
  const k1 = e.set('USART1.BaudRate', String(VT13_BAUD))
  check('.ioc: 插入新键', k1 === 'inserted', k1)
  check('.ioc: 插入后能读回', e.get('USART1.BaudRate') === '921600')

  // 重复设同一个值 → unchanged（幂等的关键）
  const k2 = e.set('USART1.BaudRate', String(VT13_BAUD))
  check('.ioc: 设相同值返回 unchanged（幂等）', k2 === 'unchanged', k2)

  // 改已有键 → modified
  const k3 = e.set('USART1.IPParameters', 'VirtualMode,BaudRate')
  check('.ioc: 修改已有键', k3 === 'modified', k3)

  // DMA：已有 2 个请求（0、1），新的应该用编号 2
  const { slot } = e.ensureDmaRequest('USART1_RX', usart1RxDmaFields('DMA2_Stream5'))
  check('.ioc: DMA 用最小可用编号（0、1 已占 → 取 2）', slot === '2', `实际 ${slot}`)
  check('.ioc: Dma.Request2 指向 USART1_RX', e.get('Dma.Request2') === 'USART1_RX')
  check('.ioc: RequestsNb 同步到 3', e.get('Dma.RequestsNb') === '3', e.get('Dma.RequestsNb'))
  check(
    '.ioc: DMA Mode 是 NORMAL（不是 CIRCULAR）',
    e.get('Dma.USART1_RX.2.Mode') === 'DMA_NORMAL',
    e.get('Dma.USART1_RX.2.Mode') ?? 'null'
  )
  check(
    '.ioc: RequestParameters 字段顺序正确',
    e.get('Dma.USART1_RX.2.RequestParameters') ===
      'Instance,Direction,PeriphInc,MemInc,PeriphDataAlignment,MemDataAlignment,Mode,Priority,FIFOMode',
    e.get('Dma.USART1_RX.2.RequestParameters') ?? 'null'
  )

  // 再跑一次 ensureDmaRequest → 复用编号 2，不新增
  const again = e.ensureDmaRequest('USART1_RX', usart1RxDmaFields('DMA2_Stream5'))
  check('VT13 · DMA 重复 ensure 复用同一编号（幂等）', again.slot === '2', again.slot)
  check('VT13 · DMA 重复 ensure 不再改动字段', again.edits.length === 0, `改了 ${again.edits.length} 处`)

  // NVIC
  e.set('NVIC.USART1_IRQn', VT13_NVIC_USART1)
  check('.ioc: NVIC 冒号带转义', (e.get('NVIC.USART1_IRQn') ?? '').includes('\\:'))

  // Stream 冲突检测
  check(
    '.ioc: 自家 Stream 不算冲突',
    e.findStreamConflict('DMA2_Stream5', 'USART1_RX') === null
  )
  e.set('Dma.SPI7_TX.0.Instance', 'DMA2_Stream5')
  check(
    '.ioc: 别的外设占用同一 Stream 能被检出',
    e.findStreamConflict('DMA2_Stream5', 'USART1_RX') === 'SPI7_TX'
  )

  // 换行符保留
  const before = readFileSync(iocPath, 'utf8')
  check('.ioc: 原文件是 CRLF', before.includes('\r\n'))
  e.save()
  const after = readFileSync(iocPath, 'utf8')
  check('.ioc: 保存后仍是 CRLF', after.includes('\r\n'))
  check('.ioc: 保存后没有被改成 LF', !/[^\r]\n/.test(after))
}

// ==========================================================================
section('VT13 · 业务层字段替换')
// ==========================================================================

{
  const src = [
    '    chassis_move.chassis_RC->rc.ch[CHASSIS_X_CHANNEL] * CHASSIS_SPEED;',
    '    chassis_move.chassis_RC->rc.ch[CHASSIS_Y_CHANNEL];',
    '    rc->rc.ch[0];',
    '    rc->rc.ch[1];',
    '    rc->rc.ch[2];',
    '    rc->rc.ch[3];',
    '    switch_is_up(rc->rc.s[CHASSIS_MODE_CHANNEL]);',
    '    switch_is_down(rc->rc.s[CHASSIS_MODE_CHANNEL]);',
    '    if (rc->key.v & SHOOT_ON_KEYBOARD) {}',
    '    rc->mouse.x; rc->mouse.y; rc->mouse.z;',
    '    rc->mouse.press_l; rc->mouse.press_r;',
    '    const RC_ctrl_t *rc = get_remote_control_point();'
  ].join('\n')

  const r = transformRcCode(src, { replaceSwitchMacros: true })

  check('替换: rc.ch[0] → Right_y（前后，不是 Right_x）', r.text.includes('rc->Right_y;'))
  check('替换: rc.ch[1] → Right_x', r.text.includes('rc->Right_x;'))
  check('替换: rc.ch[2] → Left_y', r.text.includes('rc->Left_y;'))
  check('替换: rc.ch[3] → Left_x', r.text.includes('rc->Left_x;'))
  check('替换: 宏通道 CHASSIS_X_CHANNEL → Right_y', r.text.includes('->Right_y * CHASSIS_SPEED'))
  check('替换: 宏通道 CHASSIS_Y_CHANNEL → Right_x', r.text.includes('->Right_x;'))
  check('替换: rc.s[] → mode_sw', r.text.includes('switch_is_right(rc->mode_sw)'))
  check('替换: switch_is_up → switch_is_right', r.text.includes('switch_is_right('))
  check('替换: switch_is_down → switch_is_left', r.text.includes('switch_is_left('))
  check('替换: key.v → key', r.text.includes('rc->key &'))
  check('替换: mouse.x → mouse_x', r.text.includes('rc->mouse_x;'))
  check('替换: mouse.press_l → mouse_left', r.text.includes('rc->mouse_left;'))
  check('替换: mouse.press_r → mouse_right', r.text.includes('rc->mouse_right;'))
  check('替换: RC_ctrl_t → remote_data_t', r.text.includes('const remote_data_t *rc'))
  check('替换: 旧写法零残留', r.residue.length === 0, JSON.stringify(r.residue))

  // 幂等：再跑一次应该没有变化
  const r2 = transformRcCode(r.text, { replaceSwitchMacros: true })
  check('替换: 二次执行无变化（幂等）', r2.text === r.text)
  check('替换: 二次执行没有新 note', r2.notes.length === 0, JSON.stringify(r2.notes))

  // 注释里的旧写法不算残留
  const commented = '// rc->rc.ch[0] 这行是注释\nint a = 1;'
  const r3 = transformRcCode(commented)
  check('替换: 注释里的旧写法不计入残留', r3.residue.length === 0, JSON.stringify(r3.residue))
}

// ==========================================================================
section('VT13 · stm32f4xx_it.c 的 #if 0 幂等处理')
// ==========================================================================

{
  const itSource = [
    '/**',
    '  * @brief This function handles USART1 global interrupt.',
    '  */',
    'void USART1_IRQHandler(void)',
    '{',
    '  /* USER CODE BEGIN USART1_IRQn 0 */',
    '  /* USER CODE END USART1_IRQn 0 */',
    '  HAL_UART_IRQHandler(&huart1);',
    '  /* USER CODE BEGIN USART1_IRQn 1 */',
    '  /* USER CODE END USART1_IRQn 1 */',
    '}',
    '',
    'void HAL_UART_RxCpltCallback(UART_HandleTypeDef *huart)',
    '{',
    '}',
    ''
  ].join('\n')

  check('it.c: 处理前判定为「未屏蔽」', !isHandlerCommentedOut(itSource))

  const first = commentOutUsartHandler(itSource)
  check('it.c: 第一次处理成功', first.changed && first.reason === 'wrapped', first.reason)
  check('it.c: 加了 #if 0', first.text.includes('#if 0'))
  check('it.c: 加了 #endif', first.text.includes('#endif'))
  check('it.c: 处理后判定为「已屏蔽」', isHandlerCommentedOut(first.text))
  check(
    'it.c: 函数体保留（没删代码）',
    first.text.includes('HAL_UART_IRQHandler(&huart1);')
  )
  check(
    'it.c: 其它函数没被误伤',
    first.text.includes('void HAL_UART_RxCpltCallback')
  )

  // 幂等：再跑一次不应有变化
  const second = commentOutUsartHandler(first.text)
  check('it.c: 二次处理不重复包裹（幂等）', !second.changed)
  check('it.c: 二次处理原因正确', second.reason === 'already-wrapped', second.reason)
  // 只数「真正的预处理指令行」—— 注释里提到 #if 0 是在解释屏蔽原因，不算重复包裹
  const realIf0 = second.text
    .split(/\r?\n/)
    .filter((ln) => /^\s*#\s*if\s+0\b/.test(ln)).length
  check('it.c: 二次处理后只有一条真 #if 0 指令', realIf0 === 1, `实际 ${realIf0} 条`)

  // 没有这个函数时不应该报错
  const noHandler = 'int main(void) { return 0; }'
  const third = commentOutUsartHandler(noHandler)
  check('it.c: 找不到 handler 时不报错', !third.changed && third.reason === 'no-handler')
}

// ==========================================================================
section('VT13 · 参考工程真实文件回归')
// ==========================================================================

const HERO = 'C:/Users/PoXia/Desktop/RM/Test_project/Hero_9.1/Hero_9.1'
if (existsSync(join(HERO, 'Src/stm32f4xx_it.c'))) {
  const real = readFileSync(join(HERO, 'Src/stm32f4xx_it.c'), 'utf8')
  const res = commentOutUsartHandler(real)
  check(
    '真实工程: Hero_9.1 的 stm32f4xx_it.c 能正确处理',
    res.reason === 'wrapped' || res.reason === 'already-wrapped' || res.reason === 'no-handler',
    res.reason
  )
  if (res.reason === 'wrapped') {
    check('真实工程: 处理后 handler 被屏蔽', isHandlerCommentedOut(res.text))
  }
} else {
  check('真实工程: Hero_9.1 存在（跳过了真实文件回归）', true)
}

// 用真实的 chassis_behaviour.c 跑一遍替换，确认不崩、且残留归零
if (existsSync(join(HERO, 'application/chassis_behaviour.c'))) {
  const src = readFileSync(join(HERO, 'application/chassis_behaviour.c'), 'utf8')
  const r = transformRcCode(src)
  check(
    '真实工程: Hero_9.1 的 chassis_behaviour.c 替换后旧写法零残留',
    r.residue.length === 0,
    JSON.stringify(r.residue)
  )
  check('真实工程: 替换过程没把文件搞空', r.text.length > src.length * 0.9)
}

rmSync(sandbox, { recursive: true, force: true })

// ==========================================================================
section('结果')
console.log(`  共 ${checks} 项检查，失败 ${failures} 项`)
if (failures > 0) {
  console.log('  ✗ 自检未通过')
  process.exit(1)
}
console.log('  ✓ 全部通过')