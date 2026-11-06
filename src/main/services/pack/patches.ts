/**
 * 往**用户已有文件**里插东西的三类补丁，全部返回「改前 / 改后」全文，
 * 由调用方决定要不要落盘。
 *
 * 三种补丁的共同原则：**先判「是不是已经改过了」**，而且判据要选对 ——
 *   · CMakeLists 看源文件在不在目标里（复用 cmakeModel 的编辑引擎）
 *   · freertos.c 看 osThreadCreate 在不在，而不是看函数名出现过没有
 *   · 宏定义看**值**对不对，而不是看宏存不存在
 * 判错的后果都是「跳过但看起来成功了」，比报错难查得多。
 */

import { existsSync, readFileSync } from 'node:fs'
import { join, posix } from 'node:path'
import { buildCmakeModel } from '../cmake/cmakeModel'
import { planSourceEdit } from '../cmake/cmakeEdit'
import type { ProjectFacts } from './packStore'

/** CMakeLists.txt 加源文件 —— 复用「构建目标与源文件」的编辑引擎 */
export function patchCmake(
  root: string,
  sources: string[]
): { before: string; after: string; note: string } | null {
  const file = join(root, 'CMakeLists.txt')
  if (!existsSync(file)) return null
  const model = buildCmakeModel(file, root)
  const target = model.targets.find((t) => t.kind === 'executable') ?? model.targets[0]
  if (!target) return null
  const plan = planSourceEdit(model, { targetName: target.name, add: sources })
  return {
    before: plan.before,
    after: plan.after,
    note: `在目标 ${target.name} 里加 ${plan.added.length} 个源文件：${plan.notes.join('；')}`
  }
}

/** freertos.c 里建任务 */
export function patchFreertos(
  root: string,
  facts: ProjectFacts
): { before: string; after: string; note: string } | null {
  const rel = facts.headers.get('freertos.c') ?? 'Src/freertos.c'
  const file = join(root, rel.split(posix.sep).join('\\'))
  if (!existsSync(file)) return null
  const text = readFileSync(file, 'utf8')
  /*
    判「已经装过」要看**任务创建**，不能只看 `vofa_task(` ——
    早先的版本把 extern 声明写在 #include 区，那行本身会命中 `vofa_task(`
    却并不代表 osThreadCreate 存在，真跳过就等于任务永远不会被创建。
  */
  if (/osThreadDef\s*\(\s*vofa\b/.test(text) || /osThreadCreate\s*\(\s*osThread\s*\(\s*vofa\b/.test(text)) {
    return { before: text, after: text, note: 'freertos.c 里已经有 vofa_task 的创建代码，跳过' }
  }

  // 必须插在 MX_FREERTOS_Init() 里面。`/* USER CODE END Header */` 在
  // CubeMX 标准模板里位于文件头部（函数外），插 osThreadCreate 会编译不过。
  const anchors = ['/* USER CODE BEGIN RTOS_THREADS */', '/* USER CODE BEGIN 2 */']
  const anchor = anchors.find((a) => text.includes(a))
  if (!anchor) return null

  /*
    声明也放进 snippet（函数内块作用域的 extern），**不要**插到 #include 区：
    include 那一段是 CubeMX 每次重新生成都会重写的区域，写进去等于一次性消耗品；
    只有 USER CODE 区是它承诺保留的。函数内声明 extern 函数完全合法，
    也不依赖 application/vofa 是否在 include 路径里。
  */
  const snippet = [
    '  /* --- vofa 在线调参任务（由 CV Studio 添加）--- */',
    '  extern void vofa_task(void const *argument);',
    '  osThreadDef(vofa, vofa_task, osPriorityNormal, 0, 512);',
    '  osThreadCreate(osThread(vofa), NULL);'
  ].join('\n')
  const at = text.indexOf(anchor) + anchor.length
  const after = `${text.slice(0, at)}\n${snippet}\n${text.slice(at)}`

  return {
    before: text,
    after,
    note: `在 ${rel} 的「${anchor}」之后插入 osThreadDef + osThreadCreate（含 extern 声明，整段都在 USER CODE 区内）`
  }
}

/** 加一个宏（例如关掉 SBUS 往 USART1 的转发） */
export function patchDefine(
  root: string,
  facts: ProjectFacts,
  name: string,
  value: string
): { before: string; after: string; note: string } | null {
  const rel = [...facts.headers.values()].find((v) => /remote_control\.c$/i.test(v))
  if (!rel) return null
  const file = join(root, rel.split(posix.sep).join('\\'))
  if (!existsSync(file)) return null
  const text = readFileSync(file, 'utf8')
  // 已经定义过这个宏：要看**值**对不对，不能只看「存在就当没事」。
  // 例如工程里写的是 `#define SBUS_FORWARD_TO_USART1 1`（还开着转发），
  // 我们的目的是把它关掉，跳过等于没干活，USART1 照样被占用。
  const defined = new RegExp(`(^[ \\t]*#[ \\t]*define[ \\t]+${name}[ \\t]+)(\\S+)`, 'm').exec(text)
  if (defined) {
    if (defined[2] === value) {
      return { before: text, after: text, note: `${rel} 里 ${name} 已经是 ${value}，跳过` }
    }
    const after =
      text.slice(0, defined.index) + defined[1] + value + text.slice(defined.index + defined[0].length)
    return { before: text, after, note: `${rel} 里把 ${name} 从 ${defined[2]} 改成 ${value}` }
  }
  const block = [
    '',
    '/* 由 CV Studio 添加：关掉 SBUS 往 USART1 的转发，',
    '   把 USART1 的 TX 让给 vofa 波形用。想恢复改成 1 即可。 */',
    `#define ${name} ${value}`
  ].join('\n')
  // 插在第一个 #include 之后
  const m = /^#include[^\n]*\n/m.exec(text)
  if (!m) return null
  const at = (m.index ?? 0) + m[0].length
  return {
    before: text,
    after: `${text.slice(0, at)}${block}\n${text.slice(at)}`,
    note: `在 ${rel} 里加 #define ${name} ${value}`
  }
}
