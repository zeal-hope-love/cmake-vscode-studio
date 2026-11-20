/**
 * 标题栏上的更新芯片（窗口按钮左边那一个小块）+ 点开后的快捷面板。
 *
 * ## 为什么放在标题栏
 *
 * 用户明确要求「有更新就在最小化/最大化/关闭旁边放个快捷视图」——
 * 那里是窗口上**唯一永远可见**的角落：不管当前在哪个页面、页面滚到哪，
 * 抬眼就能看见，而且不会像页面顶部的横幅那样被用户关掉后再也不出现。
 *
 * ## 只有一个入口
 *
 * 芯片本身是状态（进度 / 可重启），点开是动作（下载、取消、重启安装、看详情）。
 * 下载全自动，所以大多数时候用户只需要在两个时刻看它一眼：
 * 下载中（知道要等多久）、下载完（点一下重启）。
 *
 * ## 快捷面板不做成 Modal
 *
 * 它是「顺便看一眼」的东西，不该挡住整块工作区。用绝对定位的小卡片，
 * 点外面 / 按 Esc 就收掉。
 */

import React from 'react'
import { useStudio } from '../state/store'
import { Button, Spinner } from './ui'
import { Icons } from './icons'
import type { UpdateState } from '@shared/updateTypes'

/** 字节 → 可读 MB */
function mb(n: number): string {
  return (n / 1024 / 1024).toFixed(1)
}

/** 芯片上那行字：一眼能看出「在下载」还是「可以重启了」 */
function chipLabel(state: UpdateState): string {
  const v = state.info?.latestVersion ?? ''
  switch (state.phase) {
    case 'downloading': {
      const p = state.progress
      return p && p.percent >= 0 ? `更新 ${p.percent}%` : '正在下载更新'
    }
    case 'ready':
      return '重启更新'
    case 'available':
      return v ? `v${v} 可用` : '有新版本'
    case 'error':
      return '更新失败'
    case 'checking':
      return '检查更新中'
    default:
      return v ? `v${v} 可用` : '有新版本'
  }
}

export function UpdateChip(): React.JSX.Element | null {
  const state = useStudio((s) => s.updateState)
  const dismissed = useStudio((s) => s.updateDismissedVersion)
  const installUpdate = useStudio((s) => s.installUpdate)
  const downloadUpdateNow = useStudio((s) => s.downloadUpdateNow)
  const cancelUpdateDownload = useStudio((s) => s.cancelUpdateDownload)
  const checkUpdateNow = useStudio((s) => s.checkUpdateNow)
  const dismissUpdate = useStudio((s) => s.dismissUpdate)
  const focusUpdate = useStudio((s) => s.focusUpdate)

  const [open, setOpen] = React.useState(false)
  const boxRef = React.useRef<HTMLDivElement>(null)

  // 点外面 / Esc 收起 —— 不装全局监听，只在打开时挂
  React.useEffect(() => {
    if (!open) return
    const onDown = (e: MouseEvent): void => {
      if (!boxRef.current?.contains(e.target as Node)) setOpen(false)
    }
    const onKey = (e: KeyboardEvent): void => {
      if (e.key === 'Escape') setOpen(false)
    }
    window.addEventListener('mousedown', onDown)
    window.addEventListener('keydown', onKey)
    return () => {
      window.removeEventListener('mousedown', onDown)
      window.removeEventListener('keydown', onKey)
    }
  }, [open])

  // 没查到更新就整块不渲染：标题栏保持干净，不占位
  if (!state?.info?.hasUpdate) return null
  // 用户对「这一版」说过稍后
  if (dismissed && dismissed === state.info.latestVersion) return null

  const info = state.info
  const downloading = state.phase === 'downloading'
  const ready = state.phase === 'ready'
  const progress = state.progress
  const percent = progress && progress.percent >= 0 ? progress.percent : null

  return (
    <div className="update-chip-wrap" ref={boxRef}>
      <button
        type="button"
        className={
          'update-chip' +
          (downloading ? ' update-chip--busy' : '') +
          (ready ? ' update-chip--ready' : '') +
          (state.phase === 'error' ? ' update-chip--err' : '')
        }
        onClick={() => setOpen((v) => !v)}
        title={
          ready
            ? `v${state.readyVersion ?? info.latestVersion} 已下载完成，点这里重启更新`
            : downloading
              ? '正在后台下载更新，点开看进度'
              : `发现新版本 v${info.latestVersion}（当前 v${info.currentVersion}），点开看详情`
        }
        aria-expanded={open}
      >
        <span className="update-chip__icon">
          {downloading ? <Spinner /> : ready ? <Icons.download /> : <Icons.arrowUp />}
        </span>
        <span className="update-chip__text">{chipLabel(state)}</span>
        {/*
          进度就是芯片底色本身：左边一段按百分比铺深色，右边留浅色。
          不画细条 —— 24px 高的药丸里 2px 的条太细，看不出还剩多少。
        */}
        {downloading && (
          <span
            className={'update-chip__fill' + (percent === null ? ' update-chip__fill--indet' : '')}
            style={percent !== null ? { width: `${percent}%` } : undefined}
            aria-hidden
          />
        )}
      </button>

      {open && (
        <div className="update-pop" role="dialog" aria-label="版本更新">
          <div className="update-pop__head">
            <div>
              <div className="update-pop__title">
                {ready ? '更新已就绪' : `新版本 v${info.latestVersion}`}
              </div>
              <div className="faint small">
                当前 v{info.currentVersion}
                {info.publishedAt && ` · 发布于 ${info.publishedAt.slice(0, 10)}`}
              </div>
            </div>
            <button
              type="button"
              className="update-pop__close"
              onClick={() => setOpen(false)}
              title="收起"
            >
              ✕
            </button>
          </div>

          {/* ---- 状态区 ---- */}
          {downloading && (
            <div className="update-pop__block">
              <div className="row" style={{ justifyContent: 'space-between', marginBottom: 6 }}>
                <span className="small">
                  正在后台下载
                  {progress && progress.total > 0 && (
                    <span className="faint">
                      {' '}
                      {mb(progress.received)} / {mb(progress.total)} MB
                    </span>
                  )}
                  {progress && progress.speed > 0 && (
                    <span className="faint"> · {mb(progress.speed)} MB/s</span>
                  )}
                </span>
                <span className="faint small">{percent !== null ? `${percent}%` : '…'}</span>
              </div>
              <div className="update-pop__bar">
                <span
                  style={{
                    width: percent !== null ? `${percent}%` : '35%',
                    ...(percent === null
                      ? { animation: 'cv-progress-slide 1.2s ease-in-out infinite' }
                      : {})
                  }}
                />
              </div>
            </div>
          )}

          {ready && (
            <div className="update-pop__block">
              <div className="small">
                ✓ 安装包已下载完成
                {state.readyVersion ? `（v${state.readyVersion}）` : ''}
              </div>
              <div className="faint small" style={{ marginTop: 4 }}>
                {state.canInstall
                  ? '点「重启更新」会启动安装程序并关闭当前窗口，装完自动是新版本。'
                  : '这是免安装版，需要你手动替换 exe —— 点「打开所在文件夹」拿文件。'}
              </div>
            </div>
          )}

          {state.phase === 'error' && (
            <div className="update-pop__block small" style={{ color: 'var(--err)' }}>
              更新没成功：{state.error ?? '未知原因'}
            </div>
          )}

          {state.phase === 'available' && (
            <div className="update-pop__block faint small">
              还没下载。点「下载更新包」开始（设置里可以打开「自动下载」）。
            </div>
          )}

          {/* ---- 动作 ---- */}
          <div className="update-pop__actions">
            {ready && state.canInstall && (
              <Button size="sm" variant="primary" onClick={() => void installUpdate()}>
                重启更新
              </Button>
            )}
            {ready && !state.canInstall && (
              <Button
                size="sm"
                variant="primary"
                onClick={() => {
                  const dir = (state.filePath ?? '').replace(/[\\/][^\\/]+$/, '')
                  if (dir) void window.api.openExternal('file:///' + dir.replace(/\\/g, '/'))
                }}
              >
                打开所在文件夹
              </Button>
            )}
            {downloading && (
              <Button size="sm" variant="ghost" onClick={() => void cancelUpdateDownload()}>
                取消下载
              </Button>
            )}
            {(state.phase === 'available' || state.phase === 'error') && (
              <Button size="sm" variant="primary" onClick={() => void downloadUpdateNow()}>
                {state.phase === 'error' ? '重试下载' : '下载更新包'}
              </Button>
            )}
            {state.phase === 'error' && (
              <Button size="sm" variant="ghost" onClick={() => void checkUpdateNow(true)}>
                重新检查
              </Button>
            )}
            <div className="spacer" />
            <Button
              size="sm"
              variant="ghost"
              onClick={() => {
                setOpen(false)
                focusUpdate()
              }}
              title="到「设置 → 版本更新」里看完整信息"
            >
              详情
            </Button>
          </div>

          {info.notes && (
            <details className="update-pop__notes">
              <summary className="small faint">更新内容</summary>
              <pre>{info.notes}</pre>
            </details>
          )}

          <div className="update-pop__foot">
            <button type="button" className="linkbtn" onClick={() => dismissUpdate()}>
              这一版先不提醒
            </button>
            {info.releaseUrl && (
              <button
                type="button"
                className="linkbtn"
                onClick={() => void window.api.openExternal(info.releaseUrl)}
              >
                在浏览器打开发布页
              </button>
            )}
          </div>
        </div>
      )}
    </div>
  )
}
