/**
 * 「还没有选择工程」的统一空状态。
 *
 * 存在的理由：以前每个页面各写各的，结果对不上 ——
 *   · launch / build 被 App.tsx 整页拦截，**没有页面标题**，但有两个按钮；
 *   · tasks / settings / cpp / inspect 自己渲染，**有页面标题**，却一个按钮都没有；
 *   · 文案还不一样（「请先载入工程」「需要先载入工程」「还没有载入工程」）。
 * 同一件事三种长相，用户自然会问「为什么没统一」。
 *
 * 现在约定：
 *   1. 需要工程的页面**永远**先渲染自己的 PageHeader（标题和正常状态一模一样）；
 *   2. 正文一律用这个组件，文案和按钮都只有这一份。
 *
 * 用法：
 *   if (!bundle) {
 *     return (
 *       <>
 *         <PageHeader title="任务 tasks.json" subtitle="还没有选择工程" />
 *         <PageBody><NoProject /></PageBody>
 *       </>
 *     )
 *   }
 */

import React from 'react'
import { Button, EmptyState } from './ui'
import { useStudio } from '../state/store'

export function NoProject(props: {
  /** 这一页为什么需要工程 —— 一句话，会拼在通用说明前面 */
  reason?: string
}): React.JSX.Element {
  const browseProject = useStudio((s) => s.browseProject)
  const setPage = useStudio((s) => s.setPage)

  return (
    <EmptyState title="还没有选择工程">
      <div className="mb-12">
        {props.reason ? `${props.reason} ` : '这一页要读工程里的文件。'}
        先到「工程总览」页选一个 CMake 工程，或者直接用下面的按钮。
      </div>
      <div className="flex" style={{ justifyContent: 'center' }}>
        <Button variant="primary" onClick={() => void browseProject()}>
          选择工程目录…
        </Button>
        <Button onClick={() => setPage('project')}>去工程总览</Button>
      </div>
    </EmptyState>
  )
}
