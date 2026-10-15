/**
 * 应用外壳：左侧导航、顶部工作流条、底部状态栏、右下角提示。
 */

import React from 'react'
import { useStudio, type PageKey } from '../state/store'
import { Icons } from './icons'
import { ResizeHandle, useStoredWidth } from './Resizable'

// --------------------------------------------------------------------------
// 左侧导航
// --------------------------------------------------------------------------

/**
 * 左侧导航。
 *
 * 分组的唯一依据：**这一页需不需要先选工程**。
 *   · 工程 —— 全部需要先选工程（总览本身就是选工程的地方）
 *   · 模板 / 环境 —— 跟具体工程无关，随时能打开
 * 「关于」固定在最下面，和上面拉开距离。
 */
const NAV: Array<{ page: PageKey; label: string; icon: () => React.JSX.Element; group: string }> = [
  { page: 'project', label: '工程总览', icon: Icons.project, group: '工程' },
  { page: 'launch', label: '调试 launch.json', icon: Icons.debug, group: '工程' },
  { page: 'tasks', label: '任务 tasks.json', icon: Icons.tasks, group: '工程' },
  { page: 'settings', label: '设置 settings.json', icon: Icons.settings, group: '工程' },
  { page: 'cpp', label: 'IntelliSense', icon: Icons.cpp, group: '工程' },
  { page: 'build', label: '构建与烧录', icon: Icons.build, group: '工程' },
  { page: 'inspect', label: '检查与清理', icon: Icons.broom, group: '工程' },
  { page: 'sources', label: '构建目标与源文件', icon: Icons.tasks, group: '源码' },
  { page: 'packs', label: '调试模块', icon: Icons.debug, group: '源码' },
  { page: 'templates', label: '模板与配置', icon: Icons.templates, group: '模板' },
  { page: 'tools', label: '工具与路径', icon: Icons.tools, group: '环境' },
  { page: 'history', label: '历史记录', icon: Icons.clock, group: '记录' }
]

export function Sidebar(): React.JSX.Element {
  const activePage = useStudio((s) => s.activePage)
  const setPage = useStudio((s) => s.setPage)
  const bundle = useStudio((s) => s.bundle)
  const project = useStudio((s) => s.project)
  const templates = useStudio((s) => s.templates)
  const history = useStudio((s) => s.history)
  const { width, dragging, startDrag } = useStoredWidth('nav', 214, 170, 420)

  const counts: Partial<Record<PageKey, number>> = {
    launch: bundle?.launch.configurations.length ?? 0,
    tasks: bundle?.tasks.tasks.length ?? 0,
    settings: bundle ? Object.keys(bundle.settings).length : 0,
    cpp: bundle?.cpp.configurations.length ?? 0,
    templates: templates.length,
    history: history.length,
    // 「检查与清理」上的角标 = 需要留意的问题条数
    inspect: project ? project.warnings.length : 0
  }

  let lastGroup = ''

  return (
    <>
      <nav className="sidebar" style={{ width, flex: '0 0 auto' }}>
        {NAV.map((item) => {
          const header = item.group !== lastGroup ? item.group : null
          lastGroup = item.group
          const count = counts[item.page]
          return (
            <React.Fragment key={item.page}>
              {header && <div className="sidebar__section">{header}</div>}
              <button
                type="button"
                className={activePage === item.page ? 'navitem navitem--active' : 'navitem'}
                onClick={() => setPage(item.page)}
                title={item.label}
              >
                <span className="navitem__icon">
                  <item.icon />
                </span>
                <span style={{ flex: 1, minWidth: 0, overflow: 'hidden', textOverflow: 'ellipsis' }}>
                  {item.label}
                </span>
                {count !== undefined && count > 0 && <span className="navitem__badge">{count}</span>}
              </button>
            </React.Fragment>
          )
        })}

        <div className="spacer" />

        {project && !project.isEmbedded && (
          <div className="sidebar__section" style={{ textTransform: 'none', letterSpacing: 0 }}>
            通用 CMake 工程模式
          </div>
        )}

        {/* 关于固定在底部，随时能找到 */}
        <div className="sidebar__section">关于</div>
        <button
          type="button"
          className={activePage === 'about' ? 'navitem navitem--active' : 'navitem'}
          onClick={() => setPage('about')}
          title="关于与版本"
        >
          <span className="navitem__icon">
            <Icons.info />
          </span>
          <span style={{ flex: 1, minWidth: 0, overflow: 'hidden', textOverflow: 'ellipsis' }}>
            关于与版本
          </span>
        </button>
      </nav>

      <ResizeHandle onMouseDown={startDrag} active={dragging} title="拖动调整侧边栏宽度" />
    </>
  )
}

// --------------------------------------------------------------------------
// 底部状态栏
// --------------------------------------------------------------------------

export function StatusBar(): React.JSX.Element {
  const busy = useStudio((s) => s.busy)
  const busyText = useStudio((s) => s.busyText)
  const errorText = useStudio((s) => s.errorText)
  const project = useStudio((s) => s.project)
  const projectRoot = useStudio((s) => s.projectRoot)
  const tools = useStudio((s) => s.tools)
  const activeRunId = useStudio((s) => s.activeRunId)
  const manualSections = useStudio((s) => s.manualSections)

  const dotClass = busy
    ? 'statusbar__dot statusbar__dot--busy'
    : errorText
      ? 'statusbar__dot statusbar__dot--err'
      : project
        ? 'statusbar__dot statusbar__dot--ok'
        : 'statusbar__dot'

  return (
    <footer className="statusbar">
      <span className={dotClass} />
      <span>
        {busy
          ? busyText || '处理中…'
          : activeRunId
            ? '命令运行中…'
            : errorText
              ? '有错误'
              : project
                ? `已载入：${project.name}`
                : '就绪'}
      </span>

      <span className="faint">|</span>
      <span className="mono truncate" style={{ maxWidth: '40vw' }} title={projectRoot}>
        {projectRoot || '—'}
      </span>

      <div className="spacer" />

      {manualSections.length > 0 && (
        <span className="warn" title="你在界面上手动改过这些文件，改动生成参数不会自动重算">
          手动修改：{manualSections.join(' / ')}
        </span>
      )}

      {project && (
        <span>
          芯片 {project.device ?? '—'} · ELF {project.elfName} · build 目录 {project.buildDirs.length}{' '}
          个
        </span>
      )}

      <span className="faint">|</span>
      <span title={tools?.items.openocd?.path ?? '未找到'}>
        OpenOCD {tools?.items.openocd?.found ? '✓' : '✗'}
      </span>
      <span title={tools?.items.arm_gcc?.path ?? '未找到'}>
        工具链 {tools?.items.arm_gcc?.found ? '✓' : '✗'}
      </span>
      <span title={tools?.items.cmake?.path ?? '未找到'}>
        CMake {tools?.items.cmake?.found ? '✓' : '✗'}
      </span>
    </footer>
  )
}

// --------------------------------------------------------------------------
// 右下角提示
// --------------------------------------------------------------------------

export function ToastHost(): React.JSX.Element {
  const toasts = useStudio((s) => s.toasts)
  const dismiss = useStudio((s) => s.dismissToast)

  return (
    <div className="toast-host">
      {toasts.map((t) => (
        <div key={t.id} className={`toast toast--${t.kind}`} onClick={() => dismiss(t.id)}>
          {t.text}
        </div>
      ))}
    </div>
  )
}
