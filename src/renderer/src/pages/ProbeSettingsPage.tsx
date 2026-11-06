/**
 * 配置 · 探针与芯片（生成参数）
 *
 * 这一页原来挤在「工具与路径」里，叫「调试探针与目标」。但那些字段和「工具装在
 * 哪」毫无关系 —— 它们决定的是**生成出来的 launch.json / settings.json /
 * openocd-*.cfg 长什么样**：
 *
 *   探针      → servertype、是否需要接线配置文件
 *   device    → launch.json 的 device
 *   target    → 接线配置里 source 的 target/*.cfg
 *   适配器速度 → openocd cfg 的 adapter speed
 *   SVD       → 外设寄存器视图
 *   Live Watch→ 不停机看全局变量
 *
 * 所以它属于「配置」，不属于「工具链」，独立成一页放在配置组下。
 */

import React from 'react'
import { useStudio } from '../state/store'
import { probeByKey, PROBE_OPTIONS } from '@shared/probes'
import { mapOpenocdTarget, openocdCfgFileName, targetCfgOptions } from '@shared/chipTargets'
import { Alert, Button, Card, Checkbox, Field, Kv, PageBody, PageHeader, Select, TextInput } from '../components/ui'
import { NoProject } from '../components/NoProject'

export default function ProbeSettingsPage(): React.JSX.Element {
  const project = useStudio((s) => s.project)
  const options = useStudio((s) => s.options)
  const bundle = useStudio((s) => s.bundle)
  const patchOptions = useStudio((s) => s.patchOptions)
  const notify = useStudio((s) => s.notify)

  /** 探针一换，接线配置文件名、interface、reset 都会跟着变 */
  const onProbeChange = (key: string): void => {
    if (!options) return
    const probe = probeByKey(key)
    const prev = probeByKey(options.probeKey)
    const target = options.targetCfg

    const prevFile = prev.needsOpenocdCfg && target ? openocdCfgFileName(target, prev.key) : null
    const nextFile = probe.needsOpenocdCfg && target ? openocdCfgFileName(target, probe.key) : null

    patchOptions({
      probeKey: probe.key,
      interfaceCfg: probe.interfaceCfg,
      resetConfig: probe.resetConfig
    })
    void window.api.saveSettings({ probeKey: probe.key })

    let text = `已切换到 ${probe.label}，配置已按新探针重新生成`
    if (!probe.needsOpenocdCfg) {
      text = `已切换到 ${probe.label}：该探针由 cortex-debug 直接驱动，不再生成 ${
        prevFile ?? 'openocd-*.cfg'
      }，配置已重新生成`
    } else if (prevFile && nextFile && prevFile !== nextFile) {
      text = `已切换到 ${probe.label}：接线配置文件名从 ${prevFile} 变为 ${nextFile}，配置已重新生成`
    }
    notify('ok', text)
  }

  const targetOptions = React.useMemo(() => {
    const list: Array<{ value: string; label: string }> = [
      { value: '', label: '（不设置 target 配置）' },
      ...targetCfgOptions()
    ]
    const current = options?.targetCfg ?? ''
    if (current && !list.some((o) => o.value === current)) {
      list.unshift({ value: current, label: `${current}（当前值）` })
    }
    return list
  }, [options?.targetCfg])

  const suggestedTarget = mapOpenocdTarget(project?.device)

  if (!project || !options) {
    return (
      <>
        <PageHeader
          title="探针与芯片"
          subtitle="决定生成的 launch.json / settings.json / openocd-*.cfg 长什么样"
        />
        <PageBody>
          <NoProject />
        </PageBody>
      </>
    )
  }

  const probe = probeByKey(options.probeKey)

  return (
    <>
      <PageHeader
        title="探针与芯片"
        subtitle="这里改的是「生成参数」—— 它们决定写入 .vscode 的调试配置内容"
      />
      <PageBody>
        <Card title="调试探针与目标" hint="改这里会立刻重新生成 launch.json / tasks.json / openocd-*.cfg">
          <div className="grid grid--2">
            <div>
              <Field label="调试探针" hint="决定 launch.json 的 servertype，以及是否需要 OpenOCD 接线配置">
                <Select
                  value={options.probeKey}
                  options={PROBE_OPTIONS.map((p) => ({ value: p.key, label: p.label }))}
                  onChange={(e) => onProbeChange(e.target.value)}
                />
              </Field>

              <Field label="OpenOCD target 配置" hint="接线配置里 source 的 target/*.cfg；选错会连不上芯片">
                <Select
                  value={options.targetCfg}
                  options={targetOptions}
                  onChange={(e) => patchOptions({ targetCfg: e.target.value })}
                />
              </Field>

              {suggestedTarget && suggestedTarget !== options.targetCfg && (
                <div className="flex mb-12">
                  <span className="small muted">
                    芯片 <span className="mono accent">{project.device}</span> 通常用{' '}
                    <span className="mono accent">{suggestedTarget}</span>
                  </span>
                  <Button size="sm" onClick={() => patchOptions({ targetCfg: suggestedTarget })}>
                    用建议值
                  </Button>
                </div>
              )}

              <Field
                label="自定义 target 配置"
                hint="直接填文件名，例如 stm32f4x.cfg（可与上面的下拉互相对照）"
              >
                <TextInput
                  mono
                  value={options.targetCfg}
                  placeholder="stm32f1x.cfg"
                  onChange={(e) => patchOptions({ targetCfg: e.target.value })}
                />
              </Field>
            </div>

            <div>
              <Field
                label="cortex-debug device"
                hint="写进 launch.json 的 device 字段；留空则用工程里识别到的芯片型号"
              >
                <TextInput
                  mono
                  value={options.device}
                  placeholder={project.device ?? '例如 STM32F103C8'}
                  onChange={(e) => patchOptions({ device: e.target.value })}
                />
              </Field>

              <Field
                label="适配器速度（kHz）"
                hint="写进 openocd-*.cfg 的 adapter speed；J-Link 原生探针用作 -speed"
              >
                <TextInput
                  type="number"
                  value={String(options.adapterSpeed)}
                  onChange={(e) => patchOptions({ adapterSpeed: Number(e.target.value) || 0 })}
                  onBlur={(e) =>
                    void window.api.saveSettings({ adapterSpeed: Number(e.target.value) || 0 })
                  }
                />
              </Field>

              {/*
                Live Watch —— 不停机看全局变量（类似 Keil 的 Live Watch）。
                cortex-debug 1.12 起提供，只对 openocd / stlink / jlink 生效，PyOCD 不支持；
                官方标注「实验性」，且只测过 SWD。
              */}
              <Field
                label="Live Watch（不停机看全局变量）"
                hint="写进 launch.json 的 liveWatch，以及 settings.json 的 cortex-debug.liveWatchRefreshRate"
              >
                <div
                  style={{
                    display: 'flex',
                    flexDirection: 'column',
                    gap: 8,
                    padding: '8px 10px',
                    border: '1px solid var(--border)',
                    borderRadius: 6
                  }}
                >
                  <Checkbox
                    checked={Boolean(options.liveWatch)}
                    onChange={(on) => {
                      patchOptions({ liveWatch: on })
                      void window.api.saveSettings({ liveWatch: on })
                    }}
                    label={
                      options.liveWatch
                        ? '已启用 —— F5 起来后在 Live Watch 面板里「Add to Live Watch」加变量'
                        : '未启用'
                    }
                  />

                  {options.liveWatch && (
                    <div className="row" style={{ alignItems: 'flex-end' }}>
                      <div style={{ width: 150 }}>
                        <Field label="采样率（次/秒）" hint="0~20，默认 4">
                          <TextInput
                            type="number"
                            min={0}
                            max={20}
                            value={String(options.liveWatchSamplesPerSecond)}
                            onChange={(e) => {
                              const v = Math.max(0, Math.min(20, Number(e.target.value) || 0))
                              patchOptions({ liveWatchSamplesPerSecond: v })
                              void window.api.saveSettings({ liveWatchSamplesPerSecond: v })
                            }}
                          />
                        </Field>
                      </div>
                      <div style={{ width: 170 }}>
                        <Field label="面板刷新（毫秒）" hint="默认 300，别低于 250">
                          <TextInput
                            type="number"
                            min={100}
                            max={5000}
                            value={String(options.liveWatchRefreshRate)}
                            onChange={(e) => {
                              const v = Math.max(100, Math.min(5000, Number(e.target.value) || 300))
                              patchOptions({ liveWatchRefreshRate: v })
                              void window.api.saveSettings({ liveWatchRefreshRate: v })
                            }}
                          />
                        </Field>
                      </div>
                    </div>
                  )}

                  <div className="faint small" style={{ lineHeight: 1.7 }}>
                    {!['openocd', 'stlink', 'jlink'].includes(probe.servertype)
                      ? `当前探针（${probe.label}）用的是 ${probe.servertype}，cortex-debug 的 Live Watch 不支持它 —— 打开也不会生效。`
                      : '注意：只能看**全局变量和静态变量**（cortex-debug 靠 nm/objdump 读符号表，栈上的局部变量看不到，会显示 not available）。'}
                    <br />
                    采样率和面板刷新是两回事：采样快但刷新慢，看起来就是「值跳着变」，这是正常的。
                  </div>
                </div>
              </Field>
            </div>
          </div>

          <div style={{ marginTop: 16 }}>
            <Kv
              items={[
                [
                  '接线配置文件名',
                  bundle?.openocdCfg ? (
                    <span className="mono accent">{bundle.openocdCfg.fileName}</span>
                  ) : (
                    <span className="faint">（该探针不需要 OpenOCD 接线配置）</span>
                  )
                ],
                [
                  'SVD 文件',
                  options.svdFile ? (
                    <span className="mono">{options.svdFile}</span>
                  ) : (
                    <span className="faint">未设置（外设寄存器视图不可用）</span>
                  )
                ]
              ]}
            />
          </div>
        </Card>

        <Alert kind="info">
          这些参数会写进 <span className="mono">.vscode/</span> 下的配置文件。改完记得回「配置调试文件」点
          <b> 写入配置 </b>才会真正落盘。
        </Alert>
      </PageBody>
    </>
  )
}