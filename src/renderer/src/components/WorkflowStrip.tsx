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
import { Button, Spinner } from './ui'
import { Icons } from './icons'
import { probeByKey } from '@shared/probes'
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
  const written = useProjectWritten()

  const probe = options ? probeByKey(options.probeKey) : null

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
              value={activeTemplate?.id ?? ''}
              onChange={(e) => void switchTemplate(e.target.value)}
              title="选「默认」= 按本工程的检测结果生成；选模板 = 用模板里的选择"
            >
              <option value="">默认：按本工程的检测结果生成</option>
              {templates.map((t) => (
                <option key={t.id} value={t.id}>
                  {t.builtin ? `${t.name}（内置样板）` : t.name}
                </option>
              ))}
            </select>
            <button type="button" className="linkbtn" onClick={() => setPage('templates')}>
              管理模板
            </button>
          </div>
        </>
      )}
    </div>
  )
}
