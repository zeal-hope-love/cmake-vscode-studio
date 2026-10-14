/**
 * 版本与运行环境信息。新手引导最后一步和「关于与版本」页共用同一份。
 */

import React from 'react'
import { themeLabel, useStudio } from '../state/store'
import { Button } from './ui'

export function AboutInfo(): React.JSX.Element {
  const appInfo = useStudio((s) => s.appInfo)
  const settings = useStudio((s) => s.settings)
  const [copied, setCopied] = React.useState(false)

  const rows: Array<[string, string]> = appInfo
    ? [
        ['应用名称', appInfo.name],
        ['版本', appInfo.version],
        ['运行方式', appInfo.isPackaged ? '打包版' : '开发模式'],
        ['主题', themeLabel(settings.theme)],
        ['Electron', appInfo.electron],
        ['Chromium', appInfo.chrome],
        ['Node.js', appInfo.node],
        ['V8', appInfo.v8],
        ['平台', appInfo.platform],
        ['数据目录', appInfo.userData],
        ['版本来源文件', appInfo.packagePath]
      ]
    : []

  const copy = (): void => {
    const text = rows.map(([k, v]) => `${k}: ${v}`).join('\n')
    void navigator.clipboard.writeText(text).then(() => {
      setCopied(true)
      window.setTimeout(() => setCopied(false), 2000)
    })
  }

  if (!appInfo) return <div className="faint small">正在读取运行环境信息…</div>

  return (
    <>
      <div className="alert alert--accent">
        <span className="alert__icon">ℹ</span>
        <div>
          版本号来自项目根目录 <span className="mono">package.json</span> 的{' '}
          <span className="mono">version</span> 字段 —— 打包时 electron-builder 会拿它填 exe
          的「文件版本 / 产品版本」。
          <div className="small mt-8">
            要在 Windows 文件属性里看到新版本号，改完 <span className="mono">version</span> 之后
            <b>必须重新打包</b>；只跑开发模式是不会变的。打包与签名的图形界面流程见{' '}
            <span className="mono">docs/DEVELOPMENT.md</span> 第四节。
          </div>
        </div>
      </div>

      <div className="kv mb-12">
        {rows.map(([k, v]) => (
          <React.Fragment key={k}>
            <div className="kv__k">{k}</div>
            <div className="kv__v">{v}</div>
          </React.Fragment>
        ))}
      </div>

      <Button size="sm" onClick={copy}>
        {copied ? '已复制 ✓' : '复制这些信息（反馈问题时用）'}
      </Button>
    </>
  )
}
