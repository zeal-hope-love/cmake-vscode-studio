/**
 * 移植包面板（VT13 这类）。
 *
 * ## 为什么和 vofa 那套分开
 *
 * 常规模块包（vofa）的流程是「算 diff → 用户逐文件确认 → 落盘」，因为改动
 * 都是工具自己生成的文本。移植包不一样：它要**调 CubeMX 这个外部程序**，
 * CubeMX 会重写 `Src/`、`Inc/`，改哪些文件事先算不出来。
 *
 * 所以这里的交互是「预检 → 跑流水线 → 看结果」，保底手段是快照，
 * 而不是事先确认 diff。
 */

import React from 'react'
import {
  Alert,
  Button,
  Card,
  Field,
  Modal,
  PageBody,
  PageHeader,
  Select,
  Spinner,
  TextInput
} from '../components/ui'
import { Icons } from '../components/icons'
import { useStudio } from '../state/store'
import type {
  PackManifest,
  PackPortAcceptanceItem,
  PackPortPreflightResult,
  PackPortResult,
  PackPortStep
} from '@shared/packTypes'
import type { PackPreset } from '@shared/templateFormat'

interface Props {
  pack: PackManifest
  projectRoot: string
  onBack: () => void
}

/**
 * 步骤状态的显示样式。
 *
 * `cls` 对应 CSS 的 `.badge--<cls>`（圆底徽标）—— 早先这里是裸符号 + 文字颜色，
 * 一列堆下来像乱码。
 */
const STEP_STYLE: Record<PackPortStep['status'], { mark: string; cls: string }> = {
  running: { mark: '…', cls: 'info' },
  ok: { mark: '✓', cls: 'ok' },
  warn: { mark: '!', cls: 'warn' },
  err: { mark: '✗', cls: 'err' },
  skip: { mark: '–', cls: 'info' }
}

/**
 * 把十几步归成 4 个大阶段。
 *
 * 用户的原话：「执行过程可不可以详细展示，或者至少给你分几个大的步骤、
 * 大的区间」。平铺 11 步确实看不出「现在到哪了」—— 尤其 CubeMX 那一步
 * 要跑 40 秒，夹在一堆秒级步骤中间，光看一行「执行中…」完全没概念。
 *
 * 分组之后界面能显示「阶段 2 / 4 · 正在重新生成工程（约 40 秒）」，
 * 等待就有了预期。
 */
interface StepPhase {
  id: string
  title: string
  hint: string
  /** 归属的步骤 id（和主进程 emit 的 id 对应） */
  ids: string[]
}

const STEP_PHASES: StepPhase[] = [
  {
    id: 'prepare',
    title: '准备',
    hint: '检查工程 + 存快照，不动任何文件',
    ids: ['preflight', 'snapshot']
  },
  {
    id: 'cubemx',
    title: '改硬件配置',
    hint: '改 .ioc 并调 CubeMX 重新生成（这一步最慢，通常 35~45 秒）',
    // 注意：id 必须和主进程 emit 的完全一致，大小写也算
    ids: ['ioc', 'cubemx', 'mask']
  },
  {
    id: 'code',
    title: '改代码',
    hint: '替换模块文件 + 改造业务代码',
    ids: ['files', 'transform', 'statemachine']
  },
  {
    id: 'verify',
    title: '验收',
    hint: '逐项检查改完的结果',
    ids: ['acceptance']
  }
]

/** 一个步骤属于哪个阶段（找不到就落到最后一个，避免漏显示） */
function phaseOf(stepId: string): StepPhase {
  return STEP_PHASES.find((p) => p.ids.includes(stepId)) ?? STEP_PHASES[STEP_PHASES.length - 1]
}

export function PortPackPanel({ pack, projectRoot, onBack }: Props): React.JSX.Element {
  const notify = useStudio((s) => s.notify)

  const [preflight, setPreflight] = React.useState<PackPortPreflightResult | null>(null)
  const [checking, setChecking] = React.useState(false)
  const [running, setRunning] = React.useState(false)
  const [result, setResult] = React.useState<PackPortResult | null>(null)
  const [skipCubeMx, setSkipCubeMx] = React.useState(false)
  /** 跑的过程中实时追加的步骤（同一 id 原地覆盖，见下面的订阅逻辑） */
  const [liveSteps, setLiveSteps] = React.useState<PackPortStep[]>([])
  /** 开始执行的时间戳，用来显示「已经跑了多久」 */
  const [startedAt, setStartedAt] = React.useState<number | null>(null)
  /** 二次确认弹窗 */
  const [confirmOpen, setConfirmOpen] = React.useState(false)

  /*
   * 模块包模板。
   *
   * 移植流程当前只有一个「演示模式」开关，看着简单，但模板这层先搭好：
   * 有模板就能一键切回上次那套参数，也方便把配置分享给队友。
   */
  const [presets, setPresets] = React.useState<PackPreset[]>([])
  const [activePresetId, setActivePresetId] = React.useState('')
  const [presetName, setPresetName] = React.useState('')

  /** 当前这套参数（将来加参数就往这里加） */
  const currentParams = React.useMemo(
    () => ({ skipCubeMx }) as Record<string, string | number | boolean>,
    [skipCubeMx]
  )

  const refreshPresets = React.useCallback(async (): Promise<void> => {
    try {
      setPresets(await window.api.listPackPresets(pack.id))
    } catch {
      /* 读失败就当没有模板 */
    }
  }, [pack.id])

  React.useEffect(() => {
    void refreshPresets()
  }, [refreshPresets])

  /** 套用一个模板：把里面的参数写回界面状态 */
  const applyPreset = (id: string): void => {
    setActivePresetId(id)
    if (!id) return
    const p = presets.find((x) => x.id === id)
    if (!p) return
    setSkipCubeMx(Boolean(p.params['skipCubeMx']))
  }

  /** 把当前参数存成模板 */
  const savePreset = async (): Promise<void> => {
    const name = presetName.trim() || `${pack.name} 配置`
    try {
      const list = await window.api.savePackPreset({
        id: '',
        packId: pack.id,
        name,
        note: '',
        createdAt: Date.now(),
        updatedAt: Date.now(),
        params: currentParams
      })
      setPresets(list.filter((p) => p.packId === pack.id))
      setPresetName('')
      notify('ok', `已存为模板「${name}」`)
    } catch (err) {
      notify('err', `存模板失败：${err instanceof Error ? err.message : String(err)}`)
    }
  }

  const deletePreset = async (id: string): Promise<void> => {
    try {
      const list = await window.api.deletePackPreset(id)
      setPresets(list.filter((p) => p.packId === pack.id))
      if (activePresetId === id) setActivePresetId('')
      notify('ok', '已删除模板')
    } catch (err) {
      notify('err', `删除失败：${err instanceof Error ? err.message : String(err)}`)
    }
  }

  /** 进页面先做一次预检（只读） */
  const doPreflight = React.useCallback(async (): Promise<void> => {
    setChecking(true)
    try {
      const r = await window.api.packPortPreflight(pack.id, projectRoot)
      setPreflight(r)
    } catch (err) {
      notify('err', `预检失败：${err instanceof Error ? err.message : String(err)}`)
    } finally {
      setChecking(false)
    }
  }, [pack.id, projectRoot, notify])

  React.useEffect(() => {
    void doPreflight()
  }, [doPreflight])

  /*
   * 实时进度订阅。
   *
   * 以前这里是「等 invoke 返回再一次性显示结果」——跑 CubeMX 那 40 秒里
   * 界面只有一个转圈和「执行中…」，用户完全不知道进行到哪、卡没卡。
   * 主进程现在每完成一步就推一条，这里按 step.id 覆盖同一行
   * （先 running 后 ok/err），所以列表是**原地更新**而不是越堆越长。
   */
  React.useEffect(() => {
    const off = window.api.onPortProgress(({ step }) => {
      setLiveSteps((prev) => {
        const idx = prev.findIndex((s) => s.id === step.id)
        if (idx < 0) return [...prev, step]
        const next = prev.slice()
        next[idx] = step
        return next
      })
    })
    return off
  }, [])

  const run = async (): Promise<void> => {
    setRunning(true)
    setResult(null)
    setLiveSteps([])
    // 记一下开始时间，用来在界面上显示「已经跑了多久」
    setStartedAt(Date.now())
    try {
      const r = await window.api.packPortInstall({
        packId: pack.id,
        projectRoot,
        skipCubeMx
      })
      setResult(r)
      // 保险：万一有进度事件没送到（窗口切走等），用最终结果兜底覆盖
      setLiveSteps(r.steps)
      if (r.ok) {
        notify('ok', `移植完成，${r.acceptance.filter((a) => a.ok).length} 项验收通过`)
      } else {
        notify('err', `移植未完成：${r.errors[0] ?? '未知原因'}`)
      }
      // 重新预检，反映新状态
      void doPreflight()
    } catch (err) {
      notify('err', `执行失败：${err instanceof Error ? err.message : String(err)}`)
    } finally {
      setRunning(false)
    }
  }

  const blocked = preflight ? !preflight.ok : false
  const steps = result?.steps ?? liveSteps

  /*
   * 各阶段的整体状态。
   *
   * done   ：这一段里的步骤全跑完了（允许有 skip）
   * failed ：这一段里有出错的
   * active ：有步骤正在跑，或者前面的都完了、这一段是下一个要跑的
   * pending：还没轮到
   */
  const getPhaseStatus = (
    phase: StepPhase,
    all: PackPortStep[],
    isRunning: boolean
  ): 'done' | 'failed' | 'active' | 'pending' => {
    const mine = all.filter((s) => phaseOf(s.id).id === phase.id)
    if (mine.some((s) => s.status === 'err')) return 'failed'
    if (mine.some((s) => s.status === 'running')) return 'active'
    if (mine.length > 0 && mine.every((s) => s.status === 'ok' || s.status === 'skip')) {
      return 'done'
    }
    if (!isRunning) return mine.length ? 'done' : 'pending'
    // 正在跑：第一个还没 done 的阶段就是当前阶段
    const idx = STEP_PHASES.findIndex((p) => p.id === phase.id)
    const firstUndone = STEP_PHASES.findIndex((p) => {
      const l = all.filter((s) => phaseOf(s.id).id === p.id)
      return l.length > 0 && !l.every((s) => s.status === 'ok' || s.status === 'skip')
    })
    return idx === firstUndone ? 'active' : 'pending'
  }

  /** 当前正在跑的那个阶段（用来在卡片标题上显示） */
  const currentPhase = React.useMemo(() => {
    if (!running) return null
    return (
      STEP_PHASES.find((p) => getPhaseStatus(p, steps, true) === 'active') ?? null
    )
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [running, steps])

  /**
   * 已用时间。每秒刷一次 —— 跑 CubeMX 那 40 秒里，有个跳秒的计时器
   * 比一个静止的转圈更让人安心。
   */
  const [now, setNow] = React.useState(Date.now())
  React.useEffect(() => {
    if (!running) return
    const t = setInterval(() => setNow(Date.now()), 1000)
    return () => clearInterval(t)
  }, [running])
  const elapsed = running && startedAt ? Math.floor((now - startedAt) / 1000) : null

  return (
    <>
      {/*
        按钮顺序和同级的「配置调试文件」保持一致：
          导航类（ghost）→ 刷新类（默认）→ 主操作（primary，最右）

        以前「换一个模块」和「重新预检」都是 ghost，
        而「配置调试文件」页相同位置用的是默认样式 —— 三个同级页面
        的按钮长相不一样，看着不像一套产品。
      */}
      <PageHeader
        title={pack.name}
        subtitle={pack.summary}
        actions={
          <>
            <Button size="sm" variant="ghost" onClick={onBack}>
              换一个模块
            </Button>
            <Button
              size="sm"
              disabled={checking || running}
              onClick={() => void doPreflight()}
            >
              {checking ? <Spinner /> : <Icons.refresh />}
              重新预检
            </Button>
            <Button
              size="sm"
              variant="primary"
              disabled={blocked || running}
              onClick={() => setConfirmOpen(true)}
            >
              {running ? <Spinner /> : <Icons.write />}
              {running ? '正在移植…' : '开始移植'}
            </Button>
          </>
        }
      />

      <PageBody>
        {/* ---- ① 预检 ---- */}
        <Card title="① 预检" hint="只读，还没动任何文件">
          {!preflight ? (
            <div className="small faint">{checking ? '正在检查…' : '（没有结果）'}</div>
          ) : (
            <div className="checklist">
              {preflight.items.map((it, i) => {
                const s =
                  it.level === 'err'
                    ? { mark: '✗', cls: 'err' }
                    : it.level === 'warn'
                      ? { mark: '!', cls: 'warn' }
                      : { mark: '✓', cls: 'ok' }
                return (
                  <div key={i} className="checklist__row">
                    <span className={`badge badge--${s.cls}`}>{s.mark}</span>
                    <span className="checklist__label">{it.label}</span>
                    <span className="checklist__detail checklist__detail--wrap" title={it.detail}>
                      {it.detail}
                    </span>
                  </div>
                )
              })}
            </div>
          )}
        </Card>

        {/* ---- ② 选项 ---- */}
        <Card title="② 执行选项" hint="一般不用改">
          {/* ---- 模板 ---- */}
          <div className="row" style={{ marginBottom: 12, alignItems: 'flex-end' }}>
            <div style={{ flex: '1 1 220px', minWidth: 0 }}>
              <Field label="套用模板">
                <Select
                  value={activePresetId}
                  disabled={running}
                  onChange={(e) => applyPreset(e.target.value)}
                  options={[
                    { value: '', label: presets.length ? '（不用模板，自定义）' : '（还没有模板）' },
                    ...presets.map((p) => ({ value: p.id, label: p.name }))
                  ]}
                />
              </Field>
            </div>
            <div style={{ flex: '1 1 200px', minWidth: 0 }}>
              <Field label="存为新模板">
                <TextInput
                  value={presetName}
                  disabled={running}
                  placeholder={`${pack.name} 配置`}
                  onChange={(e) => setPresetName(e.target.value)}
                  onKeyDown={(e) => {
                    if (e.key === 'Enter') void savePreset()
                  }}
                />
              </Field>
            </div>
            <Button size="sm" disabled={running} onClick={() => void savePreset()}>
              存下来
            </Button>
            {activePresetId &&
              (presets.find((p) => p.id === activePresetId)?.builtin ? (
                <Button size="sm" variant="ghost" disabled title="内置模板跟着模块包走，不能删除">
                  不可删除
                </Button>
              ) : (
                <Button
                  size="sm"
                  variant="ghost"
                  disabled={running}
                  onClick={() => void deletePreset(activePresetId)}
                >
                  删除
                </Button>
              ))}
          </div>
          <div className="small faint" style={{ marginBottom: 12 }}>
            模板只影响下面的开关，不记录工程本身的路径。想分享给队友就「存下来」，
            再到「配置 → 模板 → 模块包模板」里导出。
          </div>

          <Field label="演示模式（跳过 CubeMX）">
            <label className="row" style={{ gap: 8, cursor: 'pointer' }}>
              <input
                type="checkbox"
                checked={skipCubeMx}
                disabled={running}
                onChange={(e) => setSkipCubeMx(e.target.checked)}
              />
              <span className="small faint">
                只做代码改造，不调 CubeMX 重新生成。用于已手动配好外设、或没装 CubeMX 的机器。
              </span>
            </label>
          </Field>
          <div className="small faint" style={{ marginTop: 8 }}>
            <strong>动文件之前会自动存快照</strong>，出问题可在「系统 → 历史与恢复」里整体还原。
          </div>
        </Card>

        {/* ---- ③ 执行过程（按 4 个大阶段分组，实时更新）---- */}
        {(running || steps.length > 0) && (
          <Card
            title="③ 执行过程"
            hint={
              running
                ? `进行中${currentPhase ? ` · ${currentPhase.title}` : ''}`
                : '已完成'
            }
            actions={
              running && elapsed !== null ? (
                <span className="small faint">已用 {elapsed} 秒</span>
              ) : steps.length > 0 ? (
                <span className="small faint">
                  {steps.filter((s) => s.status === 'ok').length} / {steps.length} 步完成
                </span>
              ) : null
            }
          >
            {/*
              大阶段分组。
              用户的原话是「至少给你分几个大的步骤、大的区间」——
              十一步平铺看不出进度，尤其 CubeMX 那步要等 40 秒。
              现在每段有标题、有「等待中 / 进行中 / 已完成」的徽标，
              跑的时候一眼能看出走到哪一段了。
            */}
            <div style={{ display: 'flex', flexDirection: 'column', gap: 10 }}>
              {STEP_PHASES.map((phase, pi) => {
                const list = steps.filter((s) => phaseOf(s.id).id === phase.id)
                const phaseStatus = getPhaseStatus(phase, steps, running)
                if (list.length === 0 && phaseStatus === 'pending') return null
                return (
                  <div key={phase.id}>
                    <div
                      className="row"
                      style={{
                        gap: 8,
                        alignItems: 'center',
                        marginBottom: list.length ? 4 : 0
                      }}
                    >
                      <span
                        className={`badge badge--${
                          phaseStatus === 'done'
                            ? 'ok'
                            : phaseStatus === 'active'
                              ? 'info'
                              : phaseStatus === 'failed'
                                ? 'err'
                                : 'info'
                        }`}
                      >
                        {phaseStatus === 'done'
                          ? '✓'
                          : phaseStatus === 'active'
                            ? '…'
                            : phaseStatus === 'failed'
                              ? '✗'
                              : pi + 1}
                      </span>
                      <span className="small bold">
                        {pi + 1}. {phase.title}
                      </span>
                      <span className="faint small">
                        {phaseStatus === 'active'
                          ? phase.hint
                          : phaseStatus === 'done'
                            ? '已完成'
                            : phaseStatus === 'failed'
                              ? '出错了'
                              : '等待中'}
                      </span>
                    </div>

                    {list.length > 0 && (
                      <div className="checklist" style={{ paddingLeft: 26 }}>
                        {list.map((s) => {
                          const st = STEP_STYLE[s.status]
                          return (
                            <div key={s.id} className="checklist__row" style={{ alignItems: 'flex-start' }}>
                              <span className={`badge badge--${st.cls}`} style={{ marginTop: 1 }}>
                                {st.mark}
                              </span>
                              <div className="grow" style={{ minWidth: 0 }}>
                                <div className="small">{s.label}</div>
                                {s.detail && (
                                  <div
                                    className="faint small"
                                    style={{ whiteSpace: 'pre-wrap', marginTop: 2 }}
                                  >
                                    {s.detail}
                                  </div>
                                )}
                              </div>
                            </div>
                          )
                        })}
                      </div>
                    )}
                  </div>
                )
              })}
            </div>
          </Card>
        )}

        {/* ---- ④ 验收 ---- */}
        {result && result.acceptance.length > 0 && (
          <Card
            title="④ 验收"
            hint={`${result.acceptance.filter((a) => a.ok).length}/${result.acceptance.length} 项通过`}
          >
            <div className="checklist">
              {result.acceptance.map((a: PackPortAcceptanceItem) => (
                <div key={a.id} className="checklist__row">
                  <span className={`badge badge--${a.ok ? 'ok' : 'err'}`}>{a.ok ? '✓' : '✗'}</span>
                  <span className="checklist__label">{a.label}</span>
                  <span className="checklist__detail" title={a.detail}>
                    {a.detail}
                  </span>
                </div>
              ))}
            </div>
          </Card>
        )}

        {/* ---- ⑤ 问题 ---- */}
        {result && (result.errors.length > 0 || result.warnings.length > 0) && (
          <Card title="⑤ 需要处理">
            {result.errors.length > 0 && (
              <div style={{ marginBottom: 8 }}>
                <div className="small" style={{ color: 'var(--err)' }}>
                  错误
                </div>
                {result.errors.map((e, i) => (
                  <div key={i} className="small faint">
                    · {e}
                  </div>
                ))}
              </div>
            )}
            {result.warnings.length > 0 && (
              <div>
                <div className="small" style={{ color: 'var(--warn)' }}>
                  提醒
                </div>
                {result.warnings.map((w, i) => (
                  <div key={i} className="small faint">
                    · {w}
                  </div>
                ))}
              </div>
            )}
          </Card>
        )}

        {/* ---- ⑥ 说明 ---- */}
        {pack.manualSteps.length > 0 && (
          <Card title="⑥ 还要你手动做的" hint="工具做不到的部分">
            <div className="list">
              {pack.manualSteps.map((s, i) => (
                <div key={i} className="list__row" style={{ alignItems: 'flex-start' }}>
                  <span className="mono faint" style={{ width: 16, flex: '0 0 auto' }}>
                    {i + 1}
                  </span>
                  <div className="grow small">{s}</div>
                </div>
              ))}
            </div>
          </Card>
        )}
      </PageBody>

      {/*
        二次确认。
        用户的原话：「执行前怎么没有二次确认」。

        这个操作会**改 .ioc、调 CubeMX 重新生成、替换/改写十几个源文件**，
        是不可逆的重操作（只能靠快照还原）。点一下按钮就直接开跑，
        既没有心理准备也没法反悔。确认框把「要动哪些东西」逐条列出来。
      */}
      {confirmOpen && (
        <Modal
          title="确认开始移植？"
          onClose={() => setConfirmOpen(false)}
          footer={
            <>
              <Button onClick={() => setConfirmOpen(false)}>取消</Button>
              <Button
                variant="primary"
                onClick={() => {
                  setConfirmOpen(false)
                  void run()
                }}
              >
                确认，开始
              </Button>
            </>
          }
        >
          <div className="small" style={{ lineHeight: 1.8 }}>
            <div style={{ marginBottom: 10 }}>
              会改动 <span className="mono">{projectRoot}</span> 里的这些内容：
            </div>
            <div className="checklist">
              {[
                ['先存一份快照', '出问题可在「历史与恢复」还原'],
                ['改 .ioc 配置', skipCubeMx ? '演示模式，跳过' : '改完由 CubeMX 重新生成'],
                ['替换模块文件', '会覆盖同名文件'],
                ['改造业务代码', '按字段替换，会改到多个源文件']
              ].map(([label, detail], i) => (
                <div key={label} className="checklist__row">
                  <span className="badge badge--info">{i + 1}</span>
                  <span className="checklist__label">{label}</span>
                  <span className="checklist__detail">{detail}</span>
                </div>
              ))}
            </div>

            {skipCubeMx && (
              <div style={{ marginTop: 12 }}>
                <Alert kind="warn">当前勾了「演示模式」：不会动 .ioc，也不调 CubeMX。</Alert>
              </div>
            )}

            <div className="faint small" style={{ marginTop: 12 }}>
              {skipCubeMx ? '预计 5 秒内完成。' : 'CubeMX 那一步通常要 35~45 秒，中间别关窗口。'}
            </div>
          </div>
        </Modal>
      )}
    </>
  )
}