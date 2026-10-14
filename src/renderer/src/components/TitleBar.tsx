/**
 * 无边框标题栏（配合主进程的 titleBarOverlay）。
 *
 * 这里只放「跟当前工程无关」的东西：品牌、路径、帮助、主题。
 * 「预览 / 写入配置」已经挪到顶部工作流条的第三步 —— 那两个动作是工作流的一部分，
 * 放在右上角会让人看不出和「第三步」是一回事。
 */

import React from 'react'
import { themeLabel, useStudio } from '../state/store'
import { Button, Select } from './ui'
import { Icons, LogoMark } from './icons'
import type { AppSettings } from '@shared/types'

export function TitleBar(): React.JSX.Element {
  const projectRoot = useStudio((s) => s.projectRoot)
  const project = useStudio((s) => s.project)
  const appInfo = useStudio((s) => s.appInfo)
  const optionsDirty = useStudio((s) => s.optionsDirty)
  const manualSections = useStudio((s) => s.manualSections)
  const regenerate = useStudio((s) => s.regenerate)
  const theme = useStudio((s) => s.settings.theme)
  const setTheme = useStudio((s) => s.setTheme)

  return (
    <header className="titlebar">
      <div
        className="titlebar__brand"
        title={
          appInfo
            ? `${appInfo.name} v${appInfo.version}\nElectron ${appInfo.electron} · Chromium ${appInfo.chrome} · Node ${appInfo.node}\n点右上角「?」看完整信息`
            : 'CMake / VSCode 工程配置器'
        }
      >
        <span className="titlebar__mark">
          <LogoMark />
        </span>
        <span>CMake / VSCode 工程配置器</span>
        {appInfo && <span className="titlebar__version">v{appInfo.version}</span>}
      </div>
      <span className="titlebar__path" title={projectRoot}>
        {projectRoot ? projectRoot : '尚未选择工程'}
      </span>
      {project && <span className="badge badge--accent">{project.name}</span>}

      <div className="titlebar__spacer" />

      <div className="titlebar__actions">
        {optionsDirty && manualSections.length > 0 && (
          <Button
            size="sm"
            variant="ghost"
            title="生成参数已改动，点这里按新参数重新生成（会覆盖界面上的手动修改）"
            onClick={() => void regenerate(true)}
          >
            <Icons.refresh />
            参数已改动 · 重新生成
          </Button>
        )}

        <Button
          size="sm"
          variant="ghost"
          title="打开新手引导"
          onClick={() => useStudio.getState().openHelp()}
          style={{ fontWeight: 700 }}
        >
          ?
        </Button>

        {/* 主题用下拉，不用「点一下循环」—— 三个选项一眼能看全，也不会点过头 */}
        <div className="theme-select" title={`主题：${themeLabel(theme)}`}>
          <Icons.theme />
          <Select
            value={theme}
            aria-label="主题"
            onChange={(e) => void setTheme(e.target.value as AppSettings['theme'])}
            options={[
              { value: 'system', label: '跟随系统' },
              { value: 'light', label: '浅色' },
              { value: 'dark', label: '深色' }
            ]}
          />
        </div>
      </div>
    </header>
  )
}
