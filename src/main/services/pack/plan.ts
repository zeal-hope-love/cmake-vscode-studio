/**
 * **算计划**：只读不写，算出每个文件改前/改后的全文，交给界面做 diff。
 *
 * 这里是「点安装之前，用户到底要看到什么」的全部答案。一条硬约束：
 * 函数里**不允许写盘**，否则 diff 就不再是预览，而是既成事实。
 * 唯一的例外是 .ioc —— 见 planUartIoc，它也只算不写。
 */

import { existsSync, readFileSync } from 'node:fs'
import type {
  PackBindings,
  PackFileChange,
  PackPlan,
  PackPlanIoc
} from '@shared/packTypes'
import { serializeVofaMap, type VofaMap } from '@shared/vofaMap'
import { inspectProject, loadPack, readPackFile, type ProjectFacts } from './packStore'
import { resolveInsideProject } from '../generate/writer'
import { planUartIoc } from '../ioc/uart'
import { findCubeMx } from '../cubeMx/index'
import { generatedNote, renderGenerated } from './render'
import { patchCmake, patchDefine, patchFreertos } from './patches'

export interface PlanOptions {
  packId: string
  root: string
  params: Record<string, string | number | boolean>
  bindings: PackBindings
  /** 原始映射表；有的话同时生成 application/vofa/vofa_map.json */
  map?: VofaMap
  /** 工程里有旧版平铺的 vofa 文件时，是否顺手删掉（否则会重复定义符号） */
  removeLegacy?: boolean
  /**
   * 覆盖包声明的「跑不跑 CubeMX」。
   *
   * 不给就按 `pack.iocSetup.runCubeMx` —— 用户在参数里改的是这个值，
   * 界面直接透传下来，不在这里再猜一次。
   */
  runCubeMx?: boolean
}

export function planPackInstall(opts: PlanOptions, factsIn?: ProjectFacts): PackPlan {
  const pack = loadPack(opts.packId)
  if (!pack) {
    return {
      packId: opts.packId,
      root: opts.root,
      params: opts.params,
      bindings: opts.bindings,
      changes: [],
      manualSteps: [],
      blocked: true,
      writeCount: 0
    }
  }
  const facts = factsIn ?? inspectProject(opts.root)
  const changes: PackFileChange[] = []
  let renderError: string | null = null
  let criticalFailed = false

  const outside = (relPath: string): boolean =>
    resolveInsideProject(opts.root, relPath.replace(/\//g, '\\')) === null

  // ---- 固定文件 ----
  for (const spec of pack.files) {
    if (outside(spec.to)) {
      criticalFailed = true
      changes.push({
        path: spec.to,
        action: 'skip',
        before: null,
        after: null,
        note: '模块文件',
        skipReason: `路径越出了工程根：${spec.to}`
      })
      continue
    }
    const content = readPackFile(pack.id, spec.from)
    if (content === null) continue
    const abs = resolveInsideProject(opts.root, spec.to)!
    const has = existsSync(abs)
    changes.push({
      path: spec.to,
      action: has ? 'overwrite' : 'create',
      before: has ? readFileSync(abs, 'utf8') : null,
      after: content,
      note: has ? '覆盖已存在的模块文件' : '新增模块文件'
    })
  }

  // ---- 生成文件 ----
  for (const spec of pack.generated) {
    if (outside(spec.to)) {
      criticalFailed = true
      changes.push({
        path: spec.to,
        action: 'skip',
        before: null,
        after: null,
        note: '生成文件',
        skipReason: `路径越出了工程根：${spec.to}`
      })
      continue
    }
    try {
      // 用哪个渲染器由 pack.json 声明，不靠模板名猜（见 render.ts 头部）
      const kind = spec.render
      const content = renderGenerated(pack, spec, opts, facts)
      const abs = resolveInsideProject(opts.root, spec.to)!
      const has = existsSync(abs)
      changes.push({
        path: spec.to,
        action: has ? 'overwrite' : 'create',
        before: has ? readFileSync(abs, 'utf8') : null,
        after: content,
        note: kind ? generatedNote(kind, spec) : '生成文件'
      })
    } catch (err) {
      renderError = err instanceof Error ? err.message : String(err)
      changes.push({
        path: spec.to,
        action: 'skip',
        before: null,
        after: null,
        note: '生成文件失败',
        skipReason: renderError
      })
    }
  }

  // ---- 映射表 ----
  if (pack.id === 'vofa' && opts.map) {
    const relMap = 'application/vofa/vofa_map.json'
    const abs = resolveInsideProject(opts.root, relMap)
    if (!abs) {
      criticalFailed = true
      changes.push({
        path: relMap,
        action: 'skip',
        before: null,
        after: null,
        note: '映射表',
        skipReason: '路径越出了工程根'
      })
    } else {
      const before = existsSync(abs) ? readFileSync(abs, 'utf8') : null
      const after = serializeVofaMap({
        ...opts.map,
        version: 1,
        packId: 'vofa',
        updatedAt: opts.map.updatedAt || Date.now()
      })
      const same = before === after
      changes.push({
        path: relMap,
        action: same ? 'skip' : before === null ? 'create' : 'overwrite',
        before,
        after,
        note: '映射表（工具读写，不参与编译）',
        skipReason: same ? '映射表没有变化' : undefined
      })
    }
  }

  // ---- 旧版平铺文件 ----
  const legacy = facts.existingVofa.filter(
    (p) => /vofa_task\.[ch]$/i.test(p) && !p.startsWith('application/vofa/')
  )
  for (const p of [...new Set(legacy)]) {
    const abs = resolveInsideProject(opts.root, p)
    if (!abs || !existsSync(abs)) continue
    changes.push({
      path: p,
      action: opts.removeLegacy ? 'delete' : 'skip',
      before: readFileSync(abs, 'utf8'),
      after: null,
      note: '旧版平铺布局的 vofa 文件',
      skipReason: opts.removeLegacy
        ? undefined
        : `还在原地。装到 application/vofa/ 会和它**重复定义符号**，必须先删掉（或勾上「顺手删掉旧文件」）`
    })
  }

  // ---- 补丁 ----
  for (const spec of pack.patches) {
    let r: { before: string; after: string; note: string } | null = null
    if (spec.action === 'add-sources' && spec.sources) {
      r = patchCmake(opts.root, spec.sources)
    } else if (spec.action === 'insert-task') {
      r = patchFreertos(opts.root, facts)
    } else if (spec.action === 'define' && spec.name) {
      r = patchDefine(opts.root, facts, spec.name, spec.value ?? '0')
    }
    if (!r) {
      if (!spec.optional) {
        criticalFailed = true
        changes.push({
          path: spec.file,
          action: 'skip',
          before: null,
          after: null,
          note: spec.note ?? spec.action,
          skipReason: `找不到可改的位置（${spec.file}）—— 这是必须的补丁，写入已阻止，需要你手动处理`
        })
      }
      continue
    }
    changes.push({
      path: spec.file,
      action: r.before === r.after ? 'skip' : 'patch',
      before: r.before,
      after: r.after,
      note: r.note,
      skipReason: r.before === r.after ? '已经是目标状态，无需改动' : undefined
    })
  }

  // ---- .ioc：把参数真的写进外设配置 ----
  //
  // 这段是「参数面板里选了 dma / 改了波特率，到底有没有生效」的答案。
  // 只算文本、不落盘 —— 和别的文件一样进清单，用户能先看 diff 再决定。
  let planIoc: PackPlanIoc | undefined
  if (pack.iocSetup) {
    const s = pack.iocSetup
    const uart = String(opts.params[s.uartParam] ?? '')
    const baud = Number(opts.params[s.baudParam] ?? 0)
    const rxMode = s.rxModeParam
      ? String(opts.params[s.rxModeParam] ?? 'it') === 'dma'
        ? 'dma'
        : 'it'
      : 'it'
    const builtinIrq = s.builtinIrqParam
      ? Boolean(opts.params[s.builtinIrqParam])
      : true
    const irqPriority = s.irqPriorityParam ? Number(opts.params[s.irqPriorityParam] ?? 5) : 5
    // 没声明 dmaModeParam 的老包按循环走 —— 那是固件默认假设的那一种
    const dmaMode: 'circular' | 'normal' =
      s.dmaModeParam && String(opts.params[s.dmaModeParam] ?? '') === 'normal' ? 'normal' : 'circular'

    const ioc = planUartIoc(opts.root, { uart, baud, rxMode, dmaMode, builtinIrq, irqPriority })
    const cubeMx = findCubeMx()
    // 用户在参数里可以单独关掉 CubeMX（只要 .ioc 改动、代码自己生成）
    const wantRun =
      opts.runCubeMx !== undefined
        ? opts.runCubeMx
        : s.cubeMxParam
          ? Boolean(opts.params[s.cubeMxParam])
          : (s.runCubeMx ?? true)

    if (!ioc.ok || !ioc.relPath) {
      // 改不了 .ioc 不算致命：模块本身在运行时能自己开中断，装完照样能用。
      // 但「波特率改了没生效」必须说清楚，否则用户会以为工具骗他。
      changes.push({
        path: ioc.relPath ?? '(.ioc)',
        action: 'skip',
        before: null,
        after: null,
        note: '改 .ioc（串口 / 波特率 / DMA）',
        skipReason: ioc.error ?? '算不出 .ioc 的改动'
      })
      planIoc = {
        relPath: ioc.relPath ?? '(.ioc)',
        notes: ioc.notes,
        warnings: ioc.warnings,
        runCubeMx: false,
        cubeMxFound: Boolean(cubeMx),
        handle: uart,
        baud
      }
    } else {
      const changed = ioc.changes.length > 0
      changes.push({
        path: ioc.relPath,
        action: changed ? 'patch' : 'skip',
        before: changed ? ioc.before : null,
        after: changed ? ioc.after : null,
        note: changed
          ? `改 .ioc：${ioc.notes.join('；')}`
          : `.ioc 已经是目标状态（${uart} / ${baud}）`,
        skipReason: changed ? undefined : '配置已经和参数一致，不用改'
      })
      planIoc = {
        relPath: ioc.relPath,
        notes: ioc.notes,
        warnings: ioc.warnings,
        runCubeMx: changed && wantRun,
        cubeMxFound: Boolean(cubeMx),
        handle: uart,
        baud
      }
      if (changed && wantRun && !cubeMx) {
        planIoc.warnings.push(
          '本机没找到 STM32CubeMX：.ioc 会被改，但 Src/ 里的代码不会重新生成 —— ' +
            '你得自己用 CubeMX 打开这个 .ioc 点一次 Generate Code，否则波特率不生效'
        )
      }
      if (changed && wantRun && cubeMx) {
        // 实测：CubeMX 会用它自己的换行符（CRLF）重写 Src/Inc 下的生成文件。
        // 用户工程的这些文件可能是 LF，于是 git 里看起来「整个文件都改了」，
        // 实际内容只有一两行不同。不说清楚会被当成工具在乱改文件。
        planIoc.warnings.push(
          'CubeMX 会重写 Src/ 和 Inc/ 下的生成文件（连换行符一起），' +
            'git 里看着像整文件改动，内容其实只有需要的那几行不同'
        )
      }
    }
  }

  const blocked =
    criticalFailed ||
    Boolean(renderError) ||
    changes.some(
      (c) =>
        c.action === 'skip' &&
        (c.skipReason?.includes('重复定义') || c.skipReason?.includes('越出了工程根'))
    )

  return {
    packId: pack.id,
    root: opts.root,
    params: opts.params,
    bindings: opts.bindings,
    changes,
    manualSteps: pack.manualSteps ?? [],
    blocked,
    writeCount: changes.filter((c) => c.action !== 'skip').length,
    ioc: planIoc
  }
}

