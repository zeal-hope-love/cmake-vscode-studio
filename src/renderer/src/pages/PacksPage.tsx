/**
 * 源码 · 调试模块（把模块包装进工程）
 *
 * 解决的事：往工程里塞一个调试模块（目前是 VOFA+ 在线调参）要改好几个文件 ——
 * 加源码、改 CMakeLists、改 freertos.c 建任务、按工程情况调串口和开关。
 * 手做一遍不难，难的是**每次都做对**，而且改错了不好回头。
 *
 * 这一页的节奏刻意是「先看清楚，再动手」：
 *   ① 兼容性检查（只读）—— 这个工程能不能装、要替你适配什么
 *   ② 参数 + 勾选调参目标/监看通道
 *   ③ 生成改动清单（只读）—— 逐文件 diff，含新建和补丁
 *   ④ 写入（先存快照，历史页能一键还原）
 *
 * 前三步都不碰磁盘。
 */

import React from 'react'
import { NoProject } from '../components/NoProject'
import { DiffView } from '../components/DiffView'
import { Alert, Button, Card, Field, Modal, PageBody, PageHeader, Select, Spinner, TextInput } from '../components/ui'
import { Icons } from '../components/icons'
import { PortPackPanel } from '../components/PortPackPanel'
import { SymbolPicker } from '../components/SymbolPicker'
import { AddrTablePanel } from '../components/AddrTablePanel'
import { useStudio } from '../state/store'
import { mapToPackBindings, type VofaBinding, type VofaMap } from '@shared/vofaMap'
import type { PackInspectResult, PackPlan, PackPlanOptions } from '@shared/types'
import type { PackApplyResult, PackApplyStep, PackParam } from '@shared/packTypes'

/**
 * 检查项的显示样式。
 *
 * `cls` 要和 CSS 里的 `.badge--<cls>` 对上 —— 早先 info 写的是 `faint`
 * （那是文字颜色类），换成圆底徽标后就对不上了。
 */
const LEVEL_STYLE: Record<string, { mark: string; cls: string }> = {
  ok: { mark: '✓', cls: 'ok' },
  warn: { mark: '!', cls: 'warn' },
  err: { mark: '✗', cls: 'err' },
  info: { mark: 'i', cls: 'info' }
}

export function PacksPage(): React.JSX.Element {
  const projectRoot = useStudio((s) => s.projectRoot)
  const project = useStudio((s) => s.project)
  const notify = useStudio((s) => s.notify)
  const refreshHistory = useStudio((s) => s.refreshHistory)

  /**
   * 包列表和「当前是哪个包」都放在 store 里 —— 左侧「扩展」组的导航项由同一份
   * 数据生成，两处共用一个来源才不会出现「导航里 3 个包、页面里只认 1 个」。
   */
  const packs = useStudio((s) => s.packs)
  const packId = useStudio((s) => s.activePackId) ?? ''
  const setPackId = useStudio((s) => s.setActivePackId)
  const refreshPacks = useStudio((s) => s.refreshPacks)
  const [inspect, setInspect] = React.useState<PackInspectResult | null>(null)
  const [busy, setBusy] = React.useState(false)
  const [params, setParams] = React.useState<Record<string, string | number | boolean>>({})
  const [bindings, setBindings] = React.useState<VofaBinding[]>([])
  const [removeLegacy, setRemoveLegacy] = React.useState(false)
  const [plan, setPlan] = React.useState<PackPlan | null>(null)
  const [dirty, setDirty] = React.useState(false)
  const [openIdx, setOpenIdx] = React.useState(0)
  const [confirmOpen, setConfirmOpen] = React.useState(false)
  /** 写入失败的原因 —— 常驻显示 */
  const [applyErrors, setApplyErrors] = React.useState<string[]>([])
  /** 写入过程中的每一步（写文件 → CubeMX → 核对波特率） */
  const [steps, setSteps] = React.useState<PackApplyStep[]>([])
  /** 上一次写入的结果 —— 主要是为了把「波特率对不上」这种话留在页面上 */
  const [lastApply, setLastApply] = React.useState<PackApplyResult | null>(null)

  const pack = packs.find((p) => p.id === packId) ?? null

  /**
   * 移植包（带 `iocChanges` 的，比如 VT13）走另一套界面。
   *
   * 为什么不共用 vofa 那套：vofa 是「算 diff → 逐文件确认 → 写」，
   * 因为改动全是工具生成的文本；移植包要调 CubeMX 这个外部程序，
   * 改哪些文件事先算不出来，所以交互改成「预检 → 跑流水线 → 看验收」。
   */
  const isPortPack = Boolean(pack && (pack.iocChanges || pack.stateMachine))
  const [portMode, setPortMode] = React.useState(false)

  /**
   * 当前包声明提供的能力。
   *
   * 「在线调参」「监看通道」这两块是 VOFA+ 特有的，遥控模块 VT13 根本用不上。
   * 以前无条件渲染，才会出现「遥控下面写着调参」这种看着很怪的情况。
   */
  const features = pack?.features ?? []

  // ---- 装载包列表（store 里已有就直接用）----
  React.useEffect(() => {
    if (packs.length === 0) void refreshPacks()
  }, [packs.length, refreshPacks])

  // ---- 选包 / 换工程 → 重新检查兼容性 ----
  const reload = React.useCallback(async (): Promise<void> => {
    if (!projectRoot || !packId) return
    setBusy(true)
    try {
      /*
       * 先重读 packs 目录，再检查工程。
       *
       * 包清单（pack.json）里的参数表会被缓存进 store，只「重新检查」不重读的话，
       * 改了清单（新增参数、把 showIf 换成 enableIf 这种）界面还是老的一套 ——
       * 表现就是「改了半天，看不出任何变化」。开发时尤其容易撞上。
       */
      await refreshPacks()
      const fresh = useStudio.getState().packs
      const r = await window.api.packInspect(packId, projectRoot)
      setInspect(r)
      // 把探测出来的适配值盖在包默认值之上 —— 例如「这个串口没配 RX DMA」自动选逐字节中断
      const p = fresh.find((x) => x.id === packId)
      const merged: Record<string, string | number | boolean> = {}
      for (const def of p?.params ?? []) merged[def.key] = def.default
      Object.assign(merged, r.report.derived)
      setParams(merged)
      setBindings(r.savedMap?.bindings ?? [])
      setPlan(null)
      setDirty(false)
    } catch (err) {
      notify('err', `检查失败：${err instanceof Error ? err.message : String(err)}`)
    } finally {
      setBusy(false)
    }
  }, [projectRoot, packId, refreshPacks, notify])

  React.useEffect(() => {
    void reload()
  }, [reload])

  const currentMap = (): VofaMap | null =>
    projectRoot && packId
      ? { version: 1, packId: 'vofa', updatedAt: Date.now(), bindings, params }
      : null

  const options: PackPlanOptions | null = (() => {
    const map = currentMap()
    if (!map || !projectRoot) return null
    return {
      packId,
      root: projectRoot,
      params,
      bindings: mapToPackBindings(map),
      map,
      removeLegacy
    }
  })()

  const makePlan = async (): Promise<void> => {
    if (!options) return
    setBusy(true)
    try {
      const p = await window.api.packPlan(options)
      setPlan(p)
      setDirty(false)
      setOpenIdx(0)
      if (p.blocked) notify('warn', '有必须先处理的问题，看清单里标出来的那条')
    } catch (err) {
      notify('err', `生成清单失败：${err instanceof Error ? err.message : String(err)}`)
    } finally {
      setBusy(false)
    }
  }

  /*
   * 写入进度：主进程每完成一步推一条（写文件 / 跑 CubeMX / 核对波特率）。
   *
   * 按 id 覆盖而不是追加 —— 同一行会在「running → ok」之间更新，
   * 追加的话 CubeMX 那一行会刷出几十条。
   */
  React.useEffect(() => {
    return window.api.onApplyProgress(({ step }) => {
      setSteps((prev) => {
        const i = prev.findIndex((x) => x.id === step.id)
        if (i < 0) return [...prev, step]
        const next = [...prev]
        next[i] = step
        return next
      })
    })
  }, [])

  const write = async (): Promise<void> => {
    if (!options) return
    setBusy(true)
    setSteps([])
    setLastApply(null)
    try {
      const r = await window.api.packApply(options)
      setLastApply(r)
      if (!r.ok) {
        // 失败信息常驻显示，不要只丢一个 3 秒就消失的提示 ——
        // 写入是半途而废最危险的操作（比如改了 CMakeLists 但源文件没写进去）
        setApplyErrors(r.errors)
        setConfirmOpen(false)
        notify('err', '写入失败，看清单上面的红框')
        return
      }
      setApplyErrors([])
      notify('ok', `已写入 ${r.written.length} 个文件。下一步构建会重新配置。`)
      setConfirmOpen(false)
      setPlan(null)
      await refreshHistory()
      await reload()
    } catch (err) {
      notify('err', `写入失败：${err instanceof Error ? err.message : String(err)}`)
    } finally {
      setBusy(false)
    }
  }

  // ---- 勾选 ----
  const touch = (): void => {
    setDirty(true)
    setPlan(null)
  }

  const saveMap = async (): Promise<void> => {
    const map = currentMap()
    if (!map || !projectRoot) return
    const r = await window.api.vofaMapSave(projectRoot, map)
    if (r.ok) notify('ok', '映射表已保存到 application/vofa/vofa_map.json')
    else notify('err', r.error ?? '保存映射表失败')
  }

  // ------------------------------------------------------------------------

  /*
   * 没选工程时**不要整页替换成空状态**。
   *
   * 这一页和「模板」一样属于「了解 / 配置这个模块本身」，
   * 不依赖具体工程 —— 用户可以先进来看这个模块是干什么的、
   * 有哪些内置模板、格式说明长什么样。只有真的要「写入工程」时
   * 才需要工程，那时候再提示。
   *
   * 所以下面统一用 `hasProject` 判断，而不是一进来就 return。
   */
  const hasProject = Boolean(projectRoot && project)

  const errCount = hasProject
    ? (inspect?.report.checks.filter((c) => c.level === 'err').length ?? 0)
    : 0

  const paramOptions = (def: {
    key: string
    options?: string[]
    optionLabels?: Record<string, string>
    optionsFrom?: 'uarts'
  }): Array<{ value: string; label: string }> => {
    if (def.optionsFrom === 'uarts') {
      /*
       * 选项文字要短。
       * select 的固有宽度 ≈ 最长选项的宽度，栅格轨道会被它撑开 ——
       * 以前把「可能被 application/remote_control.c、…」整串塞进选项，
       * 直接把右边「命令接收方式」那列挤出窗口，用户就以为 DMA 选项没了。
       * 占用的完整路径列表在兼容性检查里看，这里只留文件名。
       */
      const base = (p: string): string => p.split(/[\\/]/).pop() ?? p
      const opts = (inspect?.report.uarts ?? []).map((u) => ({
        value: u.name,
        label: `${u.name}${u.txDma ? '' : ' · 无 TX DMA'}${
          u.rxDma ? ` · RX DMA ${u.rxDmaMode === 'circular' ? '循环' : u.rxDmaMode === 'normal' ? '单次' : '?'}` : ' · 无 RX DMA'
        }${
          u.usedBy.length
            ? ` · 被 ${base(u.usedBy[0])}${u.usedBy.length > 1 ? ` 等 ${u.usedBy.length} 处` : ''}占用`
            : ''
        }`
      }))
      const cur = String(params[def.key] ?? '')
      if (cur && !opts.some((o) => o.value === cur)) {
        opts.unshift({ value: cur, label: `${cur}（工程里没有）` })
      }
      return opts
    }
    return (def.options ?? []).map((o) => ({ value: o, label: def.optionLabels?.[o] ?? o }))
  }

  /** 参数级联：`showIf` 不满足的那一行不渲染（比如没选 DMA 就没有「DMA 模式」） */
  const visibleParams = (pack?.params ?? []).filter((def) => {
    if (!def.showIf) return true
    const cur = params[def.showIf.key]
    return String(cur ?? '') === String(def.showIf.equals)
  })

  /**
   * `enableIf` 不满足 → 置灰 + 说明，**不删行**。
   *
   * 为什么不和 showIf 统一成隐藏：DMA 模式这种「隐性开关」藏起来之后，
   * 用户以为功能根本不存在。留一行灰的，等于告诉人「这里能改，只是还没轮到它」。
   */
  const paramGate = (def: PackParam): { disabled: boolean; note?: string } => {
    const dep = def.enableIf
    if (!dep || String(params[dep.key] ?? '') === String(dep.equals)) return { disabled: false }
    const depDef = (pack?.params ?? []).find((p) => p.key === dep.key)
    const want = depDef?.optionLabels?.[String(dep.equals)] ?? String(dep.equals)
    return {
      disabled: true,
      note: `上面把「${depDef?.label ?? dep.key}」选成 ${want} 之后，这一项才生效`
    }
  }

  /*
   * 选中串口在 .ioc 里的 RX DMA 现状 —— 直接摆在参数区顶上。
   *
   * 光靠下拉框后面的「· 无 RX DMA」不够：那串字在下拉框里，得点开才看得到；
   * 用户真正的问题是「我这块板子现在到底开没开 DMA、开的是哪种」，
   * 所以要有一行独立的、随手能读到的结论。
   */
  const uartKey = pack?.iocSetup?.uartParam ?? 'uart'
  const selUart =
    (inspect?.report.uarts ?? []).find((u) => u.name === String(params[uartKey] ?? '')) ?? null
  const rxModeKey = pack?.iocSetup?.rxModeParam
  const wantDma = rxModeKey ? String(params[rxModeKey] ?? '') === 'dma' : false
  const dmaModeKey = pack?.iocSetup?.dmaModeParam
  const targetDma = String((dmaModeKey && params[dmaModeKey]) || 'circular')
  const dmaLabel = (m: 'circular' | 'normal' | null): string =>
    m === 'circular' ? '循环（DMA_CIRCULAR）' : m === 'normal' ? '单次（DMA_NORMAL）' : '模式未知'

  /** 一句人能直接读懂的结论：现在是什么、写入时会动什么 */
  const dmaStatusText = ((): string | null => {
    if (!selUart) return null
    const cur: 'circular' | 'normal' | null = selUart.rxDma ? selUart.rxDmaMode : null
    const target: 'circular' | 'normal' = targetDma === 'normal' ? 'normal' : 'circular'
    if (!selUart.rxDma) {
      return wantDma
        ? `${selUart.name} 的 .ioc 里没有 RX DMA —— 写入会补上并设成 ${dmaLabel(target)}，再跑一遍 CubeMX`
        : `${selUart.name} 的 .ioc 里没有 RX DMA。把「命令接收方式」选成 dma，工具就会补上并配好模式`
    }
    if (!wantDma) {
      return `${selUart.name} 的 .ioc 里已配 RX DMA，当前是 ${dmaLabel(cur)}；接收方式选 it 时用不到它`
    }
    if (cur === target) {
      return `${selUart.name} 的 .ioc 里已配 RX DMA，当前是 ${dmaLabel(cur)}，和这里选的一致 —— 写入时这一项不动`
    }
    return `${selUart.name} 的 .ioc 里当前是 ${dmaLabel(cur)}，写入会改成 ${dmaLabel(target)}（只改 Dma.<串口>_RX.<槽>.Mode 这一个键）`
  })()

  // 移植包：整页交给 PortPackPanel（它内部也要工程，所以还是得挡一下）
  if (pack && isPortPack && portMode) {
    if (!hasProject) {
      return (
        <>
          <PageHeader title={pack.name} subtitle="还没有选择工程" />
          <PageBody>
            <NoProject reason="移植要改这个工程的 .ioc 和源码，得先选一个工程。" />
          </PageBody>
        </>
      )
    }
    return <PortPackPanel pack={pack} projectRoot={projectRoot!} onBack={() => setPortMode(false)} />
  }

  return (
    <>
      {/*
        页头和「配置调试文件」保持一致的操作习惯：
          · 左边：标题 + 一句「这个页面是干什么的」
          · 右边：同样的按钮顺序 —— 打开类 → 主操作（primary）

        以前这里只有孤零零一个「重新检查」，没有 primary，
        和同级的「配置调试文件」页（三个按钮、最后一个是 primary）差别很大，
        看着不像同一套产品里的页面。
      */}
      <PageHeader
        title={pack?.name ?? '模块包'}
        subtitle={pack ? pack.summary : '还没有选择模块'}
        actions={
          <>
            {hasProject && project && (
              <>
                <Button size="sm" onClick={() => void window.api.openInVSCode(project.root)}>
                  <Icons.vscode />在 VSCode 打开
                </Button>
                <Button size="sm" onClick={() => void window.api.openInExplorer(project.root)}>
                  <Icons.folder />
                  资源管理器
                </Button>
              </>
            )}
            <Button
              size="sm"
              variant="primary"
              onClick={() => void reload()}
              disabled={busy || !hasProject}
              title={hasProject ? '重新扫描工程，刷新兼容性检查结果' : '先选一个工程'}
            >
              {busy ? <Spinner /> : <Icons.refresh />}
              {busy ? '检查中…' : '重新检查'}
            </Button>
          </>
        }
      />

      <PageBody>
        {/* 检查结论单独一行小字，不塞进副标题 —— 副标题留给「这页干什么」 */}
        {hasProject && inspect && (
          <div className="small faint" style={{ marginBottom: 10 }}>
            检查 {inspect.report.checks.length} 项
            {errCount > 0
              ? `，其中 ${errCount} 项需要先处理`
              : isPortPack
                ? '，都没有问题 —— 点下面的「进入移植流程」开始'
                : '，都没有问题 —— 可以直接装'}
          </div>
        )}
        {/* ---- 模块简介 ----
            以前这里是个「选模块」下拉框，但用户进这一页之前已经在左边导航
            点过具体哪个模块了，再让他选一次纯属重复。现在只显示当前模块的
            名字和简介，换模块直接用左侧导航。 */}
        <Card title={pack?.name ?? '模块包'} hint={pack ? pack.id : undefined}>
          {pack ? (
            <>
              <div className="small">{pack.summary}</div>

              {/*
                移植包**只在这一处**给入口。
                以前右上角有个「进入移植流程」、页面底下还有个「写入工程」，
                两个按钮说的是同一件事，而且后者走的是 vofa 那套流程 ——
                对 VT13 根本不适用。现在移植包直接把常规配置区整个隐藏，
                这里放一个显眼的按钮，指向唯一正确的入口。
              */}
              {isPortPack && (
                <div
                  className="row"
                  style={{
                    marginTop: 14,
                    paddingTop: 14,
                    borderTop: '1px solid var(--border)',
                    alignItems: 'center',
                    gap: 12
                  }}
                >
                  <Button variant="primary" onClick={() => setPortMode(true)}>
                    <Icons.write />
                    进入移植流程
                  </Button>
                  <span className="small faint">
                    这个模块要改 .ioc、调 CubeMX 重新生成，走的是另一套流程 （预检 → 执行 →
                    验收），不是下面那种「生成清单再写入」
                  </span>
                </div>
              )}
            </>
          ) : (
            <div className="small faint">从左侧「扩展」里选一个模块</div>
          )}
        </Card>

        {/* ---- ② 兼容性 ---- */}
        {inspect && (
          <Card
            title="兼容性检查"
            hint="只读，还没动任何文件"
            actions={
              inspect.report.blocked ? (
                <span className="small" style={{ color: 'var(--err)' }}>
                  有致命问题，先解决
                </span>
              ) : null
            }
          >
            <div className="checklist">
              {inspect.report.checks.map((c, i) => {
                const s = LEVEL_STYLE[c.level] ?? LEVEL_STYLE.info
                /*
                 * 一行一条，但**给足呼吸感**：
                 *   · 符号用圆底徽标（绿勾 / 黄叹号 / 红叉），不再是裸字符
                 *   · 每条之间 padding 6px，鼠标划过有底色
                 *   · 左侧固定宽度放徽标，中间标题，右边路径/说明
                 */
                return (
                  <div key={i} className="checklist__row">
                    <span className={`mark mark--${s.cls}`}>{s.mark}</span>
                    <span className="checklist__label">{c.label}</span>
                    <span
                      className="checklist__detail checklist__detail--wrap"
                      title={c.adapted ? `工具适配：${c.adapted}` : c.detail}
                    >
                      {c.adapted ? `工具适配：${c.adapted}` : c.detail}
                    </span>
                  </div>
                )
              })}
            </div>

            {inspect.existingFiles.length > 0 && (
              <Alert kind="warn">
                工程里已经有 vofa 相关文件：
                <span className="mono small"> {inspect.existingFiles.slice(0, 5).join('、')}</span>
                {inspect.existingFiles.length > 5 ? ' …' : ''}
                <div className="mt-8">
                  <label className="checkbox">
                    <input
                      type="checkbox"
                      checked={removeLegacy}
                      onChange={(e) => {
                        setRemoveLegacy(e.target.checked)
                        touch()
                      }}
                    />
                    <span>顺手删掉旧版平铺布局的文件（不勾的话会重复定义符号，装不了）</span>
                  </label>
                </div>
              </Alert>
            )}
          </Card>
        )}
        {/* ---- 常规模块包（vofa 这类）的配置区 ----
            移植包（VT13）走的是上面那个「进入移植流程」按钮，
            它是另一套流水线（改 .ioc → 调 CubeMX → 替换文件 → 验收），
            参数也好、改动清单也好，都由那个面板自己管。
            这里再摆一份「写入工程」只会让人以为有两套做法。 */}
        {!isPortPack && (
          <>
            {/* ---- ③ 参数 ---- */}
            {pack && (
              <Card title="参数" hint="大部分是探测出来的，一般不用手改">
                {dmaStatusText && (
                  <div
                    className="small"
                    style={{
                      marginBottom: 12,
                      padding: '8px 10px',
                      border: '1px solid var(--border)',
                      borderRadius: 6
                    }}
                  >
                    <span className="faint">RX DMA · </span>
                    {dmaStatusText}
                  </div>
                )}
                <div className="grid grid--3">
                  {visibleParams.map((def) => {
                    const gate = paramGate(def)
                    return (
                      <Field
                        key={def.key}
                        label={def.label}
                        hint={
                          gate.note ? (
                            <>
                              {def.hint}
                              <div style={{ color: 'var(--warn, #c98a00)', marginTop: 4 }}>{gate.note}</div>
                            </>
                          ) : (
                            def.hint
                          )
                        }
                        style={gate.disabled ? { opacity: 0.55 } : undefined}
                      >
                        {def.type === 'bool' ? (
                          <label className="checkbox">
                            <input
                              type="checkbox"
                              checked={Boolean(params[def.key])}
                              disabled={gate.disabled}
                              onChange={(e) => {
                                setParams((p) => ({ ...p, [def.key]: e.target.checked }))
                                touch()
                              }}
                            />
                            <span className="small">{Boolean(params[def.key]) ? '开' : '关'}</span>
                          </label>
                        ) : def.type === 'enum' ? (
                          <Select
                            value={String(params[def.key] ?? '')}
                            disabled={gate.disabled}
                            onChange={(e) => {
                              setParams((p) => ({ ...p, [def.key]: e.target.value }))
                              touch()
                            }}
                            options={paramOptions(def)}
                          />
                        ) : def.type === 'number' ? (
                          <TextInput
                            type="number"
                            min={def.min}
                            max={def.max}
                            step={def.step}
                            disabled={gate.disabled}
                            value={String(params[def.key] ?? '')}
                            onChange={(e) => {
                              setParams((p) => ({ ...p, [def.key]: Number(e.target.value) }))
                              touch()
                            }}
                          />
                        ) : (
                          <TextInput
                            mono
                            disabled={gate.disabled}
                            value={String(params[def.key] ?? '')}
                            onChange={(e) => {
                              setParams((p) => ({ ...p, [def.key]: e.target.value }))
                              touch()
                            }}
                          />
                        )}
                      </Field>
                    )
                  })}
                </div>
              </Card>
            )}

            {/* ---- ④ 信号目录 + 映射表 ---- */}
            {inspect && (features.includes('onlineTuning') || features.includes('waveform')) && (
              <SymbolPicker
                symbols={inspect.symbols}
                bindings={bindings}
                features={features}
                onChange={(next) => {
                  setBindings(next)
                  touch()
                }}
                onNotify={notify}
                onSaveMap={() => void saveMap()}
              />
            )}

            {/*
              地址表：另一条调参路 —— 从 .elf 拿地址直接读内存，不改源码、不用重编。
              和上面的信号目录并列放着，因为它们的取舍不一样（static / 结构体成员），
              用户得能一眼看到两条路各自能干什么。
            */}
            {inspect && projectRoot && features.includes('waveform') && (
              <AddrTablePanel projectRoot={projectRoot} onNotify={notify} />
            )}

            {/* ---- ⑥ 改动清单 ---- */}
            <Card
              title="改动清单"
              hint="只算不写，看清楚了再落盘"
              actions={
                <div className="flex">
                  <Button onClick={() => void makePlan()} disabled={busy}>
                    {plan ? '重新生成' : '生成清单'}
                  </Button>
                  <Button
                    variant="primary"
                    disabled={!plan || plan.blocked || plan.writeCount === 0}
                    onClick={() => setConfirmOpen(true)}
                  >
                    写入工程{plan ? `（${plan.writeCount}）` : ''}
                  </Button>
                </div>
              }
            >
              {dirty && (
                <Alert kind="warn">
                  参数或勾选改过了，点「生成清单」看新的差异 —— 写入始终以最新清单为准。
                </Alert>
              )}

              {applyErrors.length > 0 && (
                <Alert kind="err">
                  <div className="bold mb-8">上次写入失败（已自动存快照，可以还原）</div>
                  {applyErrors.map((e, i) => (
                    <div key={i} className="small mono">
                      · {e}
                    </div>
                  ))}
                </Alert>
              )}

              {!plan ? (
                <div className="faint small">
                  点右上角「生成清单」，会算出要新建哪些文件、要改哪几行，逐个给你看。
                </div>
              ) : (
                <>
                  {plan.blocked && (
                    <Alert kind="err">有必须先处理的问题，写入被挡住。看下面标红的那条。</Alert>
                  )}

                  {/*
                    .ioc 那一步单独说清楚：它会改外设配置、还可能拉起 CubeMX
                    重写 Src/Inc。用户点「写入」之前必须知道这两件事。
                  */}
                  {plan.ioc && plan.ioc.runCubeMx && (
                    <Alert kind="info">
                      写完会顺带跑一次 <b>STM32CubeMX</b> 重新生成代码（约 20~60 秒），
                      否则改了 .ioc 也不会生效 —— 波特率写在 .ioc 里，而真正的
                      <code className="mono">huart.Init.BaudRate</code> 在{' '}
                      <code className="mono">Src/usart.c</code> 里。
                      <div className="faint small mt-8">
                        跑之前会把 <code className="mono">Src/</code> 和{' '}
                        <code className="mono">Inc/</code> 一起存进快照，生成坏了能整体还原。
                      </div>
                    </Alert>
                  )}
                  {plan.ioc && plan.ioc.warnings.length > 0 && (
                    <Alert kind="warn">
                      <div className="bold mb-8">.ioc 那一步要留意</div>
                      {plan.ioc.warnings.map((w, i) => (
                        <div key={i} className="small">
                          · {w}
                        </div>
                      ))}
                    </Alert>
                  )}

                  {/*
                    上一次写入的结果留在这里。波特率对不上是**静默失败**：
                    波形照发、串口照开，只是全是乱码 —— 不留个常驻提示，
                    用户会去怀疑硬件。
                  */}
                  {lastApply?.cubeMx && !lastApply.cubeMx.skipped && !lastApply.cubeMx.ok && (
                    <Alert kind="err">
                      <div className="bold mb-8">CubeMX 没能重新生成代码</div>
                      <div className="small">{lastApply.cubeMx.detail}</div>
                      {lastApply.cubeMx.log.length > 0 && (
                        <div className="small mono mt-8">
                          {lastApply.cubeMx.log.slice(-4).map((l, i) => (
                            <div key={i}>· {l}</div>
                          ))}
                        </div>
                      )}
                      <div className="faint small mt-8">
                        .ioc 已经改好了。用 CubeMX 打开它点一次「Generate Code」也行，
                        或者处理后重新点「写入工程」。
                      </div>
                    </Alert>
                  )}
                  {lastApply?.baudCheck && !lastApply.baudCheck.match && (
                    <Alert kind="warn">
                      <div className="bold mb-8">波特率还没真正生效</div>
                      <div className="small">{lastApply.baudCheck.detail}</div>
                    </Alert>
                  )}

                  <div className="list">
                    {plan.changes.map((c, i) => (
                      <div
                        key={c.path}
                        className="list__row"
                        style={{
                          cursor: c.after !== null || c.before !== null ? 'pointer' : 'default'
                        }}
                        onClick={() => setOpenIdx(i)}
                      >
                        <span
                          className="mono small"
                          style={{
                            width: 74,
                            flex: '0 0 auto',
                            color:
                              c.action === 'skip'
                                ? 'var(--text-faint)'
                                : c.action === 'patch'
                                  ? 'var(--accent)'
                                  : 'var(--ok, #16a34a)'
                          }}
                        >
                          {c.action === 'create'
                            ? '＋新增'
                            : c.action === 'overwrite'
                              ? '覆盖'
                              : c.action === 'patch'
                                ? '改几行'
                                : c.action === 'delete'
                                  ? '删除'
                                  : '跳过'}
                        </span>
                        <div className="grow">
                          <div className="mono small">{c.path}</div>
                          <div className="faint small">{c.note}</div>
                          {c.skipReason && (
                            <div className="small" style={{ color: 'var(--err)' }}>
                              {c.skipReason}
                            </div>
                          )}
                        </div>
                      </div>
                    ))}
                  </div>

                  {plan.changes[openIdx] &&
                    plan.changes[openIdx].before !== null &&
                    plan.changes[openIdx].after !== null && (
                      <div style={{ marginTop: 10 }}>
                        <div className="small bold mb-8">
                          差异：<span className="mono">{plan.changes[openIdx].path}</span>
                        </div>
                        <DiffView
                          previous={plan.changes[openIdx].before}
                          current={plan.changes[openIdx].after}
                        />
                      </div>
                    )}

                  {plan.manualSteps.length > 0 && (
                    <Alert kind="info">
                      <div className="bold mb-8">装完之后你要自己做的（工具替你不了）</div>
                      {plan.manualSteps.map((s, i) => (
                        <div key={i} className="small">
                          · {s}
                        </div>
                      ))}
                    </Alert>
                  )}
                </>
              )}
            </Card>
          </>
        )}
      </PageBody>

      {confirmOpen && plan && (
        <Modal
          title="确认写入工程"
          width={720}
          onClose={() => setConfirmOpen(false)}
          footer={
            <>
              <Button onClick={() => setConfirmOpen(false)}>取消</Button>
              <Button variant="primary" onClick={() => void write()} disabled={busy}>
                {busy ? '写入中…' : '确认写入'}
              </Button>
            </>
          }
        >
          <Alert kind="info">
            会写入 <b>{plan.writeCount}</b> 个文件（新建 / 覆盖 / 改几行）。
            <br />
            写入前会**自动存快照** —— 不满意可以在「历史记录」或「检查与清理」里一键还原，
            包括把新建的文件删掉。
          </Alert>
          <div className="small" style={{ marginTop: 8 }}>
            {plan.changes
              .filter((c) => c.action !== 'skip')
              .map((c) => (
                <div key={c.path} className="mono">
                  · {c.path}
                </div>
              ))}
          </div>

          {/*
            进度只在真的跑起来之后出现。CubeMX 那一步要几十秒，
            没有这几行的话界面就只有一个转圈，用户不知道卡在哪。
          */}
          {steps.length > 0 && (
            <div className="mt-12">
              {steps.map((st) => (
                <div key={st.id} className="row small" style={{ alignItems: 'baseline', gap: 8 }}>
                  <span
                    className="mono"
                    style={{
                      width: 18,
                      flex: '0 0 auto',
                      color:
                        st.status === 'ok'
                          ? 'var(--ok, #16a34a)'
                          : st.status === 'err'
                            ? 'var(--err)'
                            : st.status === 'warn'
                              ? 'var(--warn, #d97706)'
                              : 'var(--text-faint)'
                    }}
                  >
                    {st.status === 'ok'
                      ? '✓'
                      : st.status === 'err'
                        ? '✗'
                        : st.status === 'warn'
                          ? '!'
                          : st.status === 'skip'
                            ? '–'
                            : '·'}
                  </span>
                  <span style={{ flex: 1 }}>
                    {st.label}
                    {st.detail && <span className="faint"> · {st.detail}</span>}
                  </span>
                </div>
              ))}
            </div>
          )}
        </Modal>
      )}
    </>
  )
}

export default PacksPage
