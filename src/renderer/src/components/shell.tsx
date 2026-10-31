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
 * 分组原则：**一级 = 你在处理什么对象，二级 = 对这个对象做什么事。**
 *
 *   工程   这个工程本身      看 → 查 → 改 → 跑（四项平铺，顺序即动作流程）
 *   配置   它的配置文件      4 个 .vscode 文件收进一个可折叠父节点 + 模板
 *   扩展   装能力            每个能力一行
 *   系统   应用与机器        工具链、历史
 *
 * 为什么 4 个 JSON 收进折叠而 4 个工程项平铺：
 *   JSON 那 4 个是**同一类东西的 4 个实例**（都是 .vscode 下的文件），折叠合理；
 *   工程那 4 个是**四件不同的事**（看/查/改/跑），套一层「概况/操作」纯属硬造对称。
 *
 * 「关于」固定在最下面，和上面拉开距离。
 */
type NavLeaf = {
  type: 'leaf'
  page: PageKey
  label: string
  icon: () => React.JSX.Element
  /**
   * 只有「扩展」组的项才有：这一项代表哪个模块包。
   * 点击时先把它写进 store（PacksPage 打开后直接定位），再切页。
   */
  packId?: string
}

/** 可折叠父节点：本身不是页面，点开/收起子项 */
type NavFolder = {
  type: 'folder'
  id: string
  label: string
  icon: () => React.JSX.Element
  children: NavLeaf[]
}

type NavEntry = NavLeaf | NavFolder

const NAV: Array<{ group: string; items: NavEntry[] }> = [
  {
    group: '工程',
    items: [
      { type: 'leaf', page: 'project', label: '工程总览', icon: Icons.project },
      { type: 'leaf', page: 'inspect', label: '检查与清理', icon: Icons.broom },
      { type: 'leaf', page: 'sources', label: '源文件管理', icon: Icons.tasks },
      { type: 'leaf', page: 'build', label: '构建与烧录', icon: Icons.build }
    ]
  },
  {
    group: '配置',
    items: [
      {
        type: 'folder',
        id: 'vscode',
        label: 'VSCode 配置',
        icon: Icons.settings,
        children: [
          { type: 'leaf', page: 'launch', label: 'launch.json', icon: Icons.debug },
          { type: 'leaf', page: 'tasks', label: 'tasks.json', icon: Icons.tasks },
          { type: 'leaf', page: 'settings', label: 'settings.json', icon: Icons.settings },
          { type: 'leaf', page: 'cpp', label: 'c_cpp_properties.json', icon: Icons.cpp }
        ]
      },
      { type: 'leaf', page: 'probe', label: '探针与芯片', icon: Icons.tools },
      { type: 'leaf', page: 'templates', label: '模板', icon: Icons.templates }
    ]
  },
  {
    group: '扩展',
    items: [
      // 占位项：真正的扩展项在 Sidebar 里由 packs 动态生成（见下方 extensionItems）。
      // 这里留一行是为了**没有任何模块包时也有个入口**，不然整个「扩展」组会消失，
      // 用户会以为功能没了。
      { type: 'leaf', page: 'packs', label: '模块包', icon: Icons.debug }
    ]
  },
  {
    group: '系统',
    items: [
      { type: 'leaf', page: 'tools', label: '工具链与路径', icon: Icons.tools },
      { type: 'leaf', page: 'history', label: '历史与恢复', icon: Icons.clock }
    ]
  }
]

export function Sidebar(): React.JSX.Element {
  const activePage = useStudio((s) => s.activePage)
  const setPage = useStudio((s) => s.setPage)
  const bundle = useStudio((s) => s.bundle)
  const project = useStudio((s) => s.project)
  const templates = useStudio((s) => s.templates)
  const history = useStudio((s) => s.history)
  const packs = useStudio((s) => s.packs)
  const activePackId = useStudio((s) => s.activePackId)
  const setActivePackId = useStudio((s) => s.setActivePackId)
  const { width, dragging, startDrag } = useStoredWidth('nav', 214, 170, 420)

  /**
   * 「扩展」组的导航项由已安装的模块包动态生成。
   *
   * 这样 packs/ 目录下多一个包，导航里就自动多一行 —— 不需要改代码。
   * 一个包都没有时退回 NAV 里那个「模块包」占位项，保证入口不会消失。
   */
  const extensionEntries: NavLeaf[] = React.useMemo(
    () =>
      packs.length > 0
        ? packs.map((p) => ({
            type: 'leaf' as const,
            page: 'packs' as const,
            label: p.name || p.id,
            icon: Icons.debug,
            packId: p.id
          }))
        : [],
    [packs]
  )

  /** 把「扩展」组换成动态项；其它组原样 */
  const navSections = React.useMemo(
    () =>
      NAV.map((section) =>
        section.group === '扩展' && extensionEntries.length > 0
          ? { ...section, items: extensionEntries }
          : section
      ),
    [extensionEntries]
  )

  /**
   * 扩展项的高亮判断：同是 packs 页时，还要看 activePackId 对不对得上 ——
   * 否则装了 3 个包，3 行会同时高亮。
   */
  const isLeafActive = (leaf: NavLeaf): boolean => {
    if (activePage !== leaf.page) return false
    if (leaf.page === 'packs') {
      // 没有 packId 的是占位项，只在没选中任何包时高亮
      return leaf.packId ? activePackId === leaf.packId : !activePackId
    }
    return true
  }

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

  /**
   * 折叠状态：默认展开。
   * 用 Set 存「被用户收起来」的节点，而不是存「展开的」——
   * 这样新增的栏默认是展开的，不需要额外初始化。
   */
  const [collapsed, setCollapsed] = React.useState<Set<string>>(new Set())
  const toggleFolder = (id: string): void => {
    setCollapsed((prev) => {
      const next = new Set(prev)
      if (next.has(id)) next.delete(id)
      else next.add(id)
      return next
    })
  }

  return (
    <>
      <nav className="sidebar" style={{ width, flex: '0 0 auto' }}>
        {navSections.map((section) => (
          <React.Fragment key={section.group}>
            <div className="sidebar__section">{section.group}</div>
            {section.items.map((item) => {
              if (item.type === 'leaf') {
                const count = counts[item.page]
                return (
                  <button
                    key={item.packId ?? item.page}
                    type="button"
                    className={isLeafActive(item) ? 'navitem navitem--active' : 'navitem'}
                    onClick={() => {
                      // 扩展项要先记住是哪个包，PacksPage 打开后据此定位
                      if (item.packId) setActivePackId(item.packId)
                      setPage(item.page)
                    }}
                    title={item.label}
                  >
                    <span className="navitem__icon">
                      <item.icon />
                    </span>
                    <span
                      style={{ flex: 1, minWidth: 0, overflow: 'hidden', textOverflow: 'ellipsis' }}
                    >
                      {item.label}
                    </span>
                    {count !== undefined && count > 0 && (
                      <span className="navitem__badge">{count}</span>
                    )}
                  </button>
                )
              }

              // ---- 可折叠父节点 ----
              const isCollapsed = collapsed.has(item.id)
              // 子项里有当前页时，父节点也要高亮，否则收起来后完全看不出自己在哪
              const containsActive = item.children.some((c) => c.page === activePage)
              return (
                <React.Fragment key={item.id}>
                  <button
                    type="button"
                    className={
                      containsActive && isCollapsed ? 'navitem navitem--active' : 'navitem'
                    }
                    onClick={() => toggleFolder(item.id)}
                    title={isCollapsed ? `展开 ${item.label}` : `收起 ${item.label}`}
                    aria-expanded={!isCollapsed}
                  >
                    <span className="navitem__icon">
                      <item.icon />
                    </span>
                    <span
                      style={{ flex: 1, minWidth: 0, overflow: 'hidden', textOverflow: 'ellipsis' }}
                    >
                      {item.label}
                    </span>
                    <span
                      className="navitem__chevron"
                      data-collapsed={isCollapsed ? 'true' : 'false'}
                      aria-hidden
                    >
                      <Icons.chevron />
                    </span>
                  </button>
                  {!isCollapsed && (
                    <div className="navsub">
                      {item.children.map((child) => {
                        const count = counts[child.page]
                        return (
                          <button
                            key={child.page}
                            type="button"
                            className={
                              activePage === child.page
                                ? 'navitem navitem--sub navitem--active'
                                : 'navitem navitem--sub'
                            }
                            onClick={() => setPage(child.page)}
                            title={child.label}
                          >
                            <span
                              style={{
                                flex: 1,
                                minWidth: 0,
                                overflow: 'hidden',
                                textOverflow: 'ellipsis'
                              }}
                            >
                              {child.label}
                            </span>
                            {count !== undefined && count > 0 && (
                              <span className="navitem__badge">{count}</span>
                            )}
                          </button>
                        )
                      })}
                    </div>
                  )}
                </React.Fragment>
              )
            })}
          </React.Fragment>
        ))}

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
