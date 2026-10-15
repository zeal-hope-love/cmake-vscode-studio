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
import {
  Alert,
  Button,
  Card,
  EmptyState,
  Field,
  Modal,
  PageBody,
  PageHeader,
  Select,
  TextInput
} from '../components/ui'
import { useStudio } from '../state/store'
import type {
  ChannelBinding,
  PackInspectResult,
  PackManifest,
  PackPlan,
  PackPlanOptions,
  PidBinding,
  PidCandidate
} from '@shared/types'

/** 遥控器通道预设：标准 RM 的 RC_ctrl_t 布局（rc.ch[5] + rc.s[2]） */
const RC_PRESET_ACCESSOR = 'get_remote_control_point()'
const RC_CHANNELS: Array<{ name: string; field: string }> = [
  { name: 'rc_ch0', field: 'rc.ch[0]' },
  { name: 'rc_ch1', field: 'rc.ch[1]' },
  { name: 'rc_ch2', field: 'rc.ch[2]' },
  { name: 'rc_ch3', field: 'rc.ch[3]' },
  { name: 'rc_ch4', field: 'rc.ch[4]' },
  { name: 'rc_s0', field: 'rc.s[0]' },
  { name: 'rc_s1', field: 'rc.s[1]' }
]

const LEVEL_STYLE: Record<string, { mark: string; cls: string }> = {
  ok: { mark: '✓', cls: 'ok' },
  warn: { mark: '!', cls: 'warn' },
  err: { mark: '✗', cls: 'err' },
  info: { mark: 'i', cls: 'faint' }
}

export function PacksPage(): React.JSX.Element {
  const projectRoot = useStudio((s) => s.projectRoot)
  const project = useStudio((s) => s.project)
  const notify = useStudio((s) => s.notify)
  const refreshHistory = useStudio((s) => s.refreshHistory)

  const [packs, setPacks] = React.useState<PackManifest[]>([])
  const [packId, setPackId] = React.useState('')
  const [inspect, setInspect] = React.useState<PackInspectResult | null>(null)
  const [busy, setBusy] = React.useState(false)
  const [params, setParams] = React.useState<Record<string, string | number | boolean>>({})
  const [pids, setPids] = React.useState<PidBinding[]>([])
  const [channels, setChannels] = React.useState<ChannelBinding[]>([])
  const [removeLegacy, setRemoveLegacy] = React.useState(false)
  const [plan, setPlan] = React.useState<PackPlan | null>(null)
  const [dirty, setDirty] = React.useState(false)
  const [openIdx, setOpenIdx] = React.useState(0)
  const [confirmOpen, setConfirmOpen] = React.useState(false)
  /** 写入失败的原因 —— 常驻显示 */
  const [applyErrors, setApplyErrors] = React.useState<string[]>([])

  const pack = packs.find((p) => p.id === packId) ?? null

  // ---- 装载包列表 ----
  React.useEffect(() => {
    void (async () => {
      try {
        const list = await window.api.packList()
        setPacks(list)
        setPackId((cur) => cur || list[0]?.id || '')
      } catch (err) {
        notify('err', `读取模块包失败：${err instanceof Error ? err.message : String(err)}`)
      }
    })()
  }, [notify])

  // ---- 选包 / 换工程 → 重新检查兼容性 ----
  const reload = React.useCallback(async (): Promise<void> => {
    if (!projectRoot || !packId) return
    setBusy(true)
    try {
      const r = await window.api.packInspect(packId, projectRoot)
      setInspect(r)
      // 把探测出来的适配值盖在包默认值之上 —— 例如「这个串口没配 RX DMA」自动选逐字节中断
      const p = packs.find((x) => x.id === packId)
      const merged: Record<string, string | number | boolean> = {}
      for (const def of p?.params ?? []) merged[def.key] = def.default
      Object.assign(merged, r.report.derived)
      setParams(merged)
      setPlan(null)
      setDirty(false)
    } catch (err) {
      notify('err', `检查失败：${err instanceof Error ? err.message : String(err)}`)
    } finally {
      setBusy(false)
    }
  }, [projectRoot, packId, packs, notify])

  React.useEffect(() => {
    void reload()
  }, [reload])

  const options: PackPlanOptions | null =
    projectRoot && packId
      ? { packId, root: projectRoot, params, bindings: { pids, channels }, removeLegacy }
      : null

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

  const write = async (): Promise<void> => {
    if (!options) return
    setBusy(true)
    try {
      const r = await window.api.packApply(options)
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
  const addPid = (c: PidCandidate): void => {
    setPids((prev) => [
      ...prev,
      {
        prefix: c.name.replace(/_pid$/i, ''),
        pidType: c.pidType,
        // needsInstance 时 suggestedExpr 是空字符串 —— 工具查不到这个类型的全局实例，
        // 与其编一个不存在的变量名（编译才发现），不如留空让你填
        expr: c.suggestedExpr,
        guard: c.suggestedGuard,
        include: c.file
      }
    ])
    if (c.needsInstance) {
      notify('warn', `「${c.name}」查不到全局实例，表达式要你填：实例名.${c.name}`)
    }
    setDirty(true)
  }

  /** 遥控器访问器声明在哪个头文件 —— 从探测结果里查，生成 #include 要用 */
  const rcInclude = inspect?.symbolHeaders.find((h) => h.symbol === 'get_remote_control_point')?.file

  const addRcPreset = (): void => {
    setChannels((prev) => [
      ...prev,
      ...RC_CHANNELS.filter((rc) => !prev.some((p) => p.name === rc.name)).map((rc) => ({
        name: rc.name,
        mirrorFrom: `${RC_PRESET_ACCESSOR}->${rc.field}`,
        guard: RC_PRESET_ACCESSOR,
        include: rcInclude
      }))
    ])
    if (!rcInclude) {
      notify('warn', '工程里没找到 get_remote_control_point 的声明，生成后可能要自己补 include')
    }
    setDirty(true)
  }

  // ------------------------------------------------------------------------

  if (!projectRoot || !project) {
    return (
      <>
        <PageHeader title="调试模块" subtitle="还没有选择工程" />
        <PageBody>
          <NoProject reason="要往工程里装代码，得先知道工程长什么样（有没有那个串口、有没有 FreeRTOS）。" />
        </PageBody>
      </>
    )
  }

  const errCount = inspect?.report.checks.filter((c) => c.level === 'err').length ?? 0

  return (
    <>
      <PageHeader
        title="调试模块"
        subtitle={
          inspect
            ? `${pack?.name ?? packId} · 检查 ${inspect.report.checks.length} 项` +
              (errCount ? ` · ${errCount} 项致命` : ' · 可以装')
            : '正在检查工程…'
        }
        actions={
          <Button onClick={() => void reload()} disabled={busy}>
            {busy ? '处理中…' : '重新检查'}
          </Button>
        }
      />

      <PageBody>
        {/* ---- ① 选模块 ---- */}
        <Card title="① 选模块" hint="装什么">
          <div className="row">
            <div className="grow">
              <Field label="模块包">
                <Select
                  value={packId}
                  onChange={(e) => setPackId(e.target.value)}
                  options={packs.map((p) => ({ value: p.id, label: `${p.name}（${p.id}）` }))}
                />
              </Field>
            </div>
          </div>
          {pack && <div className="small faint">{pack.summary}</div>}
        </Card>

        {/* ---- ② 兼容性 ---- */}
        {inspect && (
          <Card
            title="② 兼容性检查"
            hint="只读，还没动任何文件"
            actions={
              inspect.report.blocked ? (
                <span className="small" style={{ color: 'var(--err)' }}>
                  有致命问题，先解决
                </span>
              ) : null
            }
          >
            <div className="list">
              {inspect.report.checks.map((c, i) => {
                const s = LEVEL_STYLE[c.level] ?? LEVEL_STYLE.info
                return (
                  <div key={i} className="list__row" style={{ alignItems: 'flex-start' }}>
                    <span
                      className={`mono ${s.cls}`}
                      style={{ width: 16, textAlign: 'center', flex: '0 0 auto' }}
                    >
                      {s.mark}
                    </span>
                    <div className="grow">
                      <div className="small">{c.label}</div>
                      <div className="faint small">{c.detail}</div>
                      {c.adapted && (
                        <div className="small" style={{ color: 'var(--accent)' }}>
                          工具适配：{c.adapted}
                        </div>
                      )}
                    </div>
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
                        setDirty(true)
                      }}
                    />
                    <span>顺手删掉旧版平铺布局的文件（不勾的话会重复定义符号，装不了）</span>
                  </label>
                </div>
              </Alert>
            )}
          </Card>
        )}

        {/* ---- ③ 参数 ---- */}
        {pack && (
          <Card title="③ 参数" hint="大部分是探测出来的，一般不用手改">
            <div className="grid grid--3">
              {pack.params.map((def) => (
                <Field key={def.key} label={def.label} hint={def.hint}>
                  {def.type === 'bool' ? (
                    <label className="checkbox">
                      <input
                        type="checkbox"
                        checked={Boolean(params[def.key])}
                        onChange={(e) => {
                          setParams((p) => ({ ...p, [def.key]: e.target.checked }))
                          setDirty(true)
                        }}
                      />
                      <span className="small">{Boolean(params[def.key]) ? '开' : '关'}</span>
                    </label>
                  ) : def.type === 'enum' ? (
                    <Select
                      value={String(params[def.key] ?? '')}
                      onChange={(e) => {
                        setParams((p) => ({ ...p, [def.key]: e.target.value }))
                        setDirty(true)
                      }}
                      options={(def.options ?? []).map((o) => ({ value: o, label: o }))}
                    />
                  ) : def.type === 'number' ? (
                    <TextInput
                      type="number"
                      value={String(params[def.key] ?? '')}
                      onChange={(e) => {
                        setParams((p) => ({ ...p, [def.key]: Number(e.target.value) }))
                        setDirty(true)
                      }}
                    />
                  ) : (
                    <TextInput
                      mono
                      value={String(params[def.key] ?? '')}
                      onChange={(e) => {
                        setParams((p) => ({ ...p, [def.key]: e.target.value }))
                        setDirty(true)
                      }}
                    />
                  )}
                </Field>
              ))}
            </div>
          </Card>
        )}

        {/* ---- ④ 调参目标 ---- */}
        {inspect && (
          <Card title="④ 调参目标（在线改）" hint="勾一个 = 一键注册一整组 Kp/Ki/Kd/max_out/max_iout">
            <div className="faint small mb-12">
              下面是**从工程里扫出来的** PID 结构体。点「用这个」自动填好表达式，表达式可以改 （比如把
              yaw 改成 pitch）。
            </div>

            {inspect.pidCandidates.length === 0 ? (
              <EmptyState title="没扫到 PID 结构体">
                这一页只认 pid_type_def / gimbal_PID_t 两种类型。也可以用下面的「自定义通道」自己填。
              </EmptyState>
            ) : (
              <div className="list list__scroll" style={{ maxHeight: 240 }}>
                {inspect.pidCandidates.map((c) => (
                  <div key={c.id} className="list__row">
                    <div className="grow">
                      <div className="mono small">{c.name}</div>
                      <div className="faint small">
                        {c.pidType} · {c.isMember ? `成员 of ${c.ownerType}` : '全局'}
                        {c.isArray ? ' · 数组' : ''} · {c.file}:{c.line}
                      </div>
                    </div>
                    <Button size="sm" onClick={() => addPid(c)}>
                      用这个
                    </Button>
                  </div>
                ))}
              </div>
            )}

            {pids.length > 0 && (
              <>
                <div className="bold mb-8" style={{ marginTop: 12 }}>
                  已选 {pids.length} 组
                </div>
                {pids.map((p, i) => (
                  <div className="row" key={i}>
                    <div style={{ width: 170 }}>
                      <Field label="参数前缀">
                        <TextInput
                          mono
                          value={p.prefix}
                          onChange={(e) => {
                            const v = e.target.value
                            setPids((prev) => prev.map((x, k) => (k === i ? { ...x, prefix: v } : x)))
                            setDirty(true)
                          }}
                        />
                      </Field>
                    </div>
                    <div className="grow">
                      <Field label="变量表达式">
                        <TextInput
                          mono
                          value={p.expr}
                          onChange={(e) => {
                            const v = e.target.value
                            setPids((prev) => prev.map((x, k) => (k === i ? { ...x, expr: v } : x)))
                            setDirty(true)
                          }}
                        />
                      </Field>
                    </div>
                    <div style={{ width: 230 }}>
                      <Field label="判空表达式（可空）">
                        <TextInput
                          mono
                          value={p.guard ?? ''}
                          onChange={(e) => {
                            const v = e.target.value
                            setPids((prev) => prev.map((x, k) => (k === i ? { ...x, guard: v } : x)))
                            setDirty(true)
                          }}
                        />
                      </Field>
                    </div>
                    <div style={{ paddingTop: 18 }}>
                      <Button
                        size="sm"
                        variant="ghost"
                        onClick={() => {
                          setPids((prev) => prev.filter((_, k) => k !== i))
                          setDirty(true)
                        }}
                      >
                        移除
                      </Button>
                    </div>
                  </div>
                ))}
                <div className="faint small">
                  会生成{' '}
                  <span className="mono">{pids[0]?.prefix}_kp / _ki / _kd / _maxout / _maxiout</span>
                  {pids.length > 1 ? ' 这样的若干组' : ''}，用 VOFA 发{' '}
                  <span className="mono">set {pids[0]?.prefix}_kp 3.5</span> 就能改。
                </div>
              </>
            )}
          </Card>
        )}

        {/* ---- ⑤ 监看通道 ---- */}
        {inspect && (
          <Card title="⑤ 监看通道（画波形）" hint="顺序 = VOFA 里的 ch0、ch1…">
            <div className="row mb-12">
              <Button size="sm" onClick={addRcPreset}>
                加入遥控器通道（ch0-4 / s0-1）
              </Button>
              <Button
                size="sm"
                onClick={() => {
                  setChannels((prev) => [...prev, { name: `ch${prev.length}`, expr: '' }])
                  setDirty(true)
                }}
              >
                + 自定义通道
              </Button>
            </div>

            {channels.length === 0 ? (
              <div className="faint small">还没加通道。加了才有波形可看。</div>
            ) : (
              channels.map((c, i) => (
                <div className="row" key={i}>
                  <div style={{ width: 150 }}>
                    <Field label="通道名">
                      <TextInput
                        mono
                        value={c.name}
                        onChange={(e) => {
                          const v = e.target.value
                          setChannels((prev) => prev.map((x, k) => (k === i ? { ...x, name: v } : x)))
                          setDirty(true)
                        }}
                      />
                    </Field>
                  </div>
                  <div className="grow">
                    <Field
                      label={c.mirrorFrom ? '源表达式（会做 fp32 镜像）' : '变量表达式'}
                      hint={c.mirrorFrom ? '源类型不是 fp32，工具自动加一个镜像变量' : undefined}
                    >
                      <TextInput
                        mono
                        value={c.mirrorFrom ?? c.expr ?? ''}
                        onChange={(e) => {
                          const v = e.target.value
                          setChannels((prev) =>
                            prev.map((x, k) =>
                              k === i ? (x.mirrorFrom ? { ...x, mirrorFrom: v } : { ...x, expr: v }) : x
                            )
                          )
                          setDirty(true)
                        }}
                      />
                    </Field>
                  </div>
                  <div style={{ width: 210 }}>
                    <Field label="判空表达式（可空）">
                      <TextInput
                        mono
                        value={c.guard ?? ''}
                        onChange={(e) => {
                          const v = e.target.value
                          setChannels((prev) => prev.map((x, k) => (k === i ? { ...x, guard: v } : x)))
                          setDirty(true)
                        }}
                      />
                    </Field>
                  </div>
                  <div style={{ paddingTop: 18 }}>
                    <Button
                      size="sm"
                      variant="ghost"
                      onClick={() => {
                        setChannels((prev) => prev.filter((_, k) => k !== i))
                        setDirty(true)
                      }}
                    >
                      移除
                    </Button>
                  </div>
                </div>
              ))
            )}
          </Card>
        )}

        {/* ---- ⑥ 改动清单 ---- */}
        <Card
          title="⑥ 改动清单"
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
          {dirty && <Alert kind="warn">参数或勾选改过了，点「重新生成」刷新清单。</Alert>}

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

              <div className="list">
                {plan.changes.map((c, i) => (
                  <div
                    key={c.path}
                    className="list__row"
                    style={{ cursor: c.after !== null || c.before !== null ? 'pointer' : 'default' }}
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
        </Modal>
      )}
    </>
  )
}

export default PacksPage
