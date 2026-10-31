/**
 * 移植包的安装编排：把 `portRunner` 的流水线包进「快照 + 历史」。
 *
 * ## 为什么单独一层
 *
 * `portRunner` 里的函数都是**纯操作**：改文件、跑 CubeMX、读结果。
 * 它们不知道快照是什么，也不知道历史怎么记。这是故意的 —— 纯操作好测试。
 *
 * 这一层的职责就三件：
 *   ① 动手前**把所有会被改的文件**都存进快照
 *   ② 按顺序调用流水线
 *   ③ 记一条历史，带上快照 id
 *
 * ## 快照要覆盖哪些文件
 *
 * 转置包会改的东西比常规包多得多：
 *   · `.ioc`（工具自己改）
 *   · `Src/` 和 `Inc/` 下的**所有** .c/.h（CubeMX 会重写）
 *   · 3 个替换文件
 *   · 11 个业务文件
 *
 * **CubeMX 生成时会写哪些文件是没法事先确定的**（CubeMX 自己决定），
 * 所以只能把 `Src/`、`Inc/` 整个目录列进去。这些文件加起来几百 KB，
 * 存快照的开销可以接受 —— 相比之下「改了 CubeMX 但没快照」是不可接受的。
 */

import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs'
import { join, relative } from 'node:path'
import type { PackManifest } from '../../shared/packTypes'
import { captureSnapshot, type SnapshotEntry } from './snapshotStore'
import { recordWrite } from './historyStore'
import {
  preflight,
  applyIocChanges,
  installPackFiles,
  transformBusinessFiles,
  rewriteShootStateMachine,
  maskUsart1Irq,
  runAcceptance,
  type PreflightReport,
  type AcceptanceItem,
  type FileStepResult
} from './vt13/portRunner'
import { findCubeMx, runCubeMxAndVerify } from './vt13/cubeMx'

export interface PortStepProgress {
  /** 步骤 id，界面用它对上进度条 */
  id: string
  label: string
  status: 'running' | 'ok' | 'warn' | 'err' | 'skip'
  detail?: string
}

export interface PortResult {
  ok: boolean
  preflight: PreflightReport
  /** 每一步的结果，界面按顺序展示 */
  steps: PortStepProgress[]
  acceptance: AcceptanceItem[]
  snapshotId: string | null
  errors: string[]
  warnings: string[]
}

export interface PortOptions {
  root: string
  pack: PackManifest
  /** 跳过 CubeMX（演示模式）：没装 CubeMX 或用户已手动配好外设 */
  skipCubeMx?: boolean
  /** 每一步开始/结束的回调，界面用来刷新进度 */
  onProgress?: (p: PortStepProgress) => void
  /** 用户点了取消 */
  isCancelled?: () => boolean
}

/**
 * 收集「这次可能被改到的所有文件」，用于快照。
 *
 * 宁可多存 —— 快照多存几十个文件只是几百 KB，漏存则意味着改坏了回不去。
 */
function collectSnapshotEntries(root: string, pack: PackManifest, iocPath: string | null): SnapshotEntry[] {
  const entries: SnapshotEntry[] = []
  const seen = new Set<string>()

  const add = (rel: string): void => {
    if (seen.has(rel)) return
    seen.add(rel)
    const abs = join(root, rel.split('/').join('\\'))
    try {
      const content = existsSync(abs) ? readFileSync(abs, 'utf8') : null
      entries.push({ relativePath: rel, previous: content })
    } catch {
      // 读不了（比如二进制）就记 null —— 还原时会当成「新建」处理，宁可这样也别漏
      entries.push({ relativePath: rel, previous: null })
    }
  }

  // ① .ioc
  //
  // 相对路径必须用 `path.relative` 算，不能自己拼字符串替换 ——
  // 踩过：root 用反斜杠、拼出来的匹配串末尾是正斜杠，replace 匹配不上，
  // 结果 rel 是一个完整绝对路径塞进快照。还原时按「工程内相对路径」去解析，
  // 就会解析到工程外面去。
  if (iocPath) {
    add(toRelative(root, iocPath))
  }

  // ② CubeMX 会写的地方：Src/ 和 Inc/ 下的全部源文件
  for (const dir of ['Src', 'Inc']) {
    const abs = join(root, dir)
    if (!existsSync(abs)) continue
    try {
      for (const name of readdirSync(abs)) {
        if (/\.(c|h)$/.test(name)) add(`${dir}/${name}`)
      }
    } catch {
      /* 读不了就跳过 */
    }
  }

  // ③ 替换的文件
  for (const f of pack.files) add(f.to)

  // ④ 业务文件
  for (const t of pack.transform ?? []) add(t.file)
  if (pack.stateMachine) add(pack.stateMachine.file)

  // ⑤ CMakeLists.txt（补丁可能动它）
  add('CMakeLists.txt')

  return entries
}

/** 把绝对路径转成「相对工程根、正斜杠」的形式 */
function toRelative(root: string, abs: string): string {
  return relative(root, abs).replace(/\\/g, '/')
}

/** 把相对路径列表交给快照，返回快照 id */
function snapshotAll(root: string, entries: SnapshotEntry[]): string | null {
  // 只存「会变」的：内容为 null 的（新建文件）也要存，还原时才删得掉
  return captureSnapshot(root, entries)
}

/**
 * 执行一次完整的移植安装。
 *
 * 顺序见 portRunner 顶部的说明。这一层额外保证：
 *   · 动手前存快照，存不下就中止（一个文件都不动）
 *   · 每一步都往 steps 里追加，界面能看到进度
 *   · 中途出错也把已完成的步骤记下来
 */
export async function runPortInstall(opts: PortOptions): Promise<PortResult> {
  const { root, pack, onProgress, isCancelled } = opts
  const steps: PortStepProgress[] = []
  const errors: string[] = []
  const warnings: string[] = []

  const emit = (p: PortStepProgress): void => {
    steps.push(p)
    onProgress?.(p)
  }

  // ---- ① 预检 ----
  emit({ id: 'preflight', label: '预检', status: 'running' })
  const pf = preflight(root, pack)
  for (const item of pf.items) {
    if (item.level === 'err') errors.push(`${item.label}：${item.detail}`)
    else if (item.level === 'warn') warnings.push(`${item.label}：${item.detail}`)
  }
  emit({
    id: 'preflight',
    label: '预检',
    status: pf.ok ? (pf.items.some((i) => i.level === 'warn') ? 'warn' : 'ok') : 'err',
    detail: pf.items.map((i) => i.detail).join(' · ')
  })
  if (!pf.ok) {
    return {
      ok: false,
      preflight: pf,
      steps,
      acceptance: [],
      snapshotId: null,
      errors,
      warnings
    }
  }

  // ---- ② 快照（必须在任何写操作之前）----
  emit({ id: 'snapshot', label: '存快照', status: 'running' })
  const entries = collectSnapshotEntries(root, pack, pf.iocPath)
  const snapshotId = snapshotAll(root, entries)
  if (!snapshotId) {
    errors.push('没能存下快照，为避免改坏了无法还原，已中止（一个文件都没动）')
    emit({ id: 'snapshot', label: '存快照', status: 'err', detail: '快照存不下，已中止' })
    return {
      ok: false,
      preflight: pf,
      steps,
      acceptance: [],
      snapshotId: null,
      errors,
      warnings
    }
  }
  emit({
    id: 'snapshot',
    label: '存快照',
    status: 'ok',
    detail: `${entries.length} 个文件已存入快照（可用「历史与恢复」还原）`
  })

  if (isCancelled?.()) {
    emit({ id: 'cancelled', label: '已取消', status: 'skip', detail: '快照已存，文件未改动' })
    return { ok: false, preflight: pf, steps, acceptance: [], snapshotId, errors, warnings }
  }

  // ---- ③ 改 .ioc ----
  let usedStream: string | undefined
  if (pf.iocPath && pack.iocChanges) {
    emit({ id: 'ioc', label: '修改 .ioc', status: 'running' })
    const r = applyIocChanges(pf.iocPath, pack.iocChanges)
    if (!r.ok) {
      errors.push(`修改 .ioc 失败：${r.error ?? '未知原因'}`)
      emit({ id: 'ioc', label: '修改 .ioc', status: 'err', detail: r.error })
    } else {
      usedStream = r.usedStream
      emit({
        id: 'ioc',
        label: '修改 .ioc',
        status: 'ok',
        detail:
          `${r.edits.length} 项改动` + (r.usedStream ? `，DMA 用 ${r.usedStream}` : '') +
          (r.conflict ? `（${r.conflict}，已换用备用 Stream）` : '')
      })
    }
  } else {
    emit({ id: 'ioc', label: '修改 .ioc', status: 'skip', detail: '没有 .ioc 或模块包未声明改动' })
  }

  // ---- ④ CubeMX ----
  if (pf.iocPath && !opts.skipCubeMx && !errors.length) {
    emit({ id: 'cubemx', label: 'CubeMX 重新生成', status: 'running' })
    const cubeMx = findCubeMx()
    if (!cubeMx) {
      warnings.push('没找到 STM32CubeMX，已跳过重新生成')
      emit({ id: 'cubemx', label: 'CubeMX 重新生成', status: 'skip', detail: '没找到 CubeMX' })
    } else {
      const watch = ['Src/usart.c', 'Src/stm32f4xx_it.c', 'Src/dma.c', 'Src/main.c'].map((f) =>
        join(root, f)
      )
      const res = await runCubeMxAndVerify(cubeMx, pf.iocPath, watch, {
        timeoutMs: 180_000,
        onLine: (line) => {
          // 把 CubeMX 的实时输出透到界面
          onProgress?.({ id: 'cubemx', label: 'CubeMX 重新生成', status: 'running', detail: line })
        }
      })
      if (!res.ok) {
        errors.push(`CubeMX 生成失败：${res.error ?? '未知原因'}`)
        emit({ id: 'cubemx', label: 'CubeMX 重新生成', status: 'err', detail: res.error })
      } else {
        emit({
          id: 'cubemx',
          label: 'CubeMX 重新生成',
          status: 'ok',
          detail:
            `用时 ${Math.round(res.durationMs / 1000)} 秒` +
            (res.closedDialogs.length ? `，自动关掉 ${res.closedDialogs.length} 个弹窗` : '') +
            (res.changedFiles.length ? `，更新 ${res.changedFiles.length} 个文件` : '')
        })
      }
    }
  } else {
    emit({
      id: 'cubemx',
      label: 'CubeMX 重新生成',
      status: 'skip',
      detail: opts.skipCubeMx ? '演示模式，已跳过' : '前置步骤未通过'
    })
  }

  if (isCancelled?.()) {
    emit({ id: 'cancelled', label: '已取消', status: 'skip', detail: '可用快照还原' })
    return { ok: false, preflight: pf, steps, acceptance: [], snapshotId, errors, warnings }
  }

  // ---- ⑤ 屏蔽 IRQ（必须在 CubeMX 之后）----
  emit({ id: 'mask', label: '屏蔽 CubeMX 的中断函数', status: 'running' })
  const mask = maskUsart1Irq(root)
  emit({
    id: 'mask',
    label: '屏蔽 CubeMX 的中断函数',
    status: mask.ok ? (mask.changed ? 'ok' : 'skip') : 'err',
    detail: !mask.ok
      ? mask.error
      : mask.changed
        ? '已包进 #if 0（remote_control.c 里有自己的实现）'
        : mask.reason === 'no-handler'
          ? 'CubeMX 没生成 USART1_IRQHandler，无需屏蔽'
          : '已经屏蔽过了'
  })
  if (!mask.ok) errors.push(`屏蔽中断函数失败：${mask.error}`)

  // ---- ⑥ 替换文件 ----
  emit({ id: 'files', label: '替换模块文件', status: 'running' })
  const fileResults: FileStepResult[] = installPackFiles(root, pack)
  const badFiles = fileResults.filter((f) => !f.ok)
  emit({
    id: 'files',
    label: '替换模块文件',
    status: badFiles.length ? 'err' : 'ok',
    detail: badFiles.length
      ? badFiles.map((f) => `${f.file}: ${f.error}`).join('; ')
      : `${fileResults.length} 个文件已替换`
  })
  for (const f of badFiles) errors.push(`替换 ${f.file} 失败：${f.error}`)

  // ---- ⑦ 业务层改造 ----
  emit({ id: 'transform', label: '改造业务代码', status: 'running' })
  const bizResults = transformBusinessFiles(root, pack)
  const totalNotes = bizResults.reduce((a, b) => a + b.notes.length, 0)
  const totalChanges = bizResults.filter((b) => b.notes.length > 0).length
  emit({
    id: 'transform',
    label: '改造业务代码',
    status: 'ok',
    detail: `${totalChanges} 个文件，共 ${totalNotes} 处字段替换`
  })

  // ---- ⑧ 状态机 ----
  if (pack.stateMachine) {
    emit({ id: 'statemachine', label: '改造发射状态机', status: 'running' })
    const sm = rewriteShootStateMachine(root, pack)
    emit({
      id: 'statemachine',
      label: '改造发射状态机',
      status: sm.ok ? (sm.changed ? 'ok' : 'skip') : 'err',
      detail: sm.error ?? sm.summary.join('；')
    })
    if (!sm.ok) errors.push(`状态机改造失败：${sm.error}`)
  }

  // ---- ⑨ 验收 ----
  emit({ id: 'acceptance', label: '验收检查', status: 'running' })
  const acceptance = runAcceptance(root, pack)
  const failedItems = acceptance.filter((a) => !a.ok)
  emit({
    id: 'acceptance',
    label: '验收检查',
    status: failedItems.length ? 'err' : 'ok',
    detail: failedItems.length
      ? failedItems.map((a) => `${a.label}：${a.detail}`).join('; ')
      : `${acceptance.length} 项全部通过`
  })
  for (const a of failedItems) errors.push(`验收未通过 — ${a.label}：${a.detail}`)

  // ---- ⑩ 记历史 ----
  try {
    recordWrite(
      root,
      [
        `移植遥控模块「${pack.name}」（${steps.filter((s) => s.status === 'ok').length} 步完成${
          failedItems.length ? `，${failedItems.length} 项验收未过` : ''
        }）`
      ],
      errors,
      snapshotId
    )
  } catch {
    /* 历史记不上不影响主流程 */
  }

  return {
    ok: errors.length === 0,
    preflight: pf,
    steps,
    acceptance,
    snapshotId,
    errors,
    warnings
  }
}