/**
 * 更新提示。
 *
 * 两种形态：
 *   · **横幅**（`compact`）——挂在页面顶部，只在真有新版本时出现，可关掉
 *   · **完整卡片** —— 用在「关于」页，任何状态都显示（含「已是最新」「检查失败」）
 *
 * 设计上的两个取舍：
 *
 * 1. **只在有新版本时打扰人**。没有更新就什么都不显示，别在界面上占位置。
 *
 * 2. **不做自动下载安装**。那需要 electron-updater + 代码签名证书，
 *    而且这个工具的安装包 140 MB，后台偷偷下载不合适。
 *    这里只「提示 + 打开下载页」，用户自己决定什么时候装。
 */

import React from 'react'
import { Button, Card, Spinner } from './ui'
import { Icons } from './icons'
import type { UpdateInfo } from '@shared/updateTypes'

/** 把 1024 字节换算成 M */
function fmtSize(bytes: number): string {
  if (!bytes) return ''
  return (bytes / 1024 / 1024).toFixed(0) + ' MB'
}

/** 把 ISO 时间转成人话 */
function fmtDate(iso: string): string {
  if (!iso) return ''
  try {
    return new Date(iso).toLocaleString('zh-CN', {
      year: 'numeric',
      month: '2-digit',
      day: '2-digit'
    })
  } catch {
    return iso
  }
}

interface Props {
  info: UpdateInfo | null
  /** 正在检查 */
  checking: boolean
  /** 点「检查更新」 */
  onCheck: () => void
  /** 关掉横幅（只对 compact 有效） */
  onDismiss?: () => void
  /** 横幅形态 */
  compact?: boolean
  /** 当前「启动时自动检查」开关状态（只有完整卡片用） */
  autoCheck?: boolean
  /** 切换自动检查 */
  onToggleAutoCheck?: (enabled: boolean) => void
}

export function UpdateNotice({
  info,
  checking,
  onCheck,
  onDismiss,
  compact = false,
  autoCheck = true,
  onToggleAutoCheck
}: Props): React.JSX.Element | null {
  const open = (url: string): void => {
    if (url) void window.api.openExternal(url)
  }

  // ---- 横幅：只在有更新时出现 ----
  if (compact) {
    if (!info?.hasUpdate) return null
    return (
      <div
        className="card"
        style={{
          display: 'flex',
          alignItems: 'center',
          gap: 12,
          padding: '10px 14px',
          marginBottom: 14,
          borderColor: 'var(--accent)',
          background: 'var(--accent-soft)'
        }}
      >
        <span style={{ flex: 0, color: 'var(--accent)', fontWeight: 600 }}>↑</span>
        <div style={{ flex: 1, minWidth: 0 }}>
          <span style={{ fontWeight: 600 }}>有新版本 v{info.latestVersion}</span>
          <span className="faint small" style={{ marginLeft: 8 }}>
            当前 v{info.currentVersion}
          </span>
        </div>
        <Button size="sm" onClick={() => open(info.releaseUrl)}>
          查看更新
        </Button>
        {onDismiss && (
          <Button size="sm" variant="ghost" onClick={onDismiss} title="本次启动不再提示">
            ✕
          </Button>
        )}
      </div>
    )
  }

  // ---- 完整卡片 ----
  const status = checking ? 'checking' : (info?.status ?? 'idle')

  return (
    <Card
      title="版本更新"
      hint="从 GitHub Releases 读取最新版本"
      actions={
        <Button size="sm" variant="ghost" onClick={onCheck} disabled={checking}>
          {checking ? <Spinner /> : <Icons.refresh />}
          {checking ? '检查中…' : '检查更新'}
        </Button>
      }
    >
      {status === 'checking' && (
        <div className="small faint">正在连接 GitHub…</div>
      )}

      {status === 'disabled' && (
        <div className="small faint">
          自动检查已关闭。点右上角「检查更新」可以手动查一次。
        </div>
      )}

      {status === 'error' && (
        <div className="small" style={{ lineHeight: 1.8 }}>
          <div style={{ color: 'var(--warn)' }}>检查失败：{info?.detail ?? '未知原因'}</div>
          <div className="faint" style={{ marginTop: 6 }}>
            可能是网络问题。不影响使用 —— 想看最新版可以直接去{' '}
            <button
              type="button"
              className="linkbtn"
              onClick={() =>
                open('https://github.com/zeal-hope-love/cmake-vscode-studio/releases')
              }
            >
              GitHub Releases
            </button>
            。
          </div>
        </div>
      )}

      {status === 'ok' && info && !info.hasUpdate && (
        <div className="small" style={{ lineHeight: 1.8 }}>
          <div>
            已是最新版本 <b>v{info.currentVersion}</b>
            {info.cached && <span className="faint"> （缓存结果，6 小时内不重复请求）</span>}
          </div>
          {info.releaseUrl && (
            <div className="faint" style={{ marginTop: 6 }}>
              最新发布：{info.releaseName || info.latestVersion}
              {info.publishedAt && ` · ${fmtDate(info.publishedAt)}`}
            </div>
          )}
        </div>
      )}

      {status === 'ok' && info && info.hasUpdate && (
        <div style={{ lineHeight: 1.8 }}>
          <div style={{ display: 'flex', gap: 10, alignItems: 'baseline', marginBottom: 10 }}>
            <span style={{ fontSize: 15, fontWeight: 600, color: 'var(--accent)' }}>
              v{info.latestVersion}
            </span>
            <span className="faint small">当前 v{info.currentVersion}</span>
            {info.publishedAt && (
              <span className="faint small" style={{ marginLeft: 'auto' }}>
                {fmtDate(info.publishedAt)}
              </span>
            )}
          </div>

          {/* 下载按钮：按文件名猜用途，用户一眼知道该下哪个 */}
          <div className="row" style={{ marginBottom: 12, flexWrap: 'wrap', gap: 8 }}>
            {info.assets.map((a) => {
              const isSetup = /setup/i.test(a.name)
              const isPortable = /portable/i.test(a.name)
              const label = isSetup ? '下载安装器' : isPortable ? '下载免安装版' : '下载安装包'
              return (
                <Button
                  key={a.name}
                  size="sm"
                  variant={isSetup ? 'primary' : undefined}
                  onClick={() => open(a.url)}
                  title={a.name}
                >
                  {label}
                  {a.size > 0 && <span className="faint"> {fmtSize(a.size)}</span>}
                </Button>
              )
            })}
            {info.assets.length === 0 && info.releaseUrl && (
              <Button size="sm" variant="primary" onClick={() => open(info.releaseUrl)}>
                打开下载页
              </Button>
            )}
            {info.releaseUrl && (
              <Button size="sm" variant="ghost" onClick={() => open(info.releaseUrl)}>
                查看发布说明
              </Button>
            )}
          </div>

          {/*
            发布说明：Markdown 原文。
            这里不做渲染 —— 引入一个 Markdown 库只为显示几十行，
            不如原样显示（用户能读懂的），省一个依赖。
          */}
          {info.notes && (
            <details>
              <summary className="small faint" style={{ cursor: 'pointer', marginBottom: 6 }}>
                更新内容
              </summary>
              <pre
                className="small"
                style={{
                  whiteSpace: 'pre-wrap',
                  wordBreak: 'break-word',
                  maxHeight: 260,
                  overflow: 'auto',
                  background: 'var(--bg-sunken)',
                  padding: 10,
                  borderRadius: 6,
                  margin: 0,
                  fontFamily: 'inherit'
                }}
              >
                {info.notes}
              </pre>
            </details>
          )}
        </div>
      )}

      {/* 自动检查开关 —— 放在卡片最下面，不抢主要信息的视线 */}
      {onToggleAutoCheck && (
        <div
          style={{
            marginTop: 14,
            paddingTop: 12,
            borderTop: '1px solid var(--border)'
          }}
        >
          <label
            className="row"
            style={{ gap: 8, alignItems: 'center', cursor: 'pointer' }}
          >
            <input
              type="checkbox"
              checked={autoCheck}
              onChange={(e) => onToggleAutoCheck(e.target.checked)}
            />
            <span className="small">启动时自动检查更新</span>
            <span className="faint small">（关掉后仍可点右上角手动检查）</span>
          </label>
        </div>
      )}
    </Card>
  )
}