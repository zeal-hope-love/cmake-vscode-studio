/**
 * 落盘之后的**外部副作用与核对**：跑 CubeMX、读回真实波特率。
 *
 * 为什么单独一个文件：这两步都可能失败，而且失败方式很不一样 ——
 *   · CubeMX 可能没装、可能被占用、可能超时（几十秒）
 *   · 波特率核对是「改了」和「生效了」的区别，不是错误而是**事实报告**
 * 混在落盘逻辑里会让人以为「写失败」和「生成失败」是一回事，其实不是。
 */

import { join, sep } from 'node:path'
import type { PackApplyResult, PackPlan } from '@shared/packTypes'
import { resolveInsideProject } from '../generate/writer'
import { checkBaudInCode } from '../ioc/uart'
import { findCubeMx, killRunningCubeMx, runCubeMxAndVerify } from '../cubeMx/index'
import { applyPackCore, collectSrcIncEntries, type ApplyOptions } from './apply'

export async function applyPackInstall(
  plan: PackPlan,
  opts: ApplyOptions = {}
): Promise<PackApplyResult> {
  const res = applyPackCore(plan, opts)
  if (res.errors.length) return res

  const iocChanged = plan.changes.some(
    (c) => c.action !== 'skip' && c.path === plan.ioc?.relPath
  )

  // CubeMX —— .ioc 改了但代码没重新生成，等于没改
  if (plan.ioc?.runCubeMx && iocChanged) {
    const cubeMx = findCubeMx()
    if (!cubeMx) {
      res.cubeMx = {
        ok: false,
        skipped: true,
        detail: '没找到 STM32CubeMX，.ioc 已改但代码没重新生成',
        changedFiles: [],
        log: []
      }
      opts.onStep?.({
        id: 'cubemx',
        label: 'CubeMX 重新生成',
        status: 'skip',
        detail: '没找到 CubeMX'
      })
    } else if (!res.errors.length) {
      opts.onStep?.({ id: 'cubemx', label: 'CubeMX 重新生成', status: 'running' })
      const iocAbs = resolveInsideProject(plan.root, plan.ioc.relPath)
      const watch = collectSrcIncEntries(plan.root).map((e) =>
        join(plan.root, e.relativePath.split('/').join(sep))
      )
      /*
       * CubeMX 是单实例程序：已经有一个开着时，命令行参数会被转交给它、
       * 自己立刻退出，**exit code 0、没有任何输出**。所以必须先关掉，
       * 否则会「以为成功了，其实什么都没生成」。
       */
      try {
        killRunningCubeMx()
      } catch {
        /* 没在跑就没什么可关的 */
      }
      const logLines: string[] = []
      const run = await runCubeMxAndVerify(cubeMx, iocAbs ?? '', watch, {
        timeoutMs: opts.cubeMxTimeoutMs ?? 180_000,
        onLine: (line) => {
          logLines.push(line)
          opts.onStep?.({
            id: 'cubemx',
            label: 'CubeMX 重新生成',
            status: 'running',
            detail: line
          })
        }
      })
      res.cubeMx = {
        ok: run.ok,
        skipped: false,
        detail: run.ok
          ? `用时 ${Math.round(run.durationMs / 1000)} 秒` +
            (run.changedFiles.length ? `，更新 ${run.changedFiles.length} 个文件` : '')
          : (run.error ?? '未知原因'),
        changedFiles: run.changedFiles.map((f) => f.replace(plan.root, '').replace(/^[\\/]/, '')),
        log: logLines.slice(-12)
      }
      if (!run.ok) {
        res.errors.push(`CubeMX 生成失败：${run.error ?? '未知原因'}`)
      }
      opts.onStep?.({
        id: 'cubemx',
        label: 'CubeMX 重新生成',
        status: run.ok ? 'ok' : 'err',
        detail: res.cubeMx.detail
      })
    }
  }

  // 4) 核对代码里实际的波特率
  //
  // 这是整件事最要紧的一句实话：.ioc 改成 921600、代码还是 115200 时，
  // 上位机能连上、波形也在发，但收发全是乱码，且不会有任何报错。
  if (plan.ioc) {
    const check = checkBaudInCode(plan.root, plan.ioc.handle, plan.ioc.baud)
    res.baudCheck = check
    opts.onStep?.({
      id: 'baud',
      label: '核对波特率',
      status: check.match ? 'ok' : 'warn',
      detail: check.detail
    })
  }

  res.ok = res.errors.length === 0
  return res
}
