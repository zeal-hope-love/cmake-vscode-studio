/**
 * 工程总览页：选工程 + 把检测到的事实集中展示。
 * 这是「这个工具到底看懂了什么」的唯一权威视图。
 *
 * 注意有两样东西**不在这里**：
 *   · 「需要注意的问题 / 检测提示」→ 挪到「检查与清理」页
 *   · 「备份与还原」→ 同样在「检查与清理」页
 * 这页只负责「看」，动文件的事都归到维护那一栏。
 */

import React from 'react'
import { useProjectWritten, useStudio } from '../state/store'
import { probeByKey } from '@shared/probes'
import {
  Alert,
  Badge,
  Button,
  Card,
  DataTable,
  EmptyState,
  Field,
  Kv,
  PageBody,
  PageHeader,
  PathText,
  Spinner,
  TextInput
} from '../components/ui'
import { Icons } from '../components/icons'
import { WorkflowStrip } from '../components/WorkflowStrip'
import { WriteSummary } from '../components/WriteSummary'

/** 候选工程的两个分组，顺序固定：正在打开的排前面 */
const CANDIDATE_GROUPS: Array<{ kind: 'open' | 'recent'; title: string }> = [
  { kind: 'open', title: 'VSCode 正在打开' },
  { kind: 'recent', title: '最近打开过' }
]

export default function ProjectPage(): React.JSX.Element {
  const project = useStudio((s) => s.project)
  const projectRoot = useStudio((s) => s.projectRoot)
  const busy = useStudio((s) => s.busy)
  const loadProject = useStudio((s) => s.loadProject)
  const browseProject = useStudio((s) => s.browseProject)
  const candidates = useStudio((s) => s.candidates)
  const refreshCandidates = useStudio((s) => s.refreshCandidates)
  const tools = useStudio((s) => s.tools)
  const options = useStudio((s) => s.options)
  const bundle = useStudio((s) => s.bundle)
  const settings = useStudio((s) => s.settings)
  const setPage = useStudio((s) => s.setPage)
  const pickerOpen = useStudio((s) => s.pickerOpen)
  const setPickerOpen = useStudio((s) => s.setPickerOpen)
  const written = useProjectWritten()

  const [pathInput, setPathInput] = React.useState(projectRoot)
  const [scanningCandidates, setScanningCandidates] = React.useState(false)

  React.useEffect(() => setPathInput(projectRoot), [projectRoot])

  // 工程换了就收起选择器（只显示当前工程）
  React.useEffect(() => {
    if (projectRoot) setPickerOpen(false)
  }, [projectRoot, setPickerOpen])

  React.useEffect(() => {
    let cancelled = false
    setScanningCandidates(true)
    refreshCandidates().finally(() => {
      if (!cancelled) setScanningCandidates(false)
    })
    return () => {
      cancelled = true
    }
  }, [refreshCandidates])

  /**
   * 窗口重新获得焦点时刷新候选列表。
   *
   * 典型场景：你在 VSCode 里开了新工程，切回这个工具 —— 列表如果还是进页面时那一份，
   * 就得手动点「刷新列表」。加了这个监听，切回来就是最新的。
   */
  React.useEffect(() => {
    const onFocus = (): void => {
      void refreshCandidates()
    }
    window.addEventListener('focus', onFocus)
    return () => window.removeEventListener('focus', onFocus)
  }, [refreshCandidates])

  const openCount = candidates.filter((c) => c.kind === 'open').length
  const recentCount = candidates.filter((c) => c.kind === 'recent').length

  const openActions = project ? (
    <>
      <Button size="sm" onClick={() => void window.api.openInVSCode(project.root)}>
        <Icons.vscode />在 VSCode 打开
      </Button>
      <Button size="sm" onClick={() => void window.api.openInExplorer(project.root)}>
        <Icons.folder />
        资源管理器
      </Button>
      <Button size="sm" variant="primary" onClick={() => void loadProject(project.root)}>
        <Icons.refresh />
        重新检测
      </Button>
    </>
  ) : null

  return (
    <>
      <PageHeader
        title="工程总览"
        subtitle="自动读取工程自身的 CMake 与 CubeMX 信息，不需要你手填"
        actions={openActions}
      />

      <PageBody>
        {/* 两步引导 + 「预览 / 写入配置」按钮。写入是这一页的收尾动作，就长在这里 */}
        <WorkflowStrip />

        {!project && settings.lastProject && (
          <Alert kind="accent">
            上次用的是 <span className="mono">{settings.lastProject}</span>
            <div className="mt-8">
              <Button
                size="sm"
                variant="primary"
                onClick={() => void loadProject(settings.lastProject!)}
              >
                继续上次这个工程
              </Button>
            </div>
          </Alert>
        )}

        {/* ---- 选择工程 ----
            选好工程之后默认收起，只留一行「当前是哪个工程」——
            常用状态下页面顶部不该被一整个选择器占满。 */}
        <Card
          id="select-project-card"
          title={project && !pickerOpen ? '当前工程' : '选择工程'}
          hint={project && !pickerOpen ? undefined : '支持直接粘贴路径、向上自动识别工程根'}
          actions={
            project ? (
              <Button
                size="sm"
                variant={pickerOpen ? 'ghost' : 'primary'}
                onClick={() => setPickerOpen(!pickerOpen)}
              >
                {pickerOpen ? '收起' : '换工程'}
              </Button>
            ) : null
          }
        >
          {project && !pickerOpen ? (
            <div className="flex" style={{ alignItems: 'center', gap: 10 }}>
              <span className="bold">{project.name}</span>
              <PathText value={project.root} />
              <div className="spacer" />
              <span className="faint small">
                {project.device ? `${project.device} · ` : ''}固件 {project.elfName}
              </span>
            </div>
          ) : (
            <>
              <div className="row mb-12">
                <div className="grow">
                  <Field label="工程路径">
                    <TextInput
                      mono
                      value={pathInput}
                      placeholder="例如 D:\\work\\my-firmware"
                      onChange={(e) => setPathInput(e.target.value)}
                      onKeyDown={(e) => {
                        if (e.key === 'Enter' && pathInput.trim()) void loadProject(pathInput.trim())
                      }}
                    />
                  </Field>
                </div>
                <Button onClick={() => void browseProject()}>浏览…</Button>
                <Button
                  variant="primary"
                  disabled={!pathInput.trim() || busy}
                  onClick={() => void loadProject(pathInput.trim())}
                >
                  {busy ? <Spinner /> : null}
                  检测工程
                </Button>
              </div>

              <div className="flex mb-8">
                <span className="small muted">
                  检测到 {openCount} 个正在打开的、{recentCount} 个最近打开过的 VSCode 工程
                </span>
                <div className="spacer" />
                <Button
                  size="sm"
                  variant="ghost"
                  onClick={() => {
                    setScanningCandidates(true)
                    void refreshCandidates().finally(() => setScanningCandidates(false))
                  }}
                >
                  {scanningCandidates ? <Spinner /> : <Icons.refresh />}
                  刷新列表
                </Button>
              </div>

              {candidates.length === 0 ? (
                <div className="faint small">
                  没有发现正在打开或最近打开过的 VSCode 工程。可以直接用上面的「浏览…」选择目录。
                </div>
              ) : (
                <>
                  {CANDIDATE_GROUPS.map((group) => {
                    const list = candidates.filter((c) => c.kind === group.kind)
                    if (!list.length) return null
                    return (
                      <div key={group.kind} className="mb-12">
                        <div className="sidebar__section" style={{ padding: '6px 0 4px' }}>
                          {group.title}
                          <span className="faint" style={{ marginLeft: 6, fontWeight: 400 }}>
                            {list.length}
                          </span>
                        </div>
                        <div className="list">
                          {list.map((c) => (
                            <div
                              key={c.root ?? c.folder}
                              className={
                                project && c.root === project.root
                                  ? 'list__item list__item--active'
                                  : 'list__item'
                              }
                              onClick={() => void loadProject(c.root ?? c.folder)}
                            >
                              <span style={{ flex: 1, minWidth: 0 }}>
                                <div className="mono truncate" title={c.root ?? c.folder}>
                                  {c.root ?? c.folder}
                                </div>
                                <div className="faint small">{c.detail}</div>
                              </span>
                              {c.chip && <Badge kind="accent">{c.chip}</Badge>}
                            </div>
                          ))}
                        </div>
                      </div>
                    )
                  })}
                  <div className="faint small">
                    列表在进入本页、以及窗口重新获得焦点时自动刷新；也可以点右上角「刷新列表」。
                  </div>
                </>
              )}
            </>
          )}
        </Card>

        {/*
          「写完你会得到什么」放在**选择工程下面、核对信息上面** ——
          这决定了「要不要写」，比一堆检测细节更该先看到。
          它自己就是两块并排的表格，和下面的「核心信息 / 芯片与调试目标」同一套骨架。
        */}
        {project && bundle && <WriteSummary bundle={bundle} />}

        {!project ? (
          <Card>
            <EmptyState title="还没有检测任何工程">
              选一个含 CMakeLists.txt（STM32 工程通常还有 .ioc）的目录，点「检测工程」。
            </EmptyState>
          </Card>
        ) : (
          <>
            {/* 问题和提示都挪到「检查与清理」页了，这里只留一个指路条 */}
            {project.warnings.length > 0 && (
              <Alert kind="warn">
                <div className="flex">
                  <span className="bold">检测到 {project.warnings.length} 条需要注意的问题</span>
                  <div className="spacer" />
                  <Button size="sm" onClick={() => setPage('inspect')}>
                    去检查与清理
                  </Button>
                </div>
                <div className="small mt-8" style={{ lineHeight: 1.7 }}>
                  {project.warnings[0]}
                  {project.warnings.length > 1 && ' …'}
                </div>
              </Alert>
            )}

            {/* ---- 概览 ---- */}
            <div className="grid grid--2">
              <Card title="核心信息">
                <Kv
                  items={[
                    ['工程根目录', <PathText key="r" value={project.root} />],
                    ['CMake 最低版本', project.cmakeMinimum ?? '未声明'],
                    [
                      'CMake 工程名',
                      project.cmakeProjectName ?? <span className="faint">未解析到 project()</span>
                    ],
                    [
                      '固件（ELF）名',
                      <span key="e" className="accent bold">
                        {project.elfName}
                      </span>
                    ],
                    [
                      'ELF 名来源',
                      <span key="s" className="small">
                        {project.elfSource}
                      </span>
                    ],
                    null,
                    ['preset 文件', project.presetFile ? project.presetFileKind : '无'],
                    ['构建目录', `${project.buildDirs.length} 个`],
                    ['compile_commands', project.hasCompileCommands ? '可用 ✓' : '未生成'],
                    ['工程类型', project.isEmbedded ? 'STM32 / 嵌入式' : '通用 CMake（本机调试）']
                  ]}
                />
              </Card>

              <Card title="芯片与调试目标">
                {project.ioc ? (
                  <Kv
                    items={[
                      ['CubeMX .ioc', <PathText key="i" value={project.ioc.file} />],
                      [
                        '芯片型号 (Mcu.CPN)',
                        <span key="c" className="accent bold">
                          {project.ioc.cpn ?? '—'}
                        </span>
                      ],
                      ['芯片系列', project.ioc.family ?? '—'],
                      ['封装', project.ioc.package ?? '—'],
                      ['Mcu.Name', project.ioc.mcuName ?? '—'],
                      ['CubeMX 工程名', project.ioc.projectName ?? '—'],
                      null,
                      ['cortex-debug device', project.device ?? <span className="faint">未识别</span>],
                      [
                        '调试探针',
                        options ? (
                          <span className="flex" style={{ gap: 6 }}>
                            <Badge kind="accent">{probeByKey(options.probeKey).label}</Badge>
                            <button type="button" className="linkbtn" onClick={() => setPage('tools')}>
                              更换
                            </button>
                          </span>
                        ) : (
                          '—'
                        )
                      ],
                      [
                        'OpenOCD 接线配置',
                        options?.targetCfg ? (
                          <span className="mono small">{options.targetCfg}</span>
                        ) : (
                          <span className="faint">不需要</span>
                        )
                      ],
                      [
                        'OpenOCD target',
                        project.device ? (
                          <span className="mono">
                            {tools?.openocdScripts ? '已定位 scripts 目录' : '未能定位 scripts'}
                          </span>
                        ) : (
                          '—'
                        )
                      ],
                      ['工具链文件', <PathText key="t" value={project.toolchainHint} />]
                    ]}
                  />
                ) : (
                  <EmptyState title="没有 .ioc 文件">
                    按通用 CMake 工程处理：会生成 cppdbg（gdb）调试配置，不会写 OpenOCD 相关内容。{' '}
                  </EmptyState>
                )}
              </Card>
            </div>

            {/* ---- CMake 目标与 preset ---- */}
            <Card title="CMake 目标" hint={project.presetFileKind || '未找到 presets'} flush>
              <DataTable
                columns={[
                  { key: 'name', title: '目标名' },
                  { key: 'kind', title: '类型' },
                  { key: 'src', title: '来源' }
                ]}
                rows={project.targets.map((t) => ({
                  key: t.name,
                  cells: [
                    <span key="n" className="mono bold">
                      {t.name}
                    </span>,
                    <Badge key="k" kind={t.kind === 'executable' ? 'accent' : 'default'}>
                      {t.kind === 'executable' ? '可执行' : '库'}
                    </Badge>,
                    <span key="s" className="faint small">
                      {t.source}
                    </span>
                  ]
                }))}
                empty={<EmptyState title="没有解析到目标" />}
              />
            </Card>

            <Card title="CMake Presets" flush>
              <DataTable
                columns={[
                  { key: 'name', title: '名称' },
                  { key: 'hidden', title: '类型' },
                  { key: 'gen', title: '生成器' },
                  { key: 'type', title: '构建类型' },
                  { key: 'dir', title: '构建目录' },
                  { key: 'tc', title: '工具链' }
                ]}
                rows={project.presets.map((p) => ({
                  key: p.name,
                  cells: [
                    <span key="n" className="mono bold">
                      {p.name}
                    </span>,
                    p.hidden ? (
                      <Badge key="h">基类 (hidden)</Badge>
                    ) : (
                      <Badge key="h" kind="ok">
                        可用
                      </Badge>
                    ),
                    p.generator ?? '—',
                    p.buildType ?? '—',
                    <PathText key="d" value={p.binaryDir} max={54} />,
                    <PathText key="t" value={p.toolchainFile} max={54} />
                  ]
                }))}
                empty={
                  <EmptyState title="没有 CMakePresets.json">
                    CMake Tools 无法一键切换 Debug/Release，构建任务会退化成
                    <span className="mono"> cmake --build build/Debug</span> 形式。
                  </EmptyState>
                }
              />
            </Card>

            {/* ---- 构建目录 ---- */}
            <Card title="构建目录" hint="已 configure 过的目录，烧录用的 ELF 从这里找" flush>
              <DataTable
                columns={[
                  { key: 'name', title: '目录' },
                  { key: 'type', title: '构建类型' },
                  { key: 'gen', title: '生成器' },
                  { key: 'cfg', title: '已配置' },
                  { key: 'art', title: '产物' },
                  { key: 'cc', title: 'compile_commands' }
                ]}
                rows={project.buildDirs.map((b) => ({
                  key: b.path,
                  cells: [
                    <span key="n" className="mono">
                      {b.name}
                    </span>,
                    b.buildType ?? '—',
                    b.generator ?? '—',
                    b.configured ? (
                      <Badge key="c" kind="ok">
                        是
                      </Badge>
                    ) : (
                      <Badge key="c" kind="warn">
                        否
                      </Badge>
                    ),
                    b.artifacts.length ? (
                      <span key="a" className="mono small">
                        {b.artifacts.map((a) => a.split(/[\\/]/).pop()).join(', ')}
                      </span>
                    ) : (
                      <span key="a" className="faint">
                        还没编译
                      </span>
                    ),
                    b.compileCommands ? (
                      <Badge key="cc" kind="ok">
                        有
                      </Badge>
                    ) : (
                      <span key="cc" className="faint">
                        —
                      </span>
                    )
                  ]
                }))}
                empty={
                  <EmptyState title="没有找到构建目录">
                    先在 VSCode 里用 CMake Tools
                    配置并构建一次，或者用本工具的「构建与烧录」页跑一次配置。
                  </EmptyState>
                }
              />
            </Card>

            {/* ---- .vscode 现状 ---- */}
            <Card title=".vscode 现状" hint="本工具会写这 4 个文件（外加 openocd-*.cfg）" flush>
              <DataTable
                columns={[
                  { key: 'file', title: '文件' },
                  { key: 'path', title: '路径' },
                  { key: 'status', title: '状态' }
                ]}
                rows={Object.values(project.vscodeFiles).map((f) => ({
                  key: f.name,
                  cells: [
                    <span key="n" className="mono bold">
                      {f.name}
                    </span>,
                    <PathText key="p" value={f.path} max={64} />,
                    f.valid === false ? (
                      <Badge key="s" kind="err">
                        {f.note}
                      </Badge>
                    ) : f.exists ? (
                      <Badge key="s" kind="ok">
                        {f.note}
                      </Badge>
                    ) : (
                      <Badge key="s">不存在，将新建</Badge>
                    )
                  ]
                }))}
              />

              {project.openocdCfgFiles.length > 0 && (
                <div className="card__body">
                  <div className="small muted mb-8">已有的 OpenOCD 接线配置：</div>
                  <div className="flex flex-wrap">
                    {project.openocdCfgFiles.map((f) => (
                      <Badge key={f} kind="accent">
                        {f.split(/[\\/]/).pop()}
                      </Badge>
                    ))}
                  </div>
                </div>
              )}
            </Card>

            {/* ---- include / defines ---- */}
            <div className="grid grid--2">
              <Card title="解析到的头文件目录">
                {project.includeDirs.length ? (
                  <div className="flex flex-wrap">
                    {project.includeDirs.map((d) => (
                      <Badge key={d}>{d}</Badge>
                    ))}
                  </div>
                ) : (
                  <span className="faint small">没有解析到 target_include_directories</span>
                )}
              </Card>

              <Card title="解析到的编译宏">
                {project.defines.length ? (
                  <div className="flex flex-wrap">
                    {project.defines.map((d) => (
                      <Badge key={d}>{d}</Badge>
                    ))}
                  </div>
                ) : (
                  <span className="faint small">没有解析到 target_compile_definitions</span>
                )}
              </Card>
            </div>
          </>
        )}
      </PageBody>
    </>
  )
}
