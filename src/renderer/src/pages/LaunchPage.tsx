/**
 * 调试配置页：直接编辑 launch.json 的 configurations。
 *
 * 表单只覆盖常用字段，任何字段都能在「原始 JSON」标签里手改；
 * 这里没有「保存」按钮 —— 每次输入都即时写回 bundle（该节会被标记为
 * 「已手动修改」），真正落盘由预览 / 写入流程统一负责。
 */

import React from 'react'
import { useStudio } from '../state/store'
import { DEBUG_TARGET_OPTIONS, debugTargetConfigName, normalizeDebugTargets } from '@shared/debugTargets'
import { probeByKey } from '@shared/probes'
import type { DebugTargetKey, LaunchConfig } from '@shared/types'
import {
  Alert,
  Badge,
  Button,
  Card,
  Checkbox,
  EmptyState,
  Field,
  PageBody,
  PageHeader,
  Select,
  Tabs,
  TextArea,
  TextInput
} from '../components/ui'
import { NoProject } from '../components/NoProject'
import { Icons } from '../components/icons'
import { SplitPane } from '../components/Resizable'
import {
  INTERFACE_OPTIONS,
  MIMODE_OPTIONS,
  OTHER,
  REQUEST_OPTIONS,
  SERVERTYPE_OPTIONS,
  TEMPLATES,
  TYPE_OPTIONS,
  lines,
  setKey,
  setList,
  splitLines,
  text,
  withCurrent,
  WS,
  type TabKey,
  type TemplateId
} from './launch/meta'
import {
  buildTargetConfig as buildTargetConfigOf,
  buildTemplate as buildTemplateOf,
  type LaunchBuildCtx
} from './launch/build'

// --------------------------------------------------------------------------

export default function LaunchPage(): React.JSX.Element {
  const project = useStudio((s) => s.project)
  const bundle = useStudio((s) => s.bundle)
  const options = useStudio((s) => s.options)
  const notify = useStudio((s) => s.notify)

  const configurations = bundle?.launch.configurations ?? []
  const configCount = configurations.length

  const [selected, setSelected] = React.useState(0)
  const [tab, setTab] = React.useState<TabKey>('form')
  const [templateOpen, setTemplateOpen] = React.useState(false)
  const [templateId, setTemplateId] = React.useState<TemplateId>('dual')
  /** 「自定义」模板里勾选的调试器；切走再切回来不丢 */
  const [pickedTargets, setPickedTargets] = React.useState<DebugTargetKey[]>([
    'probe',
    'stlink-gdbserver'
  ])
  const [rawText, setRawText] = React.useState('')
  const [rawError, setRawError] = React.useState<string | null>(null)
  const [typeOther, setTypeOther] = React.useState(false)
  const [setupDraft, setSetupDraft] = React.useState('')
  const [setupError, setSetupError] = React.useState<string | null>(null)

  const activeIndex = configCount ? Math.min(selected, configCount - 1) : -1
  const config: LaunchConfig | null = activeIndex >= 0 ? configurations[activeIndex] : null

  /** 从 store 里现取一次，避免用到过期的闭包值 */
  const liveConfig = (index: number): LaunchConfig | null =>
    useStudio.getState().bundle?.launch.configurations[index] ?? null

  const syncRawFromBundle = (index: number): void => {
    const current = liveConfig(index)
    setRawText(current ? JSON.stringify(current, null, 4) : '')
    setRawError(null)
  }

  // 切换配置（或增删条目）时，重置只跟当前配置有关的本地草稿
  React.useEffect(() => {
    const current = liveConfig(activeIndex)
    setRawText(current ? JSON.stringify(current, null, 4) : '')
    setRawError(null)
    setSetupDraft(
      current && current.setupCommands !== undefined
        ? JSON.stringify(current.setupCommands, null, 4)
        : ''
    )
    setSetupError(null)
    setTypeOther(false)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [activeIndex, configCount])

  if (!bundle || !project) {
    return (
      <>
        <PageHeader title="调试配置 launch.json" subtitle="还没有选择工程" />
        <PageBody>
          <NoProject reason="调试配置要从工程里读固件名、芯片型号和 OpenOCD 接线方式。" />
        </PageBody>
      </>
    )
  }

  // ------------------------------------------------------------------------
  // 写入
  // ------------------------------------------------------------------------

  const writeConfig = (index: number, next: LaunchConfig): void => {
    const state = useStudio.getState()
    const live = state.bundle
    if (!live || index < 0 || index >= live.launch.configurations.length) return
    const configurations2 = live.launch.configurations.map((c, i) => (i === index ? next : c))
    state.editBundle('launch', { ...live.launch, configurations: configurations2 })
  }

  const setField = (key: string, value: unknown): void => {
    if (!config) return
    writeConfig(activeIndex, setKey(config, key, value))
  }

  const setListField = (key: string, list: unknown[]): void => {
    if (!config) return
    writeConfig(activeIndex, setList(config, key, list))
  }

  // ------------------------------------------------------------------------
  // 增删改排
  // ------------------------------------------------------------------------

  /** 造配置用的上下文；options / project 变了就跟着变 */
  const buildCtx: LaunchBuildCtx = {
    options,
    project,
    openocdCfg: bundle.openocdCfg?.fileName ?? null
  }

  const buildTemplate = (id: TemplateId): LaunchConfig => buildTemplateOf(id, buildCtx)
  const buildTargetConfig = (target: DebugTargetKey): LaunchConfig =>
    buildTargetConfigOf(target, buildCtx)

  /**
   * 按勾选的调试器批量追加配置。
   *
   * 同名已存在的跳过 —— 这样「双探针」和「自定义」两个入口反复点也不会堆重复项。
   */
  const addTargets = (targets: DebugTargetKey[], sourceLabel: string): void => {
    const state = useStudio.getState()
    const live = state.bundle
    if (!live) return

    const wanted = normalizeDebugTargets(targets)
    const existing = new Set(live.launch.configurations.map((c) => text(c.name)))
    const additions = wanted
      .map((target) => buildTargetConfig(target))
      .filter((c) => !existing.has(text(c.name)))

    if (!additions.length) {
      setTemplateOpen(false)
      notify('warn', '这些调试配置已经在列表里了，没有新增')
      return
    }

    const list = [...live.launch.configurations, ...additions]
    state.editBundle('launch', { ...live.launch, configurations: list })
    setSelected(list.length - additions.length)

    // 记住这次的选择：以后换工程 / 「按当前参数重新生成全部配置」也会带上这几条。
    // 放在 editBundle 之后，是因为 patchOptions 在「没有任何手动改动」时会静默重算，
    // 那时 bundle 会被整体替换、把刚加的条目冲掉。
    void state.saveSettings({ debugTargets: wanted })
    state.patchOptions({ debugTargets: wanted })

    setTemplateOpen(false)
    notify(
      'ok',
      `${sourceLabel}：新增 ${additions.length} 条 —— ${additions.map((c) => text(c.name)).join('、')}`
    )
  }

  const addConfig = (): void => {
    if (templateId === 'dual') {
      addTargets(['probe', 'stlink-gdbserver'], '双探针')
      return
    }
    if (templateId === 'custom') {
      addTargets(pickedTargets, '自定义')
      return
    }

    const state = useStudio.getState()
    const live = state.bundle
    if (!live) return
    const next = buildTemplate(templateId)
    const list = [...live.launch.configurations, next]
    state.editBundle('launch', { ...live.launch, configurations: list })
    setSelected(list.length - 1)
    setTemplateOpen(false)
    notify('ok', `已新增配置「${next.name}」`)
  }

  const duplicateConfig = (): void => {
    if (!config) return
    const state = useStudio.getState()
    const live = state.bundle
    if (!live) return
    const copy: LaunchConfig = { ...config, name: `${text(config.name)} 副本` }
    const list = [...live.launch.configurations]
    list.splice(activeIndex + 1, 0, copy)
    state.editBundle('launch', { ...live.launch, configurations: list })
    setSelected(activeIndex + 1)
    notify('ok', `已复制为「${copy.name}」`)
  }

  const removeConfig = (): void => {
    if (!config) return
    const state = useStudio.getState()
    const live = state.bundle
    if (!live) return
    const list = live.launch.configurations.filter((_, i) => i !== activeIndex)
    state.editBundle('launch', { ...live.launch, configurations: list })
    setSelected(Math.max(0, Math.min(activeIndex, list.length - 1)))
    notify('warn', `已删除配置「${text(config.name)}」`)
  }

  const moveConfig = (delta: number): void => {
    const state = useStudio.getState()
    const live = state.bundle
    if (!live) return
    const list = [...live.launch.configurations]
    const target = activeIndex + delta
    if (target < 0 || target >= list.length) return
    const [item] = list.splice(activeIndex, 1)
    list.splice(target, 0, item)
    state.editBundle('launch', { ...live.launch, configurations: list })
    setSelected(target)
  }

  const regenerateAll = (): void => {
    const state = useStudio.getState()
    state.notify('warn', '将按当前生成参数重建全部调试配置，所有手动修改都会被覆盖')
    void state.regenerate(true)
  }

  // ------------------------------------------------------------------------
  // 编辑区
  // ------------------------------------------------------------------------

  const showCustomType = typeOther || !TYPE_OPTIONS.includes(config?.type ?? '')

  const onSetupCommandsChange = (value: string): void => {
    setSetupDraft(value)
    if (!config) return
    const trimmed = value.trim()
    if (!trimmed) {
      setSetupError(null)
      setField('setupCommands', undefined)
      return
    }
    try {
      const parsed = JSON.parse(trimmed) as unknown
      if (!Array.isArray(parsed)) {
        setSetupError('setupCommands 必须是一个 JSON 数组')
        return
      }
      setSetupError(null)
      setField('setupCommands', parsed)
    } catch (err) {
      setSetupError(err instanceof Error ? err.message : String(err))
    }
  }

  const applyRaw = (): void => {
    let parsed: unknown
    try {
      parsed = JSON.parse(rawText)
    } catch (err) {
      setRawError(err instanceof Error ? err.message : String(err))
      return
    }
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
      setRawError('最外层必须是一个 JSON 对象，例如 { "name": …, "type": …, "request": … }')
      return
    }
    setRawError(null)
    writeConfig(activeIndex, parsed as LaunchConfig)
    notify('ok', `已把 JSON 应用到第 ${activeIndex + 1} 个配置`)
  }

  const onlyDebug = config ? Array.isArray(config.loadFiles) : false
  const showInterface = config ? config.servertype === 'jlink' || config.interface !== undefined : false

  const form = !config ? null : (
    <>
      {/* ---- 通用字段 ---- */}
      <div className="grid grid--2">
        <Field label="名称 (name)">
          <TextInput
            value={text(config.name)}
            placeholder="例如 CMSIS-DAP / DAP-Link：烧录并调试"
            onChange={(e) => setField('name', e.target.value)}
          />
        </Field>

        <Field label="类型 (type)" hint="决定下面出现哪些字段">
          <Select
            value={showCustomType ? OTHER : text(config.type)}
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
              value={text(config.type)}
              placeholder="自定义调试器类型，例如 cppvsdbg"
              onChange={(e) => setField('type', e.target.value)}
            />
          )}
        </Field>
      </div>

      <Field label="请求方式 (request)">
        <Select
          value={text(config.request)}
          options={withCurrent(REQUEST_OPTIONS, text(config.request))}
          onChange={(e) => setField('request', e.target.value)}
        />
      </Field>

      {/* ---- cortex-debug ---- */}
      {config.type === 'cortex-debug' && (
        <>
          <div className="grid grid--2">
            <Field label="servertype" hint="用哪种调试服务器">
              <Select
                value={text(config.servertype)}
                options={withCurrent(SERVERTYPE_OPTIONS, text(config.servertype))}
                onChange={(e) => setField('servertype', e.target.value)}
              />
            </Field>
            <Field label="device" hint="cortex-debug 需要的芯片型号，例如 STM32F103C8">
              <TextInput
                mono
                value={text(config.device)}
                onChange={(e) => setField('device', e.target.value)}
              />
            </Field>
            <Field label="cwd" hint="调试时的工作目录">
              <TextInput
                mono
                value={text(config.cwd)}
                onChange={(e) => setField('cwd', e.target.value)}
              />
            </Field>
            <Field label="executable" hint="要调试的 ELF 文件">
              <TextInput
                mono
                value={text(config.executable)}
                onChange={(e) => setField('executable', e.target.value)}
              />
            </Field>
          </div>

          <Field
            label="configFiles"
            hint="每行一个 OpenOCD 配置文件路径；本工具生成的接线配置在 .vscode/ 下"
          >
            <TextArea
              rows={4}
              value={lines(config.configFiles)}
              placeholder={`${WS}/.vscode/openocd-stm32f1x-cmsis-dap.cfg`}
              onChange={(e) => setListField('configFiles', splitLines(e.target.value))}
            />
          </Field>

          <div className="grid grid--2">
            <Field label="runToEntryPoint" hint="启动后停在哪个符号，例如 main；留空表示直接运行">
              <TextInput
                mono
                value={text(config.runToEntryPoint)}
                onChange={(e) => setField('runToEntryPoint', e.target.value)}
              />
            </Field>
            <Field label="svdFile" hint="外设寄存器视图用的 .svd 文件，可留空">
              <TextInput
                mono
                value={text(config.svdFile)}
                onChange={(e) => setField('svdFile', e.target.value)}
              />
            </Field>
            <Field label="armToolchainPath" hint="arm-none-eabi-gdb 所在目录">
              <TextInput
                mono
                value={text(config.armToolchainPath)}
                onChange={(e) => setField('armToolchainPath', e.target.value)}
              />
            </Field>
            {showInterface && (
              <Field label="interface" hint="J-Link 原生调试时使用">
                <Select
                  value={text(config.interface)}
                  options={withCurrent(INTERFACE_OPTIONS, text(config.interface))}
                  onChange={(e) => setField('interface', e.target.value)}
                />
              </Field>
            )}
          </div>

          <Checkbox
            checked={onlyDebug}
            onChange={(checked) => setField('loadFiles', checked ? [] : undefined)}
            label="仅调试，不重新烧录（loadFiles: []）"
          />
        </>
      )}

      {/* ---- cppdbg ---- */}
      {config.type === 'cppdbg' && (
        <>
          <div className="grid grid--2">
            <Field label="cwd" hint="调试时的工作目录">
              <TextInput
                mono
                value={text(config.cwd)}
                onChange={(e) => setField('cwd', e.target.value)}
              />
            </Field>
            <Field label="program" hint="要调试的可执行文件">
              <TextInput
                mono
                value={text(config.program)}
                onChange={(e) => setField('program', e.target.value)}
              />
            </Field>
            <Field label="MIMode" hint="调试器后端">
              <Select
                value={text(config.MIMode)}
                options={withCurrent(MIMODE_OPTIONS, text(config.MIMode))}
                onChange={(e) => setField('MIMode', e.target.value)}
              />
            </Field>
            <Field label="miDebuggerPath" hint="gdb 可执行文件路径，留空则用 PATH 里的 gdb">
              <TextInput
                mono
                value={text(config.miDebuggerPath)}
                onChange={(e) => setField('miDebuggerPath', e.target.value)}
              />
            </Field>
          </div>

          <Field label="args" hint="每行一个传给被调试程序的参数">
            <TextArea
              rows={3}
              value={lines(config.args)}
              onChange={(e) => setListField('args', splitLines(e.target.value))}
            />
          </Field>

          <div className="flex flex-wrap mb-12">
            <Checkbox
              checked={config.stopAtEntry === true}
              onChange={(checked) => setField('stopAtEntry', checked)}
              label="stopAtEntry：启动后停在入口"
            />
            <Checkbox
              checked={config.externalConsole === true}
              onChange={(checked) => setField('externalConsole', checked)}
              label="externalConsole：用独立控制台窗口"
            />
          </div>

          <Field
            label="setupCommands"
            hint={'JSON 数组，每项形如 { "description": "…", "text": "…" }；写坏之前不会覆盖原值'}
          >
            <TextArea
              rows={5}
              value={setupDraft}
              placeholder={
                '[\n    {\n        "description": "为 gdb 启用整齐打印",\n        "text": "-enable-pretty-printing",\n        "ignoreFailures": true\n    }\n]'
              }
              onChange={(e) => onSetupCommandsChange(e.target.value)}
            />
            {setupError && <Alert kind="err">JSON 解析失败：{setupError}</Alert>}
          </Field>
        </>
      )}

      {/* ---- 其它类型 ---- */}
      {config.type !== 'cortex-debug' && config.type !== 'cppdbg' && (
        <Alert kind="info">
          类型「{config.type || '未填写'}」的字段比较多，这种类型请用「原始 JSON」标签编辑。
        </Alert>
      )}
    </>
  )

  const raw = !config ? null : (
    <>
      <Field label="configurations[i] 原始内容" hint="点「应用到该配置」才会写回 bundle">
        <TextArea
          rows={22}
          value={rawText}
          onChange={(e) => {
            setRawText(e.target.value)
            setRawError(null)
          }}
        />
      </Field>
      {rawError && <Alert kind="err">JSON 解析失败：{rawError}</Alert>}
      <div className="flex">
        <Button variant="primary" onClick={applyRaw}>
          应用到该配置
        </Button>
      </div>
    </>
  )

  return (
    <>
      <PageHeader
        title="调试配置 launch.json"
        subtitle={`${configCount} 个配置`}
        actions={
          <Button size="sm" variant="primary" onClick={regenerateAll}>
            <Icons.refresh />
            按当前参数重新生成全部配置
          </Button>
        }
      />

      <PageBody>
        {/* ---- 在 VSCode 里怎么调出来 ---- */}
        <Card title="这个配置怎么用" hint="运行和调试下拉里只有它 —— 纯烧录请用任务">
          <div className="grid grid--2">
            <div className="small" style={{ lineHeight: 1.9 }}>
              <div className="bold mb-8">调试：按 F5</div>
              <div>
                · 左侧点「运行和调试」图标（<kbd>Ctrl</kbd>+<kbd>Shift</kbd>+<kbd>D</kbd>）， 下拉选{' '}
                <b>{debugTargetConfigName('probe', probeByKey(options?.probeKey ?? 'cmsis-dap').label)}</b>
                {configurations.some((c) => c.type === 'stlinkgdbtarget') ? (
                  <>
                    {' '}
                    —— 插 ST-Link 时选那条 <b>ST-Link: …</b> 的。
                  </>
                ) : (
                  '。'
                )}
              </div>
              <div>
                · 按 <kbd>F5</kbd>：先构建 → 烧录 → 停在 <span className="mono">main</span> 等你下断点。
                <kbd>Shift</kbd>+<kbd>F5</kbd> 停止。
              </div>
              <div>
                · 它的 <span className="mono">preLaunchTask</span> 是「构建
                Debug」，编译不过就不会进调试。
              </div>
            </div>

            <div className="small" style={{ lineHeight: 1.9 }}>
              <div className="bold mb-8">只烧录、不调试：按 Ctrl+Shift+B</div>
              <div>
                · <b>「运行和调试」下拉里放不了「只烧不调」</b> —— 那里只能是调试会话。 以前试过用{' '}
                <span className="mono">noDebug</span> 冒充，实测 cortex-debug 会忽略它、 照样把 CPU halt
                住，结果是「固件烧进去了但板子不跑」。
              </div>
              <div>
                · 纯烧录走任务：<kbd>Ctrl</kbd>+<kbd>Shift</kbd>+<kbd>B</kbd> 跑默认生成任务 「
                <b>烧录并运行 Debug 固件</b>」—— 先构建、再烧录、烧完 reset run （OpenOCD
                跑完自己退出，全程不挂调试器）。
              </div>
              <div>
                · 想挑别的：<kbd>Ctrl</kbd>+<kbd>Shift</kbd>+<kbd>P</kbd> →{' '}
                <span className="mono">Tasks: Run Task</span>。
              </div>
            </div>
          </div>

          <Alert kind="info">
            ※ 两者都是<b>先构建再烧录</b>。Ninja 在源码没改动时什么都不做，这一步几乎不花时间；
            编译不过时依赖链会自动停下，不会去烧旧固件。
          </Alert>
        </Card>

        <SplitPane storageKey="launch-list" defaultWidth={300}>
          {/* ---- 左：配置列表 ---- */}
          <Card title="调试配置" hint={`${configCount} 个`}>
            {configCount === 0 ? (
              <EmptyState title="还没有调试配置">用下面的「新增 ▾」从模板创建一个。</EmptyState>
            ) : (
              <div className="list list__scroll">
                {configurations.map((c, i) => (
                  <div
                    key={`${text(c.name)}-${i}`}
                    className={i === activeIndex ? 'list__item list__item--active' : 'list__item'}
                    onClick={() => setSelected(i)}
                  >
                    <span style={{ flex: 1, minWidth: 0 }}>
                      <div className="truncate" title={text(c.name)}>
                        {text(c.name) || '（未命名）'}
                      </div>
                    </span>
                    <Badge kind={c.request === 'attach' ? 'warn' : 'default'}>
                      {text(c.type) || '未知'}
                    </Badge>
                  </div>
                ))}
              </div>
            )}

            <div className="flex flex-wrap mt-8">
              <Button size="sm" variant="primary" onClick={() => setTemplateOpen((open) => !open)}>
                新增 ▾
              </Button>
              <Button size="sm" disabled={!config} onClick={duplicateConfig}>
                复制
              </Button>
              <Button size="sm" variant="danger" disabled={!config} onClick={removeConfig}>
                删除
              </Button>
              <Button size="sm" disabled={!config || activeIndex <= 0} onClick={() => moveConfig(-1)}>
                上移
              </Button>
              <Button
                size="sm"
                disabled={!config || activeIndex >= configCount - 1}
                onClick={() => moveConfig(1)}
              >
                下移
              </Button>
            </div>

            {templateOpen && (
              <div className="mt-8">
                <Field label="从模板新增" hint="模板里的路径按当前生成参数填好，可再手动改">
                  <Select
                    value={templateId}
                    options={TEMPLATES.map((t) => ({ value: t.id, label: t.label }))}
                    onChange={(e) => setTemplateId(e.target.value as TemplateId)}
                  />
                </Field>

                {templateId === 'dual' && (
                  <Alert kind="info">
                    一次加两条：OpenOCD（DAP-Link 用）+ ST 官方 ST-Link GDB server。
                    VSCode「运行和调试」下拉里插哪个选哪条，不用回来改配置。
                  </Alert>
                )}

                {templateId === 'custom' && (
                  <div style={{ display: 'grid', gap: 6 }}>
                    {DEBUG_TARGET_OPTIONS.map((opt) => (
                      <div
                        key={opt.key}
                        style={{
                          padding: '6px 8px',
                          border: '1px solid var(--border)',
                          borderRadius: 6
                        }}
                      >
                        <Checkbox
                          checked={pickedTargets.includes(opt.key)}
                          onChange={(on) =>
                            setPickedTargets((prev) =>
                              on
                                ? prev.includes(opt.key)
                                  ? prev
                                  : [...prev, opt.key]
                                : prev.filter((k) => k !== opt.key)
                            )
                          }
                          label={
                            <span className="small">
                              <b>{opt.label}</b>
                              <br />
                              <span style={{ opacity: 0.72 }}>{opt.hint}</span>
                            </span>
                          }
                        />
                      </div>
                    ))}
                    {pickedTargets.length === 0 && (
                      <Alert kind="warn">
                        至少勾一个 —— 一条都不勾的话，生成出来的 launch.json 里就没有可调试项了。
                      </Alert>
                    )}
                  </div>
                )}

                <Button
                  size="sm"
                  variant="primary"
                  onClick={addConfig}
                  disabled={templateId === 'custom' && pickedTargets.length === 0}
                >
                  {templateId === 'custom' || templateId === 'dual' ? '批量创建' : '创建'}
                </Button>
              </div>
            )}
          </Card>

          {/* ---- 右：编辑区 ---- */}
          <div>
            {bundle.openocdCfg && (
              <Alert kind="accent">
                cortex-debug 的 <span className="mono">configFiles</span> 应指向{' '}
                <span className="mono">.vscode/{bundle.openocdCfg.fileName}</span> —— 本工具会把这个
                OpenOCD 接线配置一起写进工程。
              </Alert>
            )}

            {!project.isEmbedded && (
              <Alert kind="info">
                这是一个通用 CMake 工程（没识别到 .ioc / 芯片型号）：建议用 cppdbg 做本机 gdb
                调试，嵌入式那几套模板里的路径需要自己改。
              </Alert>
            )}

            {!config ? (
              <Card title="配置详情">
                <EmptyState title="没有选中的配置" />
              </Card>
            ) : (
              <Card
                title={text(config.name) || '（未命名）'}
                hint={`第 ${activeIndex + 1} / ${configCount} 个`}
              >
                <Tabs
                  value={tab}
                  onChange={(next) => {
                    // 切到原始 JSON 时重新生成文本，避免把表单里的新改动盖回去
                    if (next === 'raw') syncRawFromBundle(activeIndex)
                    setTab(next)
                  }}
                  tabs={[
                    { key: 'form', label: '表单' },
                    { key: 'raw', label: '原始 JSON' }
                  ]}
                />
                {tab === 'form' ? form : raw}
              </Card>
            )}
          </div>
        </SplitPane>
      </PageBody>
    </>
  )
}
