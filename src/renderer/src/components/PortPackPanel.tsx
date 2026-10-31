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
  Button,
  Card,
  Field,
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

export function PortPackPanel({ pack, projectRoot, onBack }: Props): React.JSX.Element {
  const notify = useStudio((s) => s.notify)

  const [preflight, setPreflight] = React.useState<PackPortPreflightResult | null>(null)
  const [checking, setChecking] = React.useState(false)
  const [running, setRunning] = React.useState(false)
  const [result, setResult] = React.useState<PackPortResult | null>(null)
  const [skipCubeMx, setSkipCubeMx] = React.useState(false)
  /** 跑的过程中实时追加的步骤 */
  const [liveSteps, setLiveSteps] = React.useState<PackPortStep[]>([])

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

  const run = async (): Promise<void> => {
    setRunning(true)
    setResult(null)
    setLiveSteps([])
    try {
      // 主进程一次性跑完整个流水线，中途没法回调进度
      // （IPC invoke 是单次往返）。所以这里先显示「正在执行」。
      const r = await window.api.packPortInstall({
        packId: pack.id,
        projectRoot,
        skipCubeMx
      })
      setResult(r)
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

  return (
    <>
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
              variant="ghost"
              disabled={checking || running}
              onClick={() => void doPreflight()}
            >
              {checking ? <Spinner /> : <Icons.refresh />}
              重新预检
            </Button>
            <Button size="sm" variant="primary" disabled={blocked || running} onClick={() => void run()}>
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

        {/* ---- ③ 执行过程 ---- */}
        {(running || steps.length > 0) && (
          <Card
            title="③ 执行过程"
            hint={running ? '正在跑，CubeMX 那一步约 40 秒' : '已完成'}
          >
            <div className="checklist">
              {steps.map((s, i) => {
                const st = STEP_STYLE[s.status]
                return (
                  <div key={`${s.id}-${i}`} className="checklist__row" style={{ alignItems: 'flex-start' }}>
                    <span
                      className={`badge badge--${st.cls}`}
                      style={{ marginTop: 1 }}
                    >
                      {st.mark}
                    </span>
                    <div className="grow" style={{ minWidth: 0 }}>
                      <div className="small">{s.label}</div>
                      {s.detail && (
                        <div className="faint small" style={{ whiteSpace: 'pre-wrap', marginTop: 2 }}>
                          {s.detail}
                        </div>
                      )}
                    </div>
                  </div>
                )
              })}
              {running && (
                <div className="checklist__row">
                  <span className="badge badge--info">
                    <Spinner />
                  </span>
                  <div className="grow small faint">执行中…</div>
                </div>
              )}
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
    </>
  )
}