/**
 * 无边框标题栏（配合主进程的 titleBarOverlay）。
 *
 * 这里只放「跟当前工程无关」的东西：品牌、路径、帮助、更新。
 * 「预览 / 写入配置」已经挪到顶部工作流条的第三步 —— 那两个动作是工作流的一部分，
 * 放在右上角会让人看不出和「第三步」是一回事。
 *
 * 主题下拉**已经挪到设置页**：它一年改一次，不值得在标题栏常驻占位。
 * 现在右上角留给「更新」—— 那个恰好是唯一需要「不看页面上哪一页都能发现」的东西。
 */

import React from 'react'
import { useStudio } from '../state/store'
import { Button } from './ui'
import { Icons, LogoMark } from './icons'
import { UpdateChip } from './UpdateChip'

export function TitleBar(): React.JSX.Element {
  const projectRoot = useStudio((s) => s.projectRoot)
  const appInfo = useStudio((s) => s.appInfo)
  const optionsDirty = useStudio((s) => s.optionsDirty)
  const manualSections = useStudio((s) => s.manualSections)
  const regenerate = useStudio((s) => s.regenerate)

  return (
    <header className="titlebar">
      <div
        className="titlebar__brand"
        title={
          appInfo
            ? `${appInfo.name} v${appInfo.version}\nElectron ${appInfo.electron} · Chromium ${appInfo.chrome} · Node ${appInfo.node}\n点右上角「?」看完整信息`
            : 'CV Studio'
        }
      >
        <span className="titlebar__mark">
          <LogoMark />
        </span>
        <span>CV Studio</span>
        {appInfo && <span className="titlebar__version">v{appInfo.version}</span>}
      </div>
      <span className="titlebar__path" title={projectRoot}>
        {projectRoot ? projectRoot : '尚未选择工程'}
      </span>
      {/*
        这里**不再额外显示工程名徽标**。
        路径末尾已经是工程目录名（`...\Hero_9.1\Hero_9.1`），再挂一个
        「Hero_9.1」徽标就是把同一个词写两遍，还和路径末尾挤在一起。
        想知道当前是哪个工程，看路径最后一段就够了。
      */}

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

        {/* 有更新时才出现的芯片：进度 / 重启更新，点开是快捷面板 */}
        <UpdateChip />
      </div>
    </header>
  )
}
