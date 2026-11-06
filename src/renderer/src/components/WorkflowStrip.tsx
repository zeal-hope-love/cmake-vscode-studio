/**
 * 工程总览页顶部的两步引导条。
 *
 * 为什么只有两步：检测是**自动**完成的，用户并没有做「核对检测结果」这个动作，
 * 把它算作一步只会让人以为自己漏了什么。真正由用户决定的是两件事：
 * 选哪个工程、要不要写进去。
 *
 * 「预览 / 写入配置」就长在第二步里面 —— 它们本来就是这个流程的收尾动作。
 */

import React from 'react'
import { useProjectWritten, useStudio } from '../state/store'
import { Button, Checkbox, Spinner } from './ui'
import { Icons } from './icons'
import { probeByKey } from '@shared/probes'
import { DEBUG_TARGET_OPTIONS, DEFAULT_DEBUG_TARGETS } from '@shared/debugTargets'
import type { DebugTargetKey } from '@shared/types'

/**
 * 下拉里「自定义」那一项的 value。
 *
 * 用一个不可能撞上模板 id 的串 —— 模板 id 要么是 `builtin:` 前缀，要么是 uuid。
 * 不能用空串：空串已经是「默认（按检测结果生成）」了。
 */
const CUSTOM_TARGETS_VALUE = '__custom_debug_targets__'

export function WorkflowStrip(): React.JSX.Element {
  const project = useStudio((s) => s.project)
  const bundle = useStudio((s) => s.bundle)
  const options = useStudio((s) => s.options)
  const activeTemplate = useStudio((s) => s.activeTemplate)
  const templates = useStudio((s) => s.templates)
  const switchTemplate = useStudio((s) => s.switchTemplate)
  const setPickerOpen = useStudio((s) => s.setPickerOpen)
  const busy = useStudio((s) => s.busy)
  const openPreview = useStudio((s) => s.openPreview)
  const setPage = useStudio((s) => s.setPage)
  const setDebugTargets = useStudio((s) => s.setDebugTargets)
  const written = useProjectWritten()

  /** 「自定义调试器组合」窗格是否展开 */
  const [targetsOpen, setTargetsOpen] = React.useState(false)

  const probe = options ? probeByKey(options.probeKey) : null
  const debugTargets: DebugTargetKey[] = options?.debugTargets ?? DEFAULT_DEBUG_TARGETS

  /** 勾选/取消一个调试器。至少留一条 —— 空列表生成出来没有可调试项 */
  const toggleTarget = (key: DebugTargetKey, on: boolean): void => {
    setDebugTargets(on ? [...debugTargets, key] : debugTargets.filter((k) => k !== key))
  }

  /** 下拉切换：可能是模板，也可能是「自定义」 */
  const onPickTemplate = (value: string): void => {
    if (value === CUSTOM_TARGETS_VALUE) {
      setTargetsOpen(true)
      return
    }
    setTargetsOpen(false)
    void switchTemplate(value)
  }

  /** 回到第一步：把选择器展开、滚到「选择工程」卡片并聚焦输入框 */
  const backToPickProject = (): void => {
    setPickerOpen(true)
    const card = document.getElementById('select-project-card')
    card?.scrollIntoView({ behavior: 'smooth', block: 'center' })
    window.setTimeout(() => {
      card?.querySelector<HTMLInputElement>('input')?.focus()
    }, 340)
  }

  const steps = [
    {
      title: '选择工程',
      desc: project ? project.name : '点下面的「浏览…」，或从列表里选一个',
      done: Boolean(project),
      onClick: project ? backToPickProject : null,
      clickTitle: '回到上一步：重新选工程',
      action: null as React.ReactNode
    },
    {
      title: '写入 .vscode 配置',
      desc: !project
        ? '先选一个工程'
        : written
          ? '内容已是最新，去 VSCode 里按 F5 试试'
          : '会先给你看差异，确认后才落盘',
      done: written,
      onClick: null,
      clickTitle: '',
      action: project ? (
        <>
          {!written && (
            <button type="button" className="linkbtn" onClick={backToPickProject}>
              ← 上一步
            </button>
          )}
          <Button size="sm" onClick={() => void openPreview()} disabled={!bundle || busy}>
            <Icons.eye />
            预览
          </Button>
          <Button
            size="sm"
            variant="primary"
            onClick={() => void openPreview()}
            disabled={!bundle || busy}
          >
            {busy ? <Spinner /> : <Icons.write />}
            写入配置
          </Button>
        </>
      ) : null
    }
  ]

  const activeIndex = steps.findIndex((s) => !s.done)

  return (
    <div className="workflow">
      <div className="steps">
        {steps.map((step, i) => {
          const cls = step.done
            ? 'steps__item steps__item--done'
            : i === activeIndex
              ? 'steps__item steps__item--active'
              : 'steps__item'
          const clickable = Boolean(step.onClick)
          return (
            <div
              key={step.title}
              className={clickable ? `${cls} steps__item--clickable` : cls}
              onClick={step.onClick ?? undefined}
              role={clickable ? 'button' : undefined}
              tabIndex={clickable ? 0 : undefined}
              title={clickable ? step.clickTitle : undefined}
              onKeyDown={
                clickable
                  ? (e) => {
                      if (e.key === 'Enter' || e.key === ' ') {
                        e.preventDefault()
                        step.onClick?.()
                      }
                    }
                  : undefined
              }
            >
              <span className="steps__num">{step.done ? '✓' : i + 1}</span>
              <div className="steps__text">
                <div className="steps__title">{step.title}</div>
                <div className="steps__desc truncate" title={step.desc}>
                  {step.desc}
                </div>
              </div>
              {step.action && <div className="steps__actions">{step.action}</div>}
            </div>
          )
        })}
      </div>

      {/* 生成的是什么配置 —— 探针和模板都写清楚，免得写完了才发现不对 */}
      {project && probe && (
        <>
          {/*
            分两行放，别挤成一行。

            原来「按 [探针徽标] 生成 4 个配置文件 · openocd-xxx.cfg
            · 生成参数 [下拉框] 管理模板」全在一行 —— 中等宽度的窗口下
            必然叠着（用户截图里「CMSIS-DAP / DAP-Link」和「配置文件」是重合的），
            因为这一行有 7 个元素、其中一个还是长文件名。
          */}
          <div className="workflow__probe">
            <span className="faint small">按</span>
            <span className="badge badge--accent">{probe.label}</span>
            <span className="faint small">生成 4 个配置文件</span>
            {bundle?.openocdCfg && (
              <span
                className="mono small faint workflow__cfgname"
                title={bundle.openocdCfg.fileName}
              >
                · {bundle.openocdCfg.fileName}
              </span>
            )}
          </div>

          {/*
            模板选择单独一行：它是「决定怎么写」的选项，
            和上面「写出来是什么」是两件事，混在一起反而看不明白。
          */}
          <div className="workflow__probe workflow__probe--options">
            <span className="faint small">用哪套生成参数</span>
            <select
              className="select workflow__template"
              aria-label="生成参数来源（模板）"
              value={targetsOpen ? CUSTOM_TARGETS_VALUE : (activeTemplate?.id ?? '')}
              onChange={(e) => onPickTemplate(e.target.value)}
              title="选「默认」= 按本工程的检测结果生成；选模板 = 用模板里的选择"
            >
              <option value="">默认：按本工程的检测结果生成</option>
              {templates.map((t) => (
                <option key={t.id} value={t.id}>
                  {t.builtin ? `${t.name}（内置样板）` : t.name}
                </option>
              ))}
              <option value={CUSTOM_TARGETS_VALUE}>
                自定义：自己勾选生成哪几条调试配置…
              </option>
            </select>
            <button type="button" className="linkbtn" onClick={() => setPage('templates')}>
              管理模板
            </button>
          </div>

          {/*
            自定义调试器组合的窗格。

            为什么不塞进模板里：模板是「一份可命名、可保存、可复制的快照」，
            而这里勾的是**一个设置**（写进 settings.json，换工程也还在）。
            两者正交 —— 选模板换的是探针/速度，勾这里换的是 launch.json 里放几条。
          */}
          {targetsOpen && (
            <div
              style={{
                marginTop: 8,
                padding: '10px 12px',
                border: '1px solid var(--border)',
                borderRadius: 8,
                background: 'var(--panel)'
              }}
            >
              <div className="faint small" style={{ marginBottom: 8, lineHeight: 1.7 }}>
                这几条会<b>同时</b>写进 <span className="mono">launch.json</span>，
                在 VSCode「运行和调试」下拉里各占一项 —— 插哪个探针就选哪条，不用改文件。
                选择会记住，换工程也还在。
              </div>

              <div style={{ display: 'grid', gap: 6 }}>
                {DEBUG_TARGET_OPTIONS.map((opt) => (
                  <Checkbox
                    key={opt.key}
                    checked={debugTargets.includes(opt.key)}
                    onChange={(on) => toggleTarget(opt.key, on)}
                    label={
                      <span className="small">
                        <b>{opt.label}</b>
                        <br />
                        <span style={{ opacity: 0.72 }}>{opt.hint}</span>
                      </span>
                    }
                  />
                ))}
              </div>

              <div
                className="faint small"
                style={{ marginTop: 8, display: 'flex', alignItems: 'center', gap: 8 }}
              >
                <span style={{ flex: 1 }}>
                  至少留一条 —— 一条都不勾会退回到「当前探针」，否则没有可调试项。
                </span>
                <Button size="sm" onClick={() => setTargetsOpen(false)}>
                  收起
                </Button>
              </div>
            </div>
          )}
        </>
      )}
    </div>
  )
}
