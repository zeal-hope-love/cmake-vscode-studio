/**
 * VT13 移植执行器：把 P0/P1 的零件串成一条可重跑的流水线。
 *
 * ## 流水线顺序（不能随便换）
 *
 * ```
 * ① 预检        —— 工程结构、目标文件、.ioc 是否齐全
 * ② 快照        —— 动任何文件之前（还原的唯一退路）
 * ③ 改 .ioc     —— 语义化改键（跳过演示模式）
 * ④ 调 CubeMX   —— 重新生成 Src/、Inc/
 * ⑤ #if 0 屏蔽  —— CubeMX 会把手写的中断函数生成回来，必须每次重做
 * ⑥ 替换 3 个文件
 * ⑦ 改造业务文件 —— 字段替换 + shoot.c 状态机
 * ⑧ 验收        —— 6 项检查，任何一项不过就报告
 * ```
 *
 * 为什么 ⑤ 在 ④ 后面：CubeMX 生成会**覆盖** `stm32f4xx_it.c`，
 * 所以屏蔽必须在生成之后做。
 *
 * 为什么 ⑥ 在 ⑦ 前面：业务文件里的字段替换不依赖整文件替换的顺序，
 * 但 shoot.c 的状态机改造要读的是**替换后**的 remote_control.h 字段名，
 * 先放好头文件能让类型检查更稳。
 */

import { existsSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import type { PackIocChanges, PackManifest } from '../../../shared/packTypes'
import { IocEditor } from './iocEditor'
import { commentOutUsartHandler, isHandlerCommentedOut, hasHandler, countDefinition } from './itHandler'
import { transformRcCode, detectEol } from './codeTransform'
import { USART1_RX_STREAMS, VT13_NVIC_USART1, VT13_BAUD, usart1RxDmaFields } from './iocSpec'
import { findCubeMx, runCubeMxAndVerify, ensureNoMigratePrompt } from './cubeMx'

// --------------------------------------------------------------------------
// 预检
// --------------------------------------------------------------------------

export interface PreflightItem {
  label: string
  level: 'ok' | 'warn' | 'err'
  detail: string
}

export interface PreflightReport {
  ok: boolean
  items: PreflightItem[]
  /** 找到的 .ioc 绝对路径（多个时取第一个并警告） */
  iocPath: string | null
}

/**
 * 移植前检查工程。
 *
 * 这一步的价值在于**在动任何文件之前把话说清楚** —— 用户看到
 * 「找不到 .ioc」比看到「跑到第 4 步失败了」有用得多。
 */
export function preflight(root: string, pack: PackManifest): PreflightReport {
  const items: PreflightItem[] = []

  // ① 工程根基本结构
  const cmake = join(root, 'CMakeLists.txt')
  items.push(
    existsSync(cmake)
      ? { label: '工程结构', level: 'ok', detail: '找到 CMakeLists.txt' }
      : {
          label: '工程结构',
          level: 'err',
          detail: '根目录没有 CMakeLists.txt —— 这不像是一个 CMake 工程'
        }
  )

  const srcDir = join(root, 'Src')
  const incDir = join(root, 'Inc')
  if (!existsSync(srcDir) || !existsSync(incDir)) {
    items.push({
      label: '工程结构',
      level: 'err',
      detail: '缺少 Src/ 或 Inc/ —— CubeMX 生成会失败'
    })
  }

  // ② .ioc
  let iocPath: string | null = null
  try {
    const { readdirSync } = require('node:fs') as typeof import('node:fs')
    const iocs = readdirSync(root).filter((f) => f.endsWith('.ioc'))
    if (iocs.length === 0) {
      items.push({
        label: '.ioc 文件',
        level: 'warn',
        detail: '根目录没有 .ioc，将跳过 CubeMX 步骤（只能做代码改造）'
      })
    } else {
      iocPath = join(root, iocs[0])
      items.push({
        label: '.ioc 文件',
        level: iocs.length > 1 ? 'warn' : 'ok',
        detail: iocs.length === 1 ? iocs[0] : `找到 ${iocs.length} 个，用 ${iocs[0]}`
      })
    }
  } catch {
    items.push({ label: '.ioc 文件', level: 'err', detail: '读取工程目录失败' })
  }

  // ③ 要替换的文件
  const missingFiles = pack.files.filter((f) => !existsSync(join(pack.dir ?? '', 'files', f.from)))
  items.push(
    missingFiles.length === 0
      ? { label: '模块文件', level: 'ok', detail: `${pack.files.length} 个源文件都在` }
      : {
          label: '模块文件',
          level: 'err',
          detail: `模块包缺文件：${missingFiles.map((f) => f.from).join(', ')}`
        }
  )

  // ④ 要改造的业务文件 —— 缺了只是警告，可以跳过
  const transforms = pack.transform ?? []
  const missingBiz = transforms.filter((t) => !existsSync(join(root, t.file)))
  items.push(
    missingBiz.length === 0
      ? { label: '业务文件', level: 'ok', detail: `${transforms.length} 个待改造文件都在` }
      : {
          label: '业务文件',
          level: 'warn',
          detail: `缺 ${missingBiz.length} 个（会跳过）：${missingBiz.map((t) => t.file).join(', ')}`
        }
  )

  // ⑤ CubeMX
  const cubeMx = findCubeMx()
  if (cubeMx) {
    items.push({ label: 'CubeMX', level: 'ok', detail: cubeMx.exe })
  } else {
    items.push({
      label: 'CubeMX',
      level: 'warn',
      detail: '没找到 STM32CubeMX，将跳过重新生成（已有的 Src/ 可能缺 USART1 配置）'
    })
  }

  // ⑥ 现有遥控实现——判断是不是已经移植过
  const rcC = join(root, 'application/remote_control.c')
  if (existsSync(rcC)) {
    const text = readFileSync(rcC, 'utf8')
    const alreadyVt13 = text.includes('RC_frame_header1') && text.includes('trigger')
    items.push({
      label: '当前遥控协议',
      level: 'ok',
      detail: alreadyVt13 ? '已经是 VT13（重复执行会幂等覆盖）' : '旧 SBUS 协议，将替换'
    })
  }

  return { ok: !items.some((i) => i.level === 'err'), items, iocPath }
}

// --------------------------------------------------------------------------
// .ioc 修改
// --------------------------------------------------------------------------

export interface IocStepResult {
  ok: boolean
  edits: Array<{ key: string; kind: string; before?: string; after: string }>
  usedStream?: string
  conflict?: string
  error?: string
}

/**
 * 按 `pack.iocChanges` 修改 `.ioc`。
 */
export function applyIocChanges(iocPath: string, spec: PackIocChanges): IocStepResult {
  const edits: IocStepResult['edits'] = []
  try {
    const e = new IocEditor(iocPath)

    // USART 参数
    if (spec.usart) {
      for (const [k, v] of Object.entries(spec.usart)) {
        const key = `USART1.${k}`
        const before = e.get(key) ?? undefined
        const kind = e.set(key, String(v))
        if (kind !== 'unchanged') edits.push({ key, kind, before, after: String(v) })
      }
    }

    // IPParameters
    if (spec.ipParameters) {
      const key = 'USART1.IPParameters'
      const before = e.get(key) ?? undefined
      const kind = e.set(key, spec.ipParameters)
      if (kind !== 'unchanged') edits.push({ key, kind, before, after: spec.ipParameters })
    }

    // NVIC
    if (spec.nvic) {
      const key = 'NVIC.USART1_IRQn'
      const before = e.get(key) ?? undefined
      const kind = e.set(key, spec.nvic)
      if (kind !== 'unchanged') edits.push({ key, kind, before, after: spec.nvic })
    }

    // DMA —— 选一个没被占用的 Stream
    let usedStream: string | undefined
    let conflict: string | undefined
    if (spec.dma) {
      const candidates = spec.dma.streamCandidates?.length
        ? spec.dma.streamCandidates
        : [...USART1_RX_STREAMS]

      for (const stream of candidates) {
        const occupied = e.findStreamConflict(stream, spec.dma.ident)
        if (occupied) {
          conflict = `${stream} 已被 ${occupied} 占用`
          continue
        }
        usedStream = stream
        const fields = usart1RxDmaFields(stream as never)
        const { edits: dmaEdits } = e.ensureDmaRequest(spec.dma.ident, fields)
        for (const d of dmaEdits) {
          edits.push({ key: d.key, kind: d.kind, before: d.before, after: d.after })
        }
        break
      }

      if (!usedStream) {
        return {
          ok: false,
          edits,
          conflict,
          error: `USART1_RX 需要的 DMA Stream 全被占用：${conflict ?? '未知'}`
        }
      }
    }

    // 防止 CubeMX 弹版本迁移框
    ensureNoMigratePrompt(iocPath)

    if (e.isDirty()) e.save()
    return { ok: true, edits, usedStream, conflict }
  } catch (err) {
    return {
      ok: false,
      edits,
      error: err instanceof Error ? err.message : String(err)
    }
  }
}

// --------------------------------------------------------------------------
// 文件替换与业务改造
// --------------------------------------------------------------------------

export interface FileStepResult {
  file: string
  ok: boolean
  notes: Array<{ from: string; to: string; count: number }>
  residue: Array<{ pattern: string; count: number }>
  error?: string
}

/** 整文件替换（3 个模块文件） */
export function installPackFiles(root: string, pack: PackManifest): FileStepResult[] {
  const out: FileStepResult[] = []
  for (const f of pack.files) {
    try {
      const srcPath = join(pack.dir ?? '', 'files', f.from)
      const dstPath = join(root, f.to)
      const content = readFileSync(srcPath, 'utf8')
      writeFileSync(dstPath, content, 'utf8')
      out.push({ file: f.to, ok: true, notes: [], residue: [] })
    } catch (err) {
      out.push({
        file: f.to,
        ok: false,
        notes: [],
        residue: [],
        error: err instanceof Error ? err.message : String(err)
      })
    }
  }
  return out
}

/** 业务层字段替换 */
export function transformBusinessFiles(root: string, pack: PackManifest): FileStepResult[] {
  const out: FileStepResult[] = []

  /*
   * 先按清单改，**再兜底扫一遍全工程**找漏网的。
   *
   * 真实踩坑：清单里写了 9 个 .c 文件，编译时才发现 chassis_task.h /
   * gimbal_task.h 里还有 `const RC_ctrl_t *` —— 头文件没人想着要列进去，
   * 结果编译报 `unknown type name 'RC_ctrl_t'`。
   *
   * 所以改完清单里的文件后，再全工程扫一次，把还有旧写法的文件也改掉。
   * 这个兜底是幂等的：已经改干净的文件不会被重复处理，也不会重复写盘。
   */
  const listed = new Set((pack.transform ?? []).map((t) => t.file))
  const todo: string[] = [...listed]
  for (const rel of listSourceFiles(root)) {
    if (!listed.has(rel)) todo.push(rel)
  }

  for (const rel of todo) {
    const path = join(root, rel)
    if (!existsSync(path)) continue
    try {
      const src = readFileSync(path, 'utf8')
      const probe = transformRcCode(src, { replaceSwitchMacros: true })
      if (probe.text === src) {
        // 清单里的文件即使没改动也报一条，让人知道检查过了
        if (listed.has(rel)) {
          out.push({ file: rel, ok: true, notes: [], residue: probe.residue })
        }
        continue
      }
      /*
       * 只做「把裸 LF 补成 CRLF」，不能无脑 replace。
       *
       * 坑：transformRcCode 内部按 \n 切分再拼回来，对 CRLF 文件来说
       * 每行末尾的 \r 还在，直接 replace(/\n/g, '\r\n') 会变成 \r\r\n ——
       * 文件表面看不出问题（CRLF 计数不变），但 GCC 报莫名其妙的语法错误。
       * 实测踩过：chassis_task.c:65 expected identifier or '('。
       */
      const outText = detectEol(src) === '\r\n'
        ? probe.text.replace(/\r?\n/g, '\r\n')
        : probe.text.replace(/\r\n/g, '\n')
      writeFileSync(path, outText, 'utf8')
      out.push({ file: rel, ok: true, notes: probe.notes, residue: probe.residue })
    } catch (err) {
      out.push({
        file: rel,
        ok: false,
        notes: [],
        residue: [],
        error: err instanceof Error ? err.message : String(err)
      })
    }
  }
  return out
}

// --------------------------------------------------------------------------
// 源码扫描工具
// --------------------------------------------------------------------------

/** 工程里可能有业务代码的目录（Drivers / Middlewares 是 ST 的，不用扫） */
const SOURCE_DIRS = ['application', 'bsp', 'components', 'Src', 'Inc']

/** 列出工程里的 .c / .h 文件（相对路径，正斜杠） */
function listSourceFiles(root: string): string[] {
  const out: string[] = []
  const walk = (rel: string): void => {
    const abs = join(root, rel)
    if (!existsSync(abs)) return
    let entries: Array<{ name: string; isDirectory(): boolean }>
    try {
      const { readdirSync } = require('node:fs') as typeof import('node:fs')
      entries = readdirSync(abs, { withFileTypes: true })
    } catch {
      return
    }
    for (const e of entries) {
      const childRel = `${rel}/${e.name}`
      if (e.isDirectory()) {
        if (['Drivers', 'Middlewares', 'build', '.git', 'node_modules'].includes(e.name)) continue
        walk(childRel)
      } else if (/\.(c|h)$/.test(e.name)) {
        out.push(childRel)
      }
    }
  }
  for (const d of SOURCE_DIRS) walk(d)
  return out
}

function countSourceFiles(root: string): number {
  return listSourceFiles(root).length
}

/** 扫出仍然含旧写法的文件 */
function scanResidue(root: string): Array<{
  file: string
  hits: Array<{ pattern: string; count: number }>
}> {
  const out: Array<{ file: string; hits: Array<{ pattern: string; count: number }> }> = []
  for (const rel of listSourceFiles(root)) {
    try {
      const r = transformRcCode(readFileSync(join(root, rel), 'utf8'))
      if (r.residue.length) out.push({ file: rel, hits: r.residue })
    } catch {
      /* 读不了就跳过 */
    }
  }
  return out
}

// --------------------------------------------------------------------------
// shoot.c 状态机改造
// --------------------------------------------------------------------------

export interface StateMachineResult {
  ok: boolean
  changed: boolean
  error?: string
  /** 改了什么（给用户看） */
  summary: string[]
}

/**
 * 改造 `shoot.c` 的发射状态机。
 *
 * 这一段**不能靠正则批量替换** —— 它是「三档开关 → 三个不同输入」的语义重映射，
 * 每一行都要单独判断。所以做成精确的字符串匹配 + 替换，并且**匹配不到就跳过**
 * （不同队伍的 shoot.c 写法差异很大，硬改会改坏）。
 *
 * 核心映射（来自 Hero_9.1 的实际实现）：
 * | 旧（SBUS） | 新（VT13） |
 * |---|---|
 * | `rc.s[SHOOT_RC_MODE_CHANNEL]` 上档 | `mode_sw` 中/右 + `fn_1` 上升沿 |
 * | `rc.s[SHOOT_RC_MODE_CHANNEL]` 下档 | `trigger` 上升沿 |
 * | `last_s` 单变量 | `last_sw` + `last_fn_1` + `last_trigger` |
 *
 * 字段替换（`rc.s[...]` → `mode_sw`）已经由 `transformRcCode` 做完，
 * 这里只处理**逻辑重写**。
 */
export function rewriteShootStateMachine(
  root: string,
  pack: PackManifest
): StateMachineResult {
  const spec = pack.stateMachine
  if (!spec) return { ok: true, changed: false, summary: ['（模块包没有声明状态机改造）'] }

  const path = join(root, spec.file)
  if (!existsSync(path)) {
    return { ok: false, changed: false, error: `${spec.file} 不存在`, summary: [] }
  }

  let text = readFileSync(path, 'utf8')
  const original = text
  const summary: string[] = []

  /*
   * 已经在 transform 阶段把 `rc.s[X]` 换成了 `mode_sw`。
   * 这里补三件事：
   *   ① 状态变量：last_s → last_sw / last_fn_1 / last_trigger
   *   ② 单发的触发源：开关下档 → trigger 上升沿
   *   ③ 赋值语句同步更新
   */

  // ① 声明新的状态变量
  const declRe = /static\s+int8_t\s+last_s\s*=\s*[^;]*;/
  if (declRe.test(text)) {
    text = text.replace(
      declRe,
      [
        'static int8_t last_sw = RC_SW_MID;',
        '    static int8_t last_fn_1 = 0;',
        '    static int8_t last_trigger = 0;'
      ].join('\n')
    )
    summary.push('last_s → last_sw + last_fn_1 + last_trigger')
  }

  // ② 赋值：last_s = ...mode_sw → 三个都更新
  const assignRe = /last_s\s*=\s*([^;]*mode_sw\s*;)/g
  if (assignRe.test(text)) {
    text = text.replace(
      assignRe,
      (m) => {
        const src = m.replace(/^last_s\s*=\s*/, '').replace(/;$/, '').trim()
        return [
          `last_sw = ${src};`,
          `        last_fn_1 = shoot_control.shoot_rc->fn_1;`,
          `        last_trigger = shoot_control.shoot_rc->trigger;`
        ].join('\n')
      }
    )
    summary.push('赋值语句同步维护三个状态')
  }

  /*
   * ③ 单发条件：`switch_is_down(...mode_sw)` → `trigger` 上升沿
   *
   * 幂等保证：换完之后这里不再有 `switch_is_down(...mode_sw)`，
   * 第二次执行匹配不到，自然跳过。
   */
  const fireRe = /switch_is_down\(\s*shoot_control\.shoot_rc->mode_sw\s*\)\s*&&\s*!switch_is_down\(\s*last_s\s*\)/g
  if (fireRe.test(text)) {
    text = text.replace(fireRe, 'shoot_control.shoot_rc->trigger && !last_trigger')
    summary.push('单发触发：开关下档 → trigger 上升沿')
  }

  // 其它残留的 last_s 引用统一改名（保底，避免编译错误）
  if (/\blast_s\b/.test(text)) {
    text = text.replace(/\blast_s\b/g, 'last_sw')
    summary.push('其余 last_s 引用 → last_sw')
  }

  if (text === original) {
    return {
      ok: true,
      changed: false,
      summary: ['没有匹配到可改造的代码（可能已经改过，或这个工程的写法不同）']
    }
  }

  // 同上的换行符处理：先归一，再统一成原文件的风格
  const outText = detectEol(original) === '\r\n'
    ? text.replace(/\r?\n/g, '\r\n')
    : text.replace(/\r\n/g, '\n')
  writeFileSync(path, outText, 'utf8')
  return { ok: true, changed: true, summary }
}

// --------------------------------------------------------------------------
// stm32f4xx_it.c 屏蔽
// --------------------------------------------------------------------------

export function maskUsart1Irq(root: string): {
  ok: boolean
  changed: boolean
  reason: string
  error?: string
} {
  const path = join(root, 'Src', 'stm32f4xx_it.c')
  if (!existsSync(path)) {
    return { ok: false, changed: false, reason: '文件不存在', error: 'Src/stm32f4xx_it.c 不存在' }
  }
  try {
    const src = readFileSync(path, 'utf8')
    const r = commentOutUsartHandler(src, 'USART1_IRQHandler')
    if (r.changed) writeFileSync(path, r.text, 'utf8')
    return { ok: true, changed: r.changed, reason: r.reason }
  } catch (err) {
    return {
      ok: false,
      changed: false,
      reason: '异常',
      error: err instanceof Error ? err.message : String(err)
    }
  }
}

// --------------------------------------------------------------------------
// 验收
// --------------------------------------------------------------------------

export interface AcceptanceItem {
  id: string
  label: string
  ok: boolean
  detail: string
}

/**
 * 6 项验收。
 *
 * 这些是「移植对不对」的客观判据，不依赖用户肉眼检查：
 *   ① 旧写法残留归零
 *   ② CubeMX 产物正确（波特率 / DMA Stream / NORMAL 模式）
 *   ③ USART1_IRQHandler 在 it.c 里被屏蔽
 *   ④ .ioc 里 DMA 是 NORMAL 不是 CIRCULAR
 *   ⑤ USART1_IRQHandler 全工程只有 1 个有效定义
 *   ⑥ 幂等：再跑一次不会产生新改动
 */
export function runAcceptance(root: string, pack: PackManifest): AcceptanceItem[] {
  const out: AcceptanceItem[] = []

  // ① 残留 —— **扫描全工程**，不只扫清单里的文件
  //
  // 为什么必须全扫：清单是人手写的，漏一个文件就编译不过。
  // 实际踩过：chassis_task.h / gimbal_task.h 里还有 RC_ctrl_t，清单里没有，
  // 结果编译报 unknown type name 'RC_ctrl_t'。全扫才能保证结论是真的。
  const residueFiles = scanResidue(root)
  const totalResidue = residueFiles.reduce((a, b) => a + b.hits.reduce((x, y) => x + y.count, 0), 0)
  const bizFiles = (pack.transform ?? []).map((t) => t.file)
  out.push({
    id: 'residue',
    label: '旧写法零残留（全工程扫描）',
    ok: totalResidue === 0,
    detail: totalResidue === 0
      ? `扫了 ${countSourceFiles(root)} 个源文件，没有 rc.ch[] / rc.s[] / key.v / RC_ctrl_t`
      : residueFiles.map((f) => `${f.file}: ${f.hits.map((x) => `${x.pattern}×${x.count}`).join(', ')}`).join('; ')
  })

  // ② CubeMX 产物
  const usartC = join(root, 'Src', 'usart.c')
  if (existsSync(usartC)) {
    const u = readFileSync(usartC, 'utf8')
    const hasBaud = /huart1\.Init\.BaudRate\s*=\s*921600/.test(u)
    const hasDma = /hdma_usart1_rx\.Instance\s*=\s*DMA2_Stream[25]/.test(u)
    const hasChannel = /hdma_usart1_rx\.Init\.Channel\s*=\s*DMA_CHANNEL_4/.test(u)
    out.push({
      id: 'cubemx',
      label: 'CubeMX 产物正确',
      ok: hasBaud && hasDma && hasChannel,
      detail: [
        hasBaud ? '波特率 921600 ✓' : '波特率 ✗',
        hasDma ? 'DMA Stream ✓' : 'DMA Stream ✗',
        hasChannel ? 'Channel 4 ✓' : 'Channel 4 ✗'
      ].join(' · ')
    })
  } else {
    out.push({
      id: 'cubemx',
      label: 'CubeMX 产物正确',
      ok: false,
      detail: 'Src/usart.c 不存在 —— CubeMX 步骤被跳过了？'
    })
  }

  // ③ it.c 屏蔽 —— 分三种情况，不能一概算「通过」
  const itC = join(root, 'Src', 'stm32f4xx_it.c')
  if (existsSync(itC)) {
    const itText = readFileSync(itC, 'utf8')
    const present = hasHandler(itText, 'USART1_IRQHandler')
    const masked = isHandlerCommentedOut(itText, 'USART1_IRQHandler')
    out.push({
      id: 'masked',
      label: 'CubeMX 的 USART1_IRQHandler 不冲突',
      // 没有函数 = 本来就不会冲突，算通过；有函数但没屏蔽 = 失败
      ok: !present || masked,
      detail: !present
        ? 'CubeMX 没有生成这个函数（这个版本的模板工程不需要屏蔽）'
        : masked
          ? '已包在 #if 0 里'
          : '有函数但没屏蔽 —— 会和 remote_control.c 里的同名函数冲突'
    })
  } else {
    out.push({ id: 'masked', label: 'CubeMX 的 USART1_IRQHandler 不冲突', ok: false, detail: '文件不存在' })
  }

  // ④ .ioc DMA 模式
  let iocPath: string | null = null
  try {
    const { readdirSync } = require('node:fs') as typeof import('node:fs')
    const iocs = readdirSync(root).filter((f) => f.endsWith('.ioc'))
    if (iocs.length) iocPath = join(root, iocs[0])
  } catch {
    /* ignore */
  }
  if (iocPath) {
    const raw = readFileSync(iocPath, 'utf8')
    const isNormal = /Dma\.USART1_RX\.\d+\.Mode=DMA_NORMAL/.test(raw)
    const isCircular = /Dma\.USART1_RX\.\d+\.Mode=DMA_CIRCULAR/.test(raw)
    out.push({
      id: 'dma-mode',
      label: '.ioc 里 DMA 是 NORMAL 不是 CIRCULAR',
      ok: isNormal && !isCircular,
      detail: isNormal ? 'DMA_NORMAL ✓' : isCircular ? '还是 DMA_CIRCULAR ✗' : '没找到 DMA Mode ✗'
    })
  } else {
    out.push({ id: 'dma-mode', label: '.ioc 里 DMA 是 NORMAL 不是 CIRCULAR', ok: false, detail: '没有 .ioc' })
  }

  // ⑤ 符号唯一
  const rcC = join(root, 'application/remote_control.c')
  let activeDefs = 0
  if (existsSync(rcC)) activeDefs += countDefinition(readFileSync(rcC, 'utf8'), 'USART1_IRQHandler')
  if (existsSync(itC)) {
    const itText = readFileSync(itC, 'utf8')
    // 只有没被 #if 0 包住的才算
    if (hasHandler(itText, 'USART1_IRQHandler') && !isHandlerCommentedOut(itText, 'USART1_IRQHandler')) {
      activeDefs += countDefinition(itText, 'USART1_IRQHandler')
    }
  }
  out.push({
    id: 'symbol',
    label: 'USART1_IRQHandler 只有 1 个有效定义',
    ok: activeDefs === 1,
    detail: `当前 ${activeDefs} 个`
  })

  // ⑥ 幂等：跑一遍字段替换看有没有变化
  let idempotent = true
  const idemDetail: string[] = []
  for (const f of bizFiles) {
    const p = join(root, f)
    if (!existsSync(p)) continue
    const src = readFileSync(p, 'utf8')
    const once = transformRcCode(src)
    if (once.text !== src) {
      idempotent = false
      idemDetail.push(f)
    }
  }
  out.push({
    id: 'idempotent',
    label: '幂等：再跑一次不产生新改动',
    ok: idempotent,
    detail: idempotent ? '业务文件已稳定' : `还会变：${idemDetail.join(', ')}`
  })

  return out
}