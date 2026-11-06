/**
 * **落盘**：把计划里算好的全文真正写进工程。
 *
 * 顺序不能换：快照 → 写 → 记历史。快照在写之前，是唯一的还原退路；
 * 历史在写之后，因为它要记录每一笔的成败（失败项也要进历史，
 * 否则用户会以为「没写」等于「没事」）。
 *
 * 写文件一律走 fileWrite 的退避重试，失败时把根因单独带出来 ——
 * 曾经因为只报「写入失败」，排查了两小时的 EPERM。
 */

import { existsSync, readFileSync, readdirSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import type {
  PackApplyResult,
  PackApplyStep,
  PackFileChange,
  PackPlan
} from '@shared/packTypes'
import { listPacks } from './packStore'
import type { SnapshotEntry } from '../data/snapshotStore'
import { openSnapshot, recordInstall } from '../data/commit'
import { resolveInsideProject } from '../generate/writer'
import { writeFileWithRetry } from '../util/fileWrite'

/** 落盘过程中的进度（CubeMX 要跑几十秒，界面不能干等） */
export type ApplyStep = PackApplyStep

export interface ApplyOptions {
  onStep?: (s: ApplyStep) => void
  /** CubeMX 超时；自检里调小，正常用默认 */
  cubeMxTimeoutMs?: number
}

/**
 * CubeMX 会重写 `Src/` 和 `Inc/` 下的生成文件 —— 具体写哪几个它自己决定，
 * 事先算不出来。所以把这两个目录整个列进快照。
 */
export function collectSrcIncEntries(root: string): SnapshotEntry[] {
  const out: SnapshotEntry[] = []
  for (const dir of ['Src', 'Inc']) {
    const abs = join(root, dir)
    if (!existsSync(abs)) continue
    let names: string[] = []
    try {
      names = readdirSync(abs)
    } catch {
      continue
    }
    for (const name of names) {
      if (!/\.(c|h)$/i.test(name)) continue
      let previous: string | null = null
      try {
        previous = readFileSync(join(abs, name), 'utf8')
      } catch {
        previous = null
      }
      out.push({ relativePath: `${dir}/${name}`, previous })
    }
  }
  return out
}

/**
 * 同步部分：快照 → 写文件 → 记历史。
 *
 * 单独抽出来是因为**自检必须是同步的**（`tools/run-ts.mjs` 用 esbuild 打成
 * cjs，顶层 await 用不了）。CubeMX 那一段要等外部进程，放在下面的
 * `applyPackInstall` 里。
 */
export function applyPackCore(plan: PackPlan, opts: ApplyOptions = {}): PackApplyResult {
  const res: PackApplyResult = { ok: false, written: [], skipped: [], errors: [], snapshotId: null }
  const todo = plan.changes.filter((c) => c.action !== 'skip')

  /*
   * 只有 .ioc 真的被改了、并且用户没关掉 CubeMX，才需要跑外部程序。
   * 单独判断而不是「有没有 ioc」，因为「配置已经是目标状态」时
   * 跑一遍 CubeMX 纯属浪费两分钟。
   */
  const willRunCubeMx = Boolean(plan.ioc?.runCubeMx)
  const iocChanged = todo.some((c) => c.path === plan.ioc?.relPath)

  if (!todo.length && !willRunCubeMx) {
    res.ok = true
    return res
  }

  // 0) 路径先全部校验 —— 任何一个越界就整体拒绝，不写半成品
  const entries: Array<{ change: PackFileChange; abs: string }> = []
  for (const c of todo) {
    const abs = resolveInsideProject(plan.root, c.path)
    if (!abs) {
      res.errors.push(`${c.path}：路径越出了工程根，已拒绝写入`)
      continue
    }
    entries.push({ change: c, abs })
  }
  if (res.errors.length) return res

  /*
   * 快照必须在写之前 —— 新建的文件 previous 记 null，还原时会把它删掉。
   * 存不下就不写（openSnapshot 会连原因一起带出来），
   * 这一页给用户的承诺就是「先存快照，可一键还原」，没快照还照写等于空话。
   *
   * 跑 CubeMX 时还要多存 Src/ 和 Inc/：那些文件是 CubeMX 改的，
   * 不在 changes 里，漏存就等于「改了但回不去」。
   */
  const snapshotEntries: SnapshotEntry[] = entries.map(({ change }) => ({
    relativePath: change.path,
    previous: change.before
  }))
  if (willRunCubeMx && iocChanged) {
    const seen = new Set(snapshotEntries.map((e) => e.relativePath))
    for (const e of collectSrcIncEntries(plan.root)) {
      if (!seen.has(e.relativePath)) snapshotEntries.push(e)
    }
  }

  const gate = openSnapshot(plan.root, snapshotEntries)
  if (!gate.ok) {
    res.errors.push(gate.message)
    return res
  }
  res.snapshotId = gate.id

  // 2) 写
  opts.onStep?.({
    id: 'write',
    label: '写入文件',
    status: 'running',
    detail: `${entries.length} 个`
  })
  for (const { change: c, abs } of entries) {
    if (c.action === 'delete') {
      try {
        rmSync(abs, { force: true })
        res.written.push(`（删除）${c.path}`)
      } catch (err) {
        res.errors.push(`${c.path}：${(err as Error).message}`)
      }
      continue
    }
    if (c.after === null) continue
    const w = writeFileWithRetry(abs, c.after, c.path)
    if (w.ok) res.written.push(c.path)
    else res.errors.push(w.error ?? `${c.path}：写入失败`)
  }
  for (const c of plan.changes.filter((x) => x.action === 'skip')) res.skipped.push(c.path)
  opts.onStep?.({
    id: 'write',
    label: '写入文件',
    status: res.errors.length ? 'err' : 'ok',
    detail: `${res.written.length} 个`
  })

  // 记历史放在**同步**这一段里：CubeMX 那步要等几十秒，万一中途崩了，
  // 快照和历史都已经在，用户仍然能还原。CubeMX 的结果只在界面上显示。
  const name = listPacks().find((p) => p.id === plan.packId)?.name ?? plan.packId
  recordInstall(
    plan.root,
    `安装调试模块「${name}」（${res.written.length} 个文件）`,
    res.errors,
    res.snapshotId
  )

  res.ok = res.errors.length === 0
  return res
}

