/**
 * 任务页：直接编辑 tasks.json 的 tasks。
 *
 * 表单覆盖 VSCode 任务里最常用的字段，所有改动即时写回 bundle（该节会被
 * 标记为「已手动修改」），真正落盘由预览 / 写入流程统一负责。
 */

import React from 'react'
import { useStudio } from '../state/store'
import type { TaskDef } from '@shared/types'
import {
  Alert,
  Badge,
  Button,
  Card,
  EmptyState,
  Field,
  PageBody,
  PageHeader,
  Select,
  TextArea,
  TextInput
} from '../components/ui'
import { NoProject } from '../components/NoProject'
import { Icons } from '../components/icons'
import { SplitPane } from '../components/Resizable'

/** VSCode 工作区变量，生成的配置里统一用它 */
const WS = '${workspaceFolder}'

/** 「其它」是个哨兵值：选中它时用输入框自由填写 type */
const OTHER = '其它'

const TYPE_OPTIONS = ['shell', 'process', 'cmake']

type TemplateId = 'buildDebug' | 'buildRelease' | 'configure' | 'clean' | 'flash' | 'blank'

/** group 下拉的中间表示 */
type GroupKey = '' | 'build' | 'test' | 'default' | 'other'

// --------------------------------------------------------------------------
// 读写小工具
// --------------------------------------------------------------------------

/** 把任务里的任意值读成字符串 */
function text(value: unknown): string {
  if (typeof value === 'string') return value
  if (typeof value === 'number' || typeof value === 'boolean') return String(value)
  return ''
}

/** 把字符串数组读成多行文本 */
function lines(value: unknown): string {
  return Array.isArray(value) ? value.map((v) => String(v)).join('\n') : ''
}

/** 多行文本 → 字符串数组（空行忽略） */
function splitLines(input: string): string[] {
  return input
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean)
}

/** 写一个字段；空值（undefined / null / 空串）表示删除该键，让 JSON 保持干净 */
function setKey<T extends Record<string, unknown>>(obj: T, key: string, value: unknown): T {
  const draft: Record<string, unknown> = { ...obj }
  if (value === undefined || value === null || value === '') delete draft[key]
  else draft[key] = value
  return draft as T
}

/** 写一个数组字段；空数组同样删除该键 */
function setList<T extends Record<string, unknown>>(obj: T, key: string, list: unknown[]): T {
  return list.length ? setKey(obj, key, list) : setKey(obj, key, undefined)
}

/** 基础下拉项；当前值不在表里时补一项，避免下拉框显示空白 */
function withCurrent(base: string[], current: string): Array<{ value: string; label: string }> {
  const options = base.map((v) => ({ value: v, label: v }))
  if (current && !base.includes(current)) options.push({ value: current, label: `其它（${current}）` })
  return options
}

/** 是否被标记为「默认构建任务」，也就是 Ctrl+Shift+B 直接跑的那个 */
function isDefaultBuildTask(task: TaskDef): boolean {
  const group = task.group
  if (!group || typeof group !== 'object' || Array.isArray(group)) return false
  return group.kind === 'build' && group.isDefault === true
}

/** group 字段 → 下拉选中的值 */
function groupValue(group: TaskDef['group']): GroupKey {
  if (!group) return ''
  if (typeof group === 'string')
    return group === 'build' ? 'build' : group === 'test' ? 'test' : 'other'
  if (Array.isArray(group)) return 'other'
  const kind = typeof group.kind === 'string' ? group.kind : ''
  if (kind === 'build') return group.isDefault === true ? 'default' : 'build'
  if (kind === 'test') return 'test'
  return 'other'
}

// --------------------------------------------------------------------------
// 在 VSCode 里怎么用这些任务
//
// 单独抽成组件，是因为它在两个地方都要出现：
//   · 正常有工程时 —— 页面顶部
//   · 还没载入工程、页面只剩空状态时 —— 也要有，否则用户根本不知道这页干嘛的
// --------------------------------------------------------------------------

function VscodeUsageHint(): React.JSX.Element {
  return (
    <Card title="在 VSCode 里怎么用" hint="写完之后回到 VSCode，这样调出来">
      <div className="grid grid--2">
        <div className="small" style={{ lineHeight: 1.9 }}>
          <div className="bold mb-8">最常用的两个</div>
          <div>
            · <kbd>Ctrl</kbd>+<kbd>Shift</kbd>+<kbd>B</kbd> —— 跑<b>默认生成任务</b>（当前是「烧录并运行
            Debug 固件」：先构建、再烧录、烧完 reset run）， 纯烧录不调试就走这条。
          </div>
          <div>
            · <kbd>Ctrl</kbd>+<kbd>Shift</kbd>+<kbd>P</kbd> → 输入{' '}
            <span className="mono">Tasks: Run Task</span> → 选任意一个任务
            （烧录、清理、自定义命令都在这里）。
          </div>
        </div>

        <div className="small" style={{ lineHeight: 1.9 }}>
          <div className="bold mb-8">容易忽略的两件事</div>
          <div>
            · 按 <kbd>F5</kbd> 调试时，<span className="mono">launch.json</span> 里的{' '}
            <span className="mono">preLaunchTask</span> 会<b>自动先跑对应任务</b>再开始调试 ——
            所以「构建 + 烧录 + 调试」按一下 F5 就够了。
          </div>
          <div>
            · 任务列表的右键菜单里可以「运行任务」/「设为默认生成任务」；改了这里保存后，VSCode
            会自动重新读 <span className="mono">tasks.json</span>，不用重启。
          </div>
        </div>
      </div>

      <Alert kind="info">
        ※ 用 <kbd>Ctrl</kbd>+<kbd>Shift</kbd>+<kbd>B</kbd> 时如果弹出一个「选择要运行的生成任务」，
        说明有多个任务被标成了默认（下面会提示）；也可以到 VSCode 里
        <span className="mono"> 终端 → 配置默认生成任务 </span>里固定一个。
      </Alert>
    </Card>
  )
}

// --------------------------------------------------------------------------

export default function TasksPage(): React.JSX.Element {
  const project = useStudio((s) => s.project)
  const bundle = useStudio((s) => s.bundle)
  const options = useStudio((s) => s.options)
  const notify = useStudio((s) => s.notify)

  const tasks = bundle?.tasks.tasks ?? []
  const taskCount = tasks.length

  const [selected, setSelected] = React.useState(0)
  const [templateOpen, setTemplateOpen] = React.useState(false)
  const [templateId, setTemplateId] = React.useState<TemplateId>('buildDebug')
  const [typeOther, setTypeOther] = React.useState(false)
  const [matcherDraft, setMatcherDraft] = React.useState('')
  const [matcherError, setMatcherError] = React.useState<string | null>(null)

  const activeIndex = taskCount ? Math.min(selected, taskCount - 1) : -1
  const task: TaskDef | null = activeIndex >= 0 ? tasks[activeIndex] : null

  /** 从 store 里现取一次，避免用到过期的闭包值 */
  const liveTask = (index: number): TaskDef | null =>
    useStudio.getState().bundle?.tasks.tasks[index] ?? null

  // 切换任务（或增删条目）时，重置只跟当前任务有关的本地草稿
  React.useEffect(() => {
    const current = liveTask(activeIndex)
    setMatcherDraft(
      current && current.problemMatcher !== undefined
        ? JSON.stringify(current.problemMatcher, null, 4)
        : ''
    )
    setMatcherError(null)
    setTypeOther(false)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [activeIndex, taskCount])

  if (!bundle) {
    return (
      <>
        <PageHeader title="任务 tasks.json" subtitle="还没有选择工程" />
        <PageBody>
          {/*
            这里**不放** <VscodeUsageHint /> —— 那张卡是给「任务已经生成好、但不知道
            按哪个键」的人看的。没工程时它只会把「选择工程」按钮挤到折叠线以下，
            还让这一页的空状态和别的页面长得不一样。空状态本身已经说明了这页干嘛。
          */}
          <NoProject reason="任务内容要按工程生成（构建目录、preset 名、烧录命令都来自工程）。" />
        </PageBody>
      </>
    )
  }

  // ------------------------------------------------------------------------
  // 写入
  // ------------------------------------------------------------------------

  const writeTask = (index: number, next: TaskDef): void => {
    const state = useStudio.getState()
    const live = state.bundle
    if (!live || index < 0 || index >= live.tasks.tasks.length) return
    const nextTasks = live.tasks.tasks.map((t, i) => (i === index ? next : t))
    state.editBundle('tasks', { ...live.tasks, tasks: nextTasks })
  }

  const setField = (key: string, value: unknown): void => {
    if (!task) return
    writeTask(activeIndex, setKey(task, key, value))
  }

  const setListField = (key: string, list: unknown[]): void => {
    if (!task) return
    writeTask(activeIndex, setList(task, key, list))
  }

  /** 只改 options.cwd，保留同级的其它键；options 空了就整个删掉 */
  const setCwd = (value: string): void => {
    if (!task) return
    const current: { cwd?: string; env?: Record<string, string> } =
      task.options && typeof task.options === 'object' ? task.options : {}
    const next = { ...current }
    if (value.trim()) next.cwd = value
    else delete next.cwd
    setField('options', Object.keys(next).length ? next : undefined)
  }

  // ------------------------------------------------------------------------
  // 增删改排
  // ------------------------------------------------------------------------

  const templateList = (): Array<{ id: TemplateId; label: string }> => [
    { id: 'buildDebug', label: '构建 Debug' },
    { id: 'buildRelease', label: '构建 Release' },
    { id: 'configure', label: `配置 CMake（${options?.debugPreset || 'Debug'}）` },
    { id: 'clean', label: '清理 Debug' },
    ...(bundle.openocdCfg ? [{ id: 'flash' as TemplateId, label: 'OpenOCD 烧录 Debug' }] : []),
    { id: 'blank', label: '自定义任务（空壳）' }
  ]

  /** 按模板造一个新任务；options / project 缺失时用保守的兜底值 */
  const buildTemplate = (id: TemplateId): TaskDef => {
    const cmake = options?.cmakeExe || 'cmake'
    const debugDir = options?.debugDir || 'build/Debug'
    const releaseDir = options?.releaseDir || 'build/Release'
    const debugPreset = options?.debugPreset || 'Debug'
    const releasePreset = options?.releasePreset || 'Release'
    const elfName = options?.elfName || project?.elfName || 'firmware'
    const cfgFile = bundle.openocdCfg?.fileName ?? ''

    /** 有 buildPresets 就走 preset，否则退回构建目录 */
    const buildArgs = (preset: string, dir: string): string[] =>
      options?.hasBuildPresets ? ['--build', '--preset', preset] : ['--build', dir]

    switch (id) {
      case 'buildDebug':
        return {
          label: '构建 Debug',
          type: 'shell',
          command: cmake,
          args: buildArgs(debugPreset, debugDir),
          options: { cwd: WS },
          group: { kind: 'build', isDefault: true },
          problemMatcher: ['$gcc']
        }
      case 'buildRelease':
        return {
          label: '构建 Release',
          type: 'shell',
          command: cmake,
          args: buildArgs(releasePreset, releaseDir),
          options: { cwd: WS },
          group: 'build',
          problemMatcher: ['$gcc']
        }
      case 'configure':
        return {
          label: `配置 CMake（${debugPreset}）`,
          type: 'shell',
          command: cmake,
          args: ['--preset', debugPreset],
          options: { cwd: WS },
          problemMatcher: []
        }
      case 'clean':
        return {
          label: '清理 Debug',
          type: 'shell',
          command: cmake,
          args: ['--build', debugDir, '--target', 'clean'],
          options: { cwd: WS },
          problemMatcher: []
        }
      case 'flash':
        if (!cfgFile) break
        return {
          label: '烧录并运行 Debug 固件',
          type: 'process',
          command: options?.openocdExe || 'openocd',
          args: [
            '-f',
            `${WS}/.vscode/${cfgFile}`,
            '-c',
            `program ${debugDir}/${elfName}.elf verify reset exit`
          ],
          options: { cwd: WS },
          group: 'build',
          problemMatcher: []
        }
      default:
        break
    }

    // 自定义任务 / 缺少原始接线配置时的兜底
    return { label: '新任务', type: 'shell', command: '' }
  }

  const addTask = (): void => {
    const state = useStudio.getState()
    const live = state.bundle
    if (!live) return
    const next = buildTemplate(templateId)
    const nextTasks = [...live.tasks.tasks, next]
    state.editBundle('tasks', { ...live.tasks, tasks: nextTasks })
    setSelected(nextTasks.length - 1)
    setTemplateOpen(false)
    notify('ok', `已新增任务「${next.label}」`)
  }

  const duplicateTask = (): void => {
    if (!task) return
    const state = useStudio.getState()
    const live = state.bundle
    if (!live) return
    const copy: TaskDef = { ...task, label: `${text(task.label)} 副本` }
    const nextTasks = [...live.tasks.tasks]
    nextTasks.splice(activeIndex + 1, 0, copy)
    state.editBundle('tasks', { ...live.tasks, tasks: nextTasks })
    setSelected(activeIndex + 1)
    notify('ok', `已复制为「${copy.label}」`)
  }

  const removeTask = (): void => {
    if (!task) return
    const state = useStudio.getState()
    const live = state.bundle
    if (!live) return
    const nextTasks = live.tasks.tasks.filter((_, i) => i !== activeIndex)
    state.editBundle('tasks', { ...live.tasks, tasks: nextTasks })
    setSelected(Math.max(0, Math.min(activeIndex, nextTasks.length - 1)))
    notify('warn', `已删除任务「${text(task.label)}」`)
  }

  const moveTask = (delta: number): void => {
    const state = useStudio.getState()
    const live = state.bundle
    if (!live) return
    const nextTasks = [...live.tasks.tasks]
    const target = activeIndex + delta
    if (target < 0 || target >= nextTasks.length) return
    const [item] = nextTasks.splice(activeIndex, 1)
    nextTasks.splice(target, 0, item)
    state.editBundle('tasks', { ...live.tasks, tasks: nextTasks })
    setSelected(target)
  }

  const markDefaultBuild = (): void => {
    if (!task) return
    writeTask(activeIndex, setKey(task, 'group', { kind: 'build', isDefault: true }))
    notify('ok', `「${text(task.label)}」已设为默认构建任务`)
  }

  const regenerateAll = (): void => {
    const state = useStudio.getState()
    state.notify('warn', '将按当前生成参数重建全部任务，所有手动修改都会被覆盖')
    void state.regenerate(true)
  }

  const defaultBuildTasks = tasks.filter(isDefaultBuildTask)

  /** 多个默认构建任务时，只留第一个，其余降级成普通 build 任务 */
  const keepFirstDefault = (): void => {
    const state = useStudio.getState()
    const live = state.bundle
    if (!live) return
    let kept = false
    const nextTasks = live.tasks.tasks.map((t) => {
      if (!isDefaultBuildTask(t)) return t
      if (!kept) {
        kept = true
        return t
      }
      return { ...t, group: 'build' } as TaskDef
    })
    state.editBundle('tasks', { ...live.tasks, tasks: nextTasks })
    state.notify('ok', '已只保留第一个默认构建任务，其余改成普通 build 任务')
  }

  // ------------------------------------------------------------------------
  // 编辑区
  // ------------------------------------------------------------------------

  const showCustomType = typeOther || !TYPE_OPTIONS.includes(task?.type ?? '')
  const group = task ? groupValue(task.group) : ''

  const onMatcherChange = (value: string): void => {
    setMatcherDraft(value)
    if (!task) return
    const trimmed = value.trim()
    if (!trimmed) {
      setMatcherError(null)
      setField('problemMatcher', undefined)
      return
    }
    try {
      const parsed = JSON.parse(trimmed) as unknown
      if (!Array.isArray(parsed)) {
        setMatcherError('problemMatcher 必须是一个 JSON 数组')
        return
      }
      setMatcherError(null)
      setField('problemMatcher', parsed)
    } catch (err) {
      setMatcherError(err instanceof Error ? err.message : String(err))
    }
  }

  return (
    <>
      <PageHeader
        title="任务 tasks.json"
        subtitle={`${taskCount} 个任务`}
        actions={
          <Button size="sm" variant="primary" onClick={regenerateAll}>
            <Icons.refresh />
            按当前参数重新生成全部配置
          </Button>
        }
      />

      <PageBody>
        {/* ---- 在 VSCode 里怎么用这些任务 ---- */}
        <VscodeUsageHint />

        {defaultBuildTasks.length > 1 && (
          <Alert kind="warn">
            <div className="bold mb-8">
              有 {defaultBuildTasks.length} 个任务被标记为默认构建任务，VSCode
              只认其中一个（Ctrl+Shift+B 会弹选择框）
            </div>
            <Button size="sm" onClick={keepFirstDefault}>
              只保留第一个
            </Button>
          </Alert>
        )}

        <SplitPane storageKey="tasks-list" defaultWidth={300}>
          {/* ---- 左：任务列表 ---- */}
          <Card title="任务列表" hint={`${taskCount} 个`}>
            {taskCount === 0 ? (
              <EmptyState title="还没有任务">用下面的「新增 ▾」从模板创建一个。</EmptyState>
            ) : (
              <div className="list list__scroll">
                {tasks.map((t, i) => (
                  <div
                    key={`${text(t.label)}-${i}`}
                    className={i === activeIndex ? 'list__item list__item--active' : 'list__item'}
                    onClick={() => setSelected(i)}
                  >
                    <span style={{ flex: 1, minWidth: 0 }}>
                      <div className="truncate" title={text(t.label)}>
                        {text(t.label) || '（未命名）'}
                      </div>
                    </span>
                    {isDefaultBuildTask(t) && <Badge kind="ok">默认构建</Badge>}
                    <Badge>{text(t.type) || '未知'}</Badge>
                  </div>
                ))}
              </div>
            )}

            <div className="flex flex-wrap mt-8">
              <Button size="sm" variant="primary" onClick={() => setTemplateOpen((open) => !open)}>
                新增 ▾
              </Button>
              <Button size="sm" disabled={!task} onClick={duplicateTask}>
                复制
              </Button>
              <Button size="sm" variant="danger" disabled={!task} onClick={removeTask}>
                删除
              </Button>
              <Button size="sm" disabled={!task || activeIndex <= 0} onClick={() => moveTask(-1)}>
                上移
              </Button>
              <Button
                size="sm"
                disabled={!task || activeIndex >= taskCount - 1}
                onClick={() => moveTask(1)}
              >
                下移
              </Button>
              <Button
                size="sm"
                disabled={!task || (group === 'default' && defaultBuildTasks.length === 1)}
                onClick={markDefaultBuild}
              >
                设为默认构建任务
              </Button>
            </div>

            {templateOpen && (
              <div className="mt-8">
                <Field label="从模板新增" hint="模板里的路径按当前生成参数填好，可再手动改">
                  <Select
                    value={templateId}
                    options={templateList().map((t) => ({ value: t.id, label: t.label }))}
                    onChange={(e) => setTemplateId(e.target.value as TemplateId)}
                  />
                </Field>
                <Button size="sm" variant="primary" onClick={addTask}>
                  创建
                </Button>
              </div>
            )}
          </Card>

          {/* ---- 右：表单 ---- */}
          <div>
            {!task ? (
              <Card title="任务详情">
                <EmptyState title="没有选中的任务" />
              </Card>
            ) : (
              <Card
                title={text(task.label) || '（未命名）'}
                hint={`第 ${activeIndex + 1} / ${taskCount} 个`}
              >
                <div className="grid grid--2">
                  <Field label="名称 (label)" hint="VSCode 里显示、也是 dependsOn 引用的名字">
                    <TextInput
                      value={text(task.label)}
                      placeholder="例如 构建 Debug"
                      onChange={(e) => setField('label', e.target.value)}
                    />
                  </Field>

                  <Field label="类型 (type)" hint="shell / process 最常用">
                    <Select
                      value={showCustomType ? OTHER : text(task.type)}
                      options={[
                        ...TYPE_OPTIONS.map((v) => ({ value: v, label: v })),
                        { value: OTHER, label: '其它（自定义）' }
                      ]}
                      onChange={(e) => {
                        const value = e.target.value
                        if (value === OTHER) {
                          setTypeOther(true)
                          return
                        }
                        setTypeOther(false)
                        setField('type', value)
                      }}
                    />
                    {showCustomType && (
                      <TextInput
                        mono
                        value={text(task.type)}
                        placeholder="自定义任务类型"
                        onChange={(e) => setField('type', e.target.value)}
                      />
                    )}
                  </Field>
                </div>

                <Field label="命令 (command)" hint="要执行的可执行文件，例如 cmake 或完整路径">
                  <TextInput
                    mono
                    value={text(task.command)}
                    placeholder="例如 cmake"
                    onChange={(e) => setField('command', e.target.value)}
                  />
                </Field>

                <Field label="参数 (args)" hint="每行一个参数；含空格的片段整体写成一行即可">
                  <TextArea
                    rows={4}
                    value={lines(task.args)}
                    placeholder={'--build\nbuild/Debug'}
                    onChange={(e) => setListField('args', splitLines(e.target.value))}
                  />
                </Field>

                <div className="grid grid--2">
                  <Field label="工作目录 (options.cwd)" hint={`一般是 ${WS}`}>
                    <TextInput
                      mono
                      value={text(task.options?.cwd)}
                      placeholder={WS}
                      onChange={(e) => setCwd(e.target.value)}
                    />
                  </Field>

                  <Field label="分组 (group)" hint="默认构建任务就是 Ctrl+Shift+B 直接跑的那个">
                    <Select
                      value={group}
                      options={[
                        { value: '', label: '无 group' },
                        { value: 'build', label: 'build（构建任务）' },
                        { value: 'test', label: 'test（测试任务）' },
                        {
                          value: 'default',
                          label: '默认构建任务 { kind: "build", isDefault: true }'
                        },
                        ...(group === 'other'
                          ? [
                              {
                                value: 'other',
                                label: `其它（${JSON.stringify(task.group)}）`,
                                disabled: true
                              }
                            ]
                          : [])
                      ]}
                      onChange={(e) => {
                        const value = e.target.value as GroupKey
                        if (value === '') setField('group', undefined)
                        else if (value === 'build') setField('group', 'build')
                        else if (value === 'test') setField('group', 'test')
                        else if (value === 'default')
                          setField('group', { kind: 'build', isDefault: true })
                      }}
                    />
                  </Field>
                </div>

                <Field label="problemMatcher" hint={'JSON 数组，例如 ["$gcc"]；写坏之前不会覆盖原值'}>
                  <TextArea
                    rows={3}
                    value={matcherDraft}
                    placeholder={'[\n    "$gcc"\n]'}
                    onChange={(e) => onMatcherChange(e.target.value)}
                  />
                  {matcherError && <Alert kind="err">JSON 解析失败：{matcherError}</Alert>}
                </Field>

                <Field label="依赖任务 (dependsOn)" hint="每行一个任务 label，会按顺序先跑它们">
                  <TextArea
                    rows={3}
                    value={lines(task.dependsOn)}
                    placeholder={'配置 CMake（Debug）'}
                    onChange={(e) => setListField('dependsOn', splitLines(e.target.value))}
                  />
                </Field>

                <Field label="说明 (detail)" hint="显示在任务列表里的一句补充说明">
                  <TextInput
                    value={text(task.detail)}
                    placeholder="例如 使用 Ninja + arm-none-eabi-gcc"
                    onChange={(e) => setField('detail', e.target.value)}
                  />
                </Field>
              </Card>
            )}
          </div>
        </SplitPane>
      </PageBody>
    </>
  )
}
